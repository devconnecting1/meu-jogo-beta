/*
 * Multiplayer wire protocol (docs/MULTIPLAYER.md §2.2, §4, §8). F0 = contracts and codecs only: no remote
 * instance is created here (F1: server/net/remotes.ts) and nothing in the current game calls this file.
 *
 *   Input     C→S  UnreliableRemoteEvent  4 B header + 1..3 commands of 8 B = 28 B (§2.2)
 *   Snap      S→C  UnreliableRemoteEvent  8 B header + self/players/bosses/zombies, ≤ 900 B per part (§4.2)
 *   Fx        S→C  UnreliableRemoteEvent  4 B header + tagged events, ≤ 900 B per packet (§4.2)
 *   World     S→C  RemoteEvent            5 B header + tagged deltas, ≤ 16 KB; WorldInit blocks too (§4.5)
 *   TimeSync  ↔    UnreliableRemoteEvent  ping 11 B / pong 23 B (optional probe, decision 9)
 *   Intent    C→S  RemoteEvent            small validated table (F1+, only the name is reserved here)
 *   Self      S→C  RemoteEvent            save mirror deltas (F3, only the name is reserved here)
 *
 * Every decoder takes `unknown` (whatever came out of the remote), never throws, and returns undefined for
 * anything malformed: not a buffer, wrong length, bad count, value out of range, unknown enum or flag bit,
 * NaN/inf float, trailing bytes. The server drops those and counts them as malformed (§8.2).
 *
 * Decisions where the doc was ambiguous (F0A):
 *  1. First byte of Snap/Fx/World/TimeSync = packet kind in the high nibble. Snap packs `part` in bits 2-3
 *     and `parts − 1` in bits 0-1 (up to 4 parts). Input has no kind byte (the doc fixes 4 + 8n bytes).
 *  2. Input commands are newest first and consecutive: cmds[i].seq = cmds[0].seq − i (mod 65 536); reserved
 *     `held` bits must be 0; viewFrac is in 1/256 of a tick.
 *  3. Snap body order: self (part 0 only) → players → bosses → zombies. Zombies go last so the encoder fills a
 *     part up to 900 B and continues in the next; the caller orders them by priority (near ring first).
 *     Header flags: bit 0 = self block present; bit 1 ("has clock" in the doc) stays reserved because the
 *     clock travels in the reliable Clock delta; unknown flag bits are rejected; the reserved byte is ignored.
 *  4. Self block: the doc lists 26 B of fields for a 28 B block. `weapon u8` (the server's equipped weapon,
 *     so a refused switch reconciles on the HUD) + 3 reserved bytes complete it. Units: reactionSpeed ×1/25,
 *     hp ×1/100 (≤ 655.35), iframe ×1/100 s, spread in 1/4° (≤ 63.75°), reload/draw/bleed as 0..1 fractions
 *     (bleed = bleed-out left of the 30 s, or the revive progress while the Downed flag is set).
 *  5. "hp%" of other players and of constructions is a u8 fraction of the maximum (1/255); boss hp is a u16
 *     fraction (its hpMax grows with S(k); the client only draws a bar).
 *  6. Zombie meta: type in bits 0-2 (1..5), big in bit 3, mid ring in bit 4 (client despawn timeout
 *     300/600 ms, §4.4), bits 5-7 reserved = 0. Other players' `swing` is relative, in u8-angle steps.
 *  7. Fx and World events carry a 1-byte type tag (not counted in the doc's per-event sizes). MapItemHit (tree,
 *     car, bin shake) is the Fx event SolidShake, since §4.5 routes it "via Fx". A batch bigger than one packet
 *     is split into several packets (never truncated); an event that cannot fit alone is dropped and counted.
 *  8. WorldInit = World batches whose first event is InitBegin{mapHash, seed, tick0Time, simHz, chunk, chunks},
 *     followed by the ordinary SolidAdd/DoorSet/LightSet/ItemAdd/Clock deltas. Clock dayTime is hours × 2048
 *     (u16, < 24 h); rain is a boolean. Solid and item ids are u32; SolidAdd/ItemAdd/ItemRemove ids must be
 *     dynamic (≥ 1 000 000). Item velocity is i16 in 1/8 u/s. User ids are f64 (Roblox ids exceed 2^32 and
 *     Studio test players are negative). Display names: u8 length, ≤ 80 bytes, cut on a UTF-8 boundary.
 *  9. Clock sync follows §4.6: the source of truth is workspace:GetServerTimeNow() with tick0Time from
 *     InitBegin/LoadAck (serverTickAt). TimePing/TimePong is an extra, optional probe (not in the doc) to
 *     measure RTT and check GetServerTimeNow's offset while testing; it has its own rate limit (mpConfig).
 * 10. Projectile speed u8 in 8 u/s (≤ 2040 u/s: arrows 600, bullets 1800); explosion radius u8 in 4 u.
 *     Boss flags/phase/extra and zombie `extra` are raw bytes whose meaning F2 defines (not validated).
 * 11. (F2-2D) Two Fx events the horde needs and F0 had no place for: `Shake` (§4.2 lists "Blood/Debris/Shake"),
 *     the camera kick of ONE survivor, and `Tracer`, a drawn shot line nobody can predict (a boss beam). A
 *     survivor's own muzzle flash, kick and tracer stay client-side (§2.5), so neither is ever sent for one.
 * 12. (MON-04) The roster carries what a survivor LOOKS like: `PlayerJoined` has `outfit` and `pet` (OutfitLook /
 *     PetLook of shared/data/cosmetics.ts — what to draw, never an EQUIPS index), replacing F0's `costume/deco`
 *     bytes that nothing drew. `PlayerProfile{slot, level, outfit, pet}` is the in-session delta: a level-up or a
 *     change of outfit/pet reaches everybody without a second PlayerJoined (which would reset the life state).
 *     Both are range-checked on decode; the server only ever sends looks it checked ownership of.
 * 13. (MP-22) The town is no longer always DESIGN.TOWN_SEED: when every survivor dies the world ends and a new town
 *     is born from a new seed. `InitBegin` carries the `seed` (u32, 1 … TOWN_SEED_MAX, next to the map hash it is
 *     checked with), so a client entering the world knows which town to build; `WorldReset{seed, endedDay, lives}`
 *     is broadcast to EVERY connected client — the lobby included — the moment a world ends: the new seed, the
 *     world day the old one fell on, and each new life: the UserId the server reset to day 1 and the `runRev` that
 *     reset left in its save (u8 count + f64 + u32 each). The client SETS its runRev from that number — adding one to
 *     its own drifted whenever a wallet carrying the new runRev overtook the reset (review of f851ad2, B2).
 * 14. (MON-05) Titles. `PlayerJoined` and `PlayerProfile` end with one more byte, `title`: the title shown under the
 *     name (shared/data/titles.ts `titleToWire`: 0 = none, else the title id + 1), range-checked on decode like the
 *     looks, and only ever one the server knows that survivor EARNED (`titleWireOf`). A title earned is announced to
 *     its owner alone as `Announce{msg = TitleUnlocked, arg = title byte}`, whose arg is checked (1..TITLE_WIRE_MAX).
 * 15. (MP-23, the match scoreboard) `PlayerTally{slot, lifeDay, kills}`, 8 B with the tag: the day of THIS life (u16,
 *     1..65535; the save allows 99 999, which the wire clamps -- a life that long has other problems) and the zombies
 *     the server's kill credit gave that survivor (`zombieKills`, u32, 0..SAVE_LIMITS.COUNTER_MAX), both read off the
 *     save the SERVER owns (never a client's report). Broadcast only when one of them moved, looked at once a second
 *     (server/net/replication.ts TALLY_EVERY_TICKS), plus one full round two ticks after a survivor joins, so the
 *     newcomer hears everybody's AFTER its PlayerJoined for each of them. Range-checked on decode like the roster.
 * 16. (VEI-05, riding) No new message and no byte more: two S→C fields in space the layouts already had. The C→S side
 *     does not change at all -- getting on and off is the E edge every command already carries, resolved by the server
 *     at its own position (server/sim/vehicles.ts), and the speed is never on the wire.
 *       - Self block: its three reserved bytes carry the rider's own vehicle as the 24-bit `ride` key of
 *         shared/sim/vehicle.ts `packRide` -- u16 (kind · 16384 + heading in 1/16384 turns) then u8 speed (2 u/s
 *         steps), all zero on foot. The simulation keeps that state on exactly this grid, so the prediction replays
 *         from the server's own numbers (§2.2). Decoded only if `rideKeyValid`: kind 0..2, on foot exactly zero, the
 *         speed within that kind's top speed; anything else drops the part, like a bad modFlags.
 *       - Other survivors: the vehicle KIND in bits 4-5 of the slot byte (slot + kind · 16, slot still 0..5), and
 *         while riding `moveAng` (the feet direction, meaningless on a saddle) is the vehicle's heading. Kind 3 or a
 *         slot byte ≥ 48 drops the part.
 */
import {
	NetReader,
	NetWriter,
	clampInt,
	dequantAngle16,
	dequantAngle8,
	dequantFrac8,
	getBits,
	isFiniteNumber,
	quantAngle16,
	quantAngle8,
	quantFrac8,
	roundClamp,
	unwrapTick,
	wrapU16,
} from "./codec";
import {
	BOSS_NET_ID_MAX,
	BOSS_TYPE_MAX,
	CMD_BYTES,
	DYNAMIC_ID_BASE,
	FX_MAX_BYTES,
	INPUT_HEADER_BYTES,
	INPUT_MAX_BYTES,
	INPUT_REDUNDANCY,
	MAX_BOSSES,
	MAX_PLAYERS,
	SIM_HZ,
	SLOT_NONE,
	SNAP_MAX_BYTES,
	SNAP_MAX_PARTS,
	TOWN_SEED_MAX,
	WORLD_MAX_BYTES,
	ZOMBIE_TYPE_MAX,
} from "./mpConfig";
import { OUTFIT_LOOK_MAX, PET_LOOK_MAX } from "shared/data/cosmetics";
import { TITLE_WIRE_MAX } from "shared/data/titles";
import { SAVE_LIMITS } from "shared/game/save";
import { rideKeyValid } from "shared/sim/rideKey";

