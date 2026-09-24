/*
 * Why a survivor died, and what the death screen says about it (docs/DESIGN_RULES.md UI-13, BEM; research
 * docs/research/MOTIVATION_AND_ETHICS.md §4.8: "a morte ensina").
 *
 * The cause is the LETHAL damage's source: every hp loss of a living body notes what took it (`PlayerState.lastHurt`,
 * `HurtBy`: a blow through `applyPlayerDamage` -- a bite, a boss, a blast, a crash --, the empty stomach and poison in
 * shared/sim/vitals.ts, rotten meat in `itemUseEffect`), and the loss that crossed 0 is the one kept. So "Starved." and
 * "Poisoned." are said only when the stomach or the poison dealt the last of it; a starving survivor bitten to death
 * was killed by the bite (the review of ca9494a, L8). A blow is a boss's when a living boss stood within a needle's
 * reach, the horde's otherwise; rotten meat is not a cause anybody is told (Unknown). The same rule feeds the analytics
 * `Died` event (server/analytics/events.ts `causeOfDeath`, whose strings are the dashboard's) and the one byte the dead
 * survivor is told (`Announce{Died}`, shared/net/protocol.ts note 23), read by the server at the death
 * (server/sim/life.ts `died`), so the screen and the dashboard never disagree about what killed somebody.
 *
 * The night flag is the world's night, 19:00-06:00 (shared/sim/clock.ts `isNightAt`, the analytics `Time - Night`): a
 * horde death then is "at night"; any other is only "Killed by zombies." -- never "in daylight", which a death at dusk
 * (18:00-19:00, the waves' fill) would make untrue.
 *
 * The screen turns it into two short lines: the cause ("Killed by the horde at night.") and ONE tip from a curated list
 * for that cause. Every tip is true in this game (the rule or file it rests on is next to it) and none of them blames:
 * a death is information, never a scolding (BEM-08: written for a player of 9 to 17). Each tip is at most
 * DEATH_TIP_MAX_CHARS long, so "Tip: " and the tip fit one line of the death screen even at a phone's text floor
 * (test:screens measures it). Pure data: no services.
 */

/** what took a living body's hp last (`PlayerState.lastHurt`); undefined = nothing recorded */
export const HurtBy = {
	/** `applyPlayerDamage`: a bite, a boss's blow or needle, a blast, a crash */
	Blow: 1,
	/** the empty stomach (shared/sim/vitals.ts) */
	Hunger: 2,
	/** poison (shared/sim/vitals.ts) */
	Poison: 3,
	/** a usable that hurts: rotten meat (`itemUseEffect`) */
	Item: 4,
} as const;
export type HurtBy = (typeof HurtBy)[keyof typeof HurtBy];

/** the longest a tip may be, in characters (English; the screen still gives a longer translation a second line) */
export const DEATH_TIP_MAX_CHARS = 58;

/** the causes, as the wire and the screen know them (0 = not known: an older server, a body nobody read) */
export const DeathKind = {
	Unknown: 0,
	Horde: 1,
	Hunger: 2,
	Poison: 3,
	Boss: 4,
} as const;
export type DeathKind = (typeof DeathKind)[keyof typeof DeathKind];
export const DEATH_KIND_MAX = 4;

/**
 * `Announce{Died}.arg`: the kind in bits 0-2 (1..DEATH_KIND_MAX: the server always knows the body it killed), bit 3 set
 * when it happened at night. Every other bit is zero; the decoder refuses anything else (`deathFromWire`).
 */
export const DEATH_AT_NIGHT = 8;

/** a living boss this close to a body at its death is what killed it: a needle's reach (shared/sim/ai/bossBrain.ts) */
export const BOSS_REACH = 900;

/** what a body carries into its death, as far as the cause goes (a PlayerState is one) */
export interface DeathBody {
	x: number;
	y: number;
	/** what took the last of its hp (`HurtBy`); undefined = nothing recorded */
	lastHurt?: number;
}

/** a boss as far as the cause goes (a BossState is one) */
export interface DeathBoss {
	x: number;
	y: number;
	hp: number;
}

/** what the dead survivor is told: why, and whether it was night */
export interface DeathNote {
	kind: DeathKind;
	night: boolean;
}

/**
 * Why a survivor died, from the lethal damage's source (`lastHurt`): the stomach, poison, or a blow -- a boss's when a
 * living boss stood within BOSS_REACH, the horde's otherwise. A death nothing recorded counts as a blow (only something
 * outside the body can have done it). Unknown: no body, or rotten meat.
 */
export function deathKindOf(body: DeathBody | undefined, bosses: ReadonlyArray<DeathBoss> | undefined): DeathKind {
	if (body === undefined) return DeathKind.Unknown;
	const by = body.lastHurt;
	if (by === HurtBy.Hunger) return DeathKind.Hunger;
	if (by === HurtBy.Poison) return DeathKind.Poison;
	if (by === HurtBy.Item) return DeathKind.Unknown;
	if (bosses !== undefined) {
		for (const b of bosses) {
			const dx = b.x - body.x;
			const dy = b.y - body.y;
			if (b.hp > 0 && dx * dx + dy * dy <= BOSS_REACH * BOSS_REACH) return DeathKind.Boss;
		}
	}
	return DeathKind.Horde;
}

/** the byte of `Announce{Died}` for a known cause (an Unknown is never sent: `deathWireOf` answers undefined) */
export function deathWireOf(kind: DeathKind, night: boolean): number | undefined {
	if (kind < 1 || kind > DEATH_KIND_MAX) return undefined;
	return kind + (night ? DEATH_AT_NIGHT : 0);
}

