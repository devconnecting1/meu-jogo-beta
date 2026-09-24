/*
 * Run audio: what the world sounds like.
 *
 * Where the events come from
 *  - `refs.fx` is read once per frame (fxAudio.drainFxAudio) for everything the channel still carries when
 *    the frame reaches the view. Today `GameLoop.playFx` clears the channel inside `update()`, so most
 *    combat events never reach a reader outside the loop.
 *  - The sounds the SERVER decides -- a bite, a door, a usable, a horn (P0-4) -- come on that channel as "sound"
 *    events (client/audio/fxAudio.ts), from the wire or from this client's own world.
 *  - The rest is DERIVED from the very state those events describe, in the same before/after window
 *    main.client.ts already uses for achievements: a magazine that lost a round is a shot, a zombie whose
 *    hp fell is a hit, one that reached 0 is a death, a survivor whose hp fell was hurt. No system is
 *    touched, nothing is guessed: the numbers are the simulation's own.
 *  - The day this reads events instead, call `setFxAudioMode("full")` and the watcher below steps aside.
 *
 * Everything positional is played at its world position and spatialised by audio.ts against the camera.
 *
 * The horde's voice (P0-4): idle groans, the snarl of a zombie that just saw you, the shout of a group turning on you.
 * Varied (four groans, two snarls, never the same take twice in a row, the pitch bent by the zombie's type) and
 * METERED: every zombie vocal spends a token of one small budget (VOICE_TOKENS, one back every VOICE_REFILL s), the
 * groans come faster as more zombies are near but never faster than GROAN_MIN_GAP, and one zombie never groans twice
 * within GROAN_REPEAT. A horde of sixty is a crowd you hear -- three, four voices -- not sixty.
 *
 * The motorcycle's engine and the flamethrower's jet are held loops (audio.ts `holdLoop`): the engine of every rider
 * in earshot, yours and your allies', its pitch and level following the speed; the jet while a flamethrower fires.
 */
import { VehicleKind, vehicleDef } from "shared/data/buildings";
import { WeaponKind } from "shared/data/kinds";
import type { SoundName } from "shared/data/sounds";
import { currentWeapon } from "shared/game/player";
import { CLOCK_ANNOUNCEMENTS } from "shared/sim/clock";
import { rideSpeed } from "shared/sim/rideKey";
import { engineRuns } from "shared/sim/vehicle";
import type { GameRefs } from "../systems/types";
import { pickupCount } from "../systems/pickups";
import { netActive, remotePlayers } from "../net/netClient";
import { audio } from "./audio";
import { drainFxAudio, FLAMETHROWER_ID, fxAudioMode, remoteFlames, shotSound } from "./fxAudio";
import { GameMusic } from "./music";

/** at most this many shot voices from one frame (a machine gun must not eat the whole pool) */
const MAX_SHOTS_PER_FRAME = 2;
/** seconds between two "a zombie noticed you" snarls, however many noticed */
const ALERT_COOLDOWN = 1.2;
/** seconds between two melee swing sounds (the chainsaw holds its swing flag down) */
const SWING_COOLDOWN = 0.22;

// ---- the horde's voice
/** the budget every zombie vocal spends: at most this many close together... */
export const VOICE_TOKENS = 3;
/** ...and one more every this many seconds */
export const VOICE_REFILL = 0.75;
/** a zombie groans only when it is this close to the survivor (world units: a street and a half) */
export const VOICE_RANGE = 1100;
/** the groans' interval: GROAN_BASE / √(zombies in range), clamped, times a random 0.7..1.3 */
const GROAN_BASE = 7;
export const GROAN_MIN_GAP = 1.5;
const GROAN_MAX_GAP = 7;
/** one zombie does not groan again within this many seconds, nor snarl twice within AGGRO_REPEAT */
export const GROAN_REPEAT = 7;
const AGGRO_REPEAT = 6;
/** this many zombies turning on you in one frame is a group: one shout, not a snarl each */
const SHOUT_GROUP = 3;
/** candidates looked at for one groan (the nearest of them that may still speak) */
const GROAN_SAMPLES = 5;
const GROANS: ReadonlyArray<SoundName> = ["zombieGroanA", "zombieGroanB", "zombieGroanC", "zombieGroanD"];
const AGGROS: ReadonlyArray<SoundName> = ["zombieAggroA", "zombieAggroB"];
/**
 * The voice of each type (1 walker ... 5 jumper): the charger's shoulders and the exploder's belly lower, the spitter's
 * sac and the jumper's lean body higher. The big walker (5 % from day 3) a step below the walker.
 */
