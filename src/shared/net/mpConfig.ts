/*
 * Multiplayer configuration (docs/MULTIPLAYER.md). Every number below comes from the doc; the comment
 * names the section. Change the doc and this file together.
 *
 * MP_PHASE decides how much of the game the server owns (§11.1), and it grows one phase at a time:
 *   0  each client simulates its own world; the server only owns save, coins and shop.
 *   1  the server owns PLAYER MOVEMENT (tick, input queue, snapshots, interest); zombies are still
 *      simulated locally by each client, so two clients see different hordes.
 *   2  the server owns THE WORLD: the horde and the bosses (§3.3, §3.5), the clock and the night waves
 *      (§4.6), every shot, bite and point of damage (§2.3) and the XP (§3.6). The client simulates
 *      nothing any more -- it draws the snapshot it receives (§4.2) and predicts only its own movement
 *      and its own weapon cosmetics (§2.5). One horde, one clock, one set of netIds, on every screen.
 * tools/test-net.mjs pins the value, so it cannot move by accident: change both together.
 */

/** migration phase switch (§11.1): 0 = current game (one world per client); 1..5 = server subsystems on */
export const MP_PHASE = 2 as number;

/**
 * MP_PHASE from which the SERVER owns the interactive world AND the backpack (§11.3 F3): ground items, loot,
 * doors, lights, fires, trees/cars/bins, constructions, crafting, the inventory, the ammunition, what is equipped
 * and the skills. Both sides read it: server/sim/simulation.ts builds the F3 systems, server/main.server.ts pins
 * the backpack fields of a report to the server's copy (server/sim/backpack.ts `stripClientBackpack`), and the
 * client stops making its own items and doors, mirrors the `World` deltas and sends the backpack verbs as
 * intents (client/net/backpackSync.ts, client/net/worldMirror.ts).
 *
 * It is ONE switch on purpose: a report may only stop carrying the inventory when every road that fills it
 * (pickups, loot, crafting, a refunded build) runs on the server. Raise it above MP_PHASE to roll back to the
 * report-driven backpack.
 *
 * 2 since the QA sweep's NET-1..6 (docs/MULTIPLAYER.md §4.8): at 3, a weapon switch, a meal, the armour and the
 * skills reached the server only in a save report, the report could write any backpack at all, and a construction
 * existed only on the screen of whoever built it. tools/test-items.mjs G4 pins it.
 */
export const WORLD_SERVER_PHASE = 2 as number;

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
/** at most this many ticks per server Heartbeat when catching up (§3.1, server/sim/heartbeat.ts) */
export const MAX_CATCHUP_TICKS = 2;
/**
 * Heartbeat debt the server carries into the next heartbeats instead of dropping it (§3.1, server/sim/heartbeat.ts):
 * a hitch shorter than this is paid back at MAX_CATCHUP_TICKS per heartbeat, and the world loses no time. Only a
 * debt past it is dropped, where catching up would be the storm the cap exists to avoid -- and the clients follow
 * that on their own (client/net/clockSync.ts re-anchors on the server's tick).
 *
 * A repaid tick consumes a command like any other, so the input queue keeps the commands that landed during the
 * hitch instead of capping them at INPUT_BUFFER_MAX (INPUT_GRACE_MAX below, server/sim/players.ts): without that
 * the repayment emptied every queue (the review of 2026-09-23: 0 -> 3.91 waits a second, tools/test-input-buffer.mjs
 * case 5). Only while the debt IS repaid: a heartbeat under 30 Hz owes ticks it never runs (server/sim/heartbeat.ts).
 * Dropping instead costs every client a hitch of the whole world (tools/test-zombie-motion.mjs, `server`).
 */
export const MAX_BACKLOG_S = 0.25;
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
/**
 * The reliable `World` deltas and the `Fx` effects go out on the snapshot's cadence, one batch each (audit M3): the
 * client plays an effect when its drawing reaches the effect's tick (client/net/fxTimeline.ts), so a batch per tick
 * bought nothing but three times the events -- up to 60 Fx and 60 World a second per client in a fight. What cannot
 * wait a tick or two -- InitBegin, WorldReset, PlayerLife -- flushes the World batch at once (server/net/replication.ts
 * `urgent`).
 */
export const WORLD_FLUSH_EVERY_TICKS = SNAP_NEAR_EVERY_TICKS;
export const FX_FLUSH_EVERY_TICKS = SNAP_NEAR_EVERY_TICKS;

