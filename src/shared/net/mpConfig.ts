/*
 * Multiplayer configuration (docs/MULTIPLAYER.md). Every number below comes from the doc; the comment
 * names the section. Change the doc and this file together.
 *
 * F0: nothing in the running game reads these yet. MP_PHASE = 0 keeps the current mode (each client
 * simulates its own world; the server only owns save, coins and shop). Phases F1..F5 turn server
 * subsystems on as the value grows (§11.1).
 */

/** migration phase switch (§11.1): 0 = current game (one world per client); 1..5 = server subsystems on */
export const MP_PHASE = 0 as number;

// ---------------------------------------------------------------- frequencies (§0.1, §3.1, §3.4)

/**
 * Fixed server simulation rate (§3.1). Movement, combat, collisions, damage and pickups run at this rate;
 * one input command is consumed per tick. Replicated to the client in LoadAck/WorldInit. Author's fallback:
 * drop to SIM_HZ_FALLBACK when the F2 measurement gives tick p95 > TICK_BUDGET_P95_MS, without any
 * protocol change (the replication divisors below are recomputed from SIM_HZ).
 */
export const SIM_HZ = 60 as number;
export const SIM_HZ_FALLBACK = 30;
/** seconds per simulation tick */
export const TICK_DT = 1 / SIM_HZ;
/** at most this many ticks per server Heartbeat when catching up; beyond that time is dropped (§3.1) */
export const MAX_CATCHUP_TICKS = 2;
/** simulation budget per tick, p95, 6 players + 150 zombies (§3.2) */
export const TICK_BUDGET_P95_MS = 6;
/** expected average simulation cost per tick (§3.2) */
export const TICK_BUDGET_AVG_MS = 3;

/** input commands per second = one per simulation tick (§2.2) */
export const INPUT_HZ = SIM_HZ;
/** client sampling-rate dilation to keep the server input queue near its target depth: ±2% (§2.2) */
export const INPUT_DILATION = 0.02;

/** snapshot rate of the near interest ring (§4.1, §4.3) */
export const SNAP_NEAR_HZ = 20;
/** per-entity rate of the mid interest ring: half of the mid zombies per snapshot, rotating (§4.3) */
export const SNAP_MID_HZ = 10;
/** reliable deltas (World) are flushed as one batch per tick when there is something to send (§3.1) */
export const WORLD_FLUSH_EVERY_TICKS = 1;
/** construction HP deltas (SolidHp) are batched at this rate (§4.5) */
export const SOLID_HP_HZ = 4;
/** the server re-sends the Clock delta at least this often (seconds) and on every change (§4.5, §4.6) */
export const CLOCK_RESYNC_S = 10;

/** zombie AI decision/steering rate by ring (§3.4); integrated movement still runs every tick */
export const AI_NEAR_HZ = 30;
export const AI_MID_HZ = 15;
export const AI_FAR_HZ_MIN = 5;
export const AI_FAR_HZ_MAX = 10;
/** AI LOD ring limits: near ≤ 800 u of any player, mid 800–1600 u, far beyond (§3.4) */
export const AI_NEAR_RANGE = 800;
export const AI_MID_RANGE = 1600;
/** multi-source flow field: full rebuild target rate and time budget per tick (§3.3) */
export const FLOW_FIELD_HZ_MIN = 5;
export const FLOW_FIELD_HZ_MAX = 10;
export const FLOW_FIELD_BUDGET_MS = 2;

/**
 * Whole number of simulation ticks between two sends at `hz`, rounded to the closest integer and never
 * below 1 (§3.1: the divisors follow SIM_HZ so 20/10 Hz stay as close as possible at 30 or 60 Hz).
 */
export function ticksPer(hz: number, simHz = SIM_HZ): number {
	if (!(hz > 0) || !(simHz > 0)) return 1;
	return math.max(1, math.floor(simHz / hz + 0.5));
}