const TYPE_PITCH: Record<number, number> = { 1: 1, 2: 1.12, 3: 0.9, 4: 0.8, 5: 1.16 };
const BIG_PITCH = 0.85;

// ---- the motorcycle and the flamethrower
/** the engine's pitch at idle and at the top speed, and its level at idle (the loop is an idle recording) */
const ENGINE_IDLE_PITCH = 0.78;
const ENGINE_TOP_PITCH = 1.8;
const ENGINE_IDLE_LEVEL = 0.55;
/** how fast an ally's measured speed follows their interpolated positions (per second) */
const SPEED_EASE = 6;
/** a flamethrower's jet is held this long after its last flame (it fires 15 a second) */
const FLAME_HOLD = 0.22;
/** held-loop keys: the local survivor's engine and jet; an ally's engine by user id, a jet by slot */
const KEY_LOCAL_ENGINE = 1;
const KEY_LOCAL_FLAME = 2;
function engineKey(userId: number): number {
	return userId * 4 + 1;
}
function flameKey(slot: number): number {
	return (slot + 1) * 4 + 3;
}

interface ZombieSnap {
	hp: number;
	x: number;
	y: number;
	detect: boolean;
	/** seconds left of a group shout (shared/sim/ai/alert.ts); 0 when not shouting */
	shout: number;
}

/** an ally's speed, measured from the positions the snapshot buffer hands the view (the wire has no speed for it) */
interface Rider {
	x: number;
	y: number;
	speed: number;
	seen: number;
}

export class GameAudio {
	readonly music = new GameMusic();

	private zombies = new Map<number, ZombieSnap>();
	private bosses = new Map<number, number>();
	private prevHp = 0;
	private prevAmmo = 0;
	private prevPointer = -1;
	private prevReloading = false;
	private prevSwing = false;
	private prevDead = false;
	private prevBlasts = 0;
	/** pickups heard so far (client/systems/pickups.ts) */
	private prevPickups = 0;
	private alertCd = 0;
	private swingCd = 0;
	private growlCd = GROAN_MIN_GAP;
	private running = false;
	/** the horde's voice budget (tokens) and what each zombie last said (os.clock()) */
	private tokens = VOICE_TOKENS;
	private lastGroan = new Map<number, number>();
	private lastAggro = new Map<number, number>();
	private pruneAt = 0;
	private lastGroanName?: SoundName;
	private aggroFlip = false;
	/** the rising "it saw you" edges of this frame, and where */
	private risingX = new Array<number>();
	private risingY = new Array<number>();
	private risingId = new Array<number>();
	/** seconds left of the local survivor's flamethrower jet */
	private flameHeld = 0;
	private riders = new Map<number, Rider>();
	private lastFrame = -1;

	// ------------------------------------------------------------ run lifecycle

	/** a run is on screen: take the first snapshot so the first frame does not fire everything at once */
	startRun(refs: GameRefs): void {
		this.running = true;
		this.zombies.clear();
		this.bosses.clear();
		this.prevBlasts = refs.explosions?.size() ?? 0;
		this.prevPickups = pickupCount();
		this.alertCd = 0;
		this.swingCd = 0;
		this.growlCd = GROAN_MIN_GAP;
		this.tokens = VOICE_TOKENS;
		this.lastGroan.clear();
		this.lastAggro.clear();
		this.flameHeld = 0;
		this.riders.clear();
		this.lastFrame = -1;
		this.snapshot(refs);
	}

