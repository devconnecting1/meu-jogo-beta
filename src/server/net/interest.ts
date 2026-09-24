//!native
/*
 * Interest management: what each client is allowed to receive (docs/MULTIPLAYER.md §4.3, §4.4; MP-07).
 *
 * One question per (viewer, target) pair — near ring, mid ring or out of interest — answered for survivors
 * (F1) and, from F2-2D on, for every zombie and boss on the server:
 *
 *   near  ≤ INTEREST_NEAR  (800 u)   → in every snapshot (SNAP_NEAR_HZ = 20 Hz); one already near stays near up to
 *                                      INTEREST_NEAR_EXIT (880 u)
 *   mid   ≤ INTEREST_MID   (1500 u)  → in every MID_DIVISOR-th snapshot (SNAP_MID_HZ = 10 Hz per entity)
 *   out   > INTEREST_EXIT  (1650 u)  → not sent; the hysteresis band keeps an entity that is hovering on the
 *                                      border from flickering in and out (and the client's despawn timeout of
 *                                      §4.4 covers the gap either way)
 *
 * The ring a zombie travels in also decides how far back its viewer draws it (client/net/snapshotBuffer.ts `extra`:
 * a near interval more in the mid ring, eased over a second when it changes), and so where a shot at it is judged
 * (server/sim/combat.ts). `ActorInterest` mirrors that easing per pair from the `mid` flags it actually SENT
 * (`noteSent`, `viewExtra`); both hysteresis bands keep a body on a border from flipping it.
 *
 * On top of the rings, §4.3 has two visibility rules that exist so the wire cannot be read as a wallhack:
 * a zombie inside a building the viewer is not in is never sent (the roof already hides it, EDI-04), and in
 * the dark a zombie outside every light is only sent when it is close enough to be heard (DARK_SENSE_RANGE).
 * Both are decided here and nowhere else, so there is exactly one place that can leak a position.
 *
 * Pure module: small tables keyed by (viewer, target), no Instances.
 */
import {
	DARK_SENSE_RANGE,
	DESPAWN_FADE_S,
	DESPAWN_MID_S,
	DESPAWN_NEAR_S,
	INTEREST_EXIT,
	INTEREST_MID,
	INTEREST_NEAR,
	INTEREST_NEAR_EXIT,
	INTERP_DEFAULT_S,
	MAX_PLAYERS,
	RENDER_DELAY_RATE,
	SNAP_MID_EVERY_TICKS,
	SNAP_NEAR_EVERY_TICKS,
	SNAP_NEAR_HZ,
	STREAM_QUIET_S,
	TRACK_FADE_IN_RATE,
} from "shared/net/mpConfig";

export const Ring = {
	Out: 0,
	Mid: 1,
	Near: 2,
} as const;
export type Ring = (typeof Ring)[keyof typeof Ring];

const NEAR2 = INTEREST_NEAR * INTEREST_NEAR;
const NEAR_EXIT2 = INTEREST_NEAR_EXIT * INTEREST_NEAR_EXIT;
const MID2 = INTEREST_MID * INTEREST_MID;
const EXIT2 = INTEREST_EXIT * INTEREST_EXIT;

/** snapshots between two sends of the same mid-ring entity: 6/3 = 2 at 60 Hz, i.e. 20 Hz → 10 Hz (§4.1) */
export const MID_DIVISOR = math.max(1, math.floor(SNAP_MID_EVERY_TICKS / SNAP_NEAR_EVERY_TICKS + 0.5));

/** ring of a squared distance, given the ring it was in before (hysteresis on the way OUT of each ring) */
export function ringOf(dist2: number, previous: Ring): Ring {
	if (dist2 <= NEAR2) return Ring.Near;
	if (previous === Ring.Near && dist2 <= NEAR_EXIT2) return Ring.Near;
	if (dist2 <= MID2) return Ring.Mid;
	if (previous !== Ring.Out && dist2 <= EXIT2) return Ring.Mid;
	return Ring.Out;
}

export interface InterestEntry {
	slot: number;
	ring: Ring;
	dist2: number;
}

/**
 * Remembers the ring of every (viewer, SURVIVOR) pair so `ringOf` can apply its hysteresis. With MAX_PLAYERS = 6
 * that is at most 36 entries, so a flat map keyed by viewer × MAX_PLAYERS + target is the cheapest thing that
 * works.
 *
 * That key is only collision-free while the target is a SLOT (< MAX_PLAYERS). Zombies and bosses are addressed
 * by netId, which runs to 65 535, so they have their own table (`ActorInterest`) with a stride to match: sharing
 * this one would cross the hysteresis of unrelated bodies, and the symptom — one client watching a zombie
 * flicker in and out because of a different zombie's distance — is as intermittent as bugs get.
 */
