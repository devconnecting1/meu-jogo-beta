/*
 * Client mixer: three buses (SFX / UI / BGM), a pool of reusable Sounds, a voice budget per sound and
 * 2D spatialisation for a game that has no 3D world at all.
 *
 * Buses
 *  - Every bus is a SoundGroup under SoundService. Its gain comes from the Settings sliders
 *    (save.settings.soundEffect and save.settings.bgm, which already persist in the save):
 *      sfx = HEADROOM.sfx * soundEffect^1.5
 *      ui  = HEADROOM.ui  * soundEffect^1.5   (the UI rides the SFX slider; the save has no third one)
 *      bgm = HEADROOM.bgm * bgm^1.5
 *    The 1.5 exponent is the usual perceptual taper: halfway on the slider is about a third of the power,
 *    which is what "half volume" sounds like. A slider at 0 mutes the group AND skips playing entirely.
 *
 * Voices
 *  - Sounds are created once and reused (nothing is created or destroyed per trigger). Each catalogue entry
 *    has its own voice limit (e.g. 4 overlapping shots): past it the OLDEST copy is stolen. When the whole
 *    pool is busy, the oldest voice of equal or lower priority is stolen; if there is none, the trigger is
 *    dropped. Every trigger picks a random PlaybackSpeed inside the entry's range so repeats never sound
 *    like a machine gun of identical samples -- and, where the entry has them, one of its takes (never the last
 *    one) and a volume a little under its base (`volJitter`).
 *  - The same entry triggered again within its `minGap` (MIN_GAP by default) is dropped: eight pellets landing in
 *    one frame, or ten zombies dying in one blast, are ONE hit and ONE death to the ear -- identical samples started
 *    together only sum into a louder, phasier copy of themselves (DESIGN_RULES SND-04).
 *  - A window of a file (`startAt` + `maxPlay`, or a take) is FILE time: it is set as Sound.PlaybackRegion, so the
 *    engine ends it on the right sample at any pitch, and the mixer's own deadline is the window divided by the
 *    speed. It used to be real time: a groan pitched down to 0.6 was cut at 60% of its phrase, and one pitched up
 *    ran into the next phrase of the same file.
 *
 * Spatialisation in a ScreenGui game (docs/MULTIPLAYER.md §11.2: audio is client-side and stays client-side)
 *  - There is no 3D world, so there is no position to attach a Sound to. We build a minimal one: a single
 *    invisible anchored Part at the origin holds one Attachment per spatial voice, and the listener is
 *    pinned to the origin with an identity CFrame (SoundService:SetListener). Before a voice plays we place
 *    its Attachment at the event's ABSOLUTE position, mapped as
 *        studs.x = worldX * STUDS_PER_UNIT   (screen right -> listener right)
 *        studs.z = worldY * STUDS_PER_UNIT   (screen down  -> behind the listener)
 *        studs.y = 0
 *    and the LISTENER is moved to the camera every frame. Roblox then recomputes pan and distance itself,
 *    every frame, for free.
 *
 *    That last part is the whole design, and it was wrong once: the first version pinned the listener to
 *    the origin and placed each voice relative to the camera AT THE MOMENT IT WAS TRIGGERED. A one-shot was
 *    fine, but anything that lasts glued itself to the listener and travelled with them -- at 210 u/s a
 *    2.1 s boss roar drifts about 28 of the 100 studs of range, so the roar that should sweep past you as
 *    you run by just followed you. Moving the listener instead is the same two numbers, the right way round.
 *  - Limitation, on purpose: a top-down plane has no elevation, and "up the screen" maps to "in front of
 *    the listener" while "down the screen" maps to "behind" — on stereo speakers front and back sound the
 *    same, so the player hears LEFT/RIGHT and NEAR/FAR, not above/below. That is exactly what a 2D top-down
 *    game needs, and it costs one Part instead of a per-voice volume hack.
 *  - If the Part cannot be created (it never should on a client), the mixer falls back to flat 2D voices
 *    with a manual distance curve: no panning, but the game still has sound.
 */
import { dropSoundAsset, SoundBus, SoundDef, SoundName, soundAssetIds, soundDef } from "shared/data/sounds";
import type { SettingsData } from "shared/game/save";

const SoundService = game.GetService("SoundService");
const ContentProvider = game.GetService("ContentProvider");
const RunService = game.GetService("RunService");
const World = game.GetService("Workspace");