	/** back to the menus / game over: the run stops being heard */
	stopRun(): void {
		this.running = false;
		this.music.stop();
		audio.stopAll();
	}

	// ------------------------------------------------------------ per frame

	/** before GameLoop.update: remember what the simulation is about to change */
	beforeUpdate(refs: GameRefs): void {
		if (!this.running) return;
		this.snapshot(refs);
	}

	/** after GameLoop.update: everything that changed becomes a sound */
	afterUpdate(refs: GameRefs, dt: number): void {
		if (!this.running) return;
		this.alertCd = math.max(0, this.alertCd - dt);
		this.swingCd = math.max(0, this.swingCd - dt);
		this.tokens = math.min(VOICE_TOKENS, this.tokens + dt / VOICE_REFILL);
		this.flameHeld = math.max(0, this.flameHeld - dt);
		this.playerSounds(refs);
		this.weaponSounds(refs);
		this.zombieSounds(refs);
		this.bossSounds(refs);
		this.worldSounds(refs);
		this.ambientGrowl(refs, dt);
	}

	/**
	 * Every frame, simulated or not: keeps the listener on the camera, plays whatever is left in `refs.fx`,
	 * holds the engines and the jets, and drives the music. Call it right before GameLoop.render().
	 */
	frame(refs: GameRefs, camX: number, camY: number): void {
		audio.setListener(camX, camY);
		drainFxAudio(refs.fx);
		if (!this.running) return;
		const now = os.clock();
		const dt = this.lastFrame < 0 ? 0 : math.clamp(now - this.lastFrame, 0, 0.25);
		this.lastFrame = now;
		this.holdEngines(refs, dt, now);
		this.holdFlames(refs, now);
		const p = refs.player;
		const dn = refs.daynight;
		this.music.update({
			isNight: dn.isNight,
			dayTime: dn.dayTime,
			hpRatio: p.hpMax > 0 ? p.hp / p.hpMax : 0,
			dead: p.dead,
		});
	}

	// ------------------------------------------------------------ hooks main.client owns

	/** every HUD message of the run passes here (refs.onMessage): the clock announcements are stingers */
	onMessage(text: string): void {
		if (!this.running) return;
		for (let i = 0; i < CLOCK_ANNOUNCEMENTS.size(); i++) {
			const a = CLOCK_ANNOUNCEMENTS[i];
			if (a.text !== text) continue;
			if (a.morning) this.music.dawnStinger();
			else this.music.waveStinger(i + 1);
			return;
		}
	}

	/** the survivor pulled the trigger with nothing left */
	emptyMagazine(refs: GameRefs): void {
		if (!this.running) return;
		audio.play("emptyClick", { x: refs.player.x, y: refs.player.y });
	}

	/** a recipe was crafted (the backpack calls it); coins are covered by the toast hook in uiAudio */
	crafted(): void {
		audio.play("craftDone");
	}

	// ------------------------------------------------------------ internals

	private snapshot(refs: GameRefs): void {
		const p = refs.player;
		const rt = p.weapon;
		this.prevHp = p.hp;
		this.prevAmmo = rt.ammoCount;
		this.prevPointer = rt.pointer;
		this.prevReloading = rt.reloading;
		this.prevSwing = p.swingerActive;
		this.prevDead = p.dead;
		this.zombies.clear();
		for (const z of refs.zombies) {
			if (z.hp > 0) this.zombies.set(z.id, { hp: z.hp, x: z.x, y: z.y, detect: z.detect, shout: z.shout ?? 0 });
		}
		this.bosses.clear();
		for (const b of refs.bosses) {
			if (!b.dead) this.bosses.set(b.id, b.hp);
		}
	}