export class InterestTable {
	private readonly rings = new Map<number, Ring>();

	private static key(viewer: number, target: number): number {
		return viewer * MAX_PLAYERS + target;
	}

	ring(viewer: number, target: number): Ring {
		return this.rings.get(InterestTable.key(viewer, target)) ?? Ring.Out;
	}

	/** classifies one target for one viewer and stores the result */
	update(viewer: number, target: number, dx: number, dy: number): Ring {
		const key = InterestTable.key(viewer, target);
		const ring = ringOf(dx * dx + dy * dy, this.rings.get(key) ?? Ring.Out);
		if (ring === Ring.Out) this.rings.delete(key);
		else this.rings.set(key, ring);
		return ring;
	}

	/** drops every pair that mentions `slot` (the player left, or their slot was reused) */
	forget(slot: number): void {
		for (let other = 0; other < MAX_PLAYERS; other++) {
			this.rings.delete(InterestTable.key(slot, other));
			this.rings.delete(InterestTable.key(other, slot));
		}
	}

	clear(): void {
		this.rings.clear();
	}
}

export interface Positioned {
	slot: number;
	x: number;
	y: number;
}

/** every other survivor `viewer` has in interest, nearest first (the snapshot fills parts in priority order) */
export function classify(
	rings: InterestTable,
	viewer: Positioned,
	targets: ReadonlyArray<Positioned>,
): Array<InterestEntry> {
	const out = new Array<InterestEntry>();
	for (const t of targets) {
		if (t.slot === viewer.slot) continue;
		const dx = t.x - viewer.x;
		const dy = t.y - viewer.y;
		const ring = rings.update(viewer.slot, t.slot, dx, dy);
		if (ring === Ring.Out) continue;
		out.push({ slot: t.slot, ring, dist2: dx * dx + dy * dy });
	}
	out.sort((a, b) => a.dist2 < b.dist2);
	return out;
}

/**
 * Is this entry in THIS snapshot? Near ring: always (20 Hz). Mid ring: one snapshot out of MID_DIVISOR, spread
 * by slot so the mid-ring players of a given viewer do not all land on the same packet (§4.1 "em rodízio").
 */
export function inSnapshot(entry: InterestEntry, snapIndex: number): boolean {
	if (entry.ring === Ring.Near) return true;
	if (entry.ring === Ring.Out) return false;
	return (snapIndex + entry.slot) % MID_DIVISOR === 0;
}

// ---------------------------------------------------------------- zombies and bosses (§4.3, F2-2D)

/**
 * §4.3 rule 3: "de dia tudo no raio é visível". The horde's own alpha (shared/sim/ai/zombieBrain.ts
 * `updateAlpha`) calls a world lit when `1 − darkAlpha ≥ 0.4`, and the interest has to agree with it to the
 * letter: a zombie the client would draw at full alpha but never receives is a zombie that pops in.
 */
const DARK_LIT_AMBIENT = 0.4;
/**
 * A zombie counts as "inside some light" from this alpha up. `alpha` fades at 3/s (§4.3 "o fade de alpha que
 * já existe esconde o surgimento"), so anything above the fade's own noise floor means a light reached it —
 * and taking the rising edge early is what lets the client's fade-in cover the first frames.
 */
const LIT_ALPHA_MIN = 0.05;
const DARK_SENSE2 = DARK_SENSE_RANGE * DARK_SENSE_RANGE;

/** is the world dark enough for §4.3's light rule to apply at all? */
export function worldIsDark(darkAlpha: number): boolean {
	return 1 - darkAlpha < DARK_LIT_AMBIENT;
}

/**
 * §4.3 rule 2. In the dark the wire only carries what the viewer could plausibly perceive: a zombie standing
 * in someone's light (`alpha`, which already means "inside SOME light", lamps and campfires included) or one
 * close enough to be heard and felt. Everything else is silence — which is also why a wallhack has nothing to
 * read in the dark.
 */
export function visibleInDark(dark: boolean, alpha: number, dist2: number): boolean {
	if (!dark) return true;
	if (alpha > LIT_ALPHA_MIN) return true;
	return dist2 <= DARK_SENSE2;
}

/**
 * §4.3 rule 1. A zombie inside a building is only sent to someone inside that same building. Both sides are
 * building ids (0 = outdoors), so the caller resolves `buildingAt` once per entity instead of per pair.
 */
export function visibleThroughWalls(viewerBuilding: number, targetBuilding: number): boolean {
	return targetBuilding === 0 || targetBuilding === viewerBuilding;
}