// ================================================================ remotes (§4.1)

export const REMOTE_INPUT = "Input";
export const REMOTE_INTENT = "Intent";
export const REMOTE_SNAP = "Snap";
export const REMOTE_FX = "Fx";
export const REMOTE_WORLD = "World";
export const REMOTE_SELF = "Self";
export const REMOTE_TIME_SYNC = "TimeSync";

export type MpRemoteClass = "RemoteEvent" | "UnreliableRemoteEvent";

export interface MpRemoteSpec {
	name: string;
	className: MpRemoteClass;
	/** C2S: client → server, S2C: server → client */
	direction: "C2S" | "S2C" | "both";
}

/**
 * The remotes F1 creates in ReplicatedStorage/Net (NET_FOLDER of net.ts), next to LoadRequest/LoadAck/
 * ShopAction. SaveRequest/SaveAck go away in F3 (§4.1).
 */
export const MP_REMOTES: ReadonlyArray<MpRemoteSpec> = [
	{ name: REMOTE_INPUT, className: "UnreliableRemoteEvent", direction: "C2S" },
	{ name: REMOTE_INTENT, className: "RemoteEvent", direction: "C2S" },
	{ name: REMOTE_SNAP, className: "UnreliableRemoteEvent", direction: "S2C" },
	{ name: REMOTE_FX, className: "UnreliableRemoteEvent", direction: "S2C" },
	{ name: REMOTE_WORLD, className: "RemoteEvent", direction: "S2C" },
	{ name: REMOTE_SELF, className: "RemoteEvent", direction: "S2C" },
	{ name: REMOTE_TIME_SYNC, className: "UnreliableRemoteEvent", direction: "both" },
];

/** high nibble of the first byte of every binary packet except Input */
export const PacketKind = {
	Snap: 1,
	Fx: 2,
	World: 3,
	TimePing: 4,
	TimePong: 5,
	Intent: 6,
} as const;
export type PacketKind = (typeof PacketKind)[keyof typeof PacketKind];

function kindOf(b0: number): number {
	return math.floor(b0 / 16);
}

function validSlot(slot: number): boolean {
	return slot < MAX_PLAYERS;
}

function validSlotOrNone(slot: number): boolean {
	return slot < MAX_PLAYERS || slot === SLOT_NONE;
}

/** encoder side: an invalid slot becomes SLOT_NONE instead of making the whole packet undecodable */
function slotOrNone(slot: number): number {
	return slot >= 0 && slot < MAX_PLAYERS ? math.floor(slot) : SLOT_NONE;
}

// ================================================================ Input (C→S, §2.2)

/** `held` bits (input held down during the tick) */
export const HeldBit = {
	Attack: 1,
	Action: 2,
	SniperAim: 4,
} as const;
/** meaningful `held` bits; the others are reserved and must be 0 */
export const HELD_MASK = 7;

/** bit offset of each 2-bit counter in `edges` (0..3 per tick) */
export const EdgeShift = {
	AttackPress: 0,
	AttackRelease: 2,
	ActionPress: 4,
	Reload: 6,
} as const;
export type EdgeShift = (typeof EdgeShift)[keyof typeof EdgeShift];
export const EDGE_MAX = 3;

/** one quantized command: exactly what the server will read (the client predicts with these values) */
export interface InputCommand {
	/** u16, modular */
	seq: number;
	/** movement direction, u8 angle (0 when moveMag = 0) */
	moveAng: number;
	/** movement magnitude 0..255 (0 = standing) */
	moveMag: number;
	/** aim, u16 angle */
	aim: number;
	/** HeldBit flags */
	held: number;
	/** four 2-bit counters, see EdgeShift */
	edges: number;
}

export interface InputPacket {
	/** tick of the snapshot the client was drawing (u16, for lag compensation) */
	viewTick: number;
	/** fraction of that tick, 0..255 (1/256) */
	viewFrac: number;
	/** 1..3 commands, newest first, consecutive seqs */
	cmds: Array<InputCommand>;
}

/** Input packet size for n commands (§8.1: len == 4 + 8n) */
export function inputPacketBytes(n: number): number {
	return INPUT_HEADER_BYTES + n * CMD_BYTES;
}

/** packs the four per-tick counters (each clamped to 0..3) */
export function packEdges(attackPress: number, attackRelease: number, actionPress: number, reload: number): number {
	return (
		clampInt(attackPress, 0, EDGE_MAX) +
		clampInt(attackRelease, 0, EDGE_MAX) * 4 +
		clampInt(actionPress, 0, EDGE_MAX) * 16 +
		clampInt(reload, 0, EDGE_MAX) * 64
	);
}

export function edgeCount(edges: number, shift: EdgeShift): number {
	return getBits(clampInt(edges, 0, 255), shift, 2);
}

/**
 * Quantizes the raw input of one tick. moveX/moveY: desired direction (length ≤ 1, longer is clamped; the
 * keyboard's 8 directions land on exact u8 steps); aim in radians. Predict with the RESULT (§2.2).
 */
export function makeCommand(
	seq: number,
	moveX: number,
	moveY: number,
	aim: number,
	held: number,
	edges: number,
): InputCommand {
	const len = math.sqrt(moveX * moveX + moveY * moveY);
	const moveMag = isFiniteNumber(len) ? quantFrac8(math.min(1, len)) : 0;
	return {
		seq: wrapU16(seq),
		moveAng: moveMag > 0 ? quantAngle8(math.atan2(moveY, moveX)) : 0,
		moveMag,
		aim: quantAngle16(aim),
		held: clampInt(held, 0, 255) & HELD_MASK,
		edges: clampInt(edges, 0, 255),
	};
}

/** movement vector of a command (length 0..1), identical on client and server */
export function commandMove(cmd: InputCommand): { x: number; y: number } {
	if (cmd.moveMag <= 0) return { x: 0, y: 0 };
	const a = dequantAngle8(cmd.moveAng);
	const m = dequantFrac8(cmd.moveMag);
	return { x: math.cos(a) * m, y: math.sin(a) * m };
}

/** aim of a command in radians [0, 2π) */
export function commandAim(cmd: InputCommand): number {
	return dequantAngle16(cmd.aim);
}

/** full (fractional) tick the shooter was seeing, given a reference full tick near it (§2.3) */
export function viewTime(packet: InputPacket, referenceTick: number): number {
	return unwrapTick(packet.viewTick, referenceTick) + packet.viewFrac / 256;
}

const inputWriter = new NetWriter(INPUT_MAX_BYTES, INPUT_MAX_BYTES);

/** undefined when there are not 1..3 commands or their seqs are not consecutive (newest first) */
export function encodeInput(packet: InputPacket): buffer | undefined {
	const cmds = packet.cmds;
	const n = cmds.size();
	if (n < 1 || n > INPUT_REDUNDANCY) return undefined;
	const first = wrapU16(cmds[0].seq);
	for (let i = 1; i < n; i++) {
		if (wrapU16(cmds[i].seq) !== wrapU16(first - i)) return undefined;
	}
	const w = inputWriter;
	w.reset();
	w.u8(n);
	w.tick16(packet.viewTick);
	w.u8(packet.viewFrac);
	for (const c of cmds) {
		w.tick16(c.seq);
		w.u8(c.moveAng);
		w.u8(c.moveMag);
		w.tick16(c.aim);
		w.u8(clampInt(c.held, 0, 255) & HELD_MASK);
		w.u8(c.edges);
	}
	return w.finish();
}

/** server side: validates the exact shape of §8.1 (len == 4 + 8n, 1 ≤ n ≤ 3, count == n, consecutive seqs) */
export function decodeInput(payload: unknown): InputPacket | undefined {
	if (!typeIs(payload, "buffer")) return undefined;
	const len = buffer.len(payload);
	if (len < inputPacketBytes(1) || len > INPUT_MAX_BYTES) return undefined;
	if ((len - INPUT_HEADER_BYTES) % CMD_BYTES !== 0) return undefined;
	const n = (len - INPUT_HEADER_BYTES) / CMD_BYTES;
	const r = new NetReader(payload);
	if (r.u8() !== n) return undefined;
	const viewTick = r.u16();
	const viewFrac = r.u8();
	const cmds = new Array<InputCommand>();
	let first = 0;
	for (let i = 0; i < n; i++) {
		const seq = r.u16();
		const moveAng = r.u8();
		const moveMag = r.u8();
		const aim = r.u16();
		const held = r.u8();
		const edges = r.u8();
		if (held > HELD_MASK) return undefined;
		if (i === 0) first = seq;
		else if (seq !== wrapU16(first - i)) return undefined;
		cmds.push({ seq, moveAng, moveMag, aim, held, edges });
	}
	if (!r.done()) return undefined;
	return { viewTick, viewFrac, cmds };
}

// ================================================================ Snap (S→C, §4.2, §4.3)

export const SNAP_HEADER_BYTES = 8;
export const SNAP_SELF_BYTES = 28;
export const SNAP_PLAYER_BYTES = 12;
export const SNAP_ZOMBIE_BYTES = 9;
/** a zombie with `extra` (jump height, spitter head recoil) takes one more byte */
export const SNAP_ZOMBIE_EXTRA_BYTES = 1;
export const SNAP_BOSS_BYTES = 14;

/** header `flags` */
export const SnapFlag = {
	Self: 1,
} as const;
const SNAP_FLAGS_MASK = 1;

/** self block `flags` */
export const SelfFlag = {
	Hit: 1,
	Poison: 2,
	Speed: 4,
	Calm: 8,
	Pain: 16,
	Acid: 32,
	Downed: 64,
	Dead: 128,
} as const;

/** self block `modFlags` */
export const ModFlag = {
	Noclip: 1,
	God: 2,
	SpawnShield: 4,
} as const;
const MOD_FLAGS_MASK = 7;

/** other player `flags` */
export const PlayerFlag = {
	Walking: 1,
	Swinging: 2,
	Reloading: 4,
	Fired: 8,
	Downed: 16,
	Dead: 32,
	Flashlight: 64,
	Spectating: 128,
} as const;