/** world units at which a spatial sound is fully silent (about a screen and a half away) */
export const AUDIO_RANGE = 1600;
/** world units inside which there is no attenuation ("right next to me") */
const AUDIO_NEAR = 140;
/** world units -> studs: AUDIO_RANGE lands on 100 studs, a comfortable range for the engine's panner */
const STUDS_PER_UNIT = 100 / AUDIO_RANGE;
/**
 * The listener follows the camera once it moved this far (world units: 1/16 stud, 1/1600 of the range). Less is
 * nothing the panner or the roll-off can render, and the camera's easing creeps by less than that for seconds.
 */
const EAR_STEP = 1;

/** the ear to `at` (no closure per call: pcall hands it the CFrame) */
function placeEar(at: CFrame): void {
	SoundService.SetListener(Enum.ListenerType.CFrame, at);
}

/** how loud each bus can get with its slider at 100% */
const HEADROOM: Record<SoundBus, number> = { sfx: 1, ui: 0.8, bgm: 0.7 };
/** perceptual taper of the sliders */
const SLIDER_CURVE = 1.5;

/** voices that can be placed in the world */
export const SPATIAL_VOICES = 20;
/**
 * Voices for the UI and for the sounds that have no place in the world: the local survivor's own (their gun, their
 * feet, their reload -- they sit on the ear, see gameAudio.ts) and the interface. 14: a magazine emptying (4) and
 * its reload over footsteps (3), the Bag's clicks and a toast, with room to spare.
 */
export const FLAT_VOICES = 14;
/** a voice younger than this is never recycled, even if the engine says it is not playing yet */
const MIN_VOICE_AGE = 0.05;
/** the same entry again sooner than this is the same event heard twice (an entry's `minGap` overrides it) */
export const MIN_GAP = 0.03;
/** the mixer's deadline for a window runs this much past its real end (the engine's PlaybackRegion ends it first) */
const WINDOW_SLACK = 0.03;

/** Sound.PlaybackRegion for a window of the file (no closure per call: pcall hands the arguments over) */
function setWindow(sound: Sound, a: number, b: number): void {
	sound.PlaybackRegion = new NumberRange(a, b);
	sound.PlaybackRegionsEnabled = true;
}

/** Sound.LoopRegion for a held loop or a track that repeats one region of its file */
function setLoopRegion(sound: Sound, a: number, b: number): void {
	sound.LoopRegion = new NumberRange(a, b);
	sound.PlaybackRegionsEnabled = true;
}
/**
 * Held loops (`holdLoop`): an engine or a flamethrower is ONE looping voice that follows its source while somebody
 * holds it every frame. Six: the six survivors of a full server on motorcycles, or a few riders and a flamethrower.
 */
const LOOP_VOICES = 6;
/** a held loop fades in over this (no click when an engine starts) and out over this once nobody holds it */
const LOOP_FADE_IN = 0.08;
const LOOP_FADE_OUT = 0.25;
/** how fast a held loop's pitch follows what it is asked for (per second): an engine revs, it does not jump */
const LOOP_PITCH_RATE = 6;

interface Voice {
	sound: Sound;
	/** spatial voices only: where the sound sits relative to the listener */
	attachment?: Attachment;
	name?: SoundName;
	/** os.clock() at the trigger (oldest is stolen first) */
	started: number;
	priority: number;
	/** os.clock() deadline from the entry's maxPlay, or math.huge */
	stopAt: number;
	active: boolean;
	/** the bus of what it plays (leaving a run stops the world's voices, not the click that left it) */
	bus: SoundBus;
	/** Sound.PlaybackRegionsEnabled as last written (a window), so a plain sound after it turns it off once */
	windowed: boolean;
}

export interface PlayOptions {
	/** world position of the event; without it the sound is flat (2D, centred) */
	x?: number;
	y?: number;
	/** extra multiplier on the entry's base volume (0..1) */
	scale?: number;
	/** overrides the entry's random pitch range */
	pitch?: number;
	/** multiplies the pitch (random or given): the voice of a zombie type, a bigger body lower */
	pitchScale?: number;
}

/** one looping voice a caller holds every frame (see `holdLoop`) */
interface LoopVoice {
	sound: Sound;
	attachment?: Attachment;
	/** the holder's key, or undefined while the voice is free */
	key?: number;
	def?: SoundDef;
	/** 0..1 fade */
	gain: number;
	/** held since the last mixer frame */
	held: boolean;
	/** the holder's level (0..1, times the entry's volume) and the pitch it asks for */
	level: number;
	pitch: number;
	/** what was last written to the Sound (a steady loop writes nothing frame after frame) */
	vol: number;
	speed: number;
	/** where the emitter was last put (world units) */
	x: number;
	y: number;
}

// ---------------------------------------------------------------- long-running tracks (music, ambience)

