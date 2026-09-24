/*
 * Prediction and reconciliation of the local survivor (docs/MULTIPLAYER.md §2.2 "Reconciliação no cliente", §5.2).
 *
 *   every command   stepPlayer(world, state, save, cmd, 1/60)            — the very code the server runs
 *   every snapshot  rewind to the authoritative state at `ackSeq`, then replay the unacked commands
 *   every frame     the leftover error is bled off visually (τ = 100 ms), never teleported under 64 u
 *
 * Two positions exist at all times and the difference matters:
 *   `exact`  what the simulation says (what the next command steps from, and what is compared with the ack)
 *   drawn    exact + the visual offset + the render lead — this is what lands in `refs.player.x/y`
 * The caller (netClient) restores `exact` into the survivor before stepping and writes the drawn position
 * back after; nothing outside this file has to know the difference.
 *
 * The body (hp, hunger, the wait before healing of DESIGN_RULES VIT-01) is the server's at the ack and predicted from
 * there, like the position: every snapshot restarts it from the self block and steps it through the unacked commands
 * with the server's own `stepVitals`. The wait is derived, never sent: from the Hit flag, the poison flag, an empty
 * stomach, and hp below the prediction (`applyVitals`).
 *
 * Pure: no Roblox service and no Instance, so tools/test-predict.mjs runs it against a simulated server.
 */
import { hasBits } from "shared/net/codec";
import { MP_PHASE, RECONCILE_EPS, TICK_DT, VISUAL_OFFSET_TAU_S, VISUAL_SNAP_DIST } from "shared/net/mpConfig";
import { InputCommand, ModFlag, SelfFlag, SelfSnap } from "shared/net/protocol";
import { moveActor, PLAYER_RADIUS } from "shared/game/physics";
import { PlayerState, recalcMoveSpeed } from "shared/game/player";
import { PlayerSaveData } from "shared/game/save";
import { WorldData } from "shared/game/world";
import { stepPlayer } from "shared/sim/playerMove";
import { moveDirX, moveDirY, SPEED_SCALE } from "shared/sim/types";
import { packRide, rideLead, unpackRide } from "shared/sim/vehicle";
import { REGEN_RESTED_S, stepVitals } from "shared/sim/vitals";

/**
 * A correction this big is worth counting: §11.3 F1 accepts fewer than one per minute outside knockback,
 * and §12.2 measures it.
 */
export const CORRECTION_DIST = 16;
/** divergence samples kept for the p50/p99 (30 s of snapshots at 20 Hz) */
const DIVERGENCE_SAMPLES = 600;
/** window of the "corrections per minute" counter, in seconds */
const CORRECTION_WINDOW_S = 60;
/** below this the visual offset is simply dropped (it is under half a pixel at any zoom) */
const OFFSET_EPS = 0.01;
/**
 * From F2 the server owns hp, hunger, buffs and the weapon machine, so the self block replaces them. In F1
 * the zombies and the combat are still local to each client (§11.3 F1), so the server's vitals are blind to
 * the damage this client just took: only the POSITION is authoritative, and the local vitals are kept
 * across the rewind.
 */
const ADOPT_VITALS = MP_PHASE >= 2;

export interface PredictionStats {
	/** |predicted(ackSeq) − server| of the last snapshot, world units */
	last: number;
	/** median and 99th percentile of that error (§12.2 target: p99 < 1 u) */
	p50: number;
	p99: number;
	samples: number;
	/** corrections above CORRECTION_DIST in the last minute (§11.3 F1 target: < 1/min) */
	correctionsPerMinute: number;
	/** corrections above CORRECTION_DIST since the session started */
	corrections: number;
	/** visual offsets dropped because they were above VISUAL_SNAP_DIST (teleport, admin, big knockback) */
	snaps: number;
	/** how many snapshots triggered a rewind + replay */
	replays: number;
	/** commands replayed by the last reconciliation */
	lastReplayed: number;
	/** current visual offset length, world units */
	offset: number;
}

