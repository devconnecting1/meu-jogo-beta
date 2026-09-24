/*
 * Zombie tuning numbers, in one place (the original's values @30 fps converted to seconds and px/second).
 *
 * They live apart from zombieBrain.ts for a reason that is invisible in TypeScript: roblox-ts emits one Luau
 * LOCAL per top-level binding, and a Luau chunk may hold at most 200 of them. Fifty constants plus fifty
 * functions plus the imports put the old client file at 177/200 — the ceiling that once stopped the client
 * from booting. Imported as `import * as T from "shared/sim/ai/zombieTuning"`, the whole table costs one.
 */
import { SPEED_SCALE } from "shared/sim/types";
import { EQUIP_LIGHTS } from "shared/data/equips";
import { FLASHLIGHT_ID, SURVIVOR_LIGHT_R } from "shared/sim/survivorLight";

/** stunned_time 30 frames */
export const STUN_TIME = 1;
/** detect_show_time 30 frames */
export const DETECT_SHOW_TIME = 1;
/** my_angle_speed 5°/frame */
export const TURN_RATE = math.rad(5) * 30;
/** feet_cycle_angle_speed 10°/frame */
export const FEET_RATE = math.rad(10) * 30;
/** reaction_speed_max */
export const REACTION_MAX = 9;
/** zombies only hit constructions when a survivor is this close (par_action collision) */
export const STRUCT_ATTACK_RANGE = 800;
/**
 * A chasing zombie pounds on a pane only while it walks INTO it (EDI-18): the cosine between its heading and the way
 * through the glass at least this (60° off square). One sliding along a shop front towards the door is walking along
 * a wall, and a row of windows is not smashed by a horde brushing past it.
 */
export const GLASS_INTO = 0.5;
/** ...a charger's rush at any angle up to 75° off square (a battering ram), never along the glass (a scrape) */
export const GLASS_INTO_RUSH = 0.25;
/** walkers stop hunting 2000 px from where they spawned unless a survivor is within 600 */
export const LEASH_SPAWN = 2000;
export const LEASH_PLAYER = 600;
/**
 * How fast each state walks, as a fraction of the zombie's own speed (DESIGN_RULES IA-03/IA-04): the player
 * reads the state from the gait as much as from the mark. A suspicious zombie walks with purpose, a searching
 * one shuffles between looks, a chasing one goes flat out.
 */
export const SUSPICIOUS_SPEED = 0.8;
export const SEARCH_SPEED = 0.6;
// --- natural motion (DESIGN_RULES IA-04): never faster than the original, only varied below it ---------------
/** each zombie's own gait, a constant fraction of its speed hashed from its id: the chase in [GAIT_MIN, 1] */
export const GAIT_MIN = 0.9;
/** ...and the wandering amble in [AMBLE_MIN, 1] of the original's 2/3 */
export const AMBLE_MIN = 0.8;
/** sideways sway of the walking heading (radians), in time with the steps: a shamble, not a rail */
export const WOBBLE_CALM = 0.16;
export const WOBBLE_CHASE = 0.08;
/** no sway this close to the target: the last metres of a chase and the bite are never off-line */
export const WOBBLE_NEAR = 200;
/**
 * How fast the walking heading can turn (rad/s): the body swings round instead of snapping. Capped by what the
 * clients' snapshot interpolation can follow: a client that runs out of snapshots extrapolates in a straight
 * line, and a body turning at ω drifts off that line by v·ω·t²/2 — at 90 u/s, 6 rad/s and 100 ms that is 2.7 u,
 * inside the 4 u three screens may disagree by (tools/test-replication.mjs (a); 9 rad/s broke it).
 */
export const TURN_WANDER = 2.5;
export const TURN_ALERT = 4.5;
export const TURN_CHASE = 6;
/** a walking body gets up to speed (and stops) at this rate (u/s²): a start, not a teleport of velocity (same cap) */
export const PACE_ACCEL = 450;
/** a zombie that moved this far without getting nearer is jostling in a stream, not stuck in a queue (flank.ts) */
export const JAM_STILL = 40;
/** wandering: each leg turns at most this much from the last (radians), and lasts this long */
export const WANDER_TURN = 1.8;
export const WANDER_LEG_MIN = 2;
export const WANDER_LEG_MAX = 5;
/** ...then it stands for a moment, and half the time it looks around while it stands */
export const WANDER_PAUSE_MIN = 0.8;
export const WANDER_PAUSE_MAX = 2.4;
export const WANDER_LOOK = 0.5;
/** a zombie that gave up a search stands this long before it wanders off */
export const GIVE_UP_PAUSE = 1.2;
/** spitter */
export const SPIT_RANGE = 400;
export const SPIT_KEEP = SPIT_RANGE - 40;
/** closer than this the spitter gives ground instead of standing and spitting in your face */
export const SPIT_BACK = 240;
export const SPIT_COOLDOWN = 6;
export const SPIT_SPEED = 15 * SPEED_SCALE;
export const SPIT_LEAD = 20 / 30;
/** seconds of sidestep after a spit (it never stands still in the open) */
export const SPIT_REPOSITION = 1.2;
export const PUDDLE_RADIUS = 70;
export const PUDDLE_LIFE = 5;
/** exploder: how far it looks around for a wall to breach, and how close it must be to bother */
export const EXPLODER_SEEK = 320;
export const EXPLODER_NEAR_TARGET = 900;
/** two survivors closer than this to each other are a cluster worth blowing up */
export const EXPLODER_CLUSTER = 320;
/** charger */
export const RUSH_MIN_DIST = 100;
/**
 * Half-width of the band a charger keeps its distance in (LEG-05): it backs off below `RUSH_MIN_DIST + 10 −
 * KEEP_BAND`, closes in above `+ KEEP_BAND`, and stands in between. Wider than one tick of its walk (1.25 u at
 * 60 Hz) so a single step can never cross the whole band, which is what made the old single line shiver.
 */
