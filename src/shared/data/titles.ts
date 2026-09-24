/*
 * Titles: a word in brackets under a survivor's name, for everyone to read (docs/DESIGN_RULES.md MON-05).
 *
 * A title is EARNED by playing and never sold (MON-01: it is identity, and the only way to have one is to have done
 * the thing). The SERVER decides every unlock from its own counters (MP-00) and writes it into the save
 * (server/save/titles.ts is the only code that grants one). The Supporter mark of the subscription (MON-07,
 * shared/data/supporter.ts) is NOT a title: it is never in this table, never counted with these, and drawn apart.
 *
 * What earns each one, and where the server decides it:
 *
 *   the kill credit (server/sim/progress.ts `creditKill`: the killing blow, never an assist, MP-15)
 *     Horde Breaker / Exterminator / Zombie Bane   100 / 1,000 / 10,000 zombies put down (`zombieKills`, lifetime)
 *     Tracker        every kind of zombie put down at least once (Walker, Spitter, Exploder, Charger, Jumper)
 *     Sharpshooter   500 zombies put down with a firearm (rifle, pistol, machine gun, shotgun, sniper)
 *   a zombie a machine you built brought down (`creditMachineKill`, ELE-04)
 *     Sentry         100 of them
 *   a boss you took part in bringing down (`creditBoss`, MP-15 participation)
 *     Boss Hunter    the first one; Apex Hunter  all four kinds (Centipede, Rafflesia, Giant, Hedgehog)
 *   a midnight the server credited to THIS life (server/sim/simulation.ts `creditMidnight`, the MP-13 count)
 *     Week One / Seasoned / Old Guard / Centurion   7 / 25 / 50 / 100 nights in one life (`lifeNights`)
 *     Unbroken       10 nights in one life that has not died once (`lifeDeaths` = 0)
 *   a whole night lived (`creditDawn` at 06:00: paid at the midnight inside it, alive in the world every tick since,
 *   awake at the controls -- progress.ts `survivedNight`), with what the server saw of that night
 *     Survivor       the first one; Nightwatch  25 of them, over every life
 *     Untouched      no health lost all night, and 10 zombies put down in it
 *     Blade Dancer   25 zombies put down in it, every killing blow by a melee weapon
 *     Stormborn      the night's sky is the town's own thunderstorm (LUZ-05: never an admin's weather)
 *     Fog Walker     the night ends in the town's own fog (dawn fog or a day of fog)
 *     Safety in Numbers   at least 3 other survivors lived the same whole night
 *     Ghost          (secret) no zombie put down and no health lost, on world day GHOST_FROM_DAY or later
 *     Close Call     (secret) the health fell to CLOSE_CALL_SHARE of the maximum or less, and the night was lived anyway
 *   the server's own verbs
 *     Builder        25 constructions placed (server/sim/build.ts `place`)
 *     Tinkerer       50 items crafted (server/sim/craft.ts: a construction counts when it is placed, as a Builder's)
 *     Safecracker    a bank vault cracked (server/sim/vault.ts `onCracked`, EDI-24)
 *
 * An assisted run (§9.3) earns none of them, as it earns no coins. Nothing here needs content outside the game of
 * today (CON-03): the bosses spawn, the vault is in every town, the weathers roll.
 *
 * RULES OF THE TABLE. A new title is a new row at the END: the save keeps one flag per id (`titles[id]`) and the wire
 * carries `id + 1`, so reordering would hand everybody's titles to the wrong names. The same for `TitleStat`: the save
 * keeps one number per stat (`titleStats[i]`), new stats go at the end. The colour is a RARITY, not a Color3: shared
 * code never reads the client's theme, and client/ui/titleStyle.ts resolves each rarity to a token held to 4,5:1 by
 * `npm run test:contrast` (rows) and `npm run test:world-art` section 9 (the nameplate over the world).
 */