	private playerSounds(refs: GameRefs): void {
		const p = refs.player;
		if (p.dead && !this.prevDead) {
			audio.play("playerDeath");
			return;
		}
		if (!p.dead && p.hp < this.prevHp - 0.01) audio.play("playerHurt");
	}

	private weaponSounds(refs: GameRefs): void {
		const p = refs.player;
		const rt = p.weapon;
		if (rt.pointer !== this.prevPointer) {
			audio.play("weaponSwitch", { x: p.x, y: p.y });
			return;
		}
		if (rt.reloading && !this.prevReloading) {
			audio.play("reloadStart", { x: p.x, y: p.y });
		} else if (!rt.reloading && this.prevReloading && rt.ammoCount > this.prevAmmo) {
			audio.play("reloadEnd", { x: p.x, y: p.y });
		}
		const w = currentWeapon(p);
		if (w.kind === WeaponKind.Melee) {
			if (p.swingerActive && !this.prevSwing && this.swingCd <= 0) {
				this.swingCd = SWING_COOLDOWN;
				audio.play("meleeSwing", { x: p.x, y: p.y });
			}
			return;
		}
		if (rt.reloading || this.prevReloading || rt.ammoCount >= this.prevAmmo) return;
		// the flamethrower is a jet, held while it spits (holdFlames), not a shot per round: before P0-4 it played the
		// stun gun's ping fifteen times a second
		if (w.id === FLAMETHROWER_ID) {
			if (this.flameHeld <= 0 && !audio.loopActive(KEY_LOCAL_FLAME))
				audio.play("flameIgnite", { x: p.x, y: p.y });
			this.flameHeld = FLAME_HOLD;
			return;
		}
		if (fxAudioMode() === "full") return; // the tracer events carry the shots instead
		const shots = math.min(this.prevAmmo - rt.ammoCount, MAX_SHOTS_PER_FRAME);
		const name = shotSound(w.kind);
		for (let i = 0; i < shots; i++) audio.play(name, { x: p.x, y: p.y });
	}

	/** spends one token of the horde's voice budget, or answers false when the budget is spent */
	private spendVoice(): boolean {
		if (this.tokens < 1) return false;
		this.tokens -= 1;
		return true;
	}

	private zombieSounds(refs: GameRefs): void {
		const full = fxAudioMode() === "full";
		const now = os.clock();
		this.risingX.clear();
		this.risingY.clear();
		this.risingId.clear();
		for (const z of refs.zombies) {
			const was = this.zombies.get(z.id);
			if (was === undefined) continue;
			if (z.hp <= 0) {
				audio.play("zombieDeath", { x: z.x, y: z.y });
				continue;
			}
			// in "full" mode the blood events already carry every hit
			if (!full && z.hp < was.hp - 0.01) audio.play("hitFlesh", { x: z.x, y: z.y });
			// The scream itself: one zombie in a group shouts and wakes the others (shared/sim/ai/alert.ts).
			// That is the sound worth hearing -- it tells the player a GROUP is coming, and from where.
			const shout = z.shout ?? 0;
			if (shout > 0 && was.shout <= 0) {
				if (this.spendVoice()) {
					this.alertCd = ALERT_COOLDOWN;
					audio.play("zombieShout", { x: z.x, y: z.y, pitchScale: this.voiceOf(z.type, z.scale) });
				}
				continue;
			}
			if (z.detect && !was.detect) {
				this.risingX.push(z.x);
				this.risingY.push(z.y);
				this.risingId.push(z.id);
			}
		}
		const n = this.risingId.size();
		if (n === 0 || this.alertCd > 0) return;
		const p = refs.player;
		// the nearest of the zombies that just saw you speaks for the others
		let best = -1;
		let bestD = math.huge;
		for (let i = 0; i < n; i++) {
			const said = this.lastAggro.get(this.risingId[i]);
			if (said !== undefined && now - said < AGGRO_REPEAT) continue;
			const dx = this.risingX[i] - p.x;
			const dy = this.risingY[i] - p.y;
			const d = dx * dx + dy * dy;
			if (d < bestD) {
				bestD = d;
				best = i;
			}
		}
		if (best < 0 || !this.spendVoice()) return;
		this.alertCd = ALERT_COOLDOWN;
		this.lastAggro.set(this.risingId[best], now);
		const x = this.risingX[best];
		const y = this.risingY[best];
		if (n >= SHOUT_GROUP) {
			// a group turning at once (the wave, a street that saw you): ONE shout says "they are coming"
			audio.play("zombieShout", { x, y });
			return;
		}
		this.aggroFlip = !this.aggroFlip;
		audio.play(this.aggroFlip ? AGGROS[0] : AGGROS[1], { x, y, scale: n > 1 ? 1 : 0.85 });
	}

