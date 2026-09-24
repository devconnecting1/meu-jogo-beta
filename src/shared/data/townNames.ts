/*
 * A town's NAME, from its seed (docs/DESIGN_RULES.md MP-26): "Millbrook", "Cedarford", "Wrenvale".
 *
 * The seed is the town (the server's, MP-26), so the name is too: every client and the server derive the same one from
 * the seed they already have -- the home screen's Town section, the match scoreboard, the world-end message, the Servers
 * list, the server's log. Nothing new travels on the wire, and nothing here draws from the town generator's random
 * stream (shared/game/world.ts TownRng): naming a town can never change its streets. `npm run test:seed` checks the
 * name across seeds, under the same poisoned clocks and random as the town itself.
 *
 * What a name may be (CON-02, and the owner's "generic small town"): a prefix of trees, birds, stones and trades and
 * a suffix of the old English place words, joined. No brand, no real city anyone would know: the combinations that
 * spell one (a film studio, a famous suburb or resort) are in TOWN_NAME_BLOCKLIST and skipped, as are the ones that
 * double a letter at the join ("Ashhaven").
 *
 * A proper noun: never translated (UI-03), and every label that shows one turns AutoLocalize off.
 */

export const TOWN_PREFIXES: ReadonlyArray<string> = [
	"Alder",
	"Amber",
	"Ash",
	"Aspen",
	"Barley",
	"Bell",
	"Birch",
	"Bramble",
	"Briar",
	"Cedar",
	"Clay",
	"Copper",
	"Crow",
	"Elm",
	"Fern",
	"Flint",
	"Hawk",
	"Hazel",
	"Heron",
	"Holly",
	"Iron",
	"Kettle",
	"Linden",
	"Maple",
	"Marsh",
	"Mill",
	"Moss",
	"Oak",
	"Otter",
	"Pine",
	"Raven",
	"Rowan",
	"Sage",
	"Stone",
	"Thorn",
	"Willow",
	"Wren",
];

export const TOWN_SUFFIXES: ReadonlyArray<string> = [
	"brook",
	"bury",
	"crest",
	"croft",
	"dale",
	"field",
	"ford",
	"gate",
	"glen",
	"grove",
	"haven",
	"hollow",
	"hurst",
	"mere",
	"moor",
	"ridge",
	"stead",
	"vale",
	"ville",
	"water",
	"well",
	"wick",
	"wood",
	"worth",
];

/**
 * Combinations that spell a real place people know, or a brand (CON-02), or read badly: never a town's name. Exactly
 * as the join spells them.
 */
export const TOWN_NAME_BLOCKLIST: ReadonlyArray<string> = [
	"Ashbury",
	"Ashfield",
	"Ashford",
	"Ashville",
	"Copperfield",
	"Elmhurst",
	"Elmwood",
	"Ferndale",
	"Hazelwood",
	"Hollyhollow",
	"Hollywood",
	"Mapleridge",
	"Maplewood",
	"Oakbrook",
	"Oakdale",
	"Oakridge",
	"Oakville",
	"Pinehurst",
	"Pineridge",
	"Pinewood",
	"Stonehaven",
	"Thornbury",
	"Willowbrook",
];

/** MINSTD's multiplier and modulus (the town's own TownRng uses them too; this is a separate, one-step hash) */
const HASH_MUL = 48271;
const HASH_MOD = 2147483647;

/** may `prefix` + `suffix` name a town: no letter doubled at the join, nothing on the blocklist */
export function townNameAllowed(prefix: string, suffix: string): boolean {
	if (prefix.sub(-1) === suffix.sub(1, 1)) return false;
	return !TOWN_NAME_BLOCKLIST.includes(prefix + suffix);
}

/** re-hashes a name that may not be used takes before giving up on the hash (then the first allowed name) */
const NAME_TRIES = 64;

/**
 * The name of the town of `seed`. Pure integer arithmetic (a seed ≤ 2^31 times 48271 stays far below 2^53, exact in
 * a double on every platform): the same name on the server and on every client, forever for that seed. A combination
 * that may not be used is hashed again (never "the next one along", which would give its neighbour twice the towns).
 * Anything that is not a seed still gets a name (the one of seed 1): a label never shows nothing.
 */
export function townNameOf(seed: number): string {
	const whole = typeIs(seed, "number") && seed === seed && seed >= 1 && seed < HASH_MOD ? math.floor(seed) : 1;
	const p = TOWN_PREFIXES.size();
	const combos = p * TOWN_SUFFIXES.size();
	let h = whole;
	for (let i = 0; i < NAME_TRIES; i++) {
		h = (h * HASH_MUL) % HASH_MOD;
		const k = h % combos;
		const prefix = TOWN_PREFIXES[k % p];
		const suffix = TOWN_SUFFIXES[math.floor(k / p)];
		if (townNameAllowed(prefix, suffix)) return prefix + suffix;
	}
	for (let k = 0; k < combos; k++) {
		const prefix = TOWN_PREFIXES[k % p];
		const suffix = TOWN_SUFFIXES[math.floor(k / p)];
		if (townNameAllowed(prefix, suffix)) return prefix + suffix;
	}
	return TOWN_PREFIXES[0] + TOWN_SUFFIXES[0];
}