/** one key per (viewer, netId): netIds are u16, so a stride of 65 536 keeps the viewers apart */
const ACTOR_KEY_STRIDE = 65536;

interface ActorRing {
	ring: Ring;
	/** snapshot round this pair was last classified in, so dead entities cannot leak the table */
	seen: number;
	/** a snapshot has carried this body to this viewer (`noteSent`): until then the fields below mean nothing */
	sent: boolean;
	/** the `mid` flag last SENT for it: what the viewer's track holds (client/net/snapshotBuffer.ts `track.mid`) */
	wireMid: boolean;
	/** tick of the last snapshot that carried it */
	sentAt: number;
	/**
	 * The server's clock (s) at the last snapshot that carried it, and at the first one of the viewer's current track:
	 * a track nothing reaches for long enough is retired (`gone`). The client retires it by REAL time (`now − lastSeen`),
	 * and ticks are not real time on a server that runs slow or drops the surplus of a hitch (§3.1): 27 ticks could be
	 * more than 0.45 s (the review of the zombie-motion branch, S3 NIT 1).
	 */
	sentClock: number;
	shownClock: number;
	/**
	 * The viewer's extra delay for it, in ticks, as its client eases it (`easeExtra`): `extraFrom` when the snapshot
	 * of tick `extraAt` -- the first to carry the current flag -- arrived, moving towards `extraTo` at
	 * RENDER_DELAY_RATE (see `viewExtra`).
	 */
	extraFrom: number;
	extraTo: number;
	extraAt: number;
}

/**
 * Ticks between a snapshot's tick and the render time of the client frame it first shows up in: the client draws
 * `lateness + buffer` behind its clock and the snapshot lands `lateness` behind it, so what is left is the buffer
 * (client/net/snapshotBuffer.ts `noteArrival`). The server does not know each client's; the default is what the
 * rewind ceiling assumes too (server/sim/history.ts), and a buffer 2 ticks off moves the eased extra by 0.1 tick.
 */
const ARRIVAL_BUFFER_S = INTERP_DEFAULT_S;

/** the client's eased extra (`easeExtra`) `elapsed` ticks after it started from `from` towards `to` */
function easedExtra(from: number, to: number, elapsed: number): number {
	if (!(elapsed > 0)) return from;
	const step = RENDER_DELAY_RATE * elapsed;
	return from + math.clamp(to - from, -step, step);
}

/**
 * Seconds without a snapshot after which the viewer no longer has a track for a body last sent with this `mid` flag,
 * `shownFor` seconds after the first snapshot of that track: its ring's timeout, then the fade out from the alpha the
 * fade-in reached (client/net/snapshotBuffer.ts `advanceActors`, §4.4). The fade-in runs until the timeout starts the
 * fade out, so a track shown once reaches (0 + timeout) × TRACK_FADE_IN_RATE of it, and goes that much sooner (the review
 * of the zombie-motion branch, S3 NIT 2: the longest fade was assumed for every track).
 */
export function retiredAfterS(mid: boolean, shownFor: number): number {
	const timeout = mid ? DESPAWN_MID_S : DESPAWN_NEAR_S;
	const alpha = math.clamp((math.max(0, shownFor) + timeout) * TRACK_FADE_IN_RATE, 0, 1);
	return timeout + alpha * DESPAWN_FADE_S;
}

/**
 * The same hysteresis as `InterestTable`, for entities that are identified by a netId instead of a slot and
 * come and go by the hundred. A pair stops being updated the moment its zombie dies, so the table is swept:
 * `forgetTarget` is the exact path (the replicator already drains the deaths) and `sweep` the safety net.
 *
 * It also mirrors, per pair, how far back the viewer draws the body (`noteSent`, `viewExtra`). The server used to
 * switch that at once with the ring while the client eases it over a second from the flag it received: for about a
 * second after every crossing of 800 u -- and every chasing zombie crosses once, inside both rifle ranges -- a shot
 * was judged up to 3 ticks away from the body on the shooter's screen, 4.5-10 u (the review of dee095a, S3).
 */
export class ActorInterest {
	private readonly rings = new Map<number, ActorRing>();
	/**
	 * The server's clock (s) at each viewer's last two snapshot rounds (`noteRound`): whether it went on sending that
	 * viewer others while it sent them one body no more -- a gap in that body's track, not in the whole stream.
	 */
	private readonly lastRound = new Map<number, number>();
	private readonly prevRound = new Map<number, number>();

	private static key(viewer: number, netId: number): number {
		return viewer * ACTOR_KEY_STRIDE + netId;
	}

