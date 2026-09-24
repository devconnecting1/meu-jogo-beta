import { WeaponKind } from "shared/data/kinds";

/*
 * What a zombie hears, and how far (docs/DESIGN_RULES.md IA-02). World units, 55 u ≈ 1 m.
 *
 * The original has two noises and only by day: the survivor's footsteps (sys_sound_view: the distance walked
 * in 20 frames, ÷ 1.2, at most 200 px, halved by Stealth) and a gunshot (sound_view_shot(800), a third with the
 * silencer), whatever the gun. At night and in the rain it simulates no sound at all, because every zombie is
 * already hunting — a blanket this remake no longer has (shared/sim/ai/perception.ts).
 *
 * Here noise matters all day and all night, and it is graded by what made it:
 *   LOUD    a gunshot, by weapon class (a pistol is the original's 800, a sniper rifle carries almost twice as
 *           far); building something; a construction smashed; an exploder going off; glass breaking.
 *   MEDIUM  running — the survivor's normal gait; a zombie pounding on glass or a barricade.
 *   LOW     walking (a hurt, starving or slowed survivor drags their feet quieter), a blow landing on a body, a door.
 * That is the tactical trade-off the owner asked for: a blade is quiet and keeps a fight local, a gun ends it
 * faster and brings the street. The rain masks everything to RAIN_HEARING (shared/sim/ai/perception.ts).
 *
 * THE TABLE (u; ×0.6 in the rain; every ring says only where it came from). One place for every source, so a new one
 * is weighed against the rest (DESIGN_RULES IA-02 prints the same table):
 *
 *   sniper 1400 · machine gun 1200 · rifle / shotgun 1120 · pistol 800 (silencer ÷3: 267) · flamethrower 360 ·
 *   stun gun 280 · bow 0                                                                    GUNSHOT × gunClassScale
 *   motorcycle horn 900 · engine 400 (idle) .. 900 (top speed) every 0.5 s · crash 400    shared/data/buildings.ts,
 *   bicycle bell 250 (a bicycle's tyres: the rider's footsteps)                           server/sim/vehicles.ts
 *   exploder going off 800 · construction smashed 650 · building 450                     EXPLOSION, STRUCT_BREAK, BUILD
 *   GLASS BREAKING 420 (a zombie's shout reaches as far: IA-03) · turret shot 800 · shock 200
 *   a zombie pounding on a barricade 300, or on glass 300 (every blow)                    STRUCT_HIT, GLASS_BANG
 *   running 220 · walking 110 (Stealth ÷2) · a blow landing on a body 150 · a door 150     STEP_*, HIT, DOOR
 *
 * There is no bank and no car alarm in the town (EDI-03's buildings, VEI-*): an alarm, if one is ever added, goes in
 * this table first. A melee swing that hits nothing, reloading and searching are silent.
 *
 * A noise tells a zombie WHERE IT CAME FROM, never where the survivor is now: it goes and looks (suspicious),
 * and only its eyes turn that into a chase. Walls do not stop a ring — a shot inside a house is heard outside,
 * so a building is never a place where noise is free (the interiors rule: no safe spots inside).
 *
 * Pure: numbers only. No world, no Instances.
 */

/** the survivor's normal gait: the original's walk ring, capped at 200 px, a little wider for a run */
export const STEP_RUN = 220;
/** a survivor slowed below WALK_BELOW (hurt, starving, in acid) drags their feet: half as loud */
export const STEP_WALK = 110;
/** below this speed (u/s) a survivor is walking rather than running: 80% of the base 7 px/frame (210 u/s) */
export const WALK_BELOW = 168;
/** "Stealth" (skill 15) halves the footsteps, as in the original */
export const STEALTH_STEPS = 0.5;
/** a blow landing on a body (a blade, a bat, a bullet's impact): a thud the next zombie over hears */
export const HIT = 150;
/** the original's sound_view_shot(800): what a pistol is heard from */
export const GUNSHOT = 800;
/** the silencer divides a shot by 3 (sys_sound_view) */
export const SILENCER_DIVISOR = 3;
/** placing a construction: hammering, dragging planks */
export const BUILD = 450;
/** a zombie banging on a barricade or a door: every blow carries down the street */
export const STRUCT_HIT = 300;
/** a construction giving way */
export const STRUCT_BREAK = 650;
/** an exploder going off (the original's boom_power 800) */
export const EXPLOSION = 800;
/**
 * A window's glass breaking (EDI-18), whoever broke it: a sharp crash the next houses hear -- as far as a zombie's
 * shout carries (IA-03, 420), well under a pistol (800) and over a zombie pounding on something (300). That is the
 * choice the owner asked for: through a door is quiet, through the glass is a shortcut the street hears. And it is
 * heard AT THE WINDOW: a pane shot from across the street pulls the horde to the pane, not to the shooter -- a lure
 * (a silenced pistol is 267 at the shooter).
 */
export const GLASS_BREAK = 420;
/** a zombie pounding on a pane before it gives (EDI-18): every blow, as loud as one on a barricade */
export const GLASS_BANG = STRUCT_HIT;
/**
 * A built door (EDI-13; the town's own doorways are open gaps, EDI-09) opened or closed with E, a creak or a slam: the
 * next zombie over hears it, as a blow
 */
export const DOOR = 150;

/**
 * How much further than a pistol each class of gun is heard. Handguns are the reference (the original's single
 * number); long guns and shotguns are louder; machine guns fire so often that a burst reads as one long noise;
 * a sniper rifle is the loudest thing in the town. The flamethrower is a hiss and a roar, the stun gun a crack.
 * Bows are not in the table: an arrow is silent until it lands (HIT).
 */
export function gunClassScale(kind: number, weaponId: number): number {
	if (weaponId === 25) return 0.45; // flamethrower
	if (weaponId === 26) return 0.35; // stun gun
	if (kind === WeaponKind.Pistol) return 1;
	if (kind === WeaponKind.Rifle) return 1.4;
	if (kind === WeaponKind.Shotgun) return 1.4;
	if (kind === WeaponKind.MG) return 1.5;
	if (kind === WeaponKind.Sniper) return 1.75;
	if (kind === WeaponKind.Bow || kind === WeaponKind.Melee) return 0;
	return 1;
}

/** radius of one shot of weapon (`kind`, `weaponId`), with or without the silencer */
export function gunshotRadius(kind: number, weaponId: number, silenced: boolean): number {
	const r = GUNSHOT * gunClassScale(kind, weaponId);
	return silenced ? r / SILENCER_DIVISOR : r;
}

/** radius of the footsteps of a survivor moving at `speed` u/s (0 = standing still: no ring) */
export function footstepRadius(speed: number, stealthy: boolean): number {
	if (speed <= 1) return 0;
	const r = speed < WALK_BELOW ? STEP_WALK : STEP_RUN;
	return stealthy ? r * STEALTH_STEPS : r;
}

/** seconds between two footstep rings (the original's walk_tempo, 20 frames) */
export const STEP_TEMPO = 20 / 30;
/** a new ring this close to a young one from the same place merges into it instead of adding another */
export const MERGE_DIST = 100;