// ---------------------------------------------------------------- players and caps (§0 D7, §3.5, §4.4)

/** players per server (§0, Players.MaxPlayers is set by hand in the Creator Dashboard, §1.1) */
export const MAX_PLAYERS = 6;
/** player slots are 0..MAX_PLAYERS-1, stable during the session (§4.4); this value means "no player" */
export const SLOT_NONE = 255;
/** hard server cap of live zombies (§3.5) and the admin override (§10: an admin's spawns may go past it, up to it) */
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
/** constructions per player (counted by the builder's ACCOUNT, MP-24) / per server (§8.1) */
export const MAX_BUILDS_PER_PLAYER = 150;
export const MAX_BUILDS_PER_SERVER = 600;
/**
 * (MP-24) A builder out of the world this long -- a disconnect, the shop, the lobby all fit in it -- and their
 * constructions start to rot; they lose their whole hp over BUILD_ABANDON_DECAY_S more and fall, unless the builder
 * comes back or somebody in the world repairs them (and so takes them over). One account, or a handful, cannot hold
 * the server's MAX_BUILDS_PER_SERVER for ever.
 */
export const BUILD_ABANDON_GRACE_S = 600;
export const BUILD_ABANDON_DECAY_S = 300;
/**
 * Largest town seed (MP-22). shared/game/world.ts `TownRng` is MINSTD: it reduces a seed modulo 2^31 − 1 and maps 0
 * to 1, so 1 … 2^31 − 2 are exactly the seeds that each build a town of their own. InitBegin and WorldReset carry
 * one; the server draws one at boot and a new one when a world ends (server/sim/worldReset.ts).
 */
export const TOWN_SEED_MAX = 2147483646;
/**
 * Workspace attribute holding the seed of the town the server runs NOW. The server is the one authority on its town
 * (it picks the seed at boot and again when a world ends, MP-22); this is how every client hears it, the moment it
 * joins and before it presses anything: the lobby draws THAT town behind the menus (client/boot/serverTown.ts, UI-10),
 * and the match builds it. Replicated state, written only by the server (server/net/mpHost.ts, at boot and when a new
 * town stands); the InitBegin a client gets on entry confirms it, and a WorldReset tells every connected client the
 * moment it changes. No client ever proposes a seed: nothing a client sends carries one.
 */
export const WORLD_SEED_ATTRIBUTE = "pz_world_seed";
/**
 * ServerStorage attribute a developer may set to PIN the first town's seed (a town reproduced in Studio; the node
 * suites that play on the validated DESIGN.TOWN_SEED). Server-only: ServerStorage is never replicated, so no client can
 * read or write it. Unset (the published game), every server opens on a fresh seed. server/main.server.ts reads it;
 * a pin on a live server is logged as a warning (every server would open on the same town).
 */
export const TOWN_SEED_PIN_ATTRIBUTE = "pz_town_seed";

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
/**
 * The most the queue's ceiling may be raised while the SERVER repays ticks it owes (a hitch, then its debt): one
 * command for every tick the Heartbeat will still run, so the repayment finds its commands (MAX_BACKLOG_S). Only a
 * debt being repaid counts (server/sim/heartbeat.ts `grace`); the client cannot raise it -- only the server's own
 * lateness does -- and every tick still consumes exactly one command.
 */
export const INPUT_GRACE_MAX = math.floor(MAX_BACKLOG_S * SIM_HZ + 0.5) + MAX_CATCHUP_TICKS;
/** a command seq must be within ±64 of the last consumed one (§8.1) */
export const INPUT_SEQ_WINDOW = 64;

// ---------------------------------------------------------------- interest management (§4.3, §4.4, §4.5, §10)

/** near ring (snapshots at SNAP_NEAR_HZ) */
export const INTEREST_NEAR = 800;
/**
 * A body already in the near ring leaves it only past this (hysteresis, like INTEREST_EXIT over INTEREST_MID). Each
 * change of ring changes how far back the client draws it (client/net/snapshotBuffer.ts `extra`, eased over a second)
 * and the server has to follow that to judge a shot at it (server/net/interest.ts); a body hovering on 800 u must not
 * flip it every snapshot (the review of dee095a, S3).
 */