/** zombie `flags` (bits 0-6; bit 7 on the wire means "an extra byte follows") */
export const ZombieFlag = {
	Detect: 1,
	Stunned: 2,
	HitFlash: 4,
	Jumping: 8,
	Charging: 16,
	FuseLit: 32,
	SpitPrep: 64,
} as const;
const ZOMBIE_FLAGS_MASK = 127;
const ZOMBIE_HAS_EXTRA = 128;
const ZOMBIE_META_BIG = 8;
const ZOMBIE_META_MID = 16;
const ZOMBIE_META_MASK = 31;

/** the local player's authoritative state (part 0 only); x/y are f32 for exact reconciliation */
export interface SelfSnap {
	x: number;
	y: number;
	/** last command seq the server consumed */
	ackSeq: number;
	/** server input queue depth (drives the ±2% sampling dilation) */
	bufDepth: number;
	/** knockback speed, 0..10.2 in 1/25 */
	reactionSpeed: number;
	/** knockback direction, radians */
	reactionDir: number;
	/** 0..655.35 in 1/100 */
	hp: number;
	/** 0..255 */
	hunger: number;
	/** SelfFlag */
	flags: number;
	/** i-frames left, 0..2.55 s in 1/100 s */
	iframe: number;
	/** rounds in the magazine, 0..255 */
	mag: number;
	/** reload progress 0..1 */
	reload: number;
	/** current spread in degrees, 0..63.75 in 1/4° */
	spread: number;
	/** bow draw / chainsaw rev 0..1 */
	draw: number;
	/** bleed-out left (0..1 of 30 s) or revive progress while Downed */
	bleed: number;
	/** ModFlag */
	modFlags: number;
	/** equipped weapon id (0..255) */
	weapon: number;
	/**
	 * (VEI-05) the vehicle this survivor rides, as shared/sim/vehicle.ts `packRide` (24 bits; 0 or absent = on foot):
	 * what the prediction replays from. Validated with `rideKeyValid` on decode.
	 */
	ride?: number;
}

/** (VEI-05) slot byte of another survivor: the slot below RIDE_SLOT_SCALE, the vehicle kind times it above */
const RIDE_SLOT_SCALE = 16;
/** VehicleKind 0..2 (shared/data/buildings.ts) */
export const RIDE_KIND_MAX = 2;

export interface PlayerSnap {
	/** 0..MAX_PLAYERS-1 */
	slot: number;
	x: number;
	y: number;
	/** radians (u8) */
	aim: number;
	/** PlayerFlag */
	flags: number;
	weapon: number;
	/** blade angle relative to the aim, radians (±178°) */
	swing: number;
	/** 0..1 of max hp */
	hp: number;
	/** revive progress 0..1 */
	revive: number;
	/** feet direction, radians (u8); while riding, the vehicle's heading */
	moveAng: number;
	/** (VEI-05) VehicleKind they ride, 0..RIDE_KIND_MAX; 0 or absent = on foot */
	ride?: number;
}

export interface ZombieSnap {
	/** 1..65535 */
	netId: number;
	x: number;
	y: number;
	/** radians (u8) */
	angle: number;
	/** ZombieFlag (bits 0-6) */
	flags: number;
	/** 1..ZOMBIE_TYPE_MAX */
	type: number;
	big: boolean;
	/** in the mid interest ring (sent at 10 Hz; client despawn after 600 ms instead of 300 ms) */
	mid: boolean;
	/** jump height / spitter head recoil, 0..255 (raw) */
	extra?: number;
}

export interface BossSnap {
	/** 1..255 */
	netId: number;
	/** 1..BOSS_TYPE_MAX */
	type: number;
	x: number;
	y: number;
	/** radians (u8) */
	angle: number;
	/** 0..1 of max hp (u16) */
	hp: number;
	/** raw bits (F2) */
	flags: number;
	/** movePos/moveCycle (raw) */
	phase: number;
	/** raw */
	extra: number;
}

export interface Snapshot {
	/** server tick (u16 on the wire) */
	tick: number;
	self?: SelfSnap;
	players: Array<PlayerSnap>;
	zombies: Array<ZombieSnap>;
	bosses: Array<BossSnap>;
}

/** one decoded part: self-contained, apply it even if the other parts never arrive */
export interface SnapshotPart extends Snapshot {
	/** 0..parts-1 */
	part: number;
	/** 1..SNAP_MAX_PARTS */
	parts: number;
}

export interface SnapshotEncodeResult {
	/** 1..SNAP_MAX_PARTS buffers, each ≤ SNAP_MAX_BYTES */
	parts: Array<buffer>;
	/** entities that did not fit (players/bosses above the caps, zombies beyond the last part) */
	dropped: number;
}

/** bytes a snapshot takes on the wire (all parts, extra headers included) — replication budgeting */
export function snapshotBytes(
	withSelf: boolean,
	players: number,
	bosses: number,
	zombies: number,
	zombieExtras: number,
): number {
	const fixed = SNAP_HEADER_BYTES + (withSelf ? SNAP_SELF_BYTES : 0) + players * SNAP_PLAYER_BYTES;
	let total = fixed + bosses * SNAP_BOSS_BYTES;
	let room = SNAP_MAX_BYTES - total;
	let left = zombies;
	let extras = zombieExtras;
	while (left > 0) {
		const size = SNAP_ZOMBIE_BYTES + (extras > 0 ? SNAP_ZOMBIE_EXTRA_BYTES : 0);
		if (size > room) {
			total += SNAP_HEADER_BYTES;
			room = SNAP_MAX_BYTES - SNAP_HEADER_BYTES;
		}
		total += size;
		room -= size;
		left -= 1;
		if (extras > 0) extras -= 1;
	}
	return total;
}

function writeSelf(w: NetWriter, s: SelfSnap): void {
	w.f32(s.x);
	w.f32(s.y);
	w.tick16(s.ackSeq);
	w.u8(s.bufDepth);
	w.u8(s.reactionSpeed * 25);
	w.angle8(s.reactionDir);
	w.u16(s.hp * 100);
	w.u8(s.hunger);
	w.u8(s.flags);
	w.u8(s.iframe * 100);
	w.u8(s.mag);
	w.frac8(s.reload);
	w.u8(s.spread * 4);
	w.frac8(s.draw);
	w.frac8(s.bleed);
	w.u8(clampInt(s.modFlags, 0, 255) & MOD_FLAGS_MASK);
	w.u8(s.weapon);
	// VEI-05: the bytes that were reserved. A key the decoder would refuse is sent as "on foot" instead
	const ride = s.ride !== undefined && rideKeyValid(s.ride) ? s.ride : 0;
	w.u16(math.floor(ride / 256));
	w.u8(ride % 256);
}

function readSelf(r: NetReader): SelfSnap | undefined {
	const x = r.f32();
	const y = r.f32();
	const ackSeq = r.u16();
	const bufDepth = r.u8();
	const reactionSpeed = r.u8() / 25;
	const reactionDir = r.angle8();
	const hp = r.u16() / 100;
	const hunger = r.u8();
	const flags = r.u8();
	const iframe = r.u8() / 100;
	const mag = r.u8();
	const reload = r.frac8();
	const spread = r.u8() / 4;
	const draw = r.frac8();
	const bleed = r.frac8();
	const modFlags = r.u8();
	const weapon = r.u8();
	const ride = r.u16() * 256 + r.u8();
	if (modFlags > MOD_FLAGS_MASK || !rideKeyValid(ride)) return undefined;
	return {
		x,
		y,
		ackSeq,
		bufDepth,
		reactionSpeed,
		reactionDir,
		hp,
		hunger,
		flags,
		iframe,
		mag,
		reload,
		spread,
		draw,
		bleed,
		modFlags,
		weapon,
		ride,
	};
}

function writePlayer(w: NetWriter, p: PlayerSnap): void {
	w.u8(clampInt(p.slot, 0, MAX_PLAYERS - 1) + clampInt(p.ride ?? 0, 0, RIDE_KIND_MAX) * RIDE_SLOT_SCALE);
	w.pos(p.x);
	w.pos(p.y);
	w.angle8(p.aim);
	w.u8(p.flags);
	w.u8(p.weapon);
	w.relAngle8(p.swing);
	w.frac8(p.hp);
	w.frac8(p.revive);
	w.angle8(p.moveAng);
}

function readPlayer(r: NetReader): PlayerSnap | undefined {
	const slotByte = r.u8();
	const slot = slotByte % RIDE_SLOT_SCALE;
	const ride = math.floor(slotByte / RIDE_SLOT_SCALE);
	const x = r.pos();
	const y = r.pos();
	const aim = r.angle8();
	const flags = r.u8();
	const weapon = r.u8();
	const swing = r.relAngle8();
	const hp = r.frac8();
	const revive = r.frac8();
	const moveAng = r.angle8();
	if (!validSlot(slot) || ride > RIDE_KIND_MAX) return undefined;
	return { slot, x, y, aim, flags, weapon, swing, hp, revive, moveAng, ride };
}

function writeZombie(w: NetWriter, z: ZombieSnap): void {
	const extra = z.extra;
	w.u16(clampInt(z.netId, 1, 65535));
	w.pos(z.x);
	w.pos(z.y);
	w.angle8(z.angle);
	w.u8((clampInt(z.flags, 0, 255) & ZOMBIE_FLAGS_MASK) + (extra !== undefined ? ZOMBIE_HAS_EXTRA : 0));
	w.u8(clampInt(z.type, 1, ZOMBIE_TYPE_MAX) + (z.big ? ZOMBIE_META_BIG : 0) + (z.mid ? ZOMBIE_META_MID : 0));
	if (extra !== undefined) w.u8(extra);
}

function readZombie(r: NetReader): ZombieSnap | undefined {
	const netId = r.u16();
	const x = r.pos();
	const y = r.pos();
	const angle = r.angle8();
	const state = r.u8();
	const meta = r.u8();
	const extra = state >= ZOMBIE_HAS_EXTRA ? r.u8() : undefined;
	const zType = meta % 8;
	if (netId < 1 || meta > ZOMBIE_META_MASK || zType < 1 || zType > ZOMBIE_TYPE_MAX) return undefined;
	return {
		netId,
		x,
		y,
		angle,
		flags: state & ZOMBIE_FLAGS_MASK,
		type: zType,
		big: (meta & ZOMBIE_META_BIG) !== 0,
		mid: (meta & ZOMBIE_META_MID) !== 0,
		extra,
	};
}