	private bossSounds(refs: GameRefs): void {
		const full = fxAudioMode() === "full";
		for (const b of refs.bosses) {
			const was = this.bosses.get(b.id);
			if (was === undefined) {
				// a boss that was not in the snapshot just entered the fight
				if (!b.dead) audio.play("bossRoar", { x: b.x, y: b.y });
				continue;
			}
			if (b.dead) {
				audio.play("bossRoar", { x: b.x, y: b.y, scale: 0.8 });
				continue;
			}
			if (!full && b.hp < was - 0.01) audio.play("hitFlesh", { x: b.x, y: b.y, scale: 0.7 });
		}
	}

	private worldSounds(refs: GameRefs): void {
		const blasts = refs.explosions;
		const count = blasts?.size() ?? 0;
		if (blasts !== undefined && count > this.prevBlasts) {
			const e = blasts[count - 1];
			audio.play("explosion", { x: e.x, y: e.y });
		}
		this.prevBlasts = count;

		// a pickup, and only a pickup: not a craft's bonus, a construction handed back or a prediction undone -- the
		// backpack growing was all of those (client/systems/pickups.ts)
		const pickups = pickupCount();
		if (pickups > this.prevPickups) audio.play("pickupItem");
		this.prevPickups = pickups;
	}

	/** a zombie type's voice (and the big walker's), as a pitch multiplier */
	private voiceOf(kind: number, scale: number | undefined): number {
		const k = TYPE_PITCH[kind] ?? 1;
		return scale !== undefined && scale > 1.05 ? k * BIG_PITCH : k;
	}

	/**
	 * The horde has to be heard before it is seen: every so often ONE zombie near the survivor groans -- more often the
	 * more of them there are (√n: ten zombies groan three times as often as one, not ten times), never twice the same
	 * zombie in GROAN_REPEAT, never the same take twice in a row, and only while the budget has a token for it.
	 */
	private ambientGrowl(refs: GameRefs, dt: number): void {
		this.growlCd -= dt;
		if (this.growlCd > 0) return;
		const p = refs.player;
		const now = os.clock();
		if (now >= this.pruneAt) this.prune(now);
		let near = 0;
		for (const z of refs.zombies) {
			if (z.hp <= 0) continue;
			const dx = z.x - p.x;
			const dy = z.y - p.y;
			if (dx * dx + dy * dy <= VOICE_RANGE * VOICE_RANGE) near++;
		}
		const gap = math.clamp(GROAN_BASE / math.sqrt(math.max(near, 1)), GROAN_MIN_GAP, GROAN_MAX_GAP);
		this.growlCd = gap * (0.7 + math.random() * 0.6);
		if (p.dead || near === 0) return;
		// a few random zombies in range; the nearest one that may still speak groans
		let pick = -1;
		let pickD = math.huge;
		const list = refs.zombies;
		for (let s = 0; s < GROAN_SAMPLES; s++) {
			const i = math.random(0, list.size() - 1);
			const z = list[i];
			if (z.hp <= 0) continue;
			const dx = z.x - p.x;
			const dy = z.y - p.y;
			const d = dx * dx + dy * dy;
			if (d > VOICE_RANGE * VOICE_RANGE || d >= pickD) continue;
			const said = this.lastGroan.get(z.id);
			if (said !== undefined && now - said < GROAN_REPEAT) continue;
			pick = i;
			pickD = d;
		}
		if (pick < 0 || !this.spendVoice()) return;
		const z = list[pick];
		this.lastGroan.set(z.id, now);
		let name = GROANS[math.random(0, GROANS.size() - 1)];
		if (name === this.lastGroanName) name = GROANS[(GROANS.indexOf(name) + 1) % GROANS.size()];
		this.lastGroanName = name;
		audio.play(name, { x: z.x, y: z.y, pitchScale: this.voiceOf(z.type, z.scale) });
	}