interface TrackSlot {
	sound: Sound;
	def?: SoundDef;
	/** current 0..1 fade level */
	gain: number;
	target: number;
	/** Sound.Volume as last written: a steady track writes nothing frame after frame */
	vol: number;
}

/**
 * One music/ambience channel with a true crossfade: two Sounds take turns, so switching clips fades the
 * old one out while the new one fades in instead of cutting.
 */
export class AudioTrack {
	private slots: Array<TrackSlot>;
	private cur = 0;
	private name?: SoundName;
	/** intensity on top of the clip's base volume (heartbeat levels, day/night dip) */
	private level = 1;
	private fadeIn: number;
	private fadeOut: number;
	private bus: SoundBus;

	constructor(bus: SoundBus, parent: Instance, group: SoundGroup, fadeIn: number, fadeOut: number) {
		this.bus = bus;
		this.fadeIn = fadeIn;
		this.fadeOut = fadeOut;
		this.slots = [];
		for (let i = 0; i < 2; i++) {
			const s = new Instance("Sound");
			s.Name = `Track${i}`;
			s.Looped = true;
			s.Volume = 0;
			s.SoundGroup = group;
			s.Parent = parent;
			this.slots.push({ sound: s, gain: 0, target: 0, vol: 0 });
		}
	}

	/** current clip, or undefined when the track is fading out / stopped */
	playing(): SoundName | undefined {
		return this.name;
	}

	/**
	 * Switch to `name` (no-op when it is already the current clip); undefined stops the track.
	 *
	 * The two slots take turns, but a slot is not always silent when its turn comes back: heartbeat 1 -> 2 -> 3 within a
	 * second and a half (three bites) lands on the slot still fading heartbeat 1 out. It used to swap the SoundId under
	 * that fading sound and let the new clip in at the old one's level -- a heartbeat jumping in at 70 %, against "nothing
	 * comes in by surprise". Now a slot still carrying the SAME clip takes it back where it is (no restart, no jump), and
	 * otherwise the quieter slot is cut to silence before the new clip fades in from zero.
	 */
	set(name: SoundName | undefined): void {
		if (name === this.name) return;
		this.name = name;
		for (const slot of this.slots) slot.target = 0;
		if (name === undefined) return;
		const def = soundDef(name);
		if (def === undefined || def.id === "") {
			// empty slot: silent fallback, the track simply carries nothing
			this.name = undefined;
			return;
		}
		for (let i = 0; i < this.slots.size(); i++) {
			const s = this.slots[i];
			if (s.def === def && s.gain > 0) {
				s.target = 1;
				this.cur = i;
				return;
			}
		}
		this.cur = this.slots[0].gain <= this.slots[1].gain ? 0 : 1;
		const slot = this.slots[this.cur];
		if (slot.sound.IsPlaying) slot.sound.Stop();
		slot.gain = 0;
		slot.def = def;
		slot.target = 1;
		if (slot.sound.SoundId !== def.id) slot.sound.SoundId = def.id;
		slot.sound.Looped = def.loop === true;
		slot.sound.PlaybackSpeed = def.pitchMin;
		const a = def.loopStart;
		const b = def.loopEnd;
		// our own loops are a region of a bank (the heartbeat): only that region repeats
		if (a !== undefined && b !== undefined) pcall(setLoopRegion, slot.sound, a, b);
		else if (slot.sound.PlaybackRegionsEnabled) slot.sound.PlaybackRegionsEnabled = false;
		slot.sound.Volume = 0;
		slot.vol = 0;
	}

	/** intensity multiplier (0..1) applied on top of the clip's base volume */
	setLevel(level: number): void {
		this.level = math.clamp(level, 0, 1);
	}

	stop(): void {
		this.set(undefined);
	}

	/** called by the mixer every frame */
	update(dt: number, busGain: number): void {
		const inRate = dt / math.max(this.fadeIn, 0.01);
		const outRate = dt / math.max(this.fadeOut, 0.01);
		for (const slot of this.slots) {
			const def = slot.def;
			if (slot.gain < slot.target) slot.gain = math.min(slot.target, slot.gain + inRate);
			else if (slot.gain > slot.target) slot.gain = math.max(slot.target, slot.gain - outRate);
			if (def === undefined) continue;
			// the slider is at zero: no streaming, no CPU
			const wanted = busGain > 0 ? slot.gain : 0;
			if (wanted <= 0) {
				if (slot.sound.IsPlaying) slot.sound.Stop();
				if (slot.vol !== 0) {
					slot.vol = 0;
					slot.sound.Volume = 0;
				}
				continue;
			}
			const vol = def.volume * wanted * this.level;
			if (slot.vol !== vol) {
				slot.vol = vol;
				slot.sound.Volume = vol;
			}
			if (!slot.sound.IsPlaying) {
				// a region loop starts on its region: from 0 it would play the rest of the bank first
				if (def.loopStart !== undefined) slot.sound.TimePosition = def.loopStart;
				slot.sound.Play();
			}
		}
	}