function writeBoss(w: NetWriter, b: BossSnap): void {
	w.u8(clampInt(b.netId, 1, BOSS_NET_ID_MAX));
	w.u8(clampInt(b.type, 1, BOSS_TYPE_MAX));
	w.pos(b.x);
	w.pos(b.y);
	w.angle8(b.angle);
	w.frac16(b.hp);
	w.u8(b.flags);
	w.u8(b.phase);
	w.u8(b.extra);
	w.u16(0);
}

function readBoss(r: NetReader): BossSnap | undefined {
	const netId = r.u8();
	const bType = r.u8();
	const x = r.pos();
	const y = r.pos();
	const angle = r.angle8();
	const hp = r.frac16();
	const flags = r.u8();
	const phase = r.u8();
	const extra = r.u8();
	r.skip(2);
	if (netId < 1 || bType < 1 || bType > BOSS_TYPE_MAX) return undefined;
	return { netId, type: bType, x, y, angle, hp, flags, phase, extra };
}

const snapWriter = new NetWriter(SNAP_MAX_BYTES, SNAP_MAX_BYTES);

/**
 * Splits one snapshot into self-contained parts of ≤ SNAP_MAX_BYTES. Part 0 carries the header, the self
 * block, the players (≤ MAX_PLAYERS) and the bosses (≤ MAX_BOSSES), then as many zombies as fit; the next
 * zombies go to parts 1..3 (header + zombies). Zombies beyond the 4th part are dropped: order them by
 * priority. Every value is clamped to its wire range.
 */
export function encodeSnapshot(snap: Snapshot): SnapshotEncodeResult {
	const w = snapWriter;
	const parts = new Array<buffer>();
	const players = snap.players;
	const bosses = snap.bosses;
	const zombies = snap.zombies;
	const own = snap.self;
	const nPlayers = math.min(players.size(), MAX_PLAYERS);
	const nBosses = math.min(bosses.size(), MAX_BOSSES);
	const nz = zombies.size();
	let zi = 0;
	for (let part = 0; part < SNAP_MAX_PARTS; part++) {
		if (part > 0 && zi >= nz) break;
		const first = part === 0;
		const withSelf = first && own !== undefined;
		const np = first ? nPlayers : 0;
		const nb = first ? nBosses : 0;
		w.reset();
		w.u8(0); // kind · part · parts-1, patched once the part count is known
		w.tick16(snap.tick);
		w.u8(np);
		w.u8(0); // nZombies, patched below
		w.u8(nb);
		w.u8(withSelf ? SnapFlag.Self : 0);
		w.u8(0);
		if (own !== undefined && withSelf) writeSelf(w, own);
		for (let i = 0; i < np; i++) writePlayer(w, players[i]);
		for (let i = 0; i < nb; i++) writeBoss(w, bosses[i]);
		// the fixed content is ≤ 124 B; only a tiny SNAP_MAX_BYTES could overflow it (nothing is sent then)
		if (w.failed()) return { parts: new Array<buffer>(), dropped: players.size() + bosses.size() + nz };
		let count = 0;
		while (zi < nz && count < 255) {
			const mark = w.length();
			writeZombie(w, zombies[zi]);
			if (w.failed()) {
				w.rollback(mark);
				break;
			}
			zi += 1;
			count += 1;
		}
		if (!first && count === 0) break;
		w.patchU8(4, count);
		const out = w.finish();
		if (out === undefined) break;
		parts.push(out);
	}
	const n = parts.size();
	for (let i = 0; i < n; i++) buffer.writeu8(parts[i], 0, PacketKind.Snap * 16 + i * 4 + (n - 1));
	return { parts, dropped: players.size() - nPlayers + (bosses.size() - nBosses) + (nz - zi) };
}

/** client side: one Snap part; undefined when malformed */
export function decodeSnapshotPart(payload: unknown): SnapshotPart | undefined {
	if (!typeIs(payload, "buffer")) return undefined;
	const len = buffer.len(payload);
	if (len < SNAP_HEADER_BYTES || len > SNAP_MAX_BYTES) return undefined;
	const r = new NetReader(payload);
	const b0 = r.u8();
	if (kindOf(b0) !== PacketKind.Snap) return undefined;
	const part = math.floor(b0 / 4) % 4;
	const parts = (b0 % 4) + 1;
	if (part >= parts) return undefined;
	const tick = r.u16();
	const np = r.u8();
	const nz = r.u8();
	const nb = r.u8();
	const flags = r.u8();
	r.skip(1);
	if (np > MAX_PLAYERS || nb > MAX_BOSSES || flags > SNAP_FLAGS_MASK) return undefined;
	const hasSelf = flags === SnapFlag.Self;
	if (hasSelf && part !== 0) return undefined;
	const minBytes =
		SNAP_HEADER_BYTES +
		(hasSelf ? SNAP_SELF_BYTES : 0) +
		np * SNAP_PLAYER_BYTES +
		nb * SNAP_BOSS_BYTES +
		nz * SNAP_ZOMBIE_BYTES;
	if (len < minBytes) return undefined;
	let own: SelfSnap | undefined;
	if (hasSelf) {
		own = readSelf(r);
		if (own === undefined) return undefined;
	}
	const players = new Array<PlayerSnap>();
	for (let i = 0; i < np; i++) {
		const p = readPlayer(r);
		if (p === undefined) return undefined;
		players.push(p);
	}
	const bosses = new Array<BossSnap>();
	for (let i = 0; i < nb; i++) {
		const b = readBoss(r);
		if (b === undefined) return undefined;
		bosses.push(b);
	}
	const zombies = new Array<ZombieSnap>();
	for (let i = 0; i < nz; i++) {
		const z = readZombie(r);
		if (z === undefined || !r.ok()) return undefined;
		zombies.push(z);
	}
	if (!r.done()) return undefined;
	return { tick, part, parts, self: own, players, zombies, bosses };
}

// ================================================================ batches (shared by Fx and World)

export interface BatchEncodeResult {
	/** 0..n packets, each ≤ the channel ceiling */
	packets: Array<buffer>;
	/** events that could not fit even alone in a packet */
	dropped: number;
}

/**
 * Writes `events` after a header, starting a new packet whenever the next event does not fit or the count
 * field is full. The count lives at `countAt` (u8 or u16).
 */
function encodeBatches<E>(
	w: NetWriter,
	events: ReadonlyArray<E>,
	writeHeader: (w: NetWriter) => void,
	countAt: number,
	countIsU16: boolean,
	writeEvent: (w: NetWriter, e: E) => void,
): BatchEncodeResult {
	const packets = new Array<buffer>();
	const maxCount = countIsU16 ? 65535 : 255;
	let dropped = 0;
	let count = 0;
	w.reset();
	writeHeader(w);
	const headerEnd = w.length();
	const flush = () => {
		if (count > 0) {
			if (countIsU16) w.patchU16(countAt, count);
			else w.patchU8(countAt, count);
			const out = w.finish();
			if (out !== undefined) packets.push(out);
		}
		w.rollback(headerEnd);
		count = 0;
	};
	for (const e of events) {
		if (count >= maxCount) flush();
		const mark = w.length();
		writeEvent(w, e);
		if (w.failed()) {
			w.rollback(mark);
			if (count === 0) {
				dropped += 1;
				continue;
			}
			flush();
			writeEvent(w, e);
			if (w.failed()) {
				w.rollback(headerEnd);
				dropped += 1;
				continue;
			}
		}
		count += 1;
	}
	flush();
	return { packets, dropped };
}

// ================================================================ Fx (S→C, unreliable, §4.1, §4.2)

export const FX_HEADER_BYTES = 4;

export const FxType = {
	Shot: 1,
	ProjSpawn: 2,
	ProjEnd: 3,
	Blood: 4,
	Debris: 5,
	/** MapItemHit (§4.5): tree/car/bin shake */
	SolidShake: 6,
	Explosion: 7,
	Sound: 8,
	/** camera shake of ONE survivor (§4.2 lists "Blood/Debris/Shake"); F2-2D: the horde asks for it */
	Shake: 9,
	/** a drawn shot line the client cannot predict (a boss beam); the survivors' own tracers are local */
	Tracer: 10,
} as const;

/** what a hitscan projectile ended on */
export const HitKind = {
	None: 0,
	Solid: 1,
	Zombie: 2,
	Boss: 3,
	MapItem: 4,
} as const;
const HIT_KIND_MAX = 4;

/** simulated projectiles (§2.3) */
export const ProjKind = {
	Arrow: 1,
	Fire: 2,
	Electric: 3,
	Needle: 4,
	Spit: 5,
} as const;
const PROJ_KIND_MAX = 5;

export const ProjEndHow = {
	Fell: 0,
	Wall: 1,
	Zombie: 2,
	Boss: 3,
	Player: 4,
} as const;
const PROJ_END_MAX = 4;

export const BloodKind = {
	Red: 0,
	Green: 1,
} as const;
const BLOOD_KIND_MAX = 1;

/** pellets per ShotResult (shotgun: 5) */
export const FX_SHOT_MAX_HITS = 16;
/** projectile speed step (u/s) */
export const PROJ_SPEED_STEP = 8;
/** explosion radius step (u) */
export const EXPLOSION_RADIUS_STEP = 4;
/** Shake.magnitude step: the simulation asks for 3..7, so 1/8 of a unit is finer than anyone can see */
export const SHAKE_MAG_STEP = 1 / 8;
/** seconds per step of Shake.duration and Tracer.life (both are fractions of a second) */
export const FX_TIME_STEP = 1 / 100;
/** TracerKind ids 1..3 (shared/sim/types.ts: bullet, electric, boss) */
export const TRACER_KIND_MAX = 3;

export interface ShotHit {
	x: number;
	y: number;
	/** HitKind */
	hit: number;
}

export interface FxShot {
	t: typeof FxType.Shot;
	/** shooter slot, or SLOT_NONE (turret) */
	slot: number;
	weapon: number;
	hits: Array<ShotHit>;
}

export interface FxProjSpawn {
	t: typeof FxType.ProjSpawn;
	projId: number;
	/** ProjKind */
	kind: number;
	/** owner slot, or SLOT_NONE (zombie/boss) */
	owner: number;
	x: number;
	y: number;
	/** radians (u16) */
	angle: number;
	/** u/s, 0..2040 in steps of 8 */
	speed: number;
}

