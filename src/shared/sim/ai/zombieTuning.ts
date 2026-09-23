/*
 * Zombie tuning numbers, in one place (the original's values @30 fps converted to seconds and px/second).
 *
 * They live apart from zombieBrain.ts for a reason that is invisible in TypeScript: roblox-ts emits one Luau
 * LOCAL per top-level binding, and a Luau chunk may hold at most 200 of them. Fifty constants plus fifty
 * functions plus the imports put the old client file at 177/200 — the ceiling that once stopped the client
 * from booting. Imported as `import * as T from "shared/sim/ai/zombieTuning"`, the whole table costs one.
 */
import { SPEED_SCALE } from "shared/sim/types";

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
/** walkers stop hunting 2000 px from where they spawned unless a survivor is within 600 */
export const LEASH_SPAWN = 2000;
export const LEASH_PLAYER = 600;
/** an investigating zombie shuffles instead of sprinting: the player can read the difference */
export const SEARCH_SPEED = 0.7;
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
export const POISON_TIME = 30;
/** exploder */
export const FUSE_TIME = 50 / 30;
export const BLAST_RADIUS = 180;
export const BLAST_GROW = 1.5 * 20 * 30;
export const BLAST_DPS = 6 * 30;
export const BLAST_ZOMBIE_DAMAGE = 60;
/** noise */
export const WALK_TEMPO = 20 / 30;
export const WALK_RING_MAX = 200;
export const WALK_RING_SPEED = 7 * SPEED_SCALE;
/** line-of-sight rays allowed per frame across the whole horde (amortised perception) */
export const LOS_BUDGET = 24;
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
 * Visibility radii at night. They match the renderer's light map (gameLoop PLAYER_LIGHT_R / LIGHT_R) so a
 * zombie is never invisible while standing on lit ground.
 */
export const PLAYER_LIGHT_R = 250;
export const STRUCTURE_LIGHT_R: Record<string, number> = { lamp: 400, lamp_drone: 320, campfire: 300, brazier: 330 };
/** flashlight (equipHand 13): original power 400 in a 45° cone → ~560 px */
export const FLASHLIGHT_R = 560;
/** how far around a survivor the AI looks for lit structures and shaking solids */
export const LIGHT_WINDOW = 1400;