	/** the slots' current levels (0..1), for the tests' "nothing jumps in" */
	gains(): ReadonlyArray<number> {
		return [this.slots[0].gain, this.slots[1].gain];
	}

	/** bus this track belongs to (the mixer needs it to pass the right gain) */
	busOf(): SoundBus {
		return this.bus;
	}
}

// ---------------------------------------------------------------- mixer

class AudioEngine {
	private started = false;
	private groups = new Map<SoundBus, SoundGroup>();
	private gains = new Map<SoundBus, number>();
	private flatRoot?: Folder;
	private emitter?: BasePart;
	private voices: Array<Voice> = [];
	private loops: Array<LoopVoice> = [];
	private tracks: Array<AudioTrack> = [];
	private settings?: () => SettingsData;
	private lastSfx = -1;
	private lastBgm = -1;
	private listenerX = 0;
	private listenerY = 0;
	/** where the engine's listener was last put (world units); huge = never */
	private earX = math.huge;
	private earY = math.huge;
	private heartbeat?: RBXScriptConnection;
	/** os.clock() of each entry's last start (minGap), and the take it played (round robin): one slot per name */
	private lastStart = new Map<SoundName, number>();
	private lastTake = new Map<SoundName, number>();

	/** builds the buses, the pool and the listener; safe to call more than once */
	start(): void {
		if (this.started || !RunService.IsClient()) return;
		this.started = true;

		const root = new Instance("Folder");
		root.Name = "ProjectZAudio";
		root.Parent = SoundService;
		this.flatRoot = root;

		for (const bus of ["sfx", "ui", "bgm"] as Array<SoundBus>) {
			const g = new Instance("SoundGroup");
			g.Name = bus;
			g.Volume = 0;
			g.Parent = root;
			this.groups.set(bus, g);
			this.gains.set(bus, 0);
		}

		// one invisible anchored part carries every spatial voice; the listener sits at the origin
		const [ok, made] = pcall(() => {
			const p = new Instance("Part");
			p.Name = "ProjectZAudioEmitters";
			p.Anchored = true;
			p.CanCollide = false;
			p.CanQuery = false;
			p.CanTouch = false;
			p.Locked = true;
			p.Transparency = 1;
			p.Size = new Vector3(0.05, 0.05, 0.05);
			p.CFrame = new CFrame();
			p.Parent = World;
			return p;
		});
		if (ok) this.emitter = made as BasePart;
		// the listener starts at the origin and is moved to the camera by setListener() every frame
		pcall(() => SoundService.SetListener(Enum.ListenerType.CFrame, new CFrame()));
		// a moving listener would otherwise bend the pitch of everything it passes: this is a top-down plane,
		// not a racing game, and a footstep that changes note because the camera panned is just a glitch
		pcall(() => {
			SoundService.DopplerScale = 0;
		});

		for (let i = 0; i < SPATIAL_VOICES; i++) this.voices.push(this.makeVoice(true, i));
		for (let i = 0; i < FLAT_VOICES; i++) this.voices.push(this.makeVoice(false, i));
		for (let i = 0; i < LOOP_VOICES; i++) this.loops.push(this.makeLoop(i));

		this.heartbeat = RunService.Heartbeat.Connect(dt => this.update(dt));
		// the sounds are fetched by the client's one preload plan, after the textures the lobby shows
		// (client/boot/preloadPlan.ts calls preloadSounds)
	}

	private makeVoice(spatial: boolean, index: number): Voice {
		const sound = new Instance("Sound");
		sound.Name = spatial ? `Voice3D_${index}` : `Voice2D_${index}`;
		sound.Volume = 0;
		let attachment: Attachment | undefined;
		const emitter = this.emitter;
		if (spatial && emitter !== undefined) {
			attachment = new Instance("Attachment");
			attachment.Name = `Emitter${index}`;
			attachment.Parent = emitter;
			sound.RollOffMode = Enum.RollOffMode.Linear;
			sound.RollOffMinDistance = AUDIO_NEAR * STUDS_PER_UNIT;
			sound.RollOffMaxDistance = AUDIO_RANGE * STUDS_PER_UNIT;
			sound.Parent = attachment;
		} else {
			sound.Parent = this.flatRoot;
		}
		return {
			sound,
			attachment,
			started: 0,
			priority: 0,
			stopAt: math.huge,
			active: false,
			bus: "sfx",
			windowed: false,
		};
	}