export interface FxProjEnd {
	t: typeof FxType.ProjEnd;
	projId: number;
	x: number;
	y: number;
	/** ProjEndHow */
	how: number;
}

export interface FxBlood {
	t: typeof FxType.Blood;
	x: number;
	y: number;
	angle: number;
	/** particles, 0..255 */
	amount: number;
	/** BloodKind */
	kind: number;
}

export interface FxDebris {
	t: typeof FxType.Debris;
	x: number;
	y: number;
	angle: number;
	/** material id (shared/net/fxWire.ts) */
	material: number;
	/** particles, 0..255 — the same field `Blood` has, so a 3-chip hit and an exploder differ on screen */
	count: number;
}

export interface FxSolidShake {
	t: typeof FxType.SolidShake;
	solidId: number;
	angle: number;
	/** 0..1 */
	strength: number;
}

export interface FxExplosion {
	t: typeof FxType.Explosion;
	x: number;
	y: number;
	/** world units, 0..1020 in steps of 4 */
	radius: number;
	/** explosion kind (raw) */
	kind: number;
}

export interface FxSound {
	t: typeof FxType.Sound;
	/** sound id (raw) */
	sound: number;
	x: number;
	y: number;
	/** 0..1 */
	volume: number;
}

export interface FxShake {
	t: typeof FxType.Shake;
	/** whose camera shakes; SLOT_NONE would shake nobody, so the encoder drops those */
	slot: number;
	/** 0..31.875 in SHAKE_MAG_STEP */
	magnitude: number;
	/** 0..2.55 s in FX_TIME_STEP */
	duration: number;
}

export interface FxTracer {
	t: typeof FxType.Tracer;
	x1: number;
	y1: number;
	x2: number;
	y2: number;
	/** TracerKind 1..3 */
	kind: number;
	/** 0..2.55 s in FX_TIME_STEP */
	life: number;
}

export type FxEvent =
	FxShot | FxProjSpawn | FxProjEnd | FxBlood | FxDebris | FxSolidShake | FxExplosion | FxSound | FxShake | FxTracer;

export interface FxBatch {
	tick: number;
	events: Array<FxEvent>;
}

function writeFxEvent(w: NetWriter, e: FxEvent): void {
	w.u8(e.t);
	switch (e.t) {
		case FxType.Shot: {
			const n = math.min(e.hits.size(), FX_SHOT_MAX_HITS);
			w.u8(slotOrNone(e.slot));
			w.u8(e.weapon);
			w.u8(n);
			for (let i = 0; i < n; i++) {
				const h = e.hits[i];
				w.pos(h.x);
				w.pos(h.y);
				w.u8(clampInt(h.hit, 0, HIT_KIND_MAX));
			}
			break;
		}
		case FxType.ProjSpawn:
			w.u16(e.projId);
			w.u8(clampInt(e.kind, 1, PROJ_KIND_MAX));
			w.u8(slotOrNone(e.owner));
			w.pos(e.x);
			w.pos(e.y);
			w.angle16(e.angle);
			w.u8(e.speed / PROJ_SPEED_STEP);
			w.u8(0);
			break;
		case FxType.ProjEnd:
			w.u16(e.projId);
			w.pos(e.x);
			w.pos(e.y);
			w.u8(clampInt(e.how, 0, PROJ_END_MAX));
			break;
		case FxType.Blood:
			w.pos(e.x);
			w.pos(e.y);
			w.angle8(e.angle);
			w.u8(e.amount);
			w.u8(clampInt(e.kind, 0, BLOOD_KIND_MAX));
			break;
		case FxType.Debris:
			w.pos(e.x);
			w.pos(e.y);
			w.angle8(e.angle);
			w.u8(e.material);
			w.u8(e.count);
			break;
		case FxType.SolidShake:
			w.u32(e.solidId);
			w.angle8(e.angle);
			w.frac8(e.strength);
			break;
		case FxType.Explosion:
			w.pos(e.x);
			w.pos(e.y);
			w.u8(e.radius / EXPLOSION_RADIUS_STEP);
			w.u8(e.kind);
			break;
		case FxType.Sound:
			w.u8(e.sound);
			w.pos(e.x);
			w.pos(e.y);
			w.frac8(e.volume);
			break;
		case FxType.Shake:
			w.u8(clampInt(e.slot, 0, MAX_PLAYERS - 1));
			w.u8(e.magnitude / SHAKE_MAG_STEP);
			w.u8(e.duration / FX_TIME_STEP);
			break;
		case FxType.Tracer:
			w.pos(e.x1);
			w.pos(e.y1);
			w.pos(e.x2);
			w.pos(e.y2);
			w.u8(clampInt(e.kind, 1, TRACER_KIND_MAX));
			w.u8(e.life / FX_TIME_STEP);
			break;
	}
}

function readFxEvent(r: NetReader): FxEvent | undefined {
	const t = r.u8();
	if (t === FxType.Shot) {
		const slot = r.u8();
		const weapon = r.u8();
		const n = r.u8();
		if (!validSlotOrNone(slot) || n > FX_SHOT_MAX_HITS) return undefined;
		const hits = new Array<ShotHit>();
		for (let i = 0; i < n; i++) {
			const x = r.pos();
			const y = r.pos();
			const hit = r.u8();
			if (hit > HIT_KIND_MAX) return undefined;
			hits.push({ x, y, hit });
		}
		return { t: FxType.Shot, slot, weapon, hits };
	} else if (t === FxType.ProjSpawn) {
		const projId = r.u16();
		const kind = r.u8();
		const owner = r.u8();
		const x = r.pos();
		const y = r.pos();
		const angle = r.angle16();
		const speed = r.u8() * PROJ_SPEED_STEP;
		r.skip(1);
		if (kind < 1 || kind > PROJ_KIND_MAX || !validSlotOrNone(owner)) return undefined;
		return { t: FxType.ProjSpawn, projId, kind, owner, x, y, angle, speed };
	} else if (t === FxType.ProjEnd) {
		const projId = r.u16();
		const x = r.pos();
		const y = r.pos();
		const how = r.u8();
		if (how > PROJ_END_MAX) return undefined;
		return { t: FxType.ProjEnd, projId, x, y, how };
	} else if (t === FxType.Blood) {
		const x = r.pos();
		const y = r.pos();
		const angle = r.angle8();
		const amount = r.u8();
		const kind = r.u8();
		if (kind > BLOOD_KIND_MAX) return undefined;
		return { t: FxType.Blood, x, y, angle, amount, kind };
	} else if (t === FxType.Debris) {
		const x = r.pos();
		const y = r.pos();
		const angle = r.angle8();
		const material = r.u8();
		const count = r.u8();
		return { t: FxType.Debris, x, y, angle, material, count };
	} else if (t === FxType.SolidShake) {
		const solidId = r.u32();
		const angle = r.angle8();
		const strength = r.frac8();
		if (solidId < 1) return undefined;
		return { t: FxType.SolidShake, solidId, angle, strength };
	} else if (t === FxType.Explosion) {
		const x = r.pos();
		const y = r.pos();
		const radius = r.u8() * EXPLOSION_RADIUS_STEP;
		const kind = r.u8();
		return { t: FxType.Explosion, x, y, radius, kind };
	} else if (t === FxType.Sound) {
		const sound = r.u8();
		const x = r.pos();
		const y = r.pos();
		const volume = r.frac8();
		return { t: FxType.Sound, sound, x, y, volume };
	} else if (t === FxType.Shake) {
		const slot = r.u8();
		const magnitude = r.u8() * SHAKE_MAG_STEP;
		const duration = r.u8() * FX_TIME_STEP;
		if (!validSlot(slot)) return undefined;
		return { t: FxType.Shake, slot, magnitude, duration };
	} else if (t === FxType.Tracer) {
		const x1 = r.pos();
		const y1 = r.pos();
		const x2 = r.pos();
		const y2 = r.pos();
		const kind = r.u8();
		const life = r.u8() * FX_TIME_STEP;
		if (kind < 1 || kind > TRACER_KIND_MAX) return undefined;
		return { t: FxType.Tracer, x1, y1, x2, y2, kind, life };
	}
	return undefined;
}

const fxWriter = new NetWriter(256, FX_MAX_BYTES);

/** one tick of effects → packets of ≤ FX_MAX_BYTES (usually one) */
export function encodeFx(batch: FxBatch): BatchEncodeResult {
	const tick = batch.tick;
	return encodeBatches(
		fxWriter,
		batch.events,
		(w: NetWriter) => {
			w.u8(PacketKind.Fx * 16);
			w.tick16(tick);
			w.u8(0);
		},
		3,
		false,
		writeFxEvent,
	);
}

/** smallest Fx event on the wire: a ShotResult with no pellets (tag + slot + weapon + n) */
const FX_MIN_EVENT_BYTES = 4;

export function decodeFx(payload: unknown): FxBatch | undefined {
	if (!typeIs(payload, "buffer")) return undefined;
	const len = buffer.len(payload);
	if (len < FX_HEADER_BYTES || len > FX_MAX_BYTES) return undefined;
	const r = new NetReader(payload);
	if (r.u8() !== PacketKind.Fx * 16) return undefined;
	const tick = r.u16();
	const count = r.u8();
	if (count * FX_MIN_EVENT_BYTES > r.remaining()) return undefined;
	const events = new Array<FxEvent>();
	for (let i = 0; i < count; i++) {
		const e = readFxEvent(r);
		if (e === undefined || !r.ok()) return undefined;
		events.push(e);
	}
	if (!r.done()) return undefined;
	return { tick, events };
}

// ================================================================ World (S→C, reliable, §4.4, §4.5, §4.6)

export const WORLD_HEADER_BYTES = 5;