/** near-ring snapshot divisor: every 3 ticks at 60 Hz (§3.1 step 4) */
export const SNAP_NEAR_EVERY_TICKS = ticksPer(SNAP_NEAR_HZ);
/** mid-ring full refresh divisor: every 6 ticks at 60 Hz (§4.1) */
export const SNAP_MID_EVERY_TICKS = ticksPer(SNAP_MID_HZ);

// ---------------------------------------------------------------- players and caps (§0 D7, §3.5, §4.4)

/** players per server (§0, Players.MaxPlayers is set by hand in the Creator Dashboard, §1.1) */
export const MAX_PLAYERS = 6;
/** player slots are 0..MAX_PLAYERS-1, stable during the session (§4.4); this value means "no player" */
export const SLOT_NONE = 255;
/** hard server cap of live zombies (§3.5) and the admin override (§10) */
export const MAX_ZOMBIES = 150;
export const MAX_ZOMBIES_ADMIN = 250;
/** simultaneous bosses (§3.5) */
export const MAX_BOSSES = 2;
/** zombie archetype ids 1..5 (shared/data/zombies.ts); the snapshot carries them in 3 bits (§4.2) */
export const ZOMBIE_TYPE_MAX = 5;
/** boss type ids 1..4 (DESIGN.BOSS1..BOSS4 in shared/engine/constants.ts) */
export const BOSS_TYPE_MAX = 4;
/** zombie netIds: recyclable u16 pool 1..65535; a freed id waits this long before reuse (§4.4) */
export const NET_ID_MIN = 1;
export const NET_ID_MAX = 65535;
export const NET_ID_REUSE_DELAY_S = 2;
/** boss netIds are u8 (§4.2) */
export const BOSS_NET_ID_MAX = 255;
/** dynamic ids (constructions, ground items) are server-assigned from here up (§1, §4.5) */
export const DYNAMIC_ID_BASE = 1000000;
/** constructions per player / per server (§8.1) */
export const MAX_BUILDS_PER_PLAYER = 150;
export const MAX_BUILDS_PER_SERVER = 600;

// ---------------------------------------------------------------- input (§2.2, §8.1)

/** one quantized command (§2.2) */
export const CMD_BYTES = 8;
/** Input header: count u8, viewTick u16, viewFrac u8 (§2.2) */
export const INPUT_HEADER_BYTES = 4;
/** commands per Input packet: the new one + the 2 previous ones as redundancy (§2.2) */
export const INPUT_REDUNDANCY = 3;
/** 4 + 3 × 8 = 28 bytes (§2.2) */
export const INPUT_MAX_BYTES = INPUT_HEADER_BYTES + INPUT_REDUNDANCY * CMD_BYTES;
/** server input queue: target depth and maximum (§2.2) */
export const INPUT_BUFFER_TARGET = 2;
export const INPUT_BUFFER_MAX = 4;
/** a command seq must be within ±64 of the last consumed one (§8.1) */
export const INPUT_SEQ_WINDOW = 64;

// ---------------------------------------------------------------- interest management (§4.3, §4.4, §4.5, §10)

/** near ring (snapshots at SNAP_NEAR_HZ) */
export const INTEREST_NEAR = 800;
/** mid ring (per entity at SNAP_MID_HZ) */
export const INTEREST_MID = 1500;
/** leave-interest radius (hysteresis over INTEREST_MID) */
export const INTEREST_EXIT = 1650;
/** in the dark a zombie outside every light is still sent when this close to the player (§4.3) */
export const DARK_SENSE_RANGE = 150;
/** ground items interest radius (§4.5) */
export const ITEM_INTEREST = 1800;
/** admin free camera: interest radius cap (§10) */
export const FREECAM_MAX_RANGE = 3000;
/** client-side removal of an entity not seen for this long, by ring, and its fade-out (§4.4) */
export const DESPAWN_NEAR_S = 0.3;
export const DESPAWN_MID_S = 0.6;
export const DESPAWN_FADE_S = 0.15;

// ---------------------------------------------------------------- packet sizes (§1.1, §4.1, §4.2, §4.5)

