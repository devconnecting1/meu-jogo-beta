/*
 * A town's NAME, from its seed (docs/DESIGN_RULES.md MP-26): "Brackenmere", "Ploverstead", "Wrenvale".
 *
 * The seed is the town (the server's, MP-26), so the name is too: every client and the server derive the same one from
 * the seed they already have -- the home screen's Town section, the match scoreboard, the world-end message, the Servers
 * list, the server's log. Nothing new travels on the wire, and nothing here draws from the town generator's random
 * stream (shared/game/world.ts TownRng): naming a town can never change its streets. `npm run test:seed` checks the
 * name across seeds, under the same poisoned clocks and random as the town itself.
 *
 * What a name may be (CON-02, and the owner's "generic small town"): a prefix and a suffix of the old English place
 * words, joined. The prefixes are the less common words of a hedgerow, a farmyard and a workshop (Bracken, Plover,
 * Tallow...), not the trees and stones every real town is named after (Oak, Pine, Stone, Willow...): far fewer of
 * the combinations are a real place (review of 0b44458, L6). No brand, no real town anyone would know: the combinations
 * that spell one are in TOWN_NAME_BLOCKLIST and are hashed again, as are the ones that double a letter at the join
 * ("Quillley").
 *
 * A proper noun: never translated (UI-03), and every label that shows one turns AutoLocalize off.
 */

export const TOWN_PREFIXES: ReadonlyArray<string> = [
	"Amber",
	"Barley",
	"Bracken",
	"Bramble",
	"Briar",
	"Cinder",
	"Clover",
	"Cobble",
	"Dapple",
	"Ember",
	"Fallow",
	"Fennel",
	"Flax",
	"Gorse",
	"Heron",
	"Hollin",
	"Juniper",
	"Kestrel",
	"Kettle",
	"Lantern",
	"Linnet",
	"Mallow",
	"Marrow",
	"Nettle",
	"Pewter",
	"Plover",
	"Quill",
	"Rook",
	"Russet",
	"Saffron",
	"Sedge",
	"Sorrel",
	"Sparrow",
	"Tallow",
	"Tansy",
	"Teasel",
	"Thistle",
	"Thrush",
	"Umber",
	"Wicker",
	"Wren",
	"Yarrow",
];

export const TOWN_SUFFIXES: ReadonlyArray<string> = [
	"bank",
	"brook",
	"bury",
	"combe",
	"croft",
	"dale",
	"fold",
	"ford",
	"gate",
	"hithe",
	"holt",
	"ley",
	"mere",
	"moor",
	"stead",
	"thorpe",
	"vale",
	"well",
	"wick",
	"worth",
];

/**
 * Names that are never a town's: the real places these lists can spell, and -- whatever the lists become -- every real
 * town or brand a review flagged. Exactly as the join spells them.
 */
export const TOWN_NAME_BLOCKLIST: ReadonlyArray<string> = [
	"Ambergate",
	"Amberley",
	"Barleythorpe",
	"Brackenbury",
	"Cinderford",
	"Flaxley",
	"Flaxmere",
	"Hollinwell",
	"Kettlebrook",
	"Kettlethorpe",
	"Kettlewell",
	"Nettlecombe",
	"Nettlestead",
	"Rookley",
	"Sedgebrook",
	"Sedgeford",
	"Sedgemoor",
	"Wrenbury",
	"Wrenthorpe",
	"Yarrowford",
	"Ashbury",
	"Ashfield",
	"Ashford",
	"Ashville",
	"Copperfield",
	"Elmhurst",
	"Elmwood",
	"Ferndale",
	"Hawkhurst",
	"Hazelwood",
	"Hollywood",
	"Ironwood",
	"Mapleridge",
	"Maplewood",
	"Oakbrook",
	"Oakdale",
	"Oakhurst",
	"Oakridge",
	"Oakville",
	"Pinecrest",
	"Pinehurst",
	"Pineridge",
	"Pinewood",
	"Stonegate",
	"Stonehaven",
	"Thornbury",
	"Willowbrook",
	"Willowdale",
];

/** MINSTD's multiplier and modulus (the town's own TownRng uses them too; this is a separate, one-step hash) */
const HASH_MUL = 48271;
const HASH_MOD = 2147483647;

/** may `prefix` + `suffix` name a town: no letter doubled at the join, no "-leley", nothing on the blocklist */
export function townNameAllowed(prefix: string, suffix: string): boolean {
	if (prefix.sub(-1) === suffix.sub(1, 1)) return false;
	// "Nettleley", "Barleyley": a "-ley" after "-le" or "-y" does not read as a town
	if (suffix === "ley" && (prefix.sub(-2) === "le" || prefix.sub(-1) === "y")) return false;
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