export const WorldEv = {
	SolidAdd: 1,
	SolidRemove: 2,
	DoorSet: 3,
	SolidHp: 4,
	LightSet: 5,
	ItemAdd: 6,
	ItemRemove: 7,
	LootFlag: 8,
	Clock: 9,
	Announce: 10,
	ZombieDied: 11,
	PlayerJoined: 12,
	PlayerLeft: 13,
	PlayerLife: 14,
	InitBegin: 15,
	/** (MON-04, MON-05) the roster's in-session delta: level, outfit, pet, title */
	PlayerProfile: 16,
	/** (MP-22) the world ended: a new town from a new seed, back to day 1 */
	WorldReset: 17,
	/** (MP-23) the scoreboard's two numbers of a survivor: the day of this life and the zombies put down */
	PlayerTally: 18,
} as const;

/** SolidAdd.state / DoorSet.state */
export const SolidState = {
	Powered: 1,
	Open: 2,
	/** built door locked by its owner (§14.2, MP-11) */
	Locked: 4,
} as const;
const SOLID_STATE_MASK = 7;

/** ItemKind ids 1..4 (shared/data/kinds.ts) */
export const ITEM_KIND_MAX = 4;
/** construction rotation: quarter turns 0..3 (client/systems/build.ts) */
export const ROT_MAX = 3;
/** item velocity step: 1/8 u/s */
export const ITEM_VEL_SCALE = 8;
/** Clock.dayTime: hours × 2048 */
export const CLOCK_HOUR_SCALE = 2048;
/** display name bytes (Roblox display names are ≤ 20 characters) */
export const NAME_MAX_BYTES = 80;
/** entries per SolidHp event */
export const SOLID_HP_MAX_ENTRIES = 255;
/** largest integer an f64 user id may carry */
const MAX_SAFE_INT = 9007199254740991;
/** UserIds one WorldReset can name (its count is a u8; a server holds far fewer players than this) */
export const WORLD_RESET_MAX_LIVES = 255;
/** largest runRev on the wire (SAVE_LIMITS.COUNTER_MAX is 10 000 000; a u32 holds it with room to spare) */
const RUN_REV_MAX = 4294967295;
/** (MP-23) the largest life day PlayerTally carries (a u16; the save's own ceiling is higher and is clamped) */
export const TALLY_DAY_MAX = 65535;
/** (MP-23) the largest kill count PlayerTally carries: the save's own counter ceiling */
export const TALLY_KILLS_MAX = SAVE_LIMITS.COUNTER_MAX;

export const DeathCause = {
	Shot: 0,
	Melee: 1,
	Explosion: 2,
	Fire: 3,
	Electric: 4,
	Turret: 5,
	Trap: 6,
	Admin: 7,
} as const;
const DEATH_CAUSE_MAX = 7;

/** PlayerLife.state (§7.3) */
export const LifeState = {
	Up: 0,
	Downed: 1,
	Revived: 2,
	Dead: 3,
} as const;
const LIFE_STATE_MAX = 3;

/** Announce.msg (the client builds the text from shared/data/lang.ts) */
export const AnnounceKind = {
	/** arg = wave number */
	Wave: 1,
	Morning: 2,
	Night: 3,
	/** arg = boss type */
	BossSpawn: 4,
	/** arg = boss type */
	BossKilled: 5,
	/** (MON-05) arg = the title byte (`titleToWire`, 1..TITLE_WIRE_MAX); sent only to the survivor who earned it */
	TitleUnlocked: 6,
} as const;
const ANNOUNCE_KIND_MAX = 6;

export interface WSolidAdd {
	t: typeof WorldEv.SolidAdd;
	/** dynamic id (≥ 1 000 000) */
	id: number;
	/** PLACEABLES id (client/systems/build.ts) */
	placeable: number;
	x: number;
	y: number;
	/** 0..3 quarter turns */
	rot: number;
	/** 0..1 */
	hp: number;
	/** SolidState */
	state: number;
	/** builder slot or SLOT_NONE */
	owner: number;
}

export interface WSolidRemove {
	t: typeof WorldEv.SolidRemove;
	id: number;
}

export interface WDoorSet {
	t: typeof WorldEv.DoorSet;
	id: number;
	/** SolidState (Open, Locked) */
	state: number;
}

export interface SolidHpEntry {
	id: number;
	/** 0..1 */
	hp: number;
}

export interface WSolidHp {
	t: typeof WorldEv.SolidHp;
	entries: Array<SolidHpEntry>;
}

export interface WLightSet {
	t: typeof WorldEv.LightSet;
	id: number;
	powered: boolean;
}

export interface WItemAdd {
	t: typeof WorldEv.ItemAdd;
	/** dynamic id (≥ 1 000 000) */
	id: number;
	/** ItemKind 1..4 */
	kind: number;
	itemId: number;
	/** ≥ 1 */
	count: number;
	x: number;
	y: number;
	/** u/s, ±4095 in 1/8 */
	vx: number;
	vy: number;
}

export interface WItemRemove {
	t: typeof WorldEv.ItemRemove;
	id: number;
}

export interface WLootFlag {
	t: typeof WorldEv.LootFlag;
	buildingId: number;
	hasLoot: boolean;
}

export interface WClock {
	t: typeof WorldEv.Clock;
	/** ≥ 1 */
	worldDay: number;
	/** hours [0, 24) */
	dayTime: number;
	/** tick (u16) at which the clock was sampled */
	tick: number;
	rain: boolean;
	/** raw wave bits (F2) */
	waveFlags: number;
}

export interface WAnnounce {
	t: typeof WorldEv.Announce;
	/** AnnounceKind */
	msg: number;
	arg: number;
}

export interface WZombieDied {
	t: typeof WorldEv.ZombieDied;
	netId: number;
	x: number;
	y: number;
	/** DeathCause */
	cause: number;
}

export interface WPlayerJoined {
	t: typeof WorldEv.PlayerJoined;
	slot: number;
	userId: number;
	name: string;
	level: number;
	/** OutfitLook (0 = none), MON-04 */
	outfit: number;
	/** PetLook (0 = none), MON-04 */
	pet: number;
	/** the title under the name, as `titleToWire` (0 = none), MON-05 */
	title: number;
}

/**
 * (MON-04, MON-05) What changed about a survivor already in the roster: the level on their plate, the outfit on their
 * body, the pet at their heel, the title under their name. Always all four (7 B with the tag): a delta this rare is
 * not worth a bitmask.
 */
export interface WPlayerProfile {
	t: typeof WorldEv.PlayerProfile;
	slot: number;
	level: number;
	outfit: number;
	pet: number;
	/** `titleToWire` (0 = none) */
	title: number;
}

export interface WPlayerLeft {
	t: typeof WorldEv.PlayerLeft;
	slot: number;
}

/**
 * (MP-23) The scoreboard's numbers of one survivor, as the SERVER's save has them: the day of this life and the zombies
 * its kill credit gave them (lifetime, MON-05's counter). 8 B with the tag; sent when one of them moves (at most once
 * a second per survivor) and in the round that follows a join.
 */
export interface WPlayerTally {
	t: typeof WorldEv.PlayerTally;
	slot: number;
	/** 1..TALLY_DAY_MAX */
	lifeDay: number;
	/** 0..TALLY_KILLS_MAX */
	kills: number;
}

export interface WPlayerLife {
	t: typeof WorldEv.PlayerLife;
	slot: number;
	/** LifeState */
	state: number;
}

export interface WInitBegin {
	t: typeof WorldEv.InitBegin;
	/** solid count + Σ id × coordinates mod 2^32 (§4.5) */
	mapHash: number;
	/** (MP-22) the seed the server's town was generated from: 1 … TOWN_SEED_MAX */
	seed: number;
	/** workspace:GetServerTimeNow() at tick 0 (§4.6) */
	tick0Time: number;
	/** the server's SIM_HZ */
	simHz: number;
	/** 0..chunks-1 */
	chunk: number;
	chunks: number;
}

/** (MP-22) one survivor the end of a world gave a new life: who, and the run the server's save is on now */
export interface WorldResetLife {
	userId: number;
	/** the save's runRev after the reset: the client takes it as it is (never its own value + 1) */
	runRev: number;
}

/**
 * (MP-22) Nobody was left alive and nobody paid a Rebirth: the world ended on `endedDay` and a new town was born from
 * `seed`, on day 1. Broadcast to every connected client, in the world or in the lobby: each one builds the new town,
 * and a client named in `lives` mirrors the new life the server gave it (the same reset as New game).
 */
export interface WWorldReset {
	t: typeof WorldEv.WorldReset;
	/** 1 … TOWN_SEED_MAX */
	seed: number;
	/** the world day the old town fell on (≥ 1) */
	endedDay: number;
	/** the survivors whose life the server reset to day 1 (at most WORLD_RESET_MAX_LIVES) */
	lives: Array<WorldResetLife>;
}

export type WorldEvent =
	| WSolidAdd
	| WSolidRemove
	| WDoorSet
	| WSolidHp
	| WLightSet
	| WItemAdd
	| WItemRemove
	| WLootFlag
	| WClock
	| WAnnounce
	| WZombieDied
	| WPlayerJoined
	| WPlayerLeft
	| WPlayerLife
	| WInitBegin
	| WPlayerProfile
	| WWorldReset
	| WPlayerTally;

export interface WorldBatch {
	tick: number;
	events: Array<WorldEvent>;
}