interface Sampled {
	seq: number;
	x: number;
	y: number;
	/** (VEI-05) the ride after this command, as `packRide` (0 on foot): compared with the self block's at the ack */
	ride: number;
	/**
	 * (VIT-01) the body after this command as predicted: the reconcile compares the server's hp at the ack with `hp` to
	 * see a hit the client could not predict, and restarts the replay of the vitals from `hungry` and `sinceHurt`
	 */
	hp: number;
	hungry: number;
	sinceHurt: number;
}

/**
 * VIT-01: hp the server's body has at the ack BELOW what this client predicted for the same command, past which the
 * difference is HP it lost to something the prediction could not see (a blast or a crash inside the i-frames, rotten
 * meat) -- a hit that starts the i-frames says so itself, in the self block's Hit flag. Below it is noise, never a
 * wait to restart: hp travels in 1/100 (±0,005), and a command the server skipped (it came too late) leaves the
 * server one step of healing behind the prediction -- 0,025 hp, 0,1 with Recovery 3, a few of them at worst between
 * two acks. A false "hurt" would cost the bar the healing drawn ahead of the ack, taken back on screen.
 */
export const HURT_EPS = 0.5;
/**
 * VIT-01: how much later than the ack the client's derived wait starts. Command by command the server is not a clock:
 * a tick it fills runs the body one step AHEAD of the seq, a command it skips (it came too late) one step behind, so
 * over a 7 s wait the two may part by a few ticks either way. Starting a quarter of a second late keeps the healing
 * the client draws from ever starting before the server's; it costs nothing visible (the ramp heals 0,02 hp in it).
 */
export const WAIT_MARGIN_S = 0.25;
/** half the step the self block carries hp in (u16 of 1/100) */
const HP_WIRE_HALF = 0.005;

/**
 * The self block's hunger is a rounded u8. The predicted value at the ack is moved as little as that allows: by a
 * whole number when the two are a whole item apart (something was eaten: the fraction the prediction carries is still
 * right), then into the rounding's interval. At the ack the prediction therefore always rounds as the server does --
 * which is what VIT-01's food gate tests (`fedEnough`) -- and each time the server's value crosses a half the
 * prediction is pulled onto it, so the fraction converges instead of drifting. (It used to be adopted only past 1.)
 */
export function hungerAtAck(predicted: number, wire: number, max: number): number {
	let h = predicted;
	const d = wire - h;
	if (math.abs(d) >= 1) h += math.round(d);
	return math.clamp(math.clamp(h, wire - 0.5, wire + 0.499), 0, max);
}

/** scratch for the render lead of a rider (no allocation per frame) */
const LEAD = { x: 0, y: 0 };

/** the survivor fields the F1 rewind must not lose (the server does not own them until F2) */
interface Vitals {
	hp: number;
	hungry: number;
	sinceHurt: number | undefined;
	dead: boolean;
	attacked: boolean;
	iframe: number;
	speed: number;
	calm: number;
	pain: number;
	poison: number;
	puddleSlow: number;
	hitFlash: number;
}

export class Prediction {
	private world?: WorldData;
	private player?: PlayerState;
	private save?: PlayerSaveData;
	private exactX = 0;
	private exactY = 0;
	private offX = 0;
	private offY = 0;
	private leadX = 0;
	private leadY = 0;
	/** predicted position per command seq, oldest first (pruned with the ack) */
	private readonly history = new Array<Sampled>();
	private readonly divergence = new Array<number>();
	private divergenceAt = 0;
	private readonly correctionAt = new Array<number>();
	private lastErr = 0;
	private corrections = 0;
	private snaps = 0;
	private replays = 0;
	private lastReplayed = 0;
	/**
	 * VIT-01: the last self block said the body is poisoned or its stomach empty -- hp it is losing every step: the
	 * wait is held until one says it is not
	 */
	private holding = false;