	/** a held loop's voice: made once, like every voice (nothing is created per engine or per burst of fire) */
	private makeLoop(index: number): LoopVoice {
		const v = this.makeVoice(this.emitter !== undefined, SPATIAL_VOICES + FLAT_VOICES + index);
		v.sound.Name = `Loop_${index}`;
		v.sound.Looped = true;
		if (v.attachment !== undefined) v.attachment.Name = `LoopEmitter${index}`;
		return {
			sound: v.sound,
			attachment: v.attachment,
			gain: 0,
			held: false,
			level: 0,
			pitch: 1,
			vol: 0,
			speed: 1,
			x: math.huge,
			y: math.huge,
		};
	}

	/**
	 * Warms the asset cache with `ids` so the first shot of a run is not silent: the last step of the client's preload
	 * plan (client/boot/preloadPlan.ts), which hands them over in the order they are needed. YIELDS until they are
	 * fetched; answers how many did not arrive. A library sound that does not arrive only plays silent (there is
	 * nothing to switch to), but one of OUR banks that does not arrive -- not approved yet, not shared with this
	 * experience -- sends its events back to their library takes for the session (sounds.ts `dropSoundAsset`, SND-01).
	 */
	preloadSounds(ids: ReadonlyArray<string>): number {
		const parent = this.flatRoot;
		if (parent === undefined || ids.size() === 0) return 0;
		const holder = new Instance("Folder");
		holder.Name = "Preload";
		holder.Parent = parent;
		const list: Array<Instance> = [];
		for (const id of ids) {
			const s = new Instance("Sound");
			s.SoundId = id;
			s.Volume = 0;
			s.Parent = holder;
			list.push(s);
		}
		let missed = 0;
		const failed: Array<string> = [];
		pcall(() =>
			ContentProvider.PreloadAsync(list, (id: string, status: Enum.AssetFetchStatus) => {
				if (status === Enum.AssetFetchStatus.Success) return;
				missed += 1;
				failed.push(id);
			}),
		);
		holder.Destroy();
		let dropped = false;
		for (const id of failed) if (dropSoundAsset(id)) dropped = true;
		if (dropped) {
			// the library takes that now stand in for the dropped bank were never asked for: fetch them too
			const asked = new Set<string>(ids);
			const more: Array<string> = [];
			for (const id of soundAssetIds()) if (!asked.has(id)) more.push(id);
			missed += this.preloadSounds(more);
		}
		return missed;
	}

	/** where the Settings sliders live; polled every frame so dragging a slider is heard at once */
	bindSettings(source: () => SettingsData): void {
		this.settings = source;
		this.refreshGains(true);
	}

	/** camera position in world units: spatial sounds are placed relative to it */
	setListener(x: number, y: number): void {
		this.listenerX = x;
		this.listenerY = y;
		// move the ear, not the world: every playing voice is re-panned and re-attenuated by the engine from
		// here, which is what makes a long sound sweep past instead of following the camera
		if (!this.started) return;
		// a still camera (a menu, a stand-off, the easing's last creep) asks nothing of the engine: no CFrame, no call.
		// It ran every frame, a CFrame and a closure each time (L2)
		if (math.abs(x - this.earX) < EAR_STEP && math.abs(y - this.earY) < EAR_STEP) return;
		this.earX = x;
		this.earY = y;
		pcall(placeEar, new CFrame(new Vector3(x * STUDS_PER_UNIT, 0, y * STUDS_PER_UNIT)));
	}

	/**
	 * Distance in world units from (x, y) to the listener. The mixer already culls past AUDIO_RANGE, but a
	 * caller whose sound does not carry that far (footsteps) needs the number to apply its own curve.
	 */
	distanceToListener(x: number, y: number): number {
		const dx = x - this.listenerX;
		const dy = y - this.listenerY;
		return math.sqrt(dx * dx + dy * dy);
	}
	/** current gain of a bus (0 = the player muted it) */
	busGain(bus: SoundBus): number {
		return this.gains.get(bus) ?? 0;
	}

	/** a track is a long-running channel (night music, day ambience, heartbeat) */
	createTrack(bus: SoundBus, fadeIn: number, fadeOut: number): AudioTrack {
		this.start();
		const group = this.groups.get(bus);
		const parent = this.flatRoot;
		if (group === undefined || parent === undefined) {
			// start() refused (server/edit): hand back a detached track that will never be heard
			const dummy = new Instance("Folder");
			const g = new Instance("SoundGroup");
			g.Parent = dummy;
			return new AudioTrack(bus, dummy, g, fadeIn, fadeOut);
		}
		const track = new AudioTrack(bus, parent, group, fadeIn, fadeOut);
		this.tracks.push(track);
		return track;
	}