/** the ids of the titles, as the save and the server know them (never renumbered: new ones go at the end) */
export const TitleId = {
	Survivor: 0,
	HordeBreaker: 1,
	WeekOne: 2,
	Exterminator: 3,
	ZombieBane: 4,
	Seasoned: 5,
	OldGuard: 6,
	Centurion: 7,
	Unbroken: 8,
	Nightwatch: 9,
	Untouched: 10,
	BladeDancer: 11,
	Stormborn: 12,
	FogWalker: 13,
	SafetyInNumbers: 14,
	Tracker: 15,
	BossHunter: 16,
	ApexHunter: 17,
	Sharpshooter: 18,
	Sentry: 19,
	Builder: 20,
	Tinkerer: 21,
	Safecracker: 22,
	Ghost: 23,
	CloseCall: 24,
} as const;
export type TitleId = (typeof TitleId)[keyof typeof TitleId];

/**
 * The counters only titles read (`PlayerSaveData.titleStats`, save v7), one number each, lifetime, server-owned. Two
 * kinds: a COUNT only grows; a set of BITS only gains bits (which zombie kinds, which bosses). Never renumbered.
 */
export const TitleStat = {
	/** whole nights lived (the Survivor's rule), over every life */
	NightsSurvived: 0,
	/** bit (type - 1) of every zombie kind put down (ZombieType 1..5) */
	ZombieKinds: 1,
	/** bit (type - 1) of every boss kind brought down with you in the fight (1..4) */
	BossKinds: 2,
	/** zombies put down with a firearm */
	GunKills: 3,
	/** zombies a machine you built (or a drone you fly) brought down */
	MachineKills: 4,
	/** constructions placed */
	Builds: 5,
	/** items crafted */
	Crafts: 6,
} as const;
export type TitleStat = (typeof TitleStat)[keyof typeof TitleStat];

/** how many numbers `titleStats` holds */
export const TITLE_STAT_COUNT = 7;
/** the zombie kinds (ZombieType 1..5) and the boss kinds (1..4) a set of bits can hold */
export const ZOMBIE_KIND_COUNT = 5;
export const BOSS_KIND_COUNT = 4;

/** a stat that is a set of bits (the rest are counts) */
export function titleStatIsBits(stat: number): boolean {
	return stat === TitleStat.ZombieKinds || stat === TitleStat.BossKinds;
}

/** the largest value a stat may hold: a count up to `countMax`, a set of bits up to all of its bits */
export function titleStatMax(stat: number, countMax: number): number {
	if (stat === TitleStat.ZombieKinds) return 2 ** ZOMBIE_KIND_COUNT - 1;
	if (stat === TitleStat.BossKinds) return 2 ** BOSS_KIND_COUNT - 1;
	return countMax;
}

// ---------------------------------------------------------------- bits, in plain arithmetic (Luau and Node alike)

/** is bit `bit` (0..30) set in `v`? */
export function hasBit(v: number, bit: number): boolean {
	return math.floor(math.max(0, v) / 2 ** bit) % 2 === 1;
}

/** `v` with bit `bit` (0..30) set */
export function withBit(v: number, bit: number): number {
	return hasBit(v, bit) ? v : math.max(0, v) + 2 ** bit;
}

/** how many of the low `bits` bits of `v` are set */
export function bitCount(v: number, bits: number): number {
	let n = 0;
	for (let i = 0; i < bits; i++) if (hasBit(v, i)) n += 1;
	return n;
}

/** the union of two sets of `bits` bits (a wallet that crossed a newer one never takes a bit back) */
export function unionBits(a: number, b: number, bits: number): number {
	let v = 0;
	for (let i = 0; i < bits; i++) if (hasBit(a, i) || hasBit(b, i)) v += 2 ** i;
	return v;
}

// ---------------------------------------------------------------- the numbers

