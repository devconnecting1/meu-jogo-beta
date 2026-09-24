/*
 * The survivor's body between two steps (docs/DESIGN_RULES.md VIT-01): the stomach, healing, starving and poison.
 *
 * SHARED and deterministic, like the rest of `stepPlayer` (shared/sim/playerMove.ts): the server steps it for every
 * survivor every tick, and the client's prediction steps the very same function for its own survivor -- so the HP bar
 * a client draws is the server's, not a guess that the next snapshot pulls back (client/net/prediction.ts).
 *
 * The owner's rule (2026-09-24): "quando o jogador toma dano, ele só consegue recuperar vida após um certo tempo sem
 * tomar dano (se caso ele tiver food suficiente)". So:
 *
 *   - every HP the body LOSES restarts the wait (`PlayerState.sinceHurt` = 0): a hit that gets through the armour
 *     (shared/game/player.ts `applyPlayerDamage`; one the armour stops whole took nothing and restarts nothing), and
 *     every step of poison, of starvation or of rotten meat (`itemUseEffect`);
 *   - REGEN_DELAY_S after the last one the body starts to heal, from nothing up to the full rate over REGEN_RAMP_S;
 *   - it heals only while the FOOD bar reads REGEN_FOOD_MIN or more (15: where the bar blinks red), and every HP it
 *     heals costs REGEN_FOOD_PER_HP of food: a full stomach buys a full heal and then some, an empty one buys nothing,
 *     and one meal eaten on an empty one is enough to start again;
 *   - Recovery (skill 1) multiplies the RATE, (1 + level) as in the original; nothing shortens the wait, which is the
 *     rule of the fight ("no healing while something is biting you") and reads the same for everybody;
 *   - what heals from the backpack (a first-aid kit, a bandage, food with hp) heals AT ONCE, wait or no wait.
 *
 * Dead Town regenerated 0,04 hp a frame (1,2 hp/s) whenever the stomach was not empty, bite or no bite, for free. A
 * survivor with Recovery 3 and steel armour out-healed a walker standing still (4,8 hp/s against 2,8), and one with
 * Patience 3 never needed to eat again. The wait takes the healing out of the fight; the rate after it is a quarter
 * faster than the original's, so the rest between two fights stays what it was (0 -> 100 in ~75 s, it was ~83 s).
 *
 * Pure: no Instances, no services, no random numbers.
 */
import { HurtBy } from "shared/data/deathCause";
import type { PlayerState } from "shared/game/player";
import type { PlayerSaveData } from "shared/game/save";

/** seconds without losing HP before the body starts to heal again */
export const REGEN_DELAY_S = 7;
/** seconds from the end of the wait to the full rate: healing fades in, it never snaps on */
export const REGEN_RAMP_S = 2;
/** a body that has rested: past the wait and the ramp (a fresh body, and the value `sinceHurt` stops counting at) */
export const REGEN_RESTED_S = REGEN_DELAY_S + REGEN_RAMP_S;
/** hp a second at the full rate, before Recovery (the original's 1,2, a quarter faster: see the header) */
export const REGEN_HP_PER_S = 1.5;
/**
 * The body heals while the FOOD bar reads this or more. 15 is where that bar already blinks red (hudConsole.ts
 * LOW_FOOD, UI-09): the warning a hungry survivor sees and the stomach that cannot heal are the same number, and no
 * new threshold is added. It is also low enough that ONE meal ends it: eaten on an empty stomach, any meal of 20 food
 * or more is still above 15 once the wait and the ramp have run their REGEN_RESTED_S (0,3 × 9 = 2,7 food of the
 * stomach at rest) -- a can of food (25) leaves 22,3, and heals ~18 hp out of it (DESIGN_RULES VIT-01).
 * The bar rounds (hudConsole.ts), and so does the u8 the self block carries (§4.2): the test is on that same rounding,
 * so the bar, the server and the prediction agree on it.
 */
export const REGEN_FOOD_MIN = 15;
/** food each healed hp costs: a full heal of 100 hp is 25 food, one can of food */
export const REGEN_FOOD_PER_HP = 0.25;
/** the stomach at rest, per second (the original's 0,01 a frame), before Patience */
export const HUNGER_PER_S = 0.01 * 30;
/** hp a second an empty stomach costs (the original's 0,02 a frame) */
export const STARVE_HP_PER_S = 0.02 * 30;
/** hp a second poison costs (the original's 0,06 a frame), halved by Poison immunity */
export const POISON_HP_PER_S = 0.06 * 30;