export const INTEREST_NEAR_EXIT = 880;
/** mid ring (per entity at SNAP_MID_HZ) */
export const INTEREST_MID = 1500;
/** leave-interest radius (hysteresis over INTEREST_MID) */
export const INTEREST_EXIT = 1650;
/** in the dark a zombie outside every light is still sent when this close to the player (§4.3) */
export const DARK_SENSE_RANGE = 150;
/** ground items interest radius (§4.5) */
export const ITEM_INTEREST = 1800;
/**
 * The server's ground items (§4.5, §8.1; security review of 5967a18, #3): every one is world litter (a drop, a
 * bin, a tree, the population's scatter, a trophy), and it rots GROUND_ITEM_LIFE_S after it appeared; and the town
 * never holds more than GROUND_ITEM_CAP, the OLDEST going first. A chainsaw at one car made 73 a minute that
 * nothing took away, and the sweep, the E press and every join read all of them. An honest night leaves a few
 * hundred at most: the cap is for a farm, the lifetime for a town nobody tidies.
 */
export const GROUND_ITEM_LIFE_S = 600;
export const GROUND_ITEM_CAP = 1000;
/**
 * (§4.3, audit L2) A ground item younger than this is NEWS: it fell where something happened just now -- a zombie
 * died there, a survivor dropped or spilled something -- so it is told only to a viewer who could see the spot, by the
 * roof and dark rules the horde is sent by (server/sim/items.ts `sees`). Older, it is litter, told in range as before:
 * asked of every item, the rule would pop each one into the light as a survivor walks up to it at night (the sweep runs
 * twice a second) and cost a light test per item in range per sweep.
 */
export const ITEM_NEWS_S = 30;
/** admin free camera (§10): the point the admin's interest follows is kept this close to their body */
export const FREECAM_MAX_RANGE = 3000;
/** client-side removal of an entity not seen for this long, by ring, and its fade-out (§4.4) */
export const DESPAWN_NEAR_S = 0.3;
export const DESPAWN_MID_S = 0.6;
export const DESPAWN_FADE_S = 0.15;
/**
 * A received body's fade-in, alpha per second (client/net/snapshotBuffer.ts). The server needs it too: a track that
 * never fully appeared fades out sooner, and server/net/interest.ts has to know when the client's track is gone.
 */
export const TRACK_FADE_IN_RATE = 3;

// ---------------------------------------------------------------- packet sizes (§1.1, §4.1, §4.2, §4.5)

/** UnreliableRemoteEvent drops payloads above this many bytes (engine limit, §1.1) */
export const UNRELIABLE_PAYLOAD_LIMIT = 1000;
/** own ceiling for raw unreliable payloads (Snap, Fx, Input): margin under the engine limit (§4.1) */
export const UNRELIABLE_MAX_BYTES = 900;
/** one Snap part (§4.1) */
export const SNAP_MAX_BYTES = UNRELIABLE_MAX_BYTES;
/** a snapshot is split into self-contained parts; the header has 2 bits for the count (§4.2) */
export const SNAP_MAX_PARTS = 4;
/**
 * Zombies in ONE snapshot, nearest first (§4.2's worst case: 60 of the near ring + half of a 60-strong mid
 * ring). The protocol would carry four parts, but four parts at 20 Hz is 72 kB/s — three times the §4.7
 * budget — so the cap is what keeps a 150-strong horde inside two packets and inside the bandwidth target.
 * Whatever does not fit is the FURTHEST away, which is also the least worth drawing.
 */
export const SNAP_ZOMBIE_CAP = 90;
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
/**
 * §2.4: a backpack verb waits for the command it was made during (`atSeq`) at most this many ticks after it
 * arrived; past that it lands on the next tick anyway. 0.5 s at 60 Hz: far above any honest reordering between
 * the reliable `Intent` and the unreliable `Input`, and short enough that a forged `atSeq` buys nothing.
 */
export const INTENT_HOLD_TICKS = 30;
/** backpack verbs one survivor may have waiting in the simulation at once (the wire rate caps it anyway) */
export const INTENT_QUEUE_MAX = 8;
/** ShopAction: the bucket of shared/net/shopGuard.ts, kept by the server and by the client alike */
export const SHOP_RATE = 2;
export const SHOP_BURST = 6;
/**
 * Admin remote: a NON-admin calling it faster than this (per second, past a burst of ADMIN_BURST) is flooding a remote
 * the game never lets them use, and is kicked, once, with one audit entry (server/admin/adminServer.ts, §9.2 level 2).
 * An admin's own requests have the panel's bucket there (4/s, burst 12) and the free camera one of its own (§10: 5/s).
 */
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