/** the cause an `Announce{Died}.arg` carries, or undefined for any value the encoder never writes */
export function deathFromWire(arg: number): DeathNote | undefined {
	if (arg % 1 !== 0 || arg < 0) return undefined;
	const night = arg >= DEATH_AT_NIGHT;
	const kind = night ? arg - DEATH_AT_NIGHT : arg;
	if (kind < 1 || kind > DEATH_KIND_MAX) return undefined;
	return { kind: kind as DeathKind, night };
}

/** the cause line of the death screen (a lang.ts key): what happened, in the fewest words, no blame */
export function deathCauseLine(note: DeathNote): string {
	if (note.kind === DeathKind.Horde) {
		return note.night ? "Killed by the horde at night." : "Killed by zombies.";
	}
	if (note.kind === DeathKind.Hunger) return "Starved.";
	if (note.kind === DeathKind.Poison) return "Poisoned.";
	if (note.kind === DeathKind.Boss) return "Killed by a boss.";
	return "You fell.";
}

/**
 * The tips, per cause (lang.ts keys, shown after "Tip:"). The most basic comes first: a first death always gets it.
 * Each is a fact of this game -- where it comes from is on its line -- and says what to TRY, never what went wrong.
 */
const TIPS_NIGHT: ReadonlyArray<string> = [
	// shared/sim/clock.ts (the waves at 19:00, 22:00, 01:00) and IA-01 (a closed door bars their eyes)
	"Waves come at 19:00, 22:00 and 01:00. Get behind a door.",
	// IA-01: the survivor's own light is seen 130 u past where it reaches; the dark shrinks their eyes
	"Your light lets them see you from farther away.",
	// IA-02: a gun is heard 800-1400 u away, a blade only by what it hits
	"Gunfire carries a whole street. A blade stays quiet.",
	// IA-01: a steel barricade bars the line of sight, a wooden one does not
	"A steel barricade blocks their sight. Wood does not.",
];
const TIPS_DAY: ReadonlyArray<string> = [
	// IA-03: lost from sight, a zombie goes to the last place it saw you, never to where you are
	"They search where they last saw you. Break line of sight.",
	// IA-03: whoever sees you shouts, and up to six around it come to look
	"A zombie that sees you shouts and wakes the ones nearby.",
	"Gunfire carries a whole street. A blade stays quiet.",
];
const TIPS_HUNGER: ReadonlyArray<string> = [
	// VIT-01: an empty stomach takes health
	"An empty stomach drains health. Eat before FOOD runs out.",
	// shared/data/usables.ts: raw meat 20, cooked meat 30
	"Cook at a campfire: cooked meat fills more than raw.",
	// shared/data/usables.ts: rotten meat costs 10 health, canned food and bread cost none
	"Rotten meat costs health. Canned food and bread do not.",
];
const TIPS_POISON: ReadonlyArray<string> = [
	// shared/sim/ai/zombieBrain.ts `jumperPoison`: a jumper poisons whoever it touches
	"Jumpers poison on contact. Keep them at a distance.",
	// VIT-01: no healing while poisoned; the Poison immunity skill halves it (shared/data/skills.ts)
	"Poison stops healing. Poison immunity halves it.",
];
const TIPS_BOSS: ReadonlyArray<string> = [
	// MON-05 / CON-04: a boss's kill is credited to everyone who fought it
	"A boss is a group fight: all who help share the kill.",
	// shared/data/usables.ts: a First aid kit restores 50 health
	"Heal before a boss: a First aid kit restores 50 health.",
];
const TIPS_ANY: ReadonlyArray<string> = [TIPS_NIGHT[0]];

/** every tip of a cause (the screen sizes its line for the longest of all: `ALL_DEATH_TIPS`) */
export function deathTipsOf(note: DeathNote): ReadonlyArray<string> {
	if (note.kind === DeathKind.Horde) return note.night ? TIPS_NIGHT : TIPS_DAY;
	if (note.kind === DeathKind.Hunger) return TIPS_HUNGER;
	if (note.kind === DeathKind.Poison) return TIPS_POISON;
	if (note.kind === DeathKind.Boss) return TIPS_BOSS;
	return TIPS_ANY;
}

/** every tip the screen can show, each once (lang.ts must list them all: test:nav) */
export const ALL_DEATH_TIPS: ReadonlyArray<string> = ((): Array<string> => {
	const out = new Array<string>();
	for (const list of [TIPS_NIGHT, TIPS_DAY, TIPS_HUNGER, TIPS_POISON, TIPS_BOSS]) {
		for (const t of list) if (!out.includes(t)) out.push(t);
	}
	return out;
})();

/** every cause line the screen can show (lang.ts must list them all: test:nav) */
export const ALL_DEATH_CAUSES: ReadonlyArray<string> = [
	"Killed by the horde at night.",
	"Killed by zombies.",
	"Starved.",
	"Poisoned.",
	"Killed by a boss.",
	"You fell.",
];

/**
 * The one tip this death shows. A first death always gets the most basic one; later deaths walk the list, so the same
 * cause twice in a row teaches something new -- deterministic (`turn` is the save's own count of deaths), so the line
 * never changes while the screen is up.
 */
export function deathTip(note: DeathNote, first: boolean, turn: number): string {
	const tips = deathTipsOf(note);
	if (first) return tips[0];
	const n = tips.size();
	const i = ((math.floor(turn) % n) + n) % n;
	return tips[i];
}