	/** plays `name` once; does nothing when the slot is empty, muted, out of range or inside its minGap */
	play(name: SoundName, opts?: PlayOptions): void {
		if (!this.started) return;
		const def = soundDef(name);
		if (def === undefined || def.id === "") return;
		// the sliders are read here too, not only on the next frame: the Settings preview of a slider moved up from 0
		// plays in the same instant the slider moved, and a gain still at 0 would drop exactly that one (two compares)
		this.refreshGains(false);
		if (this.busGain(def.bus) <= 0) return;
		const now = os.clock();
		const last = this.lastStart.get(name);
		if (last !== undefined && now - last < (def.minGap ?? MIN_GAP)) return;

		// a sound may die closer than the rest (footsteps): the engine enforces it, not the caller
		const range = def.range ?? AUDIO_RANGE;
		const hasPos = opts !== undefined && opts.x !== undefined && opts.y !== undefined;
		// the engine only pans and attenuates what hangs off the emitter Part
		const spatial = hasPos && def.spatial === true && this.emitter !== undefined;
		let flatScale = 1;
		if (hasPos) {
			const dx = (opts!.x as number) - this.listenerX;
			const dy = (opts!.y as number) - this.listenerY;
			const dist = math.sqrt(dx * dx + dy * dy);
			if (dist >= range) return;
			// flat voice with a world position (no emitter, or an entry that asked not to be panned):
			// the distance curve is applied here instead
			if (!spatial) {
				flatScale = 1 - math.clamp((dist - AUDIO_NEAR) / (range - AUDIO_NEAR), 0, 1);
				if (flatScale <= 0.01) return;
			}
		}

		const voice = this.claim(name, def, spatial);
		if (voice === undefined) return;
		this.lastStart.set(name, now);

		const sound = voice.sound;
		if (sound.SoundId !== def.id) sound.SoundId = def.id;
		sound.SoundGroup = this.groups.get(def.bus);
		sound.Looped = false;
		const jitter = def.volJitter !== undefined && def.volJitter > 0 ? 1 - math.random() * def.volJitter : 1;
		sound.Volume = def.volume * math.clamp(opts?.scale ?? 1, 0, 1) * flatScale * jitter;
		const speed = math.max(0.05, (opts?.pitch ?? this.randomPitch(def)) * (opts?.pitchScale ?? 1));
		sound.PlaybackSpeed = speed;

		// the voice is pooled, so its roll-off belongs to the ENTRY playing through it right now
		if (spatial) sound.RollOffMaxDistance = range * STUDS_PER_UNIT;
		if (spatial && voice.attachment !== undefined) {
			// absolute, because the listener is where the camera is: the engine does the subtraction, every
			// frame, instead of us doing it once at trigger time
			voice.attachment.Position = new Vector3(
				(opts!.x as number) * STUDS_PER_UNIT,
				0,
				(opts!.y as number) * STUDS_PER_UNIT,
			);
		}
		// which stretch of the file: one of the entry's takes (never the last one), or its window, or all of it
		let startAt = def.startAt;
		let maxPlay = def.maxPlay;
		const takes = def.takes;
		if (takes !== undefined && takes.size() > 0) {
			const take = takes[this.pickTake(name, takes.size())];
			startAt = take.startAt;
			maxPlay = take.maxPlay;
		}
		if (maxPlay !== undefined) {
			const a = startAt ?? 0;
			pcall(setWindow, sound, a, a + maxPlay);
			voice.windowed = true;
		} else if (voice.windowed) {
			voice.windowed = false;
			sound.PlaybackRegionsEnabled = false;
		}
		voice.name = name;
		voice.bus = def.bus;
		voice.priority = def.priority;
		voice.started = now;
		// the window is file time: at half speed it lasts twice as long (the engine's region ends it on the sample)
		voice.stopAt = maxPlay !== undefined ? now + maxPlay / speed + WINDOW_SLACK : math.huge;
		voice.active = true;
		sound.TimePosition = startAt ?? 0;
		sound.Play();
	}

	/** one of `n` takes, never the one `name` played last (a uniform pick among the others) */
	private pickTake(name: SoundName, n: number): number {
		if (n <= 1) return 0;
		const last = this.lastTake.get(name);
		let i = math.random(0, n - 2);
		if (last !== undefined && i >= last) i += 1;
		this.lastTake.set(name, i);
		return i;
	}

	/** voices sounding now (one-shots) and held loops, for the tests' budget checks */
	activeVoices(): number {
		let n = 0;
		for (const v of this.voices) if (v.active) n++;
		return n;
	}