/** UnreliableRemoteEvent drops payloads above this many bytes (engine limit, §1.1) */
export const UNRELIABLE_PAYLOAD_LIMIT = 1000;
/** own ceiling for raw unreliable payloads (Snap, Fx, Input): margin under the engine limit (§4.1) */
export const UNRELIABLE_MAX_BYTES = 900;
/** one Snap part (§4.1) */
export const SNAP_MAX_BYTES = UNRELIABLE_MAX_BYTES;
/** a snapshot is split into self-contained parts; the header has 2 bits for the count (§4.2) */
export const SNAP_MAX_PARTS = 4;
/** one Fx batch (§4.1) */
export const FX_MAX_BYTES = UNRELIABLE_MAX_BYTES;
/** one World batch / WorldInit block (§4.5: blocks of buffer ≤ 16 KB) */
export const WORLD_MAX_BYTES = 16384;

// ---------------------------------------------------------------- rate limits (§2.2, §8.2, §9.2)

/** Input: token bucket of 120 packets/s with a burst of 40 (twice the real 60/s) */
export const INPUT_RATE = 120;
export const INPUT_BURST = 40;
/** Intent (reliable C→S) */
export const INTENT_RATE = 20;
export const INTENT_BURST = 30;
/** ShopAction (already enforced by server/main.server.ts) */
export const SHOP_RATE = 2;
export const SHOP_BURST = 6;
/** admin requests */
export const ADMIN_RATE = 10;
export const ADMIN_BURST = 10;
/** TimeSync probe (decision F0A, not in the doc): at most 2/s, burst 4 */
export const TIME_SYNC_RATE = 2;
export const TIME_SYNC_BURST = 4;
/** automatic kick ("network flood"): > 3× a channel limit sustained for 5 s … */
export const FLOOD_RATE_MULT = 3;
export const FLOOD_RATE_WINDOW_S = 5;
/** … or > 500 messages in 2 s … */
export const FLOOD_MESSAGES = 500;
export const FLOOD_MESSAGES_WINDOW_S = 2;
/** … or > 50 malformed payloads in 10 s */
export const FLOOD_MALFORMED = 50;
export const FLOOD_MALFORMED_WINDOW_S = 10;

// ---------------------------------------------------------------- lag compensation (§2.3)

/** zombie/boss position history ring: 24 ticks = 400 ms at 60 Hz */
export const HISTORY_TICKS = 24;
/** maximum hitscan rewind */
export const REWIND_MAX_S = 0.3;
/** melee is not rewound; it gets a latency margin instead */
export const MELEE_RANGE_MARGIN = 12;
export const MELEE_ARC_MARGIN_DEG = 6;
/** optional "fair bite": rewind cap of the victim's view */
export const FAIR_BITE_REWIND_MAX_S = 0.15;

// ---------------------------------------------------------------- client smoothing (§2.2, §5.1, §5.2)

/** interpolation delay: default, adaptive clamp */
export const INTERP_DEFAULT_S = 0.1;
export const INTERP_MIN_S = 0.08;
export const INTERP_MAX_S = 0.25;
/** extrapolation when the interpolation buffer runs dry */
export const EXTRAPOLATE_MAX_S = 0.1;
/** reconciliation: re-simulate above this error; visual offset decays with this τ; snaps above this */
export const RECONCILE_EPS = 0.01;
export const VISUAL_OFFSET_TAU_S = 0.1;
export const VISUAL_SNAP_DIST = 64;

// ---------------------------------------------------------------- bandwidth targets (§4.7, §12.2)

/** per-client downstream, worst case (6 players, night, max horde) */
export const BANDWIDTH_WORST_BPS = 23000;
/** informal target (reached with the "mid ring at 5 Hz" lever) */
export const BANDWIDTH_TARGET_BPS = 20000;
/** typical case (day, 3 players, 25 visible zombies) upper bound */
export const BANDWIDTH_TYPICAL_BPS = 8000;