export const KEEP_BAND = 6;
/**
 * Seconds a charger whose back-off barely moved (a wall, a corner, furniture behind it) closes in to bite instead of
 * keeping its distance: long enough to reach the survivor and bite, so it does not try the back-off again at once
 */
export const CLOSE_IN_TIME = 1.5;
/**
 * ...or has no room to back off: its body, a radius plus this much further back, is in a wall. At least the 14 u
 * `steer` looks ahead: where that probe is blocked the back-off turns into a slide along the wall, side to side
 */
export const BACK_ROOM = 16;
/** ...measured like this: over BACK_CHECK_S of back-off, it netted less than this share of its walk */
export const BACK_CHECK_S = 0.4;
export const BACK_MIN_PROGRESS = 0.3;
export const RUSH_TIME = 2;
export const RUSH_COOLDOWN = 3;
export const RUSH_SPEED_MIN = 5;
export const RUSH_SPEED_MAX = 25;
/** +1 px/frame every frame */
export const RUSH_ACCEL = 30;
/** charges that found no clear lane before it goes looking for one */
export const RUSH_FAIL_MAX = 2;
/** seconds of sidestep while a special looks for a clear lane */
export const STRAFE_TIME = 0.9;
export const STRAFE_SPEED = 0.75;
/** jumper */
export const JUMP_LENGTH = 200;
export const JUMP_SPEED = 8 * SPEED_SCALE;
export const JUMP_COOLDOWN = 2.7;
export const JUMP_AIR_MAX = 2;
export const JUMP_LIFT = 28;
/** a hunting jumper only takes off when the leap actually shortens its path, in flow-field cells */
export const JUMP_GAIN = 2.5;
/**
 * A hunting jumper within a hop of the survivor that found no leap this many times running (half a second apart) is
 * stuck: only then does it look all round for a hop (zombieBrain `startJump`; further out it looks every time)
 */
export const JUMP_HOP_STUCK = 2;
export const POISON_TIME = 30;
/** exploder */
export const FUSE_TIME = 50 / 30;
export const BLAST_RADIUS = 180;
export const BLAST_GROW = 1.5 * 20 * 30;
export const BLAST_DPS = 6 * 30;
export const BLAST_ZOMBIE_DAMAGE = 60;
/** noise: how fast a footstep ring spreads (obj_sound sound_speed 7); the levels are in noise.ts */
export const WALK_RING_SPEED = 7 * SPEED_SCALE;
/**
 * Line-of-sight rays allowed per tick across the whole horde (amortised perception). Each zombie only looks at
 * 10/5/2 Hz by ring (perception.ts `senseInterval`), so this is the ceiling of a bad tick, not the usual cost.
 */
export const LOS_BUDGET = 24;
/** a zombie the budget kept waiting this long past its look drops its last "in view" (it is stale) */
export const LOS_STALE = 0.25;
/** telegraphed bite: lean back, then bite. Step out of BITE_KEEP during it and the bite whiffs. */
export const WINDUP_TIME = 0.26;
export const WINDUP_BACK = 1.2;
export const BITE_KEEP = 16;
export const WHIFF_RECOVER = 0.35;
/**
 * A body within this many units of touching another (or its target) counts as touching it, and its walk stops
 * pushing that way (LEG-05, zombieBrain `alongContacts`). Under the 3 u the bite reads as contact, so a walker
 * that stops against a survivor still bites; wider than one tick of a walk (1.5 u), so one step never makes a new
 * overlap for the separation to throw back on the next.
 */
export const CONTACT_MARGIN = 2;
/** knockback power (combat.ts: melee 6, headshot 9, blast 9) that visibly staggers a zombie */
export const STAGGER_KNOCK = 6;
export const STAGGER_TIME = 0.45;
/** straight-line chase instead of the field: §3.3 widens it to 200 u, since the field may be 0.25 s old */
export const DIRECT_CHASE = 200;
/**
 * A suspicious zombie whose remembered place is this close to where a survivor still is takes the chase field's
 * way there (through the door, not into the wall); further, the survivor has moved on and it steers locally.
 */
export const FIELD_GOTO = 400;

/**
 * Visibility radii at night. They match the renderer's light map (gameLoop PLAYER_LIGHT_R / LIGHT_R) so a
 * zombie is never invisible while standing on lit ground. A survivor's own light (the circle, the torch, night
 * vision, the flashlight's cone) is shared/sim/survivorLight.ts, the rule the light map reads too (LUZ-04).
 */
export const PLAYER_LIGHT_R = SURVIVOR_LIGHT_R;
/**
 * The built and fixed light sources, while `powered`, by tag: THE table -- the client's light map draws these very radii
 * (client/gameLoop.ts LIGHT_R is this object), so the ground the horde sees lit is the ground the survivor sees lit.
 * `portico`: a bank's portico while its alarm bell rings (EDI-24), the bell's flashing lamp.
 */
export const STRUCTURE_LIGHT_R: Record<string, number> = {
	lamp: 400,
	lamp_drone: 320,
	campfire: 300,
	brazier: 330,
	portico: 220,
};
/** flashlight (equipHand 13): original power 400 in a 45° cone → ~560 px (shared/data/equips.ts EQUIP_LIGHTS) */
export const FLASHLIGHT_R = EQUIP_LIGHTS[FLASHLIGHT_ID].radius;
/** how far around a survivor the AI looks for lit structures and shaking solids */
export const LIGHT_WINDOW = 1400;
