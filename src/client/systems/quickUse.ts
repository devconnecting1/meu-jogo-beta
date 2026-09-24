/*
 * The HUD's quick HEAL and EAT on this client (docs/DESIGN_RULES.md ITM-07, UI-09): the press, the shared use
 * cooldown, and what the two plates draw. The pick itself is the shared rule (shared/game/quickUse.ts); the use is the
 * Bag's own verb (client/net/backpackSync.ts `useItem`: predicted as one fewer and sent, or eaten locally offline).
 *
 * Two things the Bag's Use never needed, because the Bag is not pressed twice in a quarter of a second mid-fight:
 *
 *  - the COOLDOWN: the server takes one usable every USE_COOLDOWN_S (it holds a faster one, server/sim/craft.ts). A
 *    press inside it does nothing, and the plates sweep for it -- any use starts it, the Bag's too (`noteUse`);
 *  - the PENDING vitals: the client never predicts hp or food (client/net/bagPrediction.ts -- the snapshot owns them),
 *    so for a round trip after a bandage the bar still reads the old hp, and a second press would pick against it:
 *    another bandage for 10 missing hp. Until the snapshot shows the use (or PENDING_S passes), the pick reads the bar
 *    as it will be. Only the PICK reads it: the bars on screen stay the server's, so nothing flickers.
 *
 * No Instances: tools/test-items.mjs drives it against the real server.
 */
import { USABLES } from "shared/data/usables";
import { PlayerState, USE_COOLDOWN_S } from "shared/game/player";
import { PlayerSaveData } from "shared/game/save";
import {
	QUICK_EAT_KIND,
	QUICK_HEAL_KIND,
	QuickPick,
	QuickVitals,
	QuickWhy,
	newQuickPick,
	quickPick,
} from "shared/game/quickUse";

/** a use the snapshot has not brought back yet is read into the pick for at most this long */
export const QUICK_PENDING_S = 1.5;
/** the plate's light after a use (the "pulse") */
export const QUICK_PULSE_S = 0.35;

/** what a plate draws: the pick, and its two clocks */
export interface QuickView extends QuickPick {
	/** 0..1 of the use cooldown still running (the sweep); 0 = ready */
	cooldown: number;
	/** 0..1 of the light after this plate's last use; 0 = none */
	pulse: number;
}

/** what a press did */
export interface QuickPress {
	/** used: `id` went to the backpack's verb */
	used: boolean;
	id: number;
	/** why nothing was used (`cooldown`: inside the use limit; `busy`: the verb was not taken -- the server's queue) */
	why: QuickWhy | "cooldown" | "busy";
	/** what the bars should gain ("+20 HP"), from the vitals the pick read */
	hpGain: number;
	foodGain: number;
}

/** how a press reaches the backpack: the Bag's verb (backpackSync.useItem), or a test's */
export type QuickSend = (id: number) => boolean;

/** a bar that should read at least `target` until `until` (os.clock) or until the snapshot shows it */
interface Pending {
	target: number;
	until: number;
	/** the use raised the bar (a heal, a meal); false: it lowered it (rotten meat's damage) */
	up: boolean;
}

function newView(kind: number): QuickView {
	const v = newQuickPick(kind) as QuickView;
	v.cooldown = 0;
	v.pulse = 0;
	return v;
}

export class QuickUse {
	/** the HEAL and EAT plates' answers, rewritten in place every frame (`frame`) */
	readonly views: [QuickView, QuickView] = [newView(QUICK_HEAL_KIND), newView(QUICK_EAT_KIND)];
	private lastUse = -math.huge;
	private readonly usedAt = [-math.huge, -math.huge];
	private readonly hp: Pending = { target: 0, until: -math.huge, up: true };
	private readonly food: Pending = { target: 0, until: -math.huge, up: true };
	private readonly vitals: QuickVitals = { hp: 0, hpMax: 0, hunger: 0, hungerMax: 0, dead: false };

	/** a new run, a new body: nothing pending, no cooldown carried over */
	reset(): void {
		this.lastUse = -math.huge;
		this.usedAt[0] = -math.huge;
		this.usedAt[1] = -math.huge;
		this.hp.until = -math.huge;
		this.food.until = -math.huge;
	}

	/** the body's vitals, with a use the snapshot has not shown yet read in (see the header) */
	read(body: PlayerState, now: number): QuickVitals {
		const v = this.vitals;
		v.hpMax = body.hpMax;
		v.hungerMax = body.hungryMax;
		v.dead = body.dead;
		if (body.dead || body.hp <= 0) {
			// a death is never masked by a heal still on its way: nothing is pending for a body at 0 hp
			this.hp.until = -math.huge;
			this.food.until = -math.huge;
		}
		v.hp = settle(this.hp, body.hp, now);
		v.hunger = settle(this.food, body.hungry, now);
		return v;
	}

	/** 0..1 of the use cooldown still running at `now` */
	cooling(now: number): number {
		const left = this.lastUse + USE_COOLDOWN_S - now;
		return left > 0 ? math.min(1, left / USE_COOLDOWN_S) : 0;
	}

	/** both plates for this frame, written in place (no allocation): what main.client.ts hands the HUD */
	frame(body: PlayerState, save: PlayerSaveData, now: number): ReadonlyArray<QuickView> {
		const v = this.read(body, now);
		const cd = this.cooling(now);
		for (let k = 0; k < 2; k++) {
			const view = this.views[k];
			quickPick(k, save, v, view);
			view.cooldown = cd;
			const since = now - this.usedAt[k];
			view.pulse = since >= 0 && since < QUICK_PULSE_S ? 1 - since / QUICK_PULSE_S : 0;
		}
		return this.views;
	}