	ring(viewer: number, netId: number): Ring {
		return this.rings.get(ActorInterest.key(viewer, netId))?.ring ?? Ring.Out;
	}

	/** classifies one entity for one viewer and remembers it; `round` is any monotonic counter */
	update(viewer: number, netId: number, dist2: number, round: number): Ring {
		const key = ActorInterest.key(viewer, netId);
		const previous = this.rings.get(key);
		const ring = ringOf(dist2, previous?.ring ?? Ring.Out);
		if (ring === Ring.Out) {
			if (previous !== undefined) this.rings.delete(key);
			return ring;
		}
		if (previous !== undefined) {
			previous.ring = ring;
			previous.seen = round;
		} else {
			this.rings.set(key, {
				ring,
				seen: round,
				sent: false,
				wireMid: false,
				sentAt: 0,
				sentClock: 0,
				shownClock: 0,
				extraFrom: 0,
				extraTo: 0,
				extraAt: 0,
			});
		}
		return ring;
	}

	/**
	 * A snapshot round goes to this viewer at `now` (the server's clock, s): call it before the round's `noteSent`.
	 *
	 * A round after a silence of STREAM_QUIET_S or more -- the server stalled, a heartbeat that dropped its surplus (§3.1)
	 * -- is a silence of the WHOLE stream for that client: it keeps every track through it, alpha and all, and does not
	 * count it against any despawn timeout (client/net/snapshotBuffer.ts `notePart`, review of 577c729, M1). The same
	 * silence is forgiven here to every body this viewer was sent, so the retirement the server mirrors (`gone`) stays
	 * the client's. What the server cannot see is a silence the link made alone (a loss burst on the way down): there
	 * the client keeps a track the server may take as retired, at worst for the burst's length, and the one thing that
	 * costs is the blood of a death in that window (the ZombieDied goes to who the server thinks draws the body).
	 */
	noteRound(viewer: number, now: number): void {
		const last = this.lastRound.get(viewer);
		if (last !== undefined) {
			this.prevRound.set(viewer, last);
			const quiet = now - last;
			if (quiet > STREAM_QUIET_S) this.forgiveSilence(viewer, quiet - 1 / SNAP_NEAR_HZ);
		}
		this.lastRound.set(viewer, now);
	}

	/** a silence of `seconds` in this viewer's whole stream counts toward no body's retirement (`noteRound`) */
	private forgiveSilence(viewer: number, seconds: number): void {
		const from = viewer * ACTOR_KEY_STRIDE;
		const to = from + ACTOR_KEY_STRIDE;
		for (const [key, pair] of this.rings) {
			if (key < from || key >= to || !pair.sent) continue;
			pair.sentClock += seconds;
			pair.shownClock += seconds;
		}
	}

	/**
	 * A snapshot of `tick` carried this body to this viewer with this `mid` flag, and `extra` is the mid ring's
	 * extra delay in ticks (midViewExtraTicks); `now` is the server's clock (s, the replicator's). What the client does
	 * with the flag: a new track takes its extra at once; a changed flag starts easing it from wherever it was when
	 * that snapshot landed.
	 *
	 * A NEW track is not only a body seen for the first time. The client retires a track that stops arriving
	 * (`retiredAfterS`: 0.45 s near, 0.75 s mid), while the pair stays here for as long as the body stays in
	 * interest -- in the dark outside every light, inside a building, past SNAP_ZOMBIE_CAP in a horde. A body carried
	 * again after that is a new track on the client, drawn at its extra from the first frame; eased from the old ring
	 * here instead, a zombie lit in the mid ring that walked up in the dark and was lit again in the near one was
	 * judged up to 3 ticks off the body on screen for most of a second (the second review of the zombie-motion branch,
	 * S3; tools/test-replication.mjs a3: 14.7 u, and 9.8 u the other way round, where it is now 0.00 u).
	 */
	noteSent(viewer: number, netId: number, mid: boolean, tick: number, extra: number, now: number): void {
		const pair = this.rings.get(ActorInterest.key(viewer, netId));
		if (pair === undefined) return;
		const to = mid ? extra : 0;
		if (!pair.sent || this.gone(viewer, pair, now)) {
			pair.sent = true;
			pair.wireMid = mid;
			pair.sentAt = tick;
			pair.sentClock = now;
			pair.shownClock = now;
			pair.extraFrom = to;
			pair.extraTo = to;
			pair.extraAt = tick;
			return;
		}
		// the client starts a track again, faded in from nothing, when this body was not carried for longer than its ring's
		// timeout while the stream carried others (client/net/snapshotBuffer.ts `discontinuity`, review of 577c729, M1):
		// its fade out is measured from the new fade-in from here on (N1). A silence of the whole stream -- a round this
		// viewer did not get at all -- is kept as one walk there, at its alpha, and here too
		const timeout = pair.wireMid ? DESPAWN_MID_S : DESPAWN_NEAR_S;
		if (now - pair.sentClock > timeout && (this.prevRound.get(viewer) ?? -math.huge) > pair.sentClock) {
			pair.shownClock = now;
		}
		pair.sentAt = tick;
		pair.sentClock = now;
		if (pair.wireMid === mid) return;
		pair.extraFrom = easedExtra(pair.extraFrom, pair.extraTo, tick - pair.extraAt);
		pair.extraTo = to;
		pair.extraAt = tick;
		pair.wireMid = mid;
	}