	/** bind to the world and survivor the game loop owns; call again after a respawn or a world rebuild */
	attach(world: WorldData, player: PlayerState, save: PlayerSaveData): void {
		this.world = world;
		this.player = player;
		this.save = save;
		this.exactX = player.x;
		this.exactY = player.y;
		this.offX = 0;
		this.offY = 0;
		this.leadX = 0;
		this.leadY = 0;
		this.holding = false;
		this.history.clear();
	}

	detach(): void {
		this.world = undefined;
		this.player = undefined;
		this.save = undefined;
		this.history.clear();
	}

	attached(): boolean {
		return this.player !== undefined;
	}

	/** the simulated position (no visual offset, no render lead) */
	exact(): { x: number; y: number } {
		return { x: this.exactX, y: this.exactY };
	}

	/** puts the exact position back on the survivor: the caller does this before stepping commands */
	restoreExact(): void {
		const p = this.player;
		if (p === undefined) return;
		p.x = this.exactX;
		p.y = this.exactY;
	}

	/** one command, at the fixed 1/60 s step both sides use */
	step(cmd: InputCommand): void {
		const world = this.world;
		const p = this.player;
		const save = this.save;
		if (world === undefined || p === undefined || save === undefined) return;
		p.x = this.exactX;
		p.y = this.exactY;
		stepPlayer(world, p, save, cmd, TICK_DT);
		this.holdWait(p);
		this.exactX = p.x;
		this.exactY = p.y;
		this.history.push(sampleOf(cmd.seq, p));
		while (this.history.size() > 256) this.history.remove(0);
	}

	/**
	 * A snapshot's self block. `unacked` is the command queue AFTER CommandStream.ack(snap.ackSeq), i.e. the
	 * commands the server has not simulated yet — exactly what the replay has to redo.
	 */
	reconcile(snap: SelfSnap, unacked: ReadonlyArray<InputCommand>, now: number): void {
		const world = this.world;
		const p = this.player;
		const save = this.save;
		if (world === undefined || p === undefined || save === undefined) return;

		// what is on screen right now, so the correction can be hidden behind the visual offset
		const drawnX = this.exactX + this.offX;
		const drawnY = this.exactY + this.offY;

		const mine = this.takeHistory(snap.ackSeq);
		let err = 0;
		if (mine !== undefined) {
			const dx = snap.x - mine.x;
			const dy = snap.y - mine.y;
			err = math.sqrt(dx * dx + dy * dy);
			this.lastErr = err;
			this.pushDivergence(err);
			if (err > CORRECTION_DIST) {
				this.corrections += 1;
				this.correctionAt.push(now);
			}
		}

		this.applyModFlags(snap);
		if (ADOPT_VITALS) this.applyVitals(snap, p, mine, unacked.size());

		// the position is always the server's; nothing else in the protocol can put the client back in place.
		// VEI-05: so is the ride -- getting on or off, a crash, a zombie that stopped the vehicle are the server's, and
		// a ride that differs at the ack is a divergence even where the position still agrees
		const serverRide = snap.ride ?? 0;
		const needsReplay = mine === undefined || err > RECONCILE_EPS || mine.ride !== serverRide;
		if (needsReplay) {
			const kept = ADOPT_VITALS ? undefined : captureVitals(p);
			p.x = snap.x;
			p.y = snap.y;
			p.reactionSpeed = snap.reactionSpeed;
			p.reactionDir = snap.reactionDir;
			p.ride = unpackRide(serverRide);
			this.history.clear();
			let replayed = 0;
			for (const cmd of unacked) {
				stepPlayer(world, p, save, cmd, TICK_DT);
				this.holdWait(p);
				this.history.push(sampleOf(cmd.seq, p));
				replayed += 1;
			}
			this.lastReplayed = replayed;
			this.replays += 1;
			if (kept !== undefined) restoreVitals(p, kept);
			this.exactX = p.x;
			this.exactY = p.y;
		} else {
			p.reactionSpeed = snap.reactionSpeed;
			p.reactionDir = snap.reactionDir;
			this.lastReplayed = 0;
			// the position needed nothing, but the body starts again from the server's at the ack: its vitals are
			// stepped through what is still unacked, or the HP bar would sit one round trip behind and jump back to
			// the ack at every snapshot (VIT-01: the bar a client draws is the server's, never pulled back)
			if (ADOPT_VITALS) this.replayVitals(p, save, unacked);
		}

		// hide whatever moved: the screen keeps the old position and eases to the new one over ~τ
		this.offX = drawnX - this.exactX;
		this.offY = drawnY - this.exactY;
		if (this.offX * this.offX + this.offY * this.offY > VISUAL_SNAP_DIST * VISUAL_SNAP_DIST) {
			this.offX = 0;
			this.offY = 0;
			this.snaps += 1;
		}
		this.trimCorrections(now);
	}