/**
 * zombie/boss position history ring: 24 ticks = 400 ms at 60 Hz, which must hold the deepest rewind --
 * REWIND_MAX_S + MID_REWIND_EXTRA_S -- plus two ticks (tools/test-combat.mjs c' checks it)
 */
export const HISTORY_TICKS = 24;
/**
 * Maximum hitscan rewind of a body the shooter draws in the NEAR ring. One drawn in the mid ring is rewound up to
 * MID_REWIND_EXTRA_S further (350 ms in all): it is drawn that much further back (§2.3; the review of dee095a, N3).
 */
export const REWIND_MAX_S = 0.3;
/**
 * A target the shooter draws in the MID ring is drawn that much further back (client/net/snapshotBuffer.ts, the
 * track's `extra`: one near interval, 3 ticks at 60 Hz), so the server rewinds it that much further too -- and
 * lets its ceiling reach as much further for it alone, this at most (§2.3; the review of 2026-09-23, #2): a body
 * still easing into the mid ring gets the part of it that it is drawn back (server/sim/combat.ts `prepareTargets`).
 */
export const MID_REWIND_EXTRA_S = 0.05;
/**
 * The declared view is judged within this many ticks of the shooter's own running offset (§2.3 continuity): an
 * honest client's view moves smoothly, so a view that jumps inside the ping ceiling for one shot is clamped back.
 */
export const VIEW_CONTINUITY_TICKS = 3;

/** how many ticks further back than the buffer's render time a client draws a body of the mid ring (§4.3, §5.1) */
export function midViewExtraTicks(simHz = SIM_HZ): number {
	return math.max(0, ticksPer(SNAP_MID_HZ, simHz) - ticksPer(SNAP_NEAR_HZ, simHz));
}
/**
 * Melee is not rewound; it gets a latency margin of reach instead (§2.3): what a walker (MELEE_MARGIN_UPS) covers
 * in the time an honest view is old -- the measured ping, the queue's TARGET wait (the measured one is the client's
 * to choose: a queue kept at INPUT_BUFFER_MAX bought ~6 u) and the interpolation delay -- never less
 * than MELEE_RANGE_MARGIN (the old fixed 130 ms) nor more than MELEE_RANGE_MARGIN_MAX (server/sim/combat.ts
 * `meleeMargin`). At 140 ms of RTT a body is drawn ~225 ms old: 20 u of walk the fixed 12 u did not cover.
 */
export const MELEE_RANGE_MARGIN = 12;
export const MELEE_RANGE_MARGIN_MAX = 24;
/** the walker speed the melee margin is sized for, units per second (90 u/s, shared/data/zombies.ts type 1) */
export const MELEE_MARGIN_UPS = 90;
export const MELEE_ARC_MARGIN_DEG = 6;
/** optional "fair bite": rewind cap of the victim's view */
export const FAIR_BITE_REWIND_MAX_S = 0.15;

// ---------------------------------------------------------------- client smoothing (§2.2, §5.1, §5.2)

/** interpolation delay: default, adaptive clamp */
export const INTERP_DEFAULT_S = 0.1;
export const INTERP_MIN_S = 0.08;
export const INTERP_MAX_S = 0.25;
/**
 * The client's render delay never moves faster than this fraction of real time (§5.1): the buffer's own, and a
 * mid-ring body's extra near interval when it changes ring (client/net/snapshotBuffer.ts). The server mirrors the
 * second to judge a shot where the body was drawn (server/net/interest.ts `viewExtra`), so both read it here.
 */
export const RENDER_DELAY_RATE = 0.05;
/** extrapolation when the interpolation buffer runs dry */
export const EXTRAPOLATE_MAX_S = 0.1;
/**
 * An effect or a zombie's death waits for the drawing to reach its tick (audit M3: client/net/fxTimeline.ts,
 * client/net/snapshotBuffer.ts `zombieDied`), never longer than this: a render time that cannot reach it (a tick
 * unwrapped on the wrong lap, a clock re-anchoring) must not hold an effect for ever.
 */
export const FX_HOLD_MAX_S = 1.5;
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