	activeLoops(): number {
		let n = 0;
		for (const l of this.loops) if (l.key !== undefined) n++;
		return n;
	}

	/**
	 * Keeps a looping sound going at (x, y) for one more frame: an engine, a flamethrower's jet. The caller holds it
	 * EVERY frame it should be heard, under its own `key` (one per source), with its level (0..1, on top of the entry's
	 * volume) and the pitch it wants now; the voice follows the source, eases to the pitch, and fades out and frees
	 * itself the first frame nobody holds it. Nothing is created: the voices are the pool made at start. With every
	 * loop voice busy a new source is simply not heard (the six survivors of a full server fit).
	 */
	holdLoop(key: number, name: SoundName, x: number, y: number, level: number, pitch: number): void {
		if (!this.started) return;
		const def = soundDef(name);
		if (def === undefined || def.id === "") return;
		this.refreshGains(false);
		if (this.busGain(def.bus) <= 0) return;
		const range = def.range ?? AUDIO_RANGE;
		const dx = x - this.listenerX;
		const dy = y - this.listenerY;
		const dist = math.sqrt(dx * dx + dy * dy);
		// out of earshot: not held, so a voice already on it fades out like one that stopped
		if (dist >= range) return;
		let v: LoopVoice | undefined;
		let free: LoopVoice | undefined;
		for (const l of this.loops) {
			if (l.key === key) {
				v = l;
				break;
			}
			if (free === undefined && l.key === undefined) free = l;
		}
		if (v === undefined) {
			if (free === undefined) return;
			v = free;
			this.startLoop(v, key, def, x, y, pitch);
		}
		v.held = true;
		// without the emitter part the loop is flat: the distance curve goes into its level, as for a flat one-shot
		const flat = v.attachment === undefined ? 1 - math.clamp((dist - AUDIO_NEAR) / (range - AUDIO_NEAR), 0, 1) : 1;
		v.level = math.clamp(level, 0, 1) * flat;
		v.pitch = pitch;
		if (v.attachment !== undefined && (math.abs(x - v.x) >= EAR_STEP || math.abs(y - v.y) >= EAR_STEP)) {
			v.x = x;
			v.y = y;
			v.attachment.Position = new Vector3(x * STUDS_PER_UNIT, 0, y * STUDS_PER_UNIT);
		}
	}

	/** is a held loop sounding under `key` right now? (tests, and a caller that plays a one-shot when it starts) */
	loopActive(key: number): boolean {
		for (const l of this.loops) if (l.key === key) return true;
		return false;
	}

	private startLoop(v: LoopVoice, key: number, def: SoundDef, x: number, y: number, pitch: number): void {
		const sound = v.sound;
		v.key = key;
		v.def = def;
		v.gain = 0;
		v.vol = 0;
		v.speed = pitch;
		v.x = x;
		v.y = y;
		if (sound.SoundId !== def.id) sound.SoundId = def.id;
		sound.SoundGroup = this.groups.get(def.bus);
		sound.Looped = true;
		sound.Volume = 0;
		sound.PlaybackSpeed = pitch;
		const a = def.loopStart;
		const b = def.loopEnd;
		// a take is a whole recording: only its steady stretch loops (Sound.LoopRegion). pcall: a value type the Node
		// suites do not model, and a region the engine refuses must still leave a loop that plays
		if (a !== undefined && b !== undefined) pcall(setLoopRegion, sound, a, b);
		else sound.PlaybackRegionsEnabled = false;
		if (v.attachment !== undefined) {
			sound.RollOffMaxDistance = (def.range ?? AUDIO_RANGE) * STUDS_PER_UNIT;
			v.attachment.Position = new Vector3(x * STUDS_PER_UNIT, 0, y * STUDS_PER_UNIT);
		}
		sound.TimePosition = a ?? 0;
		sound.Play();
	}

	private freeLoop(v: LoopVoice): void {
		v.sound.Stop();
		v.key = undefined;
		v.def = undefined;
		v.gain = 0;
		v.held = false;
		if (v.vol !== 0) {
			v.vol = 0;
			v.sound.Volume = 0;
		}
	}