/** the FOOD bar reads REGEN_FOOD_MIN or more (it rounds half up, like the self block's u8) */
export function fedEnough(hungry: number): boolean {
	return hungry >= REGEN_FOOD_MIN - 0.5;
}

/** 0 -> 1: the part of the full rate the body heals at, `sinceHurt` seconds after the last HP it lost */
export function regenRamp(sinceHurt: number | undefined): number {
	if (sinceHurt === undefined) return 1;
	return math.clamp((sinceHurt - REGEN_DELAY_S) / REGEN_RAMP_S, 0, 1);
}

/** hp a second at the full rate: Recovery (skill 1) multiplies it by 1 + level */
export function regenRate(save: PlayerSaveData): number {
	return REGEN_HP_PER_S * (1 + (save.skillLevels[1] ?? 0));
}

/** what the body is doing about its HP right now (the HUD's cue, client/ui/hudRegen.ts) */
export const RegenPhase = {
	/** full, dead, or nothing known */
	None: 0,
	/** lost HP a moment ago: the wait is running (nothing to show: the fight says it) */
	Waiting: 1,
	/** hurt, and the FOOD bar is too low to heal: eat */
	Hungry: 2,
	/** healing (the ramp included) */
	Healing: 3,
} as const;
export type RegenPhase = (typeof RegenPhase)[keyof typeof RegenPhase];

/**
 * The phase from what the HUD holds. Low food wins over the wait: the wait ends by itself, the food does not, and
 * "eat to heal" is worth knowing before the fight is over. `sinceHurt` undefined = not tracked: never Healing.
 */
export function regenPhase(hp: number, hpMax: number, hungry: number, sinceHurt: number | undefined): RegenPhase {
	if (!(hp > 0) || hp >= hpMax) return RegenPhase.None;
	if (!fedEnough(hungry)) return RegenPhase.Hungry;
	if (sinceHurt === undefined) return RegenPhase.None;
	return regenRamp(sinceHurt) > 0 ? RegenPhase.Healing : RegenPhase.Waiting;
}

/**
 * One step of the body: the stomach runs down (Patience slows it, × (1 − level / 3), as in the original), an empty
 * one and poison take hp and restart the wait, and past the wait a fed body heals and pays for it in food. The
 * caller (`stepPlayer`) has already brought `hpMax` up to date and handles the death after it.
 *
 * Admin god mode (§10) loses nothing to a hit already (`applyPlayerDamage`); here it never starts the wait either.
 */
export function stepVitals(p: PlayerState, save: PlayerSaveData, dt: number): void {
	const hungerRate = 1 - save.skillLevels[8] / 3;
	p.hungry = math.max(0, p.hungry - HUNGER_PER_S * hungerRate * dt);
	let hurt = false;
	// what took the hp is noted only while the body was alive: the step that crossed 0 is the lethal one (deathCause.ts)
	if (p.hungry <= 0) {
		if (p.hp > 0) p.lastHurt = HurtBy.Hunger;
		p.hp -= STARVE_HP_PER_S * dt;
		hurt = true;
	}
	if (p.buffs.poison > 0) {
		p.buffs.poison -= dt;
		if (p.hp > 0) p.lastHurt = HurtBy.Poison;
		p.hp -= POISON_HP_PER_S * (save.skillLevels[20] > 0 ? 0.5 : 1) * dt;
		hurt = true;
	}
	const since = hurt && p.godMode !== true ? 0 : math.min(REGEN_RESTED_S, (p.sinceHurt ?? REGEN_RESTED_S) + dt);
	p.sinceHurt = since;
	// a step of hunger or poison is a hurt of the body (the night's tally, MON-05: PlayerState.hurts)
	if (hurt && p.godMode !== true) p.hurts = (p.hurts ?? 0) + 1;
	if (p.hp >= p.hpMax || !fedEnough(p.hungry)) return;
	const k = regenRamp(since);
	if (k <= 0) return;
	const healed = math.min(p.hpMax - p.hp, regenRate(save) * k * dt);
	p.hp += healed;
	p.hungry = math.max(0, p.hungry - healed * REGEN_FOOD_PER_HP);
}