	/**
	 * One render frame: bleeds the visual offset off with τ = VISUAL_OFFSET_TAU_S, adds the render lead (up
	 * to one prediction tick of the live input, so a key press moves the survivor in the same frame, §5.2)
	 * and writes the drawn position onto the survivor the view reads.
	 */
	present(dt: number, phase: number, live?: InputCommand): void {
		const p = this.player;
		if (p === undefined) return;
		const decay = math.exp(-math.max(0, dt) / VISUAL_OFFSET_TAU_S);
		this.offX *= decay;
		this.offY *= decay;
		if (math.abs(this.offX) < OFFSET_EPS) this.offX = 0;
		if (math.abs(this.offY) < OFFSET_EPS) this.offY = 0;
		this.computeLead(phase, live);
		p.x = this.exactX + this.offX + this.leadX;
		p.y = this.exactY + this.offY + this.leadY;
	}

	/** render-only extrapolation: at most one prediction tick ahead, collided, never rewound (§5.2) */
	private computeLead(phase: number, live?: InputCommand): void {
		this.leadX = 0;
		this.leadY = 0;
		const world = this.world;
		const p = this.player;
		const save = this.save;
		if (world === undefined || p === undefined || save === undefined) return;
		// a dead body does not move (shared/sim/playerMove.ts), so it has nothing to lead with either
		if (live === undefined || p.dead) return;
		const t = math.clamp(phase, 0, 1) * TICK_DT;
		if (t <= 0) return;
		if (p.ride !== undefined) {
			// VEI-05: a vehicle rolls on without the stick; its lead is its own speed along its heading
			rideLead(world, this.exactX, this.exactY, p.ride, p.noclip === true, t, LEAD);
			this.leadX = LEAD.x;
			this.leadY = LEAD.y;
			return;
		}
		if (live.moveMag <= 0) return;
		const speed = recalcMoveSpeed(p, save) * SPEED_SCALE;
		const dx = moveDirX(live.moveAng) * speed * t;
		const dy = moveDirY(live.moveAng) * speed * t;
		const res =
			p.noclip === true
				? { x: this.exactX + dx, y: this.exactY + dy }
				: moveActor(world, this.exactX, this.exactY, PLAYER_RADIUS, dx, dy);
		this.leadX = res.x - this.exactX;
		this.leadY = res.y - this.exactY;
	}

	/** §10: noclip and god travel in the self block's modFlags, so the prediction uses the same rules */
	private applyModFlags(snap: SelfSnap): void {
		const p = this.player;
		if (p === undefined) return;
		const noclip = hasBits(snap.modFlags, ModFlag.Noclip);
		const god = hasBits(snap.modFlags, ModFlag.God);
		if (noclip || ADOPT_VITALS) p.noclip = noclip;
		if (god || ADOPT_VITALS) p.godMode = god;
	}