	/**
	 * How many ticks further back than `viewTick` -- the render time of the frame that declared it -- this viewer
	 * drew the body: the easing of `noteSent`, `ARRIVAL_BUFFER_S` after the snapshot that started it. 0 for a body it
	 * was never sent (or that left its interest: the client may still be fading it out, never at a shot's range).
	 */
	viewExtra(viewer: number, netId: number, viewTick: number, simHz: number): number {
		const pair = this.rings.get(ActorInterest.key(viewer, netId));
		if (pair === undefined || !pair.sent) return 0;
		return easedExtra(pair.extraFrom, pair.extraTo, viewTick + ARRIVAL_BUFFER_S * simHz - pair.extraAt);
	}

	/**
	 * Does this viewer's client still have a track for the body -- a snapshot carried it, and not so long ago that the
	 * client retired it? Its `ZombieDied` goes to exactly those (audit L2): a death is news only where the body is
	 * drawn. The ring alone said "in range", and a zombie in range but in the dark, or in a building, was never sent:
	 * its death handed its position to a client that had never been allowed to see it.
	 */
	hasTrack(viewer: number, netId: number, now: number): boolean {
		const pair = this.rings.get(ActorInterest.key(viewer, netId));
		return pair !== undefined && pair.sent && !this.gone(viewer, pair, now);
	}

	/**
	 * Has the viewer's client retired this track by `now` (the server's clock, s)? Its own rule, in real time -- in the
	 * time its stream was talking: a silence this viewer is in the middle of (no round for STREAM_QUIET_S) holds its
	 * client's every track where it was, as the round that ends it will forgive (`noteRound`).
	 */
	private gone(viewer: number, pair: ActorRing, now: number): boolean {
		const last = this.lastRound.get(viewer);
		const at = last !== undefined && now - last > STREAM_QUIET_S ? last + 1 / SNAP_NEAR_HZ : now;
		return at - pair.sentClock > retiredAfterS(pair.wireMid, pair.sentClock - pair.shownClock);
	}

	/** that entity is gone (§4.4 death or despawn): every viewer forgets it */
	forgetTarget(netId: number): void {
		for (let viewer = 0; viewer < MAX_PLAYERS; viewer++) {
			this.rings.delete(ActorInterest.key(viewer, netId));
		}
	}

	/** that viewer left: drop its half of the table */
	forgetViewer(slot: number): void {
		this.lastRound.delete(slot);
		this.prevRound.delete(slot);
		const from = slot * ACTOR_KEY_STRIDE;
		const to = from + ACTOR_KEY_STRIDE;
		const gone = new Array<number>();
		for (const [key] of this.rings) {
			if (key >= from && key < to) gone.push(key);
		}
		for (const key of gone) this.rings.delete(key);
	}

	/** drops every pair not classified in the last `maxAge` rounds (an entity that vanished silently) */
	sweep(round: number, maxAge: number): number {
		const gone = new Array<number>();
		for (const [key, entry] of this.rings) {
			if (round - entry.seen > maxAge) gone.push(key);
		}
		for (const key of gone) this.rings.delete(key);
		return gone.size();
	}

	size(): number {
		return this.rings.size();
	}

	clear(): void {
		this.rings.clear();
		this.lastRound.clear();
		this.prevRound.clear();
	}
}

/**
 * Is this entity in THIS snapshot? Near: always. Mid: one round out of MID_DIVISOR, spread by netId so the
 * mid ring of one viewer is halved evenly instead of arriving in one lump every other packet (§4.3 "metade
 * dos zumbis do anel em cada snapshot, em rodízio").
 */
export function actorInSnapshot(ring: Ring, netId: number, snapIndex: number): boolean {
	if (ring === Ring.Near) return true;
	if (ring === Ring.Out) return false;
	return (snapIndex + netId) % MID_DIVISOR === 0;
}
