/*
 * Quick use: which item the HUD's HEAL and EAT plates use (docs/DESIGN_RULES.md ITM-08, UI-09).
 *
 * Nothing pauses (UI-06) and the Bag covers ~80% of a 16:9 screen, so healing or eating mid-fight through it means
 * opening a window over the danger. The two plates by the vitals do it in one press -- H / F, the D-pad's up / down,
 * a tap -- and this is the ONE rule for what they pick, pure and deterministic, so a player can predict it:
 *
 *   1. the kind's tiers (shared/data/usables.ts QUICK_HEAL / QUICK_EAT): the first tier that holds anything is used,
 *      the later ones only when the earlier are empty (raw food only without ready food, rotten meat last);
 *   2. inside the tier, the SMALLEST item that fills the bar's room without waste ("covers" it); when none does, the
 *      BIGGEST; a tie goes to the first in the tier;
 *   3. never an item that would end the survivor (rotten meat at 10 hp or less): it is skipped as if absent.
 *
 * The plates read the answer to draw their icon, count and state; the press sends the chosen id through the Bag's own
 * UseItem verb (client/net/backpackSync.ts), and the server applies it by the rule of any use -- alive, owned, would
 * do something, one every 0.25 s (server/sim/craft.ts `useItem`). No new protocol, and nothing here the server must
 * trust: a modified client choosing another id gets exactly what the Bag would have given it.
 *
 * Pure module: no Instances, no services, no clock.
 */
import { QUICK_EAT, QUICK_HEAL, QUICK_ICON, USABLES } from "shared/data/usables";
import type { PlayerSaveData } from "./save";

/** the HEAL plate (HP): H, the D-pad's up */
export const QUICK_HEAL_KIND = 0;
/** the EAT plate (FOOD): F, the D-pad's down */
export const QUICK_EAT_KIND = 1;
export const QUICK_KINDS = 2;

/**
 * Why a plate would do nothing: `none` of its kind in the backpack; the bar is `full`; the survivor is `dead`; the
 * only food left would kill them (`risky`). `ok` = a press uses `id`.
 */
export type QuickWhy = "ok" | "none" | "full" | "dead" | "risky";

/** what the pick reads of the survivor */
export interface QuickVitals {
	hp: number;
	hpMax: number;
	hunger: number;
	hungerMax: number;
	dead: boolean;
}

export interface QuickPick {
	kind: number;
	/** the usable a press uses (its icon on the plate); with nothing to use, the one that would be (or QUICK_ICON) */
	id: number;
	/** every usable of the kind in the backpack, all tiers (the plate's count) */
	count: number;
	/** how much of the bar it fills: its value, clamped to the room left ("+20 HP") */
	gain: number;
	why: QuickWhy;
}

/** the tiers of a plate */
export function quickTiers(kind: number): ReadonlyArray<ReadonlyArray<number>> {
	return kind === QUICK_HEAL_KIND ? QUICK_HEAL : QUICK_EAT;
}

/** what usable `id` adds to the bar of plate `kind`: health for HEAL, food for EAT */
export function quickValue(kind: number, id: number): number {
	const u = USABLES[id];
	if (u === undefined) return 0;
	return kind === QUICK_HEAL_KIND ? u.hp : u.hunger;
}

/** the room left in the bar plate `kind` fills */
export function quickRoom(kind: number, v: QuickVitals): number {
	return kind === QUICK_HEAL_KIND ? v.hpMax - v.hp : v.hungerMax - v.hunger;
}

/** a fresh answer to fill (the HUD keeps two and rewrites them every frame) */
export function newQuickPick(kind: number): QuickPick {
	return { kind, id: QUICK_ICON[kind] ?? -1, count: 0, gain: 0, why: "none" };
}

/**
 * The plate's answer for this backpack and these vitals, written into `out` (a fresh one when omitted). See the header
 * for the rule; `id` is never -1 (a plate always has something to draw), so read `why` before using it.
 */
export function quickPick(kind: number, save: PlayerSaveData, v: QuickVitals, out?: QuickPick): QuickPick {
	const res = out ?? newQuickPick(kind);
	const tiers = quickTiers(kind);
	const room = quickRoom(kind, v);
	let count = 0;
	let pick = -1;
	let risky = -1;
	for (const tier of tiers) {
		let cover = -1;
		let coverV = math.huge;
		let big = -1;
		let bigV = -math.huge;
		for (const id of tier) {
			const n = save.invenUse[id] ?? 0;
			if (n <= 0) continue;
			count += n;
			const u = USABLES[id];
			if (u === undefined) continue;
			// the one food that hurts is skipped when its damage would end the survivor (rotten meat at 10 hp)
			if (u.hp < 0 && v.hp + u.hp <= 0) {
				if (risky < 0) risky = id;
				continue;
			}
			const value = quickValue(kind, id);
			if (value >= room && value < coverV) {
				cover = id;
				coverV = value;
			}
			if (value > bigV) {
				big = id;
				bigV = value;
			}
		}
		// the earlier tier wins: a later one is only looked at (for its count) once a pick is made
		if (pick < 0) pick = cover >= 0 ? cover : big;
	}
	res.kind = kind;
	res.count = count;
	res.id = pick >= 0 ? pick : risky >= 0 ? risky : (QUICK_ICON[kind] ?? -1);
	res.gain = pick >= 0 ? math.max(0, math.min(quickValue(kind, pick), room)) : 0;
	if (count <= 0) res.why = "none";
	else if (v.dead || v.hp <= 0) res.why = "dead";
	else if (pick < 0) res.why = "risky";
	else if (room <= 0) res.why = "full";
	else res.why = "ok";
	return res;
}