	/**
	 * A usable was used, by any path -- a plate, or the Bag's Use: the cooldown starts, and what it adds is read into
	 * the next picks until the snapshot shows it. `hp` / `hunger`: the bars BEFORE the use (offline, the Bag's verb
	 * applies it to the body at once, and reading the body after would count it twice)
	 */
	noteUse(id: number, body: PlayerState, now: number, kind = -1, hp = body.hp, hunger = body.hungry): void {
		this.lastUse = now;
		if (kind >= 0 && kind < 2) this.usedAt[kind] = now;
		const u = USABLES[id];
		if (u === undefined) return;
		if (u.hp !== 0) raise(this.hp, hp, body.hpMax, u.hp, now);
		if (u.hunger !== 0) raise(this.food, hunger, body.hungryMax, u.hunger, now);
	}

	/**
	 * One press of plate `kind`: the pick, the cooldown, and the use through `send`. Refused, it says why (the HUD
	 * speaks the reason); used, what the bars should gain.
	 */
	press(kind: number, body: PlayerState, save: PlayerSaveData, now: number, send: QuickSend): QuickPress {
		const v = this.read(body, now);
		const pick = quickPick(kind, save, v);
		const out: QuickPress = { used: false, id: pick.id, why: pick.why, hpGain: 0, foodGain: 0 };
		if (pick.why !== "ok") return out;
		if (this.cooling(now) > 0) {
			out.why = "cooldown";
			return out;
		}
		const u = USABLES[pick.id];
		const hpRoom = v.hpMax - v.hp;
		out.hpGain = u === undefined ? 0 : u.hp >= 0 ? math.max(0, math.min(u.hp, hpRoom)) : u.hp;
		out.foodGain = u === undefined ? 0 : math.max(0, math.min(u.hunger, v.hungerMax - v.hunger));
		// the bars as the pick read them, before the verb (offline it changes the body at once)
		const hp = v.hp;
		const hunger = v.hunger;
		if (!send(pick.id)) {
			out.why = "busy";
			out.hpGain = 0;
			out.foodGain = 0;
			return out;
		}
		out.used = true;
		this.noteUse(pick.id, body, now, kind, hp, hunger);
		return out;
	}
}

/** the bar as the pick reads it: the body's, or the pending target while it has not arrived */
function settle(p: Pending, value: number, now: number): number {
	if (now >= p.until) return value;
	// the snapshot shows it: the body's own value from here on (damage after the heal counts again). A use that
	// LOWERS the bar (rotten meat's -10 hp) is read the same way down, so a second press never trusts the old hp
	const shown = p.up ? value >= p.target - 0.5 : value <= p.target + 0.5;
	if (shown) {
		p.until = -math.huge;
		return value;
	}
	return p.target;
}

/** a use adding `delta` to a bar at `value` of `max`: its pending target (a second one in flight adds to the first) */
function raise(p: Pending, value: number, max: number, delta: number, now: number): void {
	const from = now < p.until ? p.target : value;
	const target = math.clamp(from + delta, 0, max);
	// a use that leaves this bar where it is (a can's +5 hp at full health) has nothing to wait for: a pending target
	// there would only hide the next bite until it ran out
	if (math.abs(target - from) < 0.5) return;
	p.target = target;
	p.up = delta > 0;
	p.until = now + QUICK_PENDING_S;
}

/** the client's one quick-use state (client/main.client.ts drives it; the HUD draws its views) */
export const quickUse = new QuickUse();

/** the HEAL / EAT feed line after a use: "+20 HP", "+25 FOOD", "+30 FOOD · +5 HP" (the rotten meat's "-10 HP" too) */
export function quickGainText(press: QuickPress, tr: (key: string) => string): string {
	const hp = math.floor(press.hpGain + 0.5);
	const food = math.floor(press.foodGain + 0.5);
	const hpText = hp >= 0 ? `+${hp} ${tr("HP")}` : `${hp} ${tr("HP")}`;
	if (food > 0) return hp !== 0 ? `+${food} ${tr("FOOD")} · ${hpText}` : `+${food} ${tr("FOOD")}`;
	return hpText;
}

/** why a press did nothing, in the player's words ("" = nothing to say: the sweep, or the death screen, says it) */
export function quickReason(kind: number, why: QuickPress["why"]): string {
	if (why === "none") return kind === QUICK_HEAL_KIND ? "No healing items" : "No food";
	if (why === "full") return kind === QUICK_HEAL_KIND ? "Already at full health" : "You're already full";
	if (why === "risky") return "Eating that would kill you";
	return "";
}

/** what a press needs from the run: the verb, the HUD's message lines, the use sound, the language */
export interface QuickHooks {
	send: QuickSend;
	/** a line of the HUD's feed (hud.ts showMessage) */
	say: (text: string) => void;
	/** the use sound */
	heard: () => void;
	tr: (key: string) => string;
}

/**
 * A plate pressed (H / F, the D-pad's up / down, a click, a tap -- client/main.client.ts reads InputState.quickUsePressed
 * once a frame): the use, then what the player is told -- "+20 HP" and the use sound, or why nothing happened.
 */
export function pressQuick(
	kind: number,
	body: PlayerState,
	save: PlayerSaveData,
	now: number,
	hooks: QuickHooks,
	state: QuickUse = quickUse,
): QuickPress {
	const res = state.press(kind, body, save, now, hooks.send);
	if (res.used) {
		hooks.say(quickGainText(res, hooks.tr));
		hooks.heard();
		return res;
	}
	const reason = quickReason(kind, res.why);
	if (reason !== "") hooks.say(hooks.tr(reason));
	return res;
}