	/**
	 * From F2 the self block is the truth for hp, hunger, buffs and i-frames.
	 *
	 * NOT for being alive: `Snap` is unreliable, and a death that is lost in flight would leave the survivor
	 * playing on. The life state travels on the reliable `World` channel as `PlayerLife` (§4.5, §7.3), and
	 * netClient is the one that writes `dead` onto the survivor. SelfFlag.Dead stays on the wire as the
	 * continuous hint the HUD may tint with, never as the thing that decides.
	 */
	private applyVitals(snap: SelfSnap, p: PlayerState, mine: Sampled | undefined, pending: number): void {
		// VIT-01, the wait before healing. It is not on the wire: the server restarts its own on every HP the body
		// loses, and this derives the same from what the self block does carry. Whatever hurt the body did so at the
		// ack or before it, so the wait restarts WAIT_MARGIN_S after the ack -- never before the server's -- and the
		// healing this client draws never starts early, nor has to be taken back.
		// The prediction's own wait for that command, or (none: a fresh attach, a long outage) the current one wound
		// back by what is unacked:
		let since =
			mine !== undefined
				? mine.sinceHurt
				: math.max(-WAIT_MARGIN_S, (p.sinceHurt ?? REGEN_RESTED_S) - pending * TICK_DT);
		// a hit landed less than the i-frames ago (the Hit flag), or hp went missing that nothing predicted
		const hurt = hasBits(snap.flags, SelfFlag.Hit) || (mine !== undefined && snap.hp < mine.hp - HURT_EPS);
		// poison and an empty stomach: only a flag and a rounded 0 travel, so when they end on the server is unknown
		// until a snapshot says so. Until then every step is held as hurt for the wait (`holdWait`)
		this.holding = hasBits(snap.flags, SelfFlag.Poison) || snap.hunger <= 0;
		if (hurt || this.holding) since = -WAIT_MARGIN_S;
		p.sinceHurt = since;
		// hp travels rounded to 1/100: the prediction at the ack is kept where it rounds as the server's does (no
		// jitter of half a hundredth), and moved to the server's wherever it does not
		const wire = snap.hp;
		const at = mine !== undefined ? math.clamp(mine.hp, wire - HP_WIRE_HALF, wire + HP_WIRE_HALF) : wire;
		p.hp = math.min(at, p.hpMax);
		// hunger is a rounded u8 on the wire: the prediction at the ack, moved no further than that rounding allows
		p.hungry = hungerAtAck(mine !== undefined ? mine.hungry : p.hungry, snap.hunger, p.hungryMax);
		p.iframe = snap.iframe;
		p.attacked = hasBits(snap.flags, SelfFlag.Hit);
		// only the flags travel, not the timers: keep a running buff, start or stop one when the flag moved
		p.buffs.speed = flagTimer(p.buffs.speed, hasBits(snap.flags, SelfFlag.Speed));
		p.buffs.calm = flagTimer(p.buffs.calm, hasBits(snap.flags, SelfFlag.Calm));
		p.buffs.pain = flagTimer(p.buffs.pain, hasBits(snap.flags, SelfFlag.Pain));
		p.buffs.poison = flagTimer(p.buffs.poison, hasBits(snap.flags, SelfFlag.Poison));
		p.puddleSlow = flagTimer(p.puddleSlow ?? 0, hasBits(snap.flags, SelfFlag.Acid));
	}

	/**
	 * The body (hp, hunger, the wait, poison) stepped from the server's at the ack through the commands still unacked,
	 * with the same `stepVitals` the server runs; the history of those commands is rewritten with it, so the next
	 * snapshot is compared with what this client predicts NOW. A dead body is inert (stepPlayer).
	 */
	private replayVitals(p: PlayerState, save: PlayerSaveData, unacked: ReadonlyArray<InputCommand>): void {
		if (p.dead) return;
		const list = this.history;
		let at = 0;
		for (const cmd of unacked) {
			stepVitals(p, save, TICK_DT);
			this.holdWait(p);
			// the history holds these very commands, oldest first (takeHistory dropped the rest): find each by its seq
			while (at < list.size() && list[at].seq !== cmd.seq) at += 1;
			if (at >= list.size()) continue;
			const h = list[at];
			h.hp = p.hp;
			h.hungry = p.hungry;
			h.sinceHurt = p.sinceHurt ?? REGEN_RESTED_S;
		}
	}