	/** forgets what zombies long gone said (the maps would otherwise grow with every zombie of the night) */
	private prune(now: number): void {
		this.pruneAt = now + 5;
		for (const [id, t] of this.lastGroan) if (now - t > GROAN_REPEAT) this.lastGroan.delete(id);
		for (const [id, t] of this.lastAggro) if (now - t > AGGRO_REPEAT) this.lastAggro.delete(id);
		for (const [id, r] of this.riders) if (now - r.seen > 2) this.riders.delete(id);
	}

	/** the engine of every motorcycle in earshot: yours from the ride the server confirmed, an ally's from the wire */
	private holdEngines(refs: GameRefs, dt: number, now: number): void {
		const moto = vehicleDef(VehicleKind.Motorcycle);
		if (moto === undefined) return;
		const top = math.max(1, moto.topSpeed);
		const p = refs.player;
		const ride = p.ride;
		if (!p.dead && ride !== undefined && ride.kind === VehicleKind.Motorcycle && engineRuns(moto, refs.save)) {
			this.holdEngine(KEY_LOCAL_ENGINE, p.x, p.y, rideSpeed(ride) / top);
		}
		if (!netActive()) return;
		for (const rp of remotePlayers()) {
			if (rp.ride !== VehicleKind.Motorcycle || rp.dead) continue;
			let r = this.riders.get(rp.userId);
			if (r === undefined) {
				r = { x: rp.x, y: rp.y, speed: 0, seen: now };
				this.riders.set(rp.userId, r);
			}
			if (dt > 0) {
				const v = math.sqrt((rp.x - r.x) * (rp.x - r.x) + (rp.y - r.y) * (rp.y - r.y)) / dt;
				r.speed += (math.min(v, top) - r.speed) * math.min(1, dt * SPEED_EASE);
			}
			r.x = rp.x;
			r.y = rp.y;
			r.seen = now;
			this.holdEngine(engineKey(rp.userId), rp.x, rp.y, r.speed / top);
		}
	}

	private holdEngine(key: number, x: number, y: number, k: number): void {
		const s = math.clamp(k, 0, 1);
		const pitch = ENGINE_IDLE_PITCH + (ENGINE_TOP_PITCH - ENGINE_IDLE_PITCH) * s;
		audio.holdLoop(key, "engineMoto", x, y, ENGINE_IDLE_LEVEL + (1 - ENGINE_IDLE_LEVEL) * s, pitch);
	}

	/** the flamethrower's jet: yours while it spits, an ally's while their flames keep coming (fxAudio remoteFlames) */
	private holdFlames(refs: GameRefs, now: number): void {
		const p = refs.player;
		if (this.flameHeld > 0 && !p.dead) audio.holdLoop(KEY_LOCAL_FLAME, "flameLoop", p.x, p.y, 1, 0.55);
		for (const [slot, f] of remoteFlames()) {
			if (now - f.at > FLAME_HOLD) continue;
			const key = flameKey(slot);
			if (!audio.loopActive(key)) audio.play("flameIgnite", { x: f.x, y: f.y });
			audio.holdLoop(key, "flameLoop", f.x, f.y, 1, 0.55);
		}
	}
}

/** the client's single run-audio watcher */
export const gameAudio = new GameAudio();