/** Horde Breaker / Exterminator / Zombie Bane: zombies put down (killing blows the server credited, lifetime) */
export const HORDE_BREAKER_KILLS = 100;
export const EXTERMINATOR_KILLS = 1000;
export const ZOMBIE_BANE_KILLS = 10000;
/** Week One / Seasoned / Old Guard / Centurion: the midnights one life has to live, as the server credits them */
export const WEEK_ONE_NIGHTS = 7;
export const SEASONED_NIGHTS = 25;
export const OLD_GUARD_NIGHTS = 50;
export const CENTURION_NIGHTS = 100;
/** ...which takes a life that started at day 1 to day 8 */
export const WEEK_ONE_DAY = WEEK_ONE_NIGHTS + 1;
/** Unbroken: nights of one life that has not died once */
export const UNBROKEN_NIGHTS = 10;
/** Nightwatch: whole nights lived, over every life */
export const NIGHTWATCH_NIGHTS = 25;
/** Untouched: zombies put down in the night lived without losing health */
export const UNTOUCHED_KILLS = 10;
/** Blade Dancer: zombies put down in the night, every one by a melee weapon */
export const BLADE_DANCER_KILLS = 25;
/** Safety in Numbers: survivors who lived the same whole night, you included */
export const SAFETY_IN_NUMBERS_SURVIVORS = 4;
/** Ghost: a night of this WORLD day or later (the horde grows with the day, shared/game/save.ts difficultyOfDay) */
export const GHOST_FROM_DAY = 10;
/** Close Call: the share of the maximum health the survivor fell to (or under) during the night */
export const CLOSE_CALL_SHARE = 0.1;
/** Sharpshooter / Sentry */
export const SHARPSHOOTER_KILLS = 500;
export const SENTRY_KILLS = 100;
/** Builder / Tinkerer */
export const BUILDER_BUILDS = 25;
export const TINKERER_CRAFTS = 50;

// ---------------------------------------------------------------- the table

/**
 * How hard a title is to get, and the colour it is drawn in (client/ui/titleStyle.ts: one theme token each). The
 * nameplate says it by the colour; the wardrobe also writes the word ("Legendary"), so colour is never the only cue.
 */
export type TitleRarity = "common" | "uncommon" | "rare" | "epic" | "legendary";

/** the rarities from the easiest up (the wardrobe lists the titles in this order) */
export const TITLE_RARITIES: ReadonlyArray<TitleRarity> = ["common", "uncommon", "rare", "epic", "legendary"];

/** the word for a rarity (a lang key) */
export function rarityName(rarity: TitleRarity): string {
	if (rarity === "uncommon") return "Uncommon";
	if (rarity === "rare") return "Rare";
	if (rarity === "epic") return "Epic";
	if (rarity === "legendary") return "Legendary";
	return "Common";
}

/** the rarity as a key's legend, in capitals like the kit's other keys ("TITLE", "OUTFIT"): a lang key of its own */
export function rarityKeyName(rarity: TitleRarity): string {
	if (rarity === "uncommon") return "UNCOMMON";
	if (rarity === "rare") return "RARE";
	if (rarity === "epic") return "EPIC";
	if (rarity === "legendary") return "LEGENDARY";
	return "COMMON";
}

/** where a rarity sits in TITLE_RARITIES (0 = common) */
export function rarityRank(rarity: TitleRarity): number {
	const i = TITLE_RARITIES.indexOf(rarity);
	return i >= 0 ? i : 0;
}

/**
 * What a locked title's progress counts, for the wardrobe (always one of the server's own numbers, which the wallet
 * mirrors): `kills` = `zombieKills`; `lifeNights`; `deathless` = `lifeNights` while `lifeDeaths` is 0; `stat` =
 * `titleStats[stat]`; `bits` = how many bits `titleStats[stat]` has; `none` = no count, only the sentence.
 */
export type TitleTrack = "kills" | "lifeNights" | "deathless" | "stat" | "bits" | "none";

export interface TitleDef {
	/** index into `save.titles`; the wire carries `id + 1` (0 = no title) */
	id: number;
	/** the title itself, drawn in brackets: "[Survivor]" (a lang key) */
	name: string;
	/** one line: how it is earned (a lang key) */
	howTo: string;
	/** what a locked title's progress counts (a lang key): "Zombies put down: 37 / 100"; "" for `none` */
	progressLabel: string;
	/** the number that progress reaches (1 for a title earned in one go) */
	goal: number;
	rarity: TitleRarity;
	track: TitleTrack;
	/** `track` "stat" / "bits": which TitleStat */
	stat?: number;
	/**
	 * A secret: while locked, the wardrobe shows "[???]" and "A secret title", its rarity and nothing more -- how to
	 * earn it stays a surprise (BEM: it is still earned by ordinary play, and the "?" says secrets exist).
	 */
	secret?: boolean;
}