function writeWorldEvent(w: NetWriter, e: WorldEvent): void {
	w.u8(e.t);
	switch (e.t) {
		case WorldEv.SolidAdd:
			w.u32(e.id);
			w.u8(e.placeable);
			w.pos(e.x);
			w.pos(e.y);
			w.u8(clampInt(e.rot, 0, ROT_MAX));
			w.frac8(e.hp);
			w.u8(clampInt(e.state, 0, 255) & SOLID_STATE_MASK);
			w.u8(slotOrNone(e.owner));
			break;
		case WorldEv.SolidRemove:
			w.u32(e.id);
			break;
		case WorldEv.DoorSet:
			w.u32(e.id);
			w.u8(clampInt(e.state, 0, 255) & SOLID_STATE_MASK);
			break;
		case WorldEv.SolidHp: {
			const n = math.min(e.entries.size(), SOLID_HP_MAX_ENTRIES);
			w.u8(n);
			for (let i = 0; i < n; i++) {
				w.u32(e.entries[i].id);
				w.frac8(e.entries[i].hp);
			}
			break;
		}
		case WorldEv.LightSet:
			w.u32(e.id);
			w.bool(e.powered);
			break;
		case WorldEv.ItemAdd:
			w.u32(e.id);
			w.u8(clampInt(e.kind, 1, ITEM_KIND_MAX));
			w.u16(e.itemId);
			w.u16(clampInt(e.count, 1, 65535));
			w.pos(e.x);
			w.pos(e.y);
			w.i16(e.vx * ITEM_VEL_SCALE);
			w.i16(e.vy * ITEM_VEL_SCALE);
			break;
		case WorldEv.ItemRemove:
			w.u32(e.id);
			break;
		case WorldEv.LootFlag:
			w.u16(e.buildingId);
			w.bool(e.hasLoot);
			break;
		case WorldEv.Clock:
			w.u16(clampInt(e.worldDay, 1, 65535));
			w.u16(roundClamp(e.dayTime * CLOCK_HOUR_SCALE, 0, 24 * CLOCK_HOUR_SCALE - 1));
			w.tick16(e.tick);
			w.bool(e.rain);
			w.u8(e.waveFlags);
			break;
		case WorldEv.Announce:
			w.u8(clampInt(e.msg, 1, ANNOUNCE_KIND_MAX));
			w.u16(e.arg);
			break;
		case WorldEv.ZombieDied:
			w.u16(clampInt(e.netId, 1, 65535));
			w.pos(e.x);
			w.pos(e.y);
			w.u8(clampInt(e.cause, 0, DEATH_CAUSE_MAX));
			break;
		case WorldEv.PlayerJoined:
			w.u8(clampInt(e.slot, 0, MAX_PLAYERS - 1));
			w.f64(e.userId);
			w.str(e.name, NAME_MAX_BYTES);
			w.u16(clampInt(e.level, 0, 65535));
			w.u8(clampInt(e.outfit, 0, OUTFIT_LOOK_MAX));
			w.u8(clampInt(e.pet, 0, PET_LOOK_MAX));
			w.u8(clampInt(e.title, 0, TITLE_WIRE_MAX));
			break;
		case WorldEv.PlayerProfile:
			w.u8(clampInt(e.slot, 0, MAX_PLAYERS - 1));
			w.u16(clampInt(e.level, 0, 65535));
			w.u8(clampInt(e.outfit, 0, OUTFIT_LOOK_MAX));
			w.u8(clampInt(e.pet, 0, PET_LOOK_MAX));
			w.u8(clampInt(e.title, 0, TITLE_WIRE_MAX));
			break;
		case WorldEv.PlayerLeft:
			w.u8(clampInt(e.slot, 0, MAX_PLAYERS - 1));
			break;
		case WorldEv.PlayerTally:
			w.u8(clampInt(e.slot, 0, MAX_PLAYERS - 1));
			w.u16(clampInt(e.lifeDay, 1, TALLY_DAY_MAX));
			w.u32(clampInt(e.kills, 0, TALLY_KILLS_MAX));
			break;
		case WorldEv.PlayerLife:
			w.u8(clampInt(e.slot, 0, MAX_PLAYERS - 1));
			w.u8(clampInt(e.state, 0, LIFE_STATE_MAX));
			break;
		case WorldEv.InitBegin:
			w.u32(e.mapHash);
			w.u32(clampInt(e.seed, 1, TOWN_SEED_MAX));
			w.f64(e.tick0Time);
			w.u8(clampInt(e.simHz, 1, 255));
			w.u8(e.chunk);
			w.u8(clampInt(e.chunks, 1, 255));
			break;
		case WorldEv.WorldReset: {
			w.u32(clampInt(e.seed, 1, TOWN_SEED_MAX));
			w.u16(clampInt(e.endedDay, 1, 65535));
			const n = math.min(e.lives.size(), WORLD_RESET_MAX_LIVES);
			w.u8(n);
			for (let i = 0; i < n; i++) {
				w.f64(e.lives[i].userId);
				w.u32(clampInt(e.lives[i].runRev, 0, RUN_REV_MAX));
			}
			break;
		}
	}
}

function readWorldEvent(r: NetReader): WorldEvent | undefined {
	const t = r.u8();
	if (t === WorldEv.SolidAdd) {
		const id = r.u32();
		const placeable = r.u8();
		const x = r.pos();
		const y = r.pos();
		const rot = r.u8();
		const hp = r.frac8();
		const state = r.u8();
		const owner = r.u8();
		if (id < DYNAMIC_ID_BASE || rot > ROT_MAX || state > SOLID_STATE_MASK || !validSlotOrNone(owner)) {
			return undefined;
		}
		return { t: WorldEv.SolidAdd, id, placeable, x, y, rot, hp, state, owner };
	} else if (t === WorldEv.SolidRemove) {
		const id = r.u32();
		if (id < 1) return undefined;
		return { t: WorldEv.SolidRemove, id };
	} else if (t === WorldEv.DoorSet) {
		const id = r.u32();
		const state = r.u8();
		if (id < 1 || state > SOLID_STATE_MASK) return undefined;
		return { t: WorldEv.DoorSet, id, state };
	} else if (t === WorldEv.SolidHp) {
		const n = r.u8();
		if (n * 5 > r.remaining()) return undefined;
		const entries = new Array<SolidHpEntry>();
		for (let i = 0; i < n; i++) {
			const id = r.u32();
			const hp = r.frac8();
			if (id < 1) return undefined;
			entries.push({ id, hp });
		}
		return { t: WorldEv.SolidHp, entries };
	} else if (t === WorldEv.LightSet) {
		const id = r.u32();
		const powered = r.bool();
		if (id < 1) return undefined;
		return { t: WorldEv.LightSet, id, powered };
	} else if (t === WorldEv.ItemAdd) {
		const id = r.u32();
		const kind = r.u8();
		const itemId = r.u16();
		const count = r.u16();
		const x = r.pos();
		const y = r.pos();
		const vx = r.i16() / ITEM_VEL_SCALE;
		const vy = r.i16() / ITEM_VEL_SCALE;
		if (id < DYNAMIC_ID_BASE || kind < 1 || kind > ITEM_KIND_MAX || count < 1) return undefined;
		return { t: WorldEv.ItemAdd, id, kind, itemId, count, x, y, vx, vy };
	} else if (t === WorldEv.ItemRemove) {
		const id = r.u32();
		if (id < DYNAMIC_ID_BASE) return undefined;
		return { t: WorldEv.ItemRemove, id };
	} else if (t === WorldEv.LootFlag) {
		const buildingId = r.u16();
		const hasLoot = r.bool();
		return { t: WorldEv.LootFlag, buildingId, hasLoot };
	} else if (t === WorldEv.Clock) {
		const worldDay = r.u16();
		const dayQ = r.u16();
		const tick = r.u16();
		const rain = r.bool();
		const waveFlags = r.u8();
		if (worldDay < 1 || dayQ >= 24 * CLOCK_HOUR_SCALE) return undefined;
		return { t: WorldEv.Clock, worldDay, dayTime: dayQ / CLOCK_HOUR_SCALE, tick, rain, waveFlags };
	} else if (t === WorldEv.Announce) {
		const msg = r.u8();
		const arg = r.u16();
		if (msg < 1 || msg > ANNOUNCE_KIND_MAX) return undefined;
		// MON-05: a title that does not exist is not something to announce
		if (msg === AnnounceKind.TitleUnlocked && (arg < 1 || arg > TITLE_WIRE_MAX)) return undefined;
		return { t: WorldEv.Announce, msg, arg };
	} else if (t === WorldEv.ZombieDied) {
		const netId = r.u16();
		const x = r.pos();
		const y = r.pos();
		const cause = r.u8();
		if (netId < 1 || cause > DEATH_CAUSE_MAX) return undefined;
		return { t: WorldEv.ZombieDied, netId, x, y, cause };
	} else if (t === WorldEv.PlayerJoined) {
		const slot = r.u8();
		const userId = r.f64();
		const name = r.str(NAME_MAX_BYTES);
		const level = r.u16();
		const outfit = r.u8();
		const pet = r.u8();
		const title = r.u8();
		if (!validSlot(slot) || userId !== math.floor(userId) || math.abs(userId) > MAX_SAFE_INT) return undefined;
		if (outfit > OUTFIT_LOOK_MAX || pet > PET_LOOK_MAX || title > TITLE_WIRE_MAX) return undefined;
		return { t: WorldEv.PlayerJoined, slot, userId, name, level, outfit, pet, title };
	} else if (t === WorldEv.PlayerProfile) {
		const slot = r.u8();
		const level = r.u16();
		const outfit = r.u8();
		const pet = r.u8();
		const title = r.u8();
		if (!validSlot(slot)) return undefined;
		if (outfit > OUTFIT_LOOK_MAX || pet > PET_LOOK_MAX || title > TITLE_WIRE_MAX) return undefined;
		return { t: WorldEv.PlayerProfile, slot, level, outfit, pet, title };
	} else if (t === WorldEv.PlayerLeft) {
		const slot = r.u8();
		if (!validSlot(slot)) return undefined;
		return { t: WorldEv.PlayerLeft, slot };
	} else if (t === WorldEv.PlayerTally) {
		const slot = r.u8();
		const lifeDay = r.u16();
		const kills = r.u32();
		if (!validSlot(slot) || lifeDay < 1 || kills > TALLY_KILLS_MAX) return undefined;
		return { t: WorldEv.PlayerTally, slot, lifeDay, kills };
	} else if (t === WorldEv.PlayerLife) {
		const slot = r.u8();
		const state = r.u8();
		if (!validSlot(slot) || state > LIFE_STATE_MAX) return undefined;
		return { t: WorldEv.PlayerLife, slot, state };
	} else if (t === WorldEv.InitBegin) {
		const mapHash = r.u32();
		const seed = r.u32();
		const tick0Time = r.f64();
		const simHz = r.u8();
		const chunk = r.u8();
		const chunks = r.u8();
		if (!validTownSeed(seed) || simHz < 1 || chunks < 1 || chunk >= chunks) return undefined;
		return { t: WorldEv.InitBegin, mapHash, seed, tick0Time, simHz, chunk, chunks };
	} else if (t === WorldEv.WorldReset) {
		const seed = r.u32();
		const endedDay = r.u16();
		const n = r.u8();
		if (!validTownSeed(seed) || endedDay < 1 || n * 12 > r.remaining()) return undefined;
		const lives = new Array<WorldResetLife>();
		for (let i = 0; i < n; i++) {
			const userId = r.f64();
			const runRev = r.u32();
			if (userId !== math.floor(userId) || math.abs(userId) > MAX_SAFE_INT) return undefined;
			lives.push({ userId, runRev });
		}
		return { t: WorldEv.WorldReset, seed, endedDay, lives };
	}
	return undefined;
}

