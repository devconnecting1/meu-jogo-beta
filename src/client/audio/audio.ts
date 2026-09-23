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
 *    like a machine gun of identical samples.
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
import { SoundBus, SoundDef, SoundName, soundAssetIds, soundDef } from "shared/data/sounds";
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

/** how loud each bus can get with its slider at 100% */
const HEADROOM: Record<SoundBus, number> = { sfx: 1, ui: 0.8, bgm: 0.7 };
/** perceptual taper of the sliders */
const SLIDER_CURVE = 1.5;

/** voices that can be placed in the world */
const SPATIAL_VOICES = 20;
/** voices for UI and for world sounds without a position */
const FLAT_VOICES = 10;
/** a voice younger than this is never recycled, even if the engine says it is not playing yet */
const MIN_VOICE_AGE = 0.05;

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
}

export interface PlayOptions {
	/** world position of the event; without it the sound is flat (2D, centred) */
	x?: number;
	y?: number;
	/** extra multiplier on the entry's base volume (0..1) */
	scale?: number;
	/** overrides the entry's random pitch range */
	pitch?: number;
}

// ---------------------------------------------------------------- long-running tracks (music, ambience)

interface TrackSlot {
	sound: Sound;
	def?: SoundDef;
	/** current 0..1 fade level */
	gain: number;
	target: number;
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
			this.slots.push({ sound: s, gain: 0, target: 0 });
		}
	}

	/** current clip, or undefined when the track is fading out / stopped */
	playing(): SoundName | undefined {
		return this.name;
	}

	/** switch to `name` (no-op when it is already the current clip); undefined stops the track */
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
		this.cur = this.cur === 0 ? 1 : 0;
		const slot = this.slots[this.cur];
		slot.def = def;
		slot.target = 1;
		if (slot.sound.SoundId !== def.id) slot.sound.SoundId = def.id;
		slot.sound.Looped = def.loop === true;
		slot.sound.PlaybackSpeed = def.pitchMin;
		slot.sound.Volume = 0;
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
				slot.sound.Volume = 0;
				continue;
			}
			slot.sound.Volume = def.volume * wanted * this.level;
			if (!slot.sound.IsPlaying) slot.sound.Play();
		}
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
	private tracks: Array<AudioTrack> = [];
	private settings?: () => SettingsData;
	private lastSfx = -1;
	private lastBgm = -1;
	private listenerX = 0;
	private listenerY = 0;
	private heartbeat?: RBXScriptConnection;

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

		this.heartbeat = RunService.Heartbeat.Connect(dt => this.update(dt));
		this.preload();
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
		return { sound, attachment, started: 0, priority: 0, stopAt: math.huge, active: false };
	}

	/** warms the asset cache so the first shot of a run is not silent */
	private preload(): void {
		const parent = this.flatRoot;
		if (parent === undefined) return;
		task.spawn(() => {
			const holder = new Instance("Folder");
			holder.Name = "Preload";
			holder.Parent = parent;
			const list: Array<Instance> = [];
			for (const id of soundAssetIds()) {
				const s = new Instance("Sound");
				s.SoundId = id;
				s.Volume = 0;
				s.Parent = holder;
				list.push(s);
			}
			if (list.size() > 0) pcall(() => ContentProvider.PreloadAsync(list));
			holder.Destroy();
		});
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
		pcall(() =>
			SoundService.SetListener(
				Enum.ListenerType.CFrame,
				new CFrame(new Vector3(x * STUDS_PER_UNIT, 0, y * STUDS_PER_UNIT)),
			),
		);
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

	/** plays `name` once; does nothing when the slot is empty, muted or out of range */
	play(name: SoundName, opts?: PlayOptions): void {
		if (!this.started) return;
		const def = soundDef(name);
		if (def === undefined || def.id === "") return;
		// the sliders are read here too, not only on the next frame: the Settings preview of a slider moved up from 0
		// plays in the same instant the slider moved, and a gain still at 0 would drop exactly that one (two compares)
		this.refreshGains(false);
		if (this.busGain(def.bus) <= 0) return;

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

		const sound = voice.sound;
		if (sound.SoundId !== def.id) sound.SoundId = def.id;
		sound.SoundGroup = this.groups.get(def.bus);
		sound.Looped = false;
		sound.Volume = def.volume * math.clamp(opts?.scale ?? 1, 0, 1) * flatScale;
		sound.PlaybackSpeed = opts?.pitch ?? this.randomPitch(def);

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
		voice.name = name;
		voice.priority = def.priority;
		voice.started = os.clock();
		voice.stopAt = def.maxPlay !== undefined ? voice.started + def.maxPlay : math.huge;
		voice.active = true;
		sound.TimePosition = def.startAt ?? 0;
		sound.Play();
	}

	/** stops every voice and track (leaving a run, or the player muted everything) */
	stopAll(): void {
		for (const v of this.voices) {
			if (!v.active) continue;
			v.sound.Stop();
			v.active = false;
			v.name = undefined;
		}
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