export const TITLES: Array<TitleDef> = [
	{
		id: TitleId.Survivor,
		name: "Survivor",
		howTo: "Survive your first night.",
		progressLabel: "Nights survived",
		goal: 1,
		rarity: "common",
		track: "stat",
		stat: TitleStat.NightsSurvived,
	},
	{
		id: TitleId.HordeBreaker,
		name: "Horde Breaker",
		howTo: "Put down 100 zombies.",
		progressLabel: "Zombies put down",
		goal: HORDE_BREAKER_KILLS,
		rarity: "uncommon",
		track: "kills",
	},
	{
		id: TitleId.WeekOne,
		name: "Week One",
		howTo: "Stay alive for 7 days in one life.",
		progressLabel: "Nights survived in this life",
		goal: WEEK_ONE_NIGHTS,
		rarity: "uncommon",
		track: "lifeNights",
	},
	{
		id: TitleId.Exterminator,
		name: "Exterminator",
		howTo: "Put down 1,000 zombies.",
		progressLabel: "Zombies put down",
		goal: EXTERMINATOR_KILLS,
		rarity: "rare",
		track: "kills",
	},
	{
		id: TitleId.ZombieBane,
		name: "Zombie Bane",
		howTo: "Put down 10,000 zombies.",
		progressLabel: "Zombies put down",
		goal: ZOMBIE_BANE_KILLS,
		rarity: "legendary",
		track: "kills",
	},
	{
		id: TitleId.Seasoned,
		name: "Seasoned",
		howTo: "Stay alive for 25 days in one life.",
		progressLabel: "Nights survived in this life",
		goal: SEASONED_NIGHTS,
		rarity: "rare",
		track: "lifeNights",
	},
	{
		id: TitleId.OldGuard,
		name: "Old Guard",
		howTo: "Stay alive for 50 days in one life.",
		progressLabel: "Nights survived in this life",
		goal: OLD_GUARD_NIGHTS,
		rarity: "epic",
		track: "lifeNights",
	},
	{
		id: TitleId.Centurion,
		name: "Centurion",
		howTo: "Stay alive for 100 days in one life.",
		progressLabel: "Nights survived in this life",
		goal: CENTURION_NIGHTS,
		rarity: "legendary",
		track: "lifeNights",
	},
	{
		id: TitleId.Unbroken,
		name: "Unbroken",
		howTo: "Live 10 days in one life without dying once.",
		progressLabel: "Nights without dying in this life",
		goal: UNBROKEN_NIGHTS,
		rarity: "rare",
		track: "deathless",
	},
	{
		id: TitleId.Nightwatch,
		name: "Nightwatch",
		howTo: "Survive 25 whole nights.",
		progressLabel: "Nights survived",
		goal: NIGHTWATCH_NIGHTS,
		rarity: "uncommon",
		track: "stat",
		stat: TitleStat.NightsSurvived,
	},
	{
		id: TitleId.Untouched,
		name: "Untouched",
		howTo: "Survive a night without losing health, putting down 10 zombies.",
		progressLabel: "",
		goal: 1,
		rarity: "rare",
		track: "none",
	},
	{
		id: TitleId.BladeDancer,
		name: "Blade Dancer",
		howTo: "Survive a night putting down 25 zombies, all with melee weapons.",
		progressLabel: "",
		goal: 1,
		rarity: "rare",
		track: "none",
	},
	{
		id: TitleId.Stormborn,
		name: "Stormborn",
		howTo: "Survive a whole night in a thunderstorm.",
		progressLabel: "",
		goal: 1,
		rarity: "epic",
		track: "none",
	},
	{
		id: TitleId.FogWalker,
		name: "Fog Walker",
		howTo: "Survive a whole night that ends in fog.",
		progressLabel: "",
		goal: 1,
		rarity: "uncommon",
		track: "none",
	},
	{
		id: TitleId.SafetyInNumbers,
		name: "Safety in Numbers",
		howTo: "Survive a whole night with 3 other survivors who make it too.",
		progressLabel: "",
		goal: 1,
		rarity: "uncommon",
		track: "none",
	},
	{
		id: TitleId.Tracker,
		name: "Tracker",
		howTo: "Put down every kind of zombie.",
		progressLabel: "Kinds of zombie put down",
		goal: ZOMBIE_KIND_COUNT,
		rarity: "uncommon",
		track: "bits",
		stat: TitleStat.ZombieKinds,
	},
	{
		id: TitleId.BossHunter,
		name: "Boss Hunter",
		howTo: "Help bring down a boss.",
		progressLabel: "Kinds of boss brought down",
		goal: 1,
		rarity: "uncommon",
		track: "bits",
		stat: TitleStat.BossKinds,
	},
	{
		id: TitleId.ApexHunter,
		name: "Apex Hunter",
		howTo: "Help bring down all four bosses.",
		progressLabel: "Kinds of boss brought down",
		goal: BOSS_KIND_COUNT,
		rarity: "epic",
		track: "bits",
		stat: TitleStat.BossKinds,
	},
	{
		id: TitleId.Sharpshooter,
		name: "Sharpshooter",
		howTo: "Put down 500 zombies with firearms.",
		progressLabel: "Zombies put down with firearms",
		goal: SHARPSHOOTER_KILLS,
		rarity: "rare",
		track: "stat",
		stat: TitleStat.GunKills,
	},
	{
		id: TitleId.Sentry,
		name: "Sentry",
		howTo: "Bring down 100 zombies with turrets you built.",
		progressLabel: "Zombies your turrets brought down",
		goal: SENTRY_KILLS,
		rarity: "rare",
		track: "stat",
		stat: TitleStat.MachineKills,
	},
	{
		id: TitleId.Builder,
		name: "Builder",
		howTo: "Place 25 constructions.",
		progressLabel: "Constructions placed",
		goal: BUILDER_BUILDS,
		rarity: "common",
		track: "stat",
		stat: TitleStat.Builds,
	},
	{
		id: TitleId.Tinkerer,
		name: "Tinkerer",
		howTo: "Craft 50 items.",
		progressLabel: "Items crafted",
		goal: TINKERER_CRAFTS,
		rarity: "common",
		track: "stat",
		stat: TitleStat.Crafts,
	},
	{
		id: TitleId.Safecracker,
		name: "Safecracker",
		howTo: "Crack a bank vault.",
		progressLabel: "",
		goal: 1,
		rarity: "rare",
		track: "none",
	},
	{
		id: TitleId.Ghost,
		name: "Ghost",
		howTo: "Survive a night from world day 10 on without putting down a zombie or losing health.",
		progressLabel: "",
		goal: 1,
		rarity: "rare",
		track: "none",
		secret: true,
	},
	{
		id: TitleId.CloseCall,
		name: "Close Call",
		howTo: "Survive a whole night after falling to a tenth of your health.",
		progressLabel: "",
		goal: 1,
		rarity: "rare",
		track: "none",
		secret: true,
	},
];

/** the largest title byte on the wire (PlayerJoined / PlayerProfile / Announce): 0 = none, else id + 1 */
export const TITLE_WIRE_MAX = TITLES.size();

/** the wire byte of a title id (-1 = none) */
export function titleToWire(id: number): number {
	return id >= 0 && id < TITLES.size() ? id + 1 : 0;
}

/** the title id a wire byte names, or -1 for none (and for anything out of range) */
export function titleFromWire(wire: number): number {
	return wire >= 1 && wire <= TITLE_WIRE_MAX && wire % 1 === 0 ? wire - 1 : -1;
}

/**
 * The titles in the wardrobe's order: by rarity from common up, and in the table's order within one rarity -- so the
 * list reads as a ladder, and the colours come in bands.
 */
export function titlesInOrder(): Array<TitleDef> {
	const out: Array<TitleDef> = [];
	for (const rarity of TITLE_RARITIES) {
		for (const def of TITLES) if (def.rarity === rarity) out.push(def);
	}
	return out;
}