	/** VIT-01: poisoned or starving at the last snapshot = still, for the wait (see `applyVitals`) */
	private holdWait(p: PlayerState): void {
		if (this.holding && !p.dead && p.godMode !== true) p.sinceHurt = -WAIT_MARGIN_S;
	}

	/** the predicted state for `seq`, dropping everything older (the server will never ask for it again) */
	private takeHistory(seq: number): Sampled | undefined {
		const list = this.history;
		let found: Sampled | undefined;
		while (list.size() > 0) {
			const head = list[0];
			const d = (((seq - head.seq) % 65536) + 65536) % 65536;
			if (d >= 32768) break; // head is newer than the ack: keep it
			list.remove(0);
			if (d === 0) {
				found = head;
				break;
			}
		}
		return found;
	}

	private pushDivergence(err: number): void {
		const list = this.divergence;
		if (list.size() < DIVERGENCE_SAMPLES) {
			list.push(err);
		} else {
			list[this.divergenceAt] = err;
			this.divergenceAt = (this.divergenceAt + 1) % DIVERGENCE_SAMPLES;
		}
	}

	private trimCorrections(now: number): void {
		const list = this.correctionAt;
		while (list.size() > 0 && now - list[0] > CORRECTION_WINDOW_S) list.remove(0);
	}

	/** p50 / p99 of the divergence ring; sorts a copy, so only call it for the debug overlay */
	stats(now = 0): PredictionStats {
		const list = this.divergence;
		const n = list.size();
		let p50 = 0;
		let p99 = 0;
		if (n > 0) {
			const copy = new Array<number>();
			for (const v of list) copy.push(v);
			copy.sort((a, b) => a < b);
			p50 = copy[math.min(n - 1, math.floor(n * 0.5))];
			p99 = copy[math.min(n - 1, math.floor(n * 0.99))];
		}
		let recent = 0;
		for (const t of this.correctionAt) {
			if (now === 0 || now - t <= CORRECTION_WINDOW_S) recent += 1;
		}
		return {
			last: this.lastErr,
			p50,
			p99,
			samples: n,
			correctionsPerMinute: recent,
			corrections: this.corrections,
			snaps: this.snaps,
			replays: this.replays,
			lastReplayed: this.lastReplayed,
			offset: math.sqrt(this.offX * this.offX + this.offY * this.offY),
		};
	}
}

/** what the history keeps of the survivor after command `seq` */
function sampleOf(seq: number, p: PlayerState): Sampled {
	return {
		seq,
		x: p.x,
		y: p.y,
		ride: packRide(p.ride),
		hp: p.hp,
		hungry: p.hungry,
		sinceHurt: p.sinceHurt ?? REGEN_RESTED_S,
	};
}

/** a buff whose flag is set keeps running (or starts); one whose flag is clear is over */
function flagTimer(current: number, on: boolean): number {
	if (!on) return 0;
	return current > 0 ? current : TICK_DT;
}

function captureVitals(p: PlayerState): Vitals {
	return {
		hp: p.hp,
		hungry: p.hungry,
		sinceHurt: p.sinceHurt,
		dead: p.dead,
		attacked: p.attacked,
		iframe: p.iframe,
		speed: p.buffs.speed,
		calm: p.buffs.calm,
		pain: p.buffs.pain,
		poison: p.buffs.poison,
		puddleSlow: p.puddleSlow ?? 0,
		hitFlash: p.hitFlash ?? 0,
	};
}

function restoreVitals(p: PlayerState, v: Vitals): void {
	p.hp = v.hp;
	p.hungry = v.hungry;
	p.sinceHurt = v.sinceHurt;
	p.dead = v.dead;
	p.attacked = v.attacked;
	p.iframe = v.iframe;
	p.buffs.speed = v.speed;
	p.buffs.calm = v.calm;
	p.buffs.pain = v.pain;
	p.buffs.poison = v.poison;
	p.puddleSlow = v.puddleSlow;
	p.hitFlash = v.hitFlash;
}