/** a seed TownRng (shared/game/world.ts) turns into a town of its own: 1 … TOWN_SEED_MAX */
function validTownSeed(seed: number): boolean {
	return seed >= 1 && seed <= TOWN_SEED_MAX;
}

const worldWriter = new NetWriter(1024, WORLD_MAX_BYTES);

/** one tick of reliable deltas (or one WorldInit block) → packets of ≤ WORLD_MAX_BYTES (usually one) */
export function encodeWorld(batch: WorldBatch): BatchEncodeResult {
	const tick = batch.tick;
	return encodeBatches(
		worldWriter,
		batch.events,
		(w: NetWriter) => {
			w.u8(PacketKind.World * 16);
			w.tick16(tick);
			w.u16(0);
		},
		3,
		true,
		writeWorldEvent,
	);
}

/** smallest World event on the wire (PlayerLeft: tag + slot) */
const WORLD_MIN_EVENT_BYTES = 2;

export function decodeWorld(payload: unknown): WorldBatch | undefined {
	if (!typeIs(payload, "buffer")) return undefined;
	const len = buffer.len(payload);
	if (len < WORLD_HEADER_BYTES || len > WORLD_MAX_BYTES) return undefined;
	const r = new NetReader(payload);
	if (r.u8() !== PacketKind.World * 16) return undefined;
	const tick = r.u16();
	const count = r.u16();
	if (count * WORLD_MIN_EVENT_BYTES > r.remaining()) return undefined;
	const events = new Array<WorldEvent>();
	for (let i = 0; i < count; i++) {
		const e = readWorldEvent(r);
		if (e === undefined || !r.ok()) return undefined;
		events.push(e);
	}
	if (!r.done()) return undefined;
	return { tick, events };
}

// ================================================================ clock sync (§4.6)

/** full (fractional) server tick at `serverNow` = workspace:GetServerTimeNow() (§4.6) */
export function serverTickAt(serverNow: number, tick0Time: number, simHz = SIM_HZ): number {
	return (serverNow - tick0Time) * simHz;
}

/** GetServerTimeNow() value at which `tick` (full) started */
export function serverTimeOfTick(tick: number, tick0Time: number, simHz = SIM_HZ): number {
	return tick0Time + tick / simHz;
}

export const TIME_PING_BYTES = 11;
export const TIME_PONG_BYTES = 23;

/** C→S probe; clientTime is whatever clock the client wants echoed (normally GetServerTimeNow()) */
export interface TimePing {
	seq: number;
	clientTime: number;
}

/** S→C answer: the echo + the server clock and tick when the ping was handled */
export interface TimePong {
	seq: number;
	clientTime: number;
	serverTime: number;
	/** full server tick (u32) */
	serverTick: number;
}

export function encodeTimePing(p: TimePing): buffer | undefined {
	const w = new NetWriter(TIME_PING_BYTES, TIME_PING_BYTES);
	w.u8(PacketKind.TimePing * 16);
	w.tick16(p.seq);
	w.f64(p.clientTime);
	return w.finish();
}

export function decodeTimePing(payload: unknown): TimePing | undefined {
	if (!typeIs(payload, "buffer") || buffer.len(payload) !== TIME_PING_BYTES) return undefined;
	const r = new NetReader(payload);
	if (r.u8() !== PacketKind.TimePing * 16) return undefined;
	const seq = r.u16();
	const clientTime = r.f64();
	if (!r.done()) return undefined;
	return { seq, clientTime };
}

export function encodeTimePong(p: TimePong): buffer | undefined {
	const w = new NetWriter(TIME_PONG_BYTES, TIME_PONG_BYTES);
	w.u8(PacketKind.TimePong * 16);
	w.tick16(p.seq);
	w.f64(p.clientTime);
	w.f64(p.serverTime);
	w.u32(p.serverTick);
	return w.finish();
}

export function decodeTimePong(payload: unknown): TimePong | undefined {
	if (!typeIs(payload, "buffer") || buffer.len(payload) !== TIME_PONG_BYTES) return undefined;
	const r = new NetReader(payload);
	if (r.u8() !== PacketKind.TimePong * 16) return undefined;
	const seq = r.u16();
	const clientTime = r.f64();
	const serverTime = r.f64();
	const serverTick = r.u32();
	if (!r.done()) return undefined;
	return { seq, clientTime, serverTime, serverTick };
}

// ---------------------------------------------------------------- Intent (C->S, reliable, ordered)

/**
 * What a client may ASK for. Reliable and ordered, because it changes who exists in the world -- and it is
 * the smallest surface a client can push on, so it is a single validated byte and nothing else.
 *
 * EnterWorld / LeaveWorld exist because being connected is not the same as playing: a player reading the
 * shop or the credits should not have a body standing in the street for the horde to find (§7.1). The
 * server decides WHERE and WHETHER; the client only ever says that it wants in or out.
 */
export const IntentKind = {
	EnterWorld: 1,
	LeaveWorld: 2,
	/** F3, §8.1: arg = CRAFT_RECIPES id */
	Craft: 3,
	/** F3, §8.1: arg = USABLES id */
	UseItem: 4,
	/** F3, §8.1: arg = EQUIPS id */
	Equip: 5,
	/** F3, §8.1: arg = equipment slot 1..5 (`EquipSlot`: cloth, hand, gun, outfit, pet) */
	Unequip: 6,
	/** F3, §8.1: arg = SKILLS id */
	LearnSkill: 7,
} as const;
export type IntentKind = (typeof IntentKind)[keyof typeof IntentKind];
const INTENT_KIND_MAX = 7;

/**
 * The presence verbs (EnterWorld / LeaveWorld) are a bare kind and nothing else — that is the whole payload,
 * and it stays that way. From F3 the backpack verbs carry one argument and the `seq` of the command the
 * player made them during (§2.4), so "I switched, then I crafted" applies in that order however the packets
 * arrive. Two lengths, one header: a decoder tells them apart by size, and anything else is malformed.
 *
 * Note what is NOT here. There is no `pickup(itemId)`, no `interact(solidId)`, no `place(x, y)`: those ride
 * the input command's own edges and the server picks the target itself, at the position it simulated
 * (server/sim/interaction.ts). A verb that names a target is a verb that can name the wrong one.
 */
export const INTENT_BYTES = 2;
/** kind, verb, atSeq u16, arg u16, reserved u16 */
export const INTENT_ARGS_BYTES = 8;
/** the first verb that carries arguments */
const INTENT_ARGS_FROM = 3;

/** a decoded intent: `arg` and `atSeq` are 0 for the two presence verbs */
export interface IntentMessage {
	kind: IntentKind;
	/** the `seq` of the command this was made during (§2.4); 0 when the sender did not say */
	atSeq: number;
	/** the verb's single argument — a recipe, a usable, an equipment, a slot or a skill */
	arg: number;
}

export function encodeIntent(kind: IntentKind): buffer | undefined {
	const w = new NetWriter(INTENT_BYTES, INTENT_BYTES);
	w.u8(PacketKind.Intent * 16);
	w.u8(kind);
	return w.finish();
}

/** one of the F3 verbs, with its argument and the command it belongs to (§2.4) */
export function encodeIntentArgs(kind: IntentKind, atSeq: number, arg: number): buffer | undefined {
	if (kind < INTENT_ARGS_FROM || kind > INTENT_KIND_MAX) return undefined;
	const w = new NetWriter(INTENT_ARGS_BYTES, INTENT_ARGS_BYTES);
	w.u8(PacketKind.Intent * 16);
	w.u8(kind);
	w.u16(wrapU16(atSeq));
	w.u16(clampInt(arg, 0, 65535));
	w.u16(0);
	return w.finish();
}

/**
 * Undefined for anything that is not exactly one of the intents above (§8.1: never trust the client).
 * The presence verbs only ever arrive in the short form and the backpack verbs only in the long one, so a
 * Craft packed as 2 bytes — or an EnterWorld padded to 8 — is malformed, not "close enough".
 */
export function decodeIntentMessage(payload: unknown): IntentMessage | undefined {
	if (!typeIs(payload, "buffer")) return undefined;
	const len = buffer.len(payload);
	if (len !== INTENT_BYTES && len !== INTENT_ARGS_BYTES) return undefined;
	const r = new NetReader(payload);
	if (r.u8() !== PacketKind.Intent * 16) return undefined;
	const kind = r.u8();
	if (kind < 1 || kind > INTENT_KIND_MAX) return undefined;
	if (len === INTENT_BYTES) {
		if (kind >= INTENT_ARGS_FROM || !r.done()) return undefined;
		return { kind: kind as IntentKind, atSeq: 0, arg: 0 };
	}
	if (kind < INTENT_ARGS_FROM) return undefined;
	const atSeq = r.u16();
	const arg = r.u16();
	if (r.u16() !== 0) return undefined;
	if (!r.done()) return undefined;
	return { kind: kind as IntentKind, atSeq, arg };
}

/** the presence half of `decodeIntentMessage`, kept for server/net/mpHost.ts's EnterWorld/LeaveWorld handler */
export function decodeIntent(payload: unknown): IntentKind | undefined {
	const msg = decodeIntentMessage(payload);
	if (msg === undefined) return undefined;
	if (msg.kind !== IntentKind.EnterWorld && msg.kind !== IntentKind.LeaveWorld) return undefined;
	return msg.kind;
}

/** round-trip time of a pong received at `clientNow` (same clock as the ping's clientTime) */
export function pongRtt(p: TimePong, clientNow: number): number {
	return math.max(0, clientNow - p.clientTime);
}

/** server clock − client clock, assuming a symmetric path (≈ 0 when clientTime is GetServerTimeNow()) */
export function pongClockOffset(p: TimePong, clientNow: number): number {
	return p.serverTime - (p.clientTime + clientNow) / 2;
}