	/** one mixer frame of the held loops: fade, level, pitch; the ones nobody held are faded out and freed */
	private updateLoops(dt: number): void {
		for (const v of this.loops) {
			const def = v.def;
			if (v.key === undefined || def === undefined) continue;
			if (this.busGain(def.bus) <= 0) {
				// the slider went to 0: no stream, no CPU
				this.freeLoop(v);
				continue;
			}
			const target = v.held ? 1 : 0;
			v.held = false;
			if (v.gain < target) v.gain = math.min(target, v.gain + dt / LOOP_FADE_IN);
			else if (v.gain > target) v.gain = math.max(target, v.gain - dt / LOOP_FADE_OUT);
			if (v.gain <= 0 && target === 0) {
				this.freeLoop(v);
				continue;
			}
			const vol = def.volume * v.gain * v.level;
			if (math.abs(vol - v.vol) > 0.002) {
				v.vol = vol;
				v.sound.Volume = vol;
			}
			const k = math.min(1, dt * LOOP_PITCH_RATE);
			const speed = v.speed + (v.pitch - v.speed) * k;
			if (math.abs(speed - v.sound.PlaybackSpeed) > 0.004) v.sound.PlaybackSpeed = speed;
			v.speed = speed;
		}
	}

	/**
	 * Leaving a run: every world voice (SFX and the BGM stingers), every held loop and every track stops -- but not the
	 * interface. The click on "Home" or "Quit" is what makes a run stop, and it used to be cut in the same frame it
	 * started, depending only on which Activated handler ran first.
	 */
	stopWorld(): void {
		for (const v of this.voices) {
			if (!v.active || v.bus === "ui") continue;
			this.steal(v);
		}
		for (const l of this.loops) if (l.key !== undefined) this.freeLoop(l);
		for (const t of this.tracks) t.stop();
	}

	/** stops every voice and track, the interface's too (teardown) */
	stopAll(): void {
		for (const v of this.voices) {
			if (!v.active) continue;
			this.steal(v);
		}
		for (const l of this.loops) if (l.key !== undefined) this.freeLoop(l);
		for (const t of this.tracks) t.stop();
	}

	private randomPitch(def: SoundDef): number {
		if (def.pitchMax <= def.pitchMin) return def.pitchMin;
		return def.pitchMin + math.random() * (def.pitchMax - def.pitchMin);
	}

	/** a free voice, or the one we may steal (oldest copy of the same sound, then oldest of <= priority) */
	private claim(name: SoundName, def: SoundDef, spatial: boolean): Voice | undefined {
		let free: Voice | undefined;
		let sameCount = 0;
		let oldestSame: Voice | undefined;
		let oldestLow: Voice | undefined;
		for (const v of this.voices) {
			const fits = spatial ? v.attachment !== undefined : v.attachment === undefined;
			if (!fits) continue;
			if (!v.active) {
				if (free === undefined) free = v;
				continue;
			}
			if (v.name === name) {
				sameCount++;
				if (oldestSame === undefined || v.started < oldestSame.started) oldestSame = v;
			}
			if (v.priority <= def.priority && (oldestLow === undefined || v.started < oldestLow.started)) {
				oldestLow = v;
			}
		}
		if (sameCount >= def.voices && oldestSame !== undefined) return this.steal(oldestSame);
		if (free !== undefined) return free;
		if (oldestLow !== undefined) return this.steal(oldestLow);
		return undefined;
	}

	private steal(v: Voice): Voice {
		v.sound.Stop();
		v.active = false;
		v.name = undefined;
		return v;
	}

	private refreshGains(force: boolean): void {
		const source = this.settings;
		if (source === undefined) return;
		const s = source();
		if (!force && s.soundEffect === this.lastSfx && s.bgm === this.lastBgm) return;
		this.lastSfx = s.soundEffect;
		this.lastBgm = s.bgm;
		const sfx = math.pow(math.clamp(s.soundEffect, 0, 1), SLIDER_CURVE);
		const bgm = math.pow(math.clamp(s.bgm, 0, 1), SLIDER_CURVE);
		this.setGain("sfx", HEADROOM.sfx * sfx);
		this.setGain("ui", HEADROOM.ui * sfx);
		this.setGain("bgm", HEADROOM.bgm * bgm);
	}

	private setGain(bus: SoundBus, gain: number): void {
		this.gains.set(bus, gain);
		const group = this.groups.get(bus);
		if (group !== undefined) group.Volume = gain;
	}

	private update(dt: number): void {
		this.refreshGains(false);
		const now = os.clock();
		for (const v of this.voices) {
			if (!v.active) continue;
			if (now >= v.stopAt) {
				this.steal(v);
				continue;
			}
			if (now - v.started < MIN_VOICE_AGE) continue;
			if (!v.sound.IsPlaying) {
				v.active = false;
				v.name = undefined;
			}
		}
		this.updateLoops(dt);
		for (const t of this.tracks) t.update(dt, this.busGain(t.busOf()));
	}

	/** for tests / teardown */
	shutdown(): void {
		this.heartbeat?.Disconnect();
		this.heartbeat = undefined;
		this.stopAll();
	}
}

/** the client's single mixer */
export const audio = new AudioEngine();
