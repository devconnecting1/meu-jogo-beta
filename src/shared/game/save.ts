import { SKILLS } from "shared/data/skills";
import { ACHIEVEMENTS } from "shared/data/achievements";
import { WEAPONS } from "shared/data/weapons";
import { EQUIPS, EquipSlot } from "shared/data/equips";
import { USABLES } from "shared/data/usables";
import { ETC_ITEMS } from "shared/data/etcItems";
import { ItemKind } from "shared/data/kinds";
import { COSTUMES, ECONOMY, SHOP_PACKS, costumeForEquip } from "shared/data/shop";
import { OutfitLook, PetLook, cosmeticSlotOf, outfitLookOfEquip, petLookOfEquip } from "shared/data/cosmetics";
import { TITLES, titleToWire } from "shared/data/titles";
import { MP_PHASE } from "shared/net/mpConfig";

/**
 * v1: raw client JSON (shopHave = pending packs). v2: server-validated, packsBought/packsOpened/costumes.
 * v3 (docs/MULTIPLAYER.md §6.4): the SERVER owns the run, so the run's body travels with the save —
 * `runHp` and `runHunger`. Nothing else changes: `day` keeps its value and only gains a clearer meaning
 * (days survived in this life, §6.2).
 *
 * The migration is additive and therefore reversible. v3 lives in the SAME DataStore document as v2
 * (`{data, lock}`), `sanitizeStoredSave` fills the two new fields from `emptySave()` when a v2 document has
 * no trace of them, and a server rolled back to v2 code simply drops them as unknown keys. So: no save is
 * rewritten, no save is lost, and a rollback costs at most one run's HP bar.
 *
 * v4 (MON-04, docs/MULTIPLAYER.md §6.5): the single "Deco" slot becomes TWO cosmetic slots worn at once —
 * `equipOutfit` (Santa, Zombie, Cowboy: the body) and `equipPet` (the pigeons, the eagle, the dogs: a companion).
 * `equipDeco` is gone from the schema. Same rules as v3: same document, additive, reversible —
 *   - a v3 document has `equipDeco` and neither new field: `readProgress` routes that one id to the slot it
 *     belongs to (`cosmeticSlotOf`), so whatever was equipped stays equipped;
 *   - a server rolled back to v3 code drops the two unknown keys and reads no `equipDeco`, so the survivor comes
 *     back with no cosmetic EQUIPPED. What they OWN (`costumes`, the inventory) is untouched in both directions:
 *     a rollback costs one click in the backpack, never a purchase.
 *
 * v5 (MON-05): titles, EARNED on the server's own counters and never sold. New fields, same document, additive:
 * `titles` (one flag per shared/data/titles.ts id, server-owned like `costumes`), `zombieKills` (the lifetime
 * killing blows the server credited, server-owned like `bossKills`), `lifeNights` (the midnights the server credited
 * to this life, Week One's count), `equipTitle` (the one shown under the name, -1 = none, checked against `titles`
 * like an outfit against `costumes`) and `titleEpoch` (which title history the save is, server/save/titleRecord.ts).
 *   - a v4 document has none of them: no title unlocked, no kill or night counted, nothing shown -- exactly the
 *     truth, since no server counted any of it before v5;
 *   - a server rolled back to v4 code drops them all when it writes. What was EARNED survives that anyway: every
 *     session also writes `titles` and `zombieKills` to a second document v4 never opens (server/save/titleRecord.ts,
 *     store `ProjectZ_Titles`), and the next v5 load takes the larger of the two. So a rollback forgets only WHICH
 *     title was shown -- one click in the wardrobe -- never a title or a kill. (And the current life's progress
 *     toward Week One, `lifeNights`, which is a count toward a title, not one.)
 *
 * v6 (CON-04, docs/MULTIPLAYER.md §6.7): the achievements become the SERVER's. Their counters move only on events the
 * server decided (server/save/achievements.ts: its kill credit, its midnight, its crafting, its deaths), so a report no
 * longer carries them -- `sanitizeClientReport` copies `achievements` from the trusted save, as it does `titles`. One
 * new field, same document, additive: `lifeDeaths`, EVERY death of this life that the server decided (Never die reads
 * it; `deathCount` only counts the paid Rebirths, which price the next one). A v5 document has none: 1 when its life
 * already died as far as it can tell (`deathCount > 0` -- where the old rule stopped -- or `runOver`), else 0; a v5 death
 * answered by waiting for daybreak left no record. A server rolled back to v5 drops it and takes achievements from
 * reports again; nothing earned is lost.
 */
export const SAVE_VERSION = 6;
/** the first version that carries `runHp` / `runHunger`; below it those two fields are absent, not zero */
export const SAVE_VERSION_RUN_BODY = 3;
/** the first version with `equipOutfit` / `equipPet`; below it the one cosmetic lives in `equipDeco` */
export const SAVE_VERSION_COSMETIC_SLOTS = 4;
/** the first version with `titles` / `zombieKills` / `equipTitle` (MON-05) */
export const SAVE_VERSION_TITLES = 5;
/** the first version whose `achievements` are server-owned and that carries `lifeDeaths` (CON-04) */
export const SAVE_VERSION_SERVER_ACHIEVEMENTS = 6;

/** hard sanity limits applied to every save the server reads or accepts */
export const SAVE_LIMITS = {
	LEVEL_MAX: 999,
	DAY_MAX: 99999,
	ITEM_MAX: 9999,
	AMMO_MAX: 99999,
	MONEY_MAX: 100000000,
	COUNTER_MAX: 10000000,
	/** v3 run body: hp is 100 + 10 per "tough" skill level, so this is far above any legitimate value */
	RUN_HP_MAX: 100000,
	/** v3 run body: hunger accumulated; DESIGN.PLAYER_HUNGRY is the bar, this is a generous ceiling */
	RUN_HUNGER_MAX: 100000,
	/** v5 `titleEpoch`: an os.time() (seconds since 1970) with room for centuries */
	EPOCH_MAX: 99999999999,
} as const;

export interface SettingsData {
	soundEffect: number;
	bgm: number;
	uiSize: number;
	leftSize: number;
	leftPos: number;
	leftRelative: boolean;
	rightSize: number;
	rightPos: number;
	/** left-handed: the move stick and the aim/fire pad swap sides (shared/engine/input.ts) */
	mirror: boolean;
	langType: number;
	/** Settings › Graphics: 0 Auto (by the frame time), 1 High, 2 Low (client/view/quality.ts) */
	graphics: number;
}

/** every field of SettingsData (the order is irrelevant; `carrySettings` walks it) */
const SETTINGS_KEYS: ReadonlyArray<keyof SettingsData> = [
	"soundEffect",
	"bgm",
	"uiSize",
	"leftSize",
	"leftPos",
	"leftRelative",
	"rightSize",
	"rightPos",
	"mirror",
	"langType",
	"graphics",
];

/**
 * The settings a player changed on a save that was never the server's -- the fallback save the lobby shows while the
 * LoadAck is on its way, or a session that does not persist -- are carried into the save that replaces it
 * (client/main.client.ts `applyLoad`): every field where `mine` differs from `base` (what that save started with) is
 * written into `into`, and only those, so what the player did not touch comes from the save arriving. Returns whether
 * anything was carried. The values are the client's own settings, never anything the server owns: the report that
 * follows goes through `readSettings` like every other.
 */
export function carrySettings(mine: SettingsData, base: SettingsData, into: SettingsData): boolean {
	let carried = false;
	for (const k of SETTINGS_KEYS) {
		if (mine[k] === base[k]) continue;
		(into as unknown as Record<string, unknown>)[k] = mine[k];
		carried = true;
	}
	return carried;
}

export function defaultSettings(): SettingsData {
	return {
		soundEffect: 0.5,
		bgm: 0.5,
		uiSize: 0.5,
		leftSize: 0.5,
		leftPos: 0.5,
		leftRelative: true,
		rightSize: 0.5,
		rightPos: 0.5,
		mirror: false,
		langType: 0,
		graphics: 0,
	};
}

/**
 * Field ownership:
 * - server-owned (the client copy is display-only and is ignored when reported):
 *   money, deathCount, bestDay, packsBought, costumes, runRev, version, titles, zombieKills, lifeNights, titleEpoch,
 *   achievements and lifeDeaths (v6)
 * - client-simulated, validated/clamped by the server: everything else
 *   (day, level, bossKills and packsOpened additionally have time/ordering limits on the server)
 * - from PROGRESS_SERVER_PHASE the progress (level, exp, skillPoint, bossKills, day) is the server's, and from
 *   WORLD_SERVER_PHASE (shared/net/mpConfig.ts) the backpack too: inventory, ammunition, equipped slots, skill levels
 *   and packsOpened. A report no longer moves them (server/sim/progress.ts `stripClientProgress`,
 *   server/sim/backpack.ts `stripClientBackpack`); the wallet's `bag` brings the server's copy back (`BagMirror`).
 */
export interface PlayerSaveData {
	version: number;
	level: number;
	exp: number;
	skillPoint: number;
	skillLevels: Array<number>;
	money: number;
	day: number;
	bestDay: number;
	deathCount: number;
	bossKills: number;
	firstInstall: boolean;
	tutorialDone: boolean;
	/**
	 * One counter per shared/data/achievements.ts row, capped at its `max`. v6: written only by the SERVER
	 * (server/save/achievements.ts), on events it decided; a report never moves it (CON-04).
	 */
	achievements: Array<number>;
	/** lifetime packs bought, per SHOP_PACKS id */
	packsBought: Array<number>;
	/** lifetime packs delivered into the inventory, per SHOP_PACKS id (never above packsBought) */
	packsOpened: Array<number>;
	/** 1 = unlocked, per COSTUMES id */
	costumes: Array<number>;
	/** the current run ended in a game over (needs a paid rebirth or a new run to continue) */
	runOver: boolean;
	/**
	 * v3 (§6.1): the run's HP when the session ended, so coming back does not hand out a free heal.
	 * 0 means "not recorded" (a v2 save, a fresh run, or a run that ended in death) and the survivor
	 * spawns at full — never at 0 hp, which would kill them on arrival.
	 */
	runHp: number;
	/** v3 (§6.1): hunger ACCUMULATED, so 0 = full. `PlayerState.hungry` counts the other way (it runs down). */
	runHunger: number;
	/** bumped by the server on every rebirth / new run: reports from before it are stale */
	runRev: number;
	settings: SettingsData;
	invenWeapon: Array<number>;
	invenEquip: Array<number>;
	invenUse: Array<number>;
	invenEtc: Array<number>;
	ammoNormal: number;
	ammoShotgun: number;
	ammoMachinegun: number;
	ammoArrow: number;
	oil: number;
	electric: number;
	equipWeapon: number;
	equipCloth: number;
	equipHand: number;
	equipGun: number;
	/** v4 (MON-04): EQUIPS id of the worn outfit (EquipSlot.Outfit), -1 = none. Drawn on the body, for everyone. */
	equipOutfit: number;
	/** v4 (MON-04): EQUIPS id of the pet that follows the survivor (EquipSlot.Pet), -1 = none */
	equipPet: number;
	/** v5 (MON-05): 1 = earned, per TITLES id. Written only by the server (server/save/titles.ts `grantTitle`) */
	titles: Array<number>;
	/**
	 * v5 (MON-05): lifetime zombies put down -- the killing blows the SERVER's kill credit gave this survivor
	 * (server/sim/progress.ts), never an assist and never a number a report carried. It only grows.
	 */
	zombieKills: number;
	/**
	 * v5 (MON-05): the midnights the SERVER credited to this life while its run paid (server/sim/simulation.ts
	 * `creditMidnight`): never a day a client reported before the server counted days, an admin set, or an assisted
	 * run lived. Week One counts these. Back to 0 with the life (`resetRun`). Server-owned.
	 */
	lifeNights: number;
	/** v5 (MON-05): TITLES id shown under the name, -1 = none; must be earned (`enforceSaveInvariants`) */
	equipTitle: number;
	/**
	 * v6 (CON-04): the deaths of THIS life the server decided -- every one, whatever answered it (a paid Rebirth, the
	 * wait for daybreak, an ally). Never die counts only while it is 0. Back to 0 with the life (`resetRun`).
	 * Server-owned (server/sim/life.ts through server/save/achievements.ts `countLifeDeath`).
	 */
	lifeDeaths: number;
	/**
	 * v5 (MON-05): which title HISTORY this save is. 0 for a save that came from v4 (or went through a v4 server);
	 * otherwise the os.time() it was started at (a new save) or an admin last edited or reset it at. A title record
	 * (server/save/titleRecord.ts) from an OLDER epoch belongs to a history that was reset or deleted on purpose and is
	 * never merged back. Server-owned: written only by server/main.server.ts.
	 */
	titleEpoch: number;
}

/** the server-owned part of the save, pushed to the client after every economy change */
export interface Wallet {
	money: number;
	deathCount: number;
	bestDay: number;
	bossKills: number;
	packsBought: Array<number>;
	packsOpened: Array<number>;
	costumes: Array<number>;
	runRev: number;
	/** v5 (MON-05): what the server says was earned, and the kill count a locked Horde Breaker shows */
	titles: Array<number>;
	zombieKills: number;
	/** v5 (MON-05): the nights the server credited to this life -- a locked Week One's progress. Optional: older servers */
	lifeNights?: number;
	/** v6 (CON-04): the achievement counters, the server's. Optional: a wallet from an older server has none */
	achievements?: Array<number>;
	/**
	 * The day of this life (MP-13), from PROGRESS_SERVER_PHASE on the SERVER's (its midnight credits it, or refuses
	 * to: dead, absent, AFK). Optional so a wallet from an older server still parses.
	 */
	day?: number;
	/**
	 * Level and XP, from PROGRESS_SERVER_PHASE on (§11.3 F2) the SERVER's (server/sim/progress.ts `awardExp`): this
	 * wallet is how they reach the client. Optional so a wallet from an older server still parses.
	 */
	level?: number;
	exp?: number;
	/**
	 * From WORLD_SERVER_PHASE (F3) the backpack is the SERVER's, and this is how it reaches the client: pushed by
	 * server/main.server.ts whenever it changed or an intent was answered. Absent below that phase, and in a wallet
	 * that carries nothing new about it.
	 */
	bag?: BagMirror;
}

/**
 * The backpack as the SERVER holds it (docs/MULTIPLAYER.md §6.3 "espelho somente leitura"): everything a client
 * used to write into its own copy and report — the inventory, the ammunition, what is equipped and the skills —
 * plus the two numbers the client reconciles its predictions with (client/net/backpackSync.ts):
 *   - `ack`: the nonce of the last backpack intent the server HANDLED, applied or refused (shared/net/intentWire.ts);
 *     a prediction for a newer one is replayed on top of this bag, an older one is dropped;
 *   - `seq`: the last command the server had consumed from this survivor when it wrote the bag (-1 = not in the
 *     world); a build placed or cancelled by an edge of a newer command is still the client's prediction.
 * `place` is the construction on the server's cursor (PLACEABLES id, -1 = none): a craft puts it there, the attack
 * edge places it, the action edge cancels it (server/sim/build.ts).
 *
 * Sizes: ~150 numbers, sent only when one of them changed (or `ack` moved) — a reload, a pickup, a craft, a switch.
 */
export interface BagMirror {
	invenWeapon: Array<number>;
	invenEquip: Array<number>;
	invenUse: Array<number>;
	invenEtc: Array<number>;
	/** ammoNormal, ammoShotgun, ammoMachinegun, ammoArrow, oil, electric */
	ammo: Array<number>;
	/** equipWeapon, equipCloth, equipHand, equipGun, equipOutfit, equipPet */
	equip: Array<number>;
	skillLevels: Array<number>;
	skillPoint: number;
	/** PLACEABLES id on the server's cursor, -1 = none */
	place: number;
	/** nonce of the last backpack intent the server handled, 0 = none yet (u16) */
	ack: number;
	/** the last command seq (u16) the server consumed from this survivor when it wrote this, -1 = not in the world */
	seq: number;
}

/** the largest PLACEABLES id a bag may name (shared/sim/placement.ts keys by ETC index) */
const BAG_PLACE_MAX = 255;
/** nonces and command seqs are u16 on the wire */
const BAG_U16_MAX = 65535;

function ammoOf(save: PlayerSaveData): Array<number> {
	return [save.ammoNormal, save.ammoShotgun, save.ammoMachinegun, save.ammoArrow, save.oil, save.electric];
}

function equipsOf(save: PlayerSaveData): Array<number> {
	return [save.equipWeapon, save.equipCloth, save.equipHand, save.equipGun, save.equipOutfit, save.equipPet];
}

/** SERVER: the bag of a live save, for the wallet push */
export function bagOf(save: PlayerSaveData, place: number, ack: number, seq: number): BagMirror {
	return {
		invenWeapon: copyArray(save.invenWeapon),
		invenEquip: copyArray(save.invenEquip),
		invenUse: copyArray(save.invenUse),
		invenEtc: copyArray(save.invenEtc),
		ammo: ammoOf(save),
		equip: equipsOf(save),
		skillLevels: copyArray(save.skillLevels),
		skillPoint: save.skillPoint,
		place,
		ack,
		seq,
	};
}

/**
 * SERVER: everything in the bag that can change, as one string — the push compares it with the last one it sent
 * (`seq` is left out on purpose: it moves every tick and is only ever read together with the rest).
 */
export function bagSignature(save: PlayerSaveData, place: number, ack: number): string {
	return [
		save.invenWeapon.join(","),
		save.invenEquip.join(","),
		save.invenUse.join(","),
		save.invenEtc.join(","),
		ammoOf(save).join(","),
		equipsOf(save).join(","),
		save.skillLevels.join(","),
		save.skillPoint,
		place,
		ack,
	].join("|");
}

/**
 * CLIENT: a bag from the wire, or undefined when it is not one. S→C, so this is defensive rather than a security
 * gate — a malformed table must not break the client's backpack — and every number is clamped to what the save
 * itself allows (`readIntArray`, the same limits `sanitizeStoredSave` uses).
 */
export function readBag(raw: unknown): BagMirror | undefined {
	if (!typeIs(raw, "table")) return undefined;
	const r = raw as Record<string, unknown>;
	for (const key of ["invenWeapon", "invenEquip", "invenUse", "invenEtc", "ammo", "equip", "skillLevels"]) {
		if (!typeIs(r[key], "table")) return undefined;
	}
	const L = SAVE_LIMITS;
	const eqMax = EQUIPS.size() - 1;
	const rawEquip = r.equip as Array<unknown>;
	// -1 (nothing equipped) is a value here, so each slot keeps its real floor: the weapon, then five EQUIPS slots
	const equip: Array<number> = [];
	for (let i = 0; i < 6; i++) equip.push(readInt(rawEquip[i], -1, -1, i === 0 ? WEAPONS.size() - 1 : eqMax));
	return {
		invenWeapon: readIntArray(r.invenWeapon, WEAPONS.size(), itemMax, undefined),
		invenEquip: readIntArray(r.invenEquip, EQUIPS.size(), itemMax, undefined),
		invenUse: readIntArray(r.invenUse, USABLES.size(), itemMax, undefined),
		invenEtc: readIntArray(r.invenEtc, ETC_ITEMS.size(), itemMax, undefined),
		ammo: readIntArray(r.ammo, 6, () => L.AMMO_MAX, undefined),
		equip,
		skillLevels: readIntArray(r.skillLevels, SKILLS.size(), i => SKILLS[i].maxLevel, undefined),
		skillPoint: readInt(r.skillPoint, 0, 0, L.LEVEL_MAX),
		place: readInt(r.place, -1, -1, BAG_PLACE_MAX),
		ack: readInt(r.ack, 0, 0, BAG_U16_MAX),
		seq: readInt(r.seq, -1, -1, BAG_U16_MAX),
	};
}

/** CLIENT: the server's bag, written over the local copy in place (array identity kept, as `copySaveInto` does) */
export function applyBag(save: PlayerSaveData, bag: BagMirror): void {
	copyInto(save.invenWeapon, bag.invenWeapon);
	copyInto(save.invenEquip, bag.invenEquip);
	copyInto(save.invenUse, bag.invenUse);
	copyInto(save.invenEtc, bag.invenEtc);
	save.ammoNormal = bag.ammo[0] ?? 0;
	save.ammoShotgun = bag.ammo[1] ?? 0;
	save.ammoMachinegun = bag.ammo[2] ?? 0;
	save.ammoArrow = bag.ammo[3] ?? 0;
	save.oil = bag.ammo[4] ?? 0;
	save.electric = bag.ammo[5] ?? 0;
	save.equipWeapon = bag.equip[0] ?? -1;
	save.equipCloth = bag.equip[1] ?? -1;
	save.equipHand = bag.equip[2] ?? -1;
	save.equipGun = bag.equip[3] ?? -1;
	save.equipOutfit = bag.equip[4] ?? -1;
	save.equipPet = bag.equip[5] ?? -1;
	copyInto(save.skillLevels, bag.skillLevels);
	save.skillPoint = bag.skillPoint;
}

/**
 * From this MP_PHASE on the server counts XP, levels and days (server/sim/progress.ts re-exports it): a client
 * report no longer moves them, and the wallet brings them back.
 */
export const PROGRESS_SERVER_PHASE = 2;

function zeros(n: number): Array<number> {
	const a: Array<number> = [];
	for (let i = 0; i < n; i++) {
		a.push(0);
	}
	return a;
}

function copyArray(src: Array<number>): Array<number> {
	const a: Array<number> = [];
	for (const v of src) {
		a.push(v);
	}
	return a;
}

/** overwrites `dst` with `src`'s contents, in place (the array identity is what callers rely on) */
function copyInto(dst: Array<number>, src: Array<number>): void {
	dst.clear();
	for (const v of src) dst.push(v);
}

function idByName(list: Array<{ id: number; name: string }>, name: string): number {
	for (const def of list) {
		if (def.name === name) return def.id;
	}
	return -1;
}

/** what every new run starts with (as in the original): a dagger, 3 bandages and 3 canned food */
const STARTER_WEAPON = idByName(WEAPONS, "Dagger");
const STARTER_USABLES: Array<[number, number]> = [
	[idByName(USABLES, "Bandage"), 3],
	[idByName(USABLES, "Canned food"), 3],
];

function giveStarterKit(save: PlayerSaveData): void {
	save.invenWeapon = zeros(WEAPONS.size());
	save.invenEquip = zeros(EQUIPS.size());
	save.invenUse = zeros(USABLES.size());
	save.invenEtc = zeros(ETC_ITEMS.size());
	if (STARTER_WEAPON >= 0) save.invenWeapon[STARTER_WEAPON] = 1;
	for (const [id, count] of STARTER_USABLES) {
		if (id >= 0) save.invenUse[id] = count;
	}
	save.ammoNormal = 0;
	save.ammoShotgun = 0;
	save.ammoMachinegun = 0;
	save.ammoArrow = 0;
	save.oil = 0;
	save.electric = 0;
	save.equipWeapon = STARTER_WEAPON;
	save.equipCloth = -1;
	save.equipHand = -1;
	save.equipGun = -1;
}

export function defaultSave(): PlayerSaveData {
	const save = emptySave();
	giveStarterKit(save);
	return save;
}

/**
 * The player answered "No" to "Do you want to watch the tutorial?". Two flags carry the tutorial and the answer
 * has to clear both: `tutorialDone` (the lobby's question and the How to play card) and `firstInstall` (the
 * in-run coach, client/onboarding). Clearing only the first was the bug the owner hit on 2026-09-23 -- "No" still
 * started the coach's lessons in the first match.
 */
export function declineTutorial(save: PlayerSaveData): void {
	save.tutorialDone = true;
	save.firstInstall = false;
}

/**
 * Starts a new run after a game over: back to day 1 with the starter kit and a fresh continue price.
 * Kept: level/exp/skills, achievements, records, coins, packs, costumes (and the outfit / pet a costume unlocked),
 * titles, the kill count and the title shown (MON-05: what was earned is the survivor's, not the run's), and
 * settings. The server applies it on the "newRun" action and when a world ends (MP-22, server/sim/life.ts
 * `restartWorld`); the client applies the same to its copy.
 */
export function resetRun(save: PlayerSaveData): void {
	giveStarterKit(save);
	save.day = 1;
	save.lifeNights = 0;
	save.lifeDeaths = 0;
	save.deathCount = 0;
	save.runOver = false;
	// a new run starts with a new body: never inherit the HP bar the last one died on (v3, §6.1)
	save.runHp = 0;
	save.runHunger = 0;
	// a costume is forever; a pigeon that came in a pack lived in the inventory the starter kit just replaced
	save.equipOutfit = validEquip(save, save.equipOutfit, EquipSlot.Outfit);
	save.equipPet = validEquip(save, save.equipPet, EquipSlot.Pet);
	save.equipTitle = validTitle(save, save.equipTitle);
}

function emptySave(): PlayerSaveData {
	return {
		version: SAVE_VERSION,
		level: 1,
		exp: 0,
		skillPoint: 0,
		skillLevels: zeros(SKILLS.size()),
		money: 0,
		day: 1,
		bestDay: 1,
		deathCount: 0,
		bossKills: 0,
		firstInstall: true,
		tutorialDone: false,
		achievements: zeros(ACHIEVEMENTS.size()),
		packsBought: zeros(SHOP_PACKS.size()),
		packsOpened: zeros(SHOP_PACKS.size()),
		costumes: zeros(COSTUMES.size()),
		runOver: false,
		runHp: 0,
		runHunger: 0,
		runRev: 0,
		settings: defaultSettings(),
		invenWeapon: zeros(WEAPONS.size()),
		invenEquip: zeros(EQUIPS.size()),
		invenUse: zeros(USABLES.size()),
		invenEtc: zeros(ETC_ITEMS.size()),
		ammoNormal: 0,
		ammoShotgun: 0,
		ammoMachinegun: 0,
		ammoArrow: 0,
		oil: 0,
		electric: 0,
		equipWeapon: -1,
		equipCloth: -1,
		equipHand: -1,
		equipGun: -1,
		equipOutfit: -1,
		equipPet: -1,
		titles: zeros(TITLES.size()),
		zombieKills: 0,
		lifeNights: 0,
		equipTitle: -1,
		titleEpoch: 0,
		lifeDeaths: 0,
	};
}

export function expMaxInit(level: number): number {
	return math.floor(math.sqrt(level) * 10 + 2) * 10;
}

export function expMaxLevelUp(level: number): number {
	return math.floor(level * 10 + 4) * 15;
}

export function difficultyOfDay(day: number): number {
	return math.min(2, math.floor(day / 15));
}

// ---------------------------------------------------------------- ownership helpers

/** WEAPONS[0] is the default weapon every survivor starts with (the game falls back to it) */
export function ownsWeapon(save: PlayerSaveData, weaponId: number): boolean {
	if (weaponId === 0) return true;
	if (weaponId < 0 || weaponId >= WEAPONS.size()) return false;
	return (save.invenWeapon[weaponId] ?? 0) > 0;
}

export function ownsCostume(save: PlayerSaveData, costumeId: number): boolean {
	return (save.costumes[costumeId] ?? 0) > 0;
}

/** equipment in the inventory, or a cosmetic permanently unlocked by a costume */
export function ownsEquip(save: PlayerSaveData, equipId: number): boolean {
	if (equipId < 0 || equipId >= EQUIPS.size()) return false;
	if ((save.invenEquip[equipId] ?? 0) > 0) return true;
	const c = costumeForEquip(equipId);
	return c !== undefined && ownsCostume(save, c.id);
}

/**
 * Equipment slot of an EQUIPS entry (`EquipSlot`): 1 cloth, 2 hand, 3 gun, 4 outfit, 5 pet — or 0 for a row that
 * fits no slot (a kind-4 row shared/data/cosmetics.ts does not know how to draw).
 */
export function equipSlotOf(equipId: number): number {
	const e = EQUIPS[equipId];
	if (e === undefined) return 0;
	if (e.kind === EquipSlot.Cloth || e.kind === EquipSlot.Hand || e.kind === EquipSlot.Gun) return e.kind;
	return cosmeticSlotOf(equipId);
}

/** the EQUIPS id worn in `slot` (EquipSlot), or -1 when it is empty or `slot` is not an equipment slot */
export function equippedIn(save: PlayerSaveData, slot: number): number {
	if (slot === EquipSlot.Cloth) return save.equipCloth;
	if (slot === EquipSlot.Hand) return save.equipHand;
	if (slot === EquipSlot.Gun) return save.equipGun;
	if (slot === EquipSlot.Outfit) return save.equipOutfit;
	if (slot === EquipSlot.Pet) return save.equipPet;
	return -1;
}

/**
 * Writes `equipId` (-1 = take it off) into `slot`. No ownership check: the callers (the client's backpack, the
 * server's `ServerCraft.equip`) check first, and `enforceSaveInvariants` checks again on every save the server
 * accepts. False when `slot` is not an equipment slot.
 */
export function setEquipped(save: PlayerSaveData, slot: number, equipId: number): boolean {
	if (slot === EquipSlot.Cloth) save.equipCloth = equipId;
	else if (slot === EquipSlot.Hand) save.equipHand = equipId;
	else if (slot === EquipSlot.Gun) save.equipGun = equipId;
	else if (slot === EquipSlot.Outfit) save.equipOutfit = equipId;
	else if (slot === EquipSlot.Pet) save.equipPet = equipId;
	else return false;
	return true;
}

/**
 * Does this survivor own this cosmetic (MON-04)? Two ways, and both are the SERVER's:
 *   - the costume was bought (`costumes`, written only by the shop action in server/main.server.ts), or
 *   - a pack delivered one into the inventory (the Pigeon and Carolina packs) — `sanitizeClientReport` caps that
 *     count at what the server-counted packs delivered, so a report cannot make one up.
 * The client never declares what it owns: every look that leaves the server goes through `outfitLookOf` /
 * `petLookOf`, which ask this.
 */
export function ownsCosmetic(save: PlayerSaveData, equipId: number): boolean {
	return cosmeticSlotOf(equipId) !== 0 && ownsEquip(save, equipId);
}

/** what the outfit slot DRAWS (OutfitLook): the equipped outfit if it is one and it is owned, otherwise none */
export function outfitLookOf(save: PlayerSaveData): number {
	const id = save.equipOutfit;
	if (id < 0 || !ownsCosmetic(save, id)) return OutfitLook.None;
	return outfitLookOfEquip(id);
}

/** what the pet slot DRAWS (PetLook): the equipped pet if it is one and it is owned, otherwise none */
export function petLookOf(save: PlayerSaveData): number {
	const id = save.equipPet;
	if (id < 0 || !ownsCosmetic(save, id)) return PetLook.None;
	return petLookOfEquip(id);
}

/** has the SERVER granted this title (MON-05)? `titles` is written only by server/save/titles.ts `grantTitle` */
export function ownsTitle(save: PlayerSaveData, titleId: number): boolean {
	if (titleId < 0 || titleId >= TITLES.size() || titleId % 1 !== 0) return false;
	return (save.titles[titleId] ?? 0) > 0;
}

/** `titleId` when it can be shown (a real title this survivor earned), otherwise -1 */
function validTitle(save: PlayerSaveData, titleId: number): number {
	return ownsTitle(save, titleId) ? titleId : -1;
}

/**
 * What the title line DRAWS, as the wire byte (shared/data/titles.ts `titleToWire`: 0 = none): the equipped title if
 * it is earned, otherwise none. Like `outfitLookOf`, it asks ownership again, so nothing a report or a stray write
 * put in `equipTitle` ever reaches the wire or a nameplate.
 */
export function titleWireOf(save: PlayerSaveData): number {
	return titleToWire(validTitle(save, save.equipTitle));
}

export function pendingPacks(save: PlayerSaveData, packId: number): number {
	return math.max(0, (save.packsBought[packId] ?? 0) - (save.packsOpened[packId] ?? 0));
}

export function totalPendingPacks(save: PlayerSaveData): number {
	let n = 0;
	for (let i = 0; i < SHOP_PACKS.size(); i++) n += pendingPacks(save, i);
	return n;
}

export function walletOf(save: PlayerSaveData): Wallet {
	return {
		money: save.money,
		deathCount: save.deathCount,
		bestDay: save.bestDay,
		bossKills: save.bossKills,
		packsBought: copyArray(save.packsBought),
		packsOpened: copyArray(save.packsOpened),
		costumes: copyArray(save.costumes),
		runRev: save.runRev,
		titles: copyArray(save.titles),
		zombieKills: save.zombieKills,
		lifeNights: save.lifeNights,
		achievements: copyArray(save.achievements),
		day: save.day,
		level: save.level,
		exp: save.exp,
	};
}

// ---------------------------------------------------------------- validation

function isFiniteNumber(v: unknown): v is number {
	return typeIs(v, "number") && v === v && v !== math.huge && v !== -math.huge;
}

function readInt(v: unknown, fallback: number, min: number, max: number): number {
	if (!isFiniteNumber(v)) return math.clamp(fallback, min, max);
	return math.clamp(math.floor(v), min, max);
}

function readReal(v: unknown, fallback: number, min: number, max: number): number {
	if (!isFiniteNumber(v)) return math.clamp(fallback, min, max);
	return math.clamp(v, min, max);
}

function readBool(v: unknown, fallback: boolean): boolean {
	return typeIs(v, "boolean") ? v : fallback;
}

/** fixed-size integer array; missing/garbage entries fall back, extra entries are dropped */
function readIntArray(
	v: unknown,
	size: number,
	maxOf: (i: number) => number,
	fallback: Array<number> | undefined,
): Array<number> {
	const src = typeIs(v, "table") ? (v as Array<unknown>) : undefined;
	const out: Array<number> = [];
	for (let i = 0; i < size; i++) {
		const fb = fallback !== undefined ? (fallback[i] ?? 0) : 0;
		out.push(readInt(src !== undefined ? src[i] : undefined, fb, 0, maxOf(i)));
	}
	return out;
}

function readSettings(v: unknown, fb: SettingsData): SettingsData {
	const r = typeIs(v, "table") ? (v as Record<string, unknown>) : {};
	return {
		soundEffect: readReal(r.soundEffect, fb.soundEffect, 0, 1),
		bgm: readReal(r.bgm, fb.bgm, 0, 1),
		uiSize: readReal(r.uiSize, fb.uiSize, 0, 1),
		leftSize: readReal(r.leftSize, fb.leftSize, 0, 1),
		leftPos: readReal(r.leftPos, fb.leftPos, 0, 1),
		leftRelative: readBool(r.leftRelative, fb.leftRelative),
		rightSize: readReal(r.rightSize, fb.rightSize, 0, 1),
		rightPos: readReal(r.rightPos, fb.rightPos, 0, 1),
		mirror: readBool(r.mirror, fb.mirror),
		langType: readInt(r.langType, fb.langType, 0, 3),
		graphics: readInt(r.graphics, fb.graphics, 0, 2),
	};
}

const itemMax = (): number => SAVE_LIMITS.ITEM_MAX;

/**
 * v3 → v4: the fallback of one cosmetic slot. A document that already speaks v4 (either new field present) is read
 * as it is; one that does not still has the old single `equipDeco`, and that id goes to the slot it belongs to —
 * an outfit to `equipOutfit`, a pet to `equipPet`, anything else nowhere. `fb` answers when there is neither.
 * Ownership is not decided here: `enforceSaveInvariants` does that for every slot, migrated or not.
 */
function legacyCosmetic(r: Record<string, unknown>, slot: number, fb: number): number {
	if (r.equipOutfit !== undefined || r.equipPet !== undefined) return fb;
	if (!isFiniteNumber(r.equipDeco)) return fb;
	const deco = readInt(r.equipDeco, -1, -1, EQUIPS.size() - 1);
	return deco >= 0 && cosmeticSlotOf(deco) === slot ? deco : fb;
}

/** reads every client-simulated field of `r`, falling back to `fb` field by field */
function readProgress(r: Record<string, unknown>, fb: PlayerSaveData): PlayerSaveData {
	const L = SAVE_LIMITS;
	const eqMax = EQUIPS.size() - 1;
	return {
		version: SAVE_VERSION,
		level: readInt(r.level, fb.level, 1, L.LEVEL_MAX),
		exp: readInt(r.exp, fb.exp, 0, 1000000),
		skillPoint: readInt(r.skillPoint, fb.skillPoint, 0, L.LEVEL_MAX),
		skillLevels: readIntArray(r.skillLevels, SKILLS.size(), i => SKILLS[i].maxLevel, fb.skillLevels),
		money: fb.money,
		day: readInt(r.day, fb.day, 1, L.DAY_MAX),
		bestDay: fb.bestDay,
		deathCount: fb.deathCount,
		bossKills: readInt(r.bossKills, fb.bossKills, 0, L.COUNTER_MAX),
		firstInstall: readBool(r.firstInstall, fb.firstInstall),
		tutorialDone: readBool(r.tutorialDone, fb.tutorialDone),
		// v6: the SERVER's (copied, never read from `r`): a report cannot write an achievement (CON-04);
		// `sanitizeStoredSave` reads the stored counters
		achievements: copyArray(fb.achievements),
		packsBought: copyArray(fb.packsBought),
		packsOpened: copyArray(fb.packsOpened),
		costumes: copyArray(fb.costumes),
		runOver: readBool(r.runOver, fb.runOver),
		// v3: absent in a v2 document, so the fallback (0 = "not recorded") is exactly the migration
		runHp: readInt(r.runHp, fb.runHp, 0, L.RUN_HP_MAX),
		runHunger: readInt(r.runHunger, fb.runHunger, 0, L.RUN_HUNGER_MAX),
		runRev: fb.runRev,
		settings: readSettings(r.settings, fb.settings),
		invenWeapon: readIntArray(r.invenWeapon, WEAPONS.size(), itemMax, fb.invenWeapon),
		invenEquip: readIntArray(r.invenEquip, EQUIPS.size(), itemMax, fb.invenEquip),
		invenUse: readIntArray(r.invenUse, USABLES.size(), itemMax, fb.invenUse),
		invenEtc: readIntArray(r.invenEtc, ETC_ITEMS.size(), itemMax, fb.invenEtc),
		ammoNormal: readInt(r.ammoNormal, fb.ammoNormal, 0, L.AMMO_MAX),
		ammoShotgun: readInt(r.ammoShotgun, fb.ammoShotgun, 0, L.AMMO_MAX),
		ammoMachinegun: readInt(r.ammoMachinegun, fb.ammoMachinegun, 0, L.AMMO_MAX),
		ammoArrow: readInt(r.ammoArrow, fb.ammoArrow, 0, L.AMMO_MAX),
		oil: readInt(r.oil, fb.oil, 0, L.AMMO_MAX),
		electric: readInt(r.electric, fb.electric, 0, L.AMMO_MAX),
		equipWeapon: readInt(r.equipWeapon, fb.equipWeapon, -1, WEAPONS.size() - 1),
		equipCloth: readInt(r.equipCloth, fb.equipCloth, -1, eqMax),
		equipHand: readInt(r.equipHand, fb.equipHand, -1, eqMax),
		equipGun: readInt(r.equipGun, fb.equipGun, -1, eqMax),
		// v4: absent in a v3 document, whose `equipDeco` is routed to the right one of the two (the migration)
		equipOutfit: readInt(r.equipOutfit, legacyCosmetic(r, EquipSlot.Outfit, fb.equipOutfit), -1, eqMax),
		equipPet: readInt(r.equipPet, legacyCosmetic(r, EquipSlot.Pet, fb.equipPet), -1, eqMax),
		// v5: what was earned is the SERVER's (copied, never read from `r`); only the choice of what to show is read,
		// and `enforceSaveInvariants` checks it against those earned flags. Absent in v4: nothing shown
		titles: copyArray(fb.titles),
		zombieKills: fb.zombieKills,
		lifeNights: fb.lifeNights,
		equipTitle: readInt(r.equipTitle, fb.equipTitle, -1, TITLES.size() - 1),
		titleEpoch: fb.titleEpoch,
		lifeDeaths: fb.lifeDeaths,
	};
}

function sum(a: Array<number>): number {
	let n = 0;
	for (const v of a) n += v;
	return n;
}

function validEquip(save: PlayerSaveData, id: number, slot: number): number {
	if (id < 0) return -1;
	if (equipSlotOf(id) !== slot) return -1;
	return ownsEquip(save, id) ? id : -1;
}

/**
 * Cross-field rules: skills never exceed the points earned by levelling (1 per level),
 * exp stays below the next level, equipped items must be owned and fit their slot,
 * delivered packs never exceed bought packs.
 * `previous` (the last trusted copy) is used to roll back an impossible skill spread.
 */
export function enforceSaveInvariants(s: PlayerSaveData, previous?: PlayerSaveData): void {
	const L = SAVE_LIMITS;
	s.level = math.clamp(math.floor(s.level), 1, L.LEVEL_MAX);
	s.day = math.clamp(math.floor(s.day), 1, L.DAY_MAX);
	s.bestDay = math.clamp(math.max(s.bestDay, s.day), 1, L.DAY_MAX);
	s.exp = math.clamp(s.exp, 0, expMaxInit(s.level));
	const earned = s.level - 1;
	if (sum(s.skillLevels) > earned) {
		s.skillLevels =
			previous !== undefined && sum(previous.skillLevels) <= earned
				? copyArray(previous.skillLevels)
				: zeros(SKILLS.size());
	}
	s.skillPoint = math.clamp(s.skillPoint, 0, math.max(0, earned - sum(s.skillLevels)));
	for (let i = 0; i < SHOP_PACKS.size(); i++) {
		s.packsBought[i] = math.max(0, s.packsBought[i] ?? 0);
		s.packsOpened[i] = math.clamp(s.packsOpened[i] ?? 0, 0, s.packsBought[i]);
	}
	if (s.equipWeapon >= 0 && !ownsWeapon(s, s.equipWeapon)) s.equipWeapon = -1;
	s.equipCloth = validEquip(s, s.equipCloth, EquipSlot.Cloth);
	s.equipHand = validEquip(s, s.equipHand, EquipSlot.Hand);
	s.equipGun = validEquip(s, s.equipGun, EquipSlot.Gun);
	// MON-04: a cosmetic is worn only if it is one of THAT slot and the server says it is owned (`ownsEquip` reads
	// `costumes` and the pack-capped inventory). A report naming one it does not own is corrected to none.
	s.equipOutfit = validEquip(s, s.equipOutfit, EquipSlot.Outfit);
	s.equipPet = validEquip(s, s.equipPet, EquipSlot.Pet);
	// MON-05: the same rule for the title line -- only one the server granted (`titles`) is shown, so a report
	// (or a hand-edited document) naming one the save does not hold is corrected to none
	s.equipTitle = validTitle(s, s.equipTitle);
	s.zombieKills = math.clamp(math.floor(s.zombieKills), 0, L.COUNTER_MAX);
	s.lifeNights = math.clamp(math.floor(s.lifeNights), 0, L.DAY_MAX);
	s.lifeDeaths = math.clamp(math.floor(s.lifeDeaths), 0, L.COUNTER_MAX);
	// v3 run body: a stored 0 means "not recorded" and the session starts at full, so the only rule here is
	// that neither number may be negative or absurd. Hunger is capped at its own bar by the player state.
	s.runHp = math.clamp(math.floor(s.runHp), 0, L.RUN_HP_MAX);
	s.runHunger = math.clamp(math.floor(s.runHunger), 0, L.RUN_HUNGER_MAX);
	s.version = SAVE_VERSION;
}

/**
 * The version a stored document claims, or 0 when it does not say (v1 never wrote the field).
 * Only used for logging and for the migration test: `sanitizeStoredSave` needs no version to do its job,
 * because every field falls back on its own.
 */
export function storedVersion(raw: unknown): number {
	if (!typeIs(raw, "table")) return 0;
	const v = (raw as Record<string, unknown>).version;
	return isFiniteNumber(v) ? math.max(0, math.floor(v)) : 0;
}

/**
 * Copies `src` field by field into `dst`, keeping `dst`'s identity (docs/MULTIPLAYER.md §6.3).
 *
 * From F2 on the SERVER writes into the live save table while a session is open — XP at the instant a zombie
 * dies (server/sim/progress.ts), coins at midnight, and from F3 the inventory itself. Replacing that table
 * with a new one (`session.save = updated`) silently detaches every holder of the old one: server/sim's
 * `ServerPlayer.save` keeps the orphan, and whatever the server wrote into it between the swap and the next
 * `adoptSave` pass is simply gone. Copying in place removes the whole class of bug — there is only ever one
 * table per session, so there is nothing to re-point and nothing to lose.
 *
 * Arrays are copied element by element for the same reason: `dst.skillLevels` may be aliased elsewhere.
 */
export function copySaveInto(dst: PlayerSaveData, src: PlayerSaveData): PlayerSaveData {
	if (dst === src) return dst;
	dst.version = src.version;
	dst.level = src.level;
	dst.exp = src.exp;
	dst.skillPoint = src.skillPoint;
	copyInto(dst.skillLevels, src.skillLevels);
	dst.money = src.money;
	dst.day = src.day;
	dst.bestDay = src.bestDay;
	dst.deathCount = src.deathCount;
	dst.bossKills = src.bossKills;
	dst.firstInstall = src.firstInstall;
	dst.tutorialDone = src.tutorialDone;
	copyInto(dst.achievements, src.achievements);
	copyInto(dst.packsBought, src.packsBought);
	copyInto(dst.packsOpened, src.packsOpened);
	copyInto(dst.costumes, src.costumes);
	dst.runOver = src.runOver;
	dst.runHp = src.runHp;
	dst.runHunger = src.runHunger;
	dst.runRev = src.runRev;
	dst.settings = src.settings;
	copyInto(dst.invenWeapon, src.invenWeapon);
	copyInto(dst.invenEquip, src.invenEquip);
	copyInto(dst.invenUse, src.invenUse);
	copyInto(dst.invenEtc, src.invenEtc);
	dst.ammoNormal = src.ammoNormal;
	dst.ammoShotgun = src.ammoShotgun;
	dst.ammoMachinegun = src.ammoMachinegun;
	dst.ammoArrow = src.ammoArrow;
	dst.oil = src.oil;
	dst.electric = src.electric;
	dst.equipWeapon = src.equipWeapon;
	dst.equipCloth = src.equipCloth;
	dst.equipHand = src.equipHand;
	dst.equipGun = src.equipGun;
	dst.equipOutfit = src.equipOutfit;
	dst.equipPet = src.equipPet;
	copyInto(dst.titles, src.titles);
	dst.zombieKills = src.zombieKills;
	dst.lifeNights = src.lifeNights;
	dst.equipTitle = src.equipTitle;
	dst.titleEpoch = src.titleEpoch;
	dst.lifeDeaths = src.lifeDeaths;
	return dst;
}

/**
 * Trusted data (DataStore, or the server's LoadAck on the client): full schema check and migration
 * from v1 (shopHave → packsBought). Unknown keys are dropped.
 */
export function sanitizeStoredSave(raw: unknown): PlayerSaveData {
	if (!typeIs(raw, "table")) return defaultSave();
	const r = raw as Record<string, unknown>;
	const L = SAVE_LIMITS;
	// missing fields fall back to an empty save (not to the starter kit)
	const s = readProgress(r, emptySave());
	s.money = readInt(r.money, 0, 0, L.MONEY_MAX);
	s.runRev = readInt(r.runRev, 0, 0, L.COUNTER_MAX);
	s.deathCount = readInt(r.deathCount, 0, 0, L.COUNTER_MAX);
	s.bestDay = readInt(r.bestDay, s.day, 1, L.DAY_MAX);
	s.costumes = readIntArray(r.costumes, COSTUMES.size(), () => 1, undefined);
	// v5 (MON-05): absent in a v4 document -- nothing earned, nothing counted (server/save/titleRecord.ts may still
	// bring back what a rolled-back server dropped, on the session load)
	s.titles = readIntArray(r.titles, TITLES.size(), () => 1, undefined);
	s.zombieKills = readInt(r.zombieKills, 0, 0, L.COUNTER_MAX);
	s.lifeNights = readInt(r.lifeNights, 0, 0, L.DAY_MAX);
	s.titleEpoch = readInt(r.titleEpoch, 0, 0, L.EPOCH_MAX);
	// v6 (CON-04): the stored counters, each capped at its goal. `lifeDeaths` is absent in a v5 document: a life with a
	// paid Rebirth (`deathCount`) or a body lying dead (`runOver`) has died at least once, and must not start Never die
	// again (the old rule already stopped at `deathCount > 0`); otherwise 0 -- a v5 death answered by waiting for
	// daybreak left no record at all
	s.achievements = readIntArray(r.achievements, ACHIEVEMENTS.size(), i => ACHIEVEMENTS[i].max, undefined);
	s.lifeDeaths = readInt(r.lifeDeaths, s.deathCount > 0 || s.runOver ? 1 : 0, 0, L.COUNTER_MAX);
	const packMax = (): number => L.COUNTER_MAX;
	if (r.packsBought !== undefined) {
		s.packsBought = readIntArray(r.packsBought, SHOP_PACKS.size(), packMax, undefined);
		s.packsOpened = readIntArray(r.packsOpened, SHOP_PACKS.size(), packMax, undefined);
	} else {
		// v1 kept only the pending count, and never delivered it: keep it pending
		s.packsBought = readIntArray(r.shopHave, SHOP_PACKS.size(), () => ECONOMY.MAX_PENDING_PACKS, undefined);
		s.packsOpened = zeros(SHOP_PACKS.size());
	}
	enforceSaveInvariants(s);
	return s;
}

/**
 * Untrusted client report: reads only client-simulated fields (validated and clamped), copies every
 * server-owned field from `base` (money is NEVER taken from the client). packsOpened may only move
 * forward and never past packsBought. Returns undefined when the payload is not a table.
 * Time-based limits (days, levels and boss kills per real minute) are applied by the server afterwards.
 */
export function sanitizeClientReport(raw: unknown, base: PlayerSaveData): PlayerSaveData | undefined {
	if (!typeIs(raw, "table")) return undefined;
	const r = raw as Record<string, unknown>;
	const s = readProgress(r, base);
	// v3: the run's body is the SERVER's (§2.1 "HP, fome, buffs ... ✅ servidor"). A report may mirror it,
	// never move it — otherwise "report full hp" is a one-line heal.
	s.runHp = base.runHp;
	s.runHunger = base.runHunger;
	const reported = readIntArray(r.packsOpened, SHOP_PACKS.size(), () => SAVE_LIMITS.COUNTER_MAX, base.packsOpened);
	for (let i = 0; i < SHOP_PACKS.size(); i++) {
		const bought = base.packsBought[i] ?? 0;
		const floor = math.min(base.packsOpened[i] ?? 0, bought);
		s.packsOpened[i] = math.min(math.max(reported[i], floor), bought);
	}
	// shop-only cosmetics (outfits and pets) are not found or crafted in the world: a report may only add
	// the ones delivered by the packs it opens
	for (const c of COSTUMES) {
		const id = c.equipId;
		if (id < 0) continue;
		let cap = base.invenEquip[id] ?? 0;
		for (const pack of SHOP_PACKS) {
			const opened = (s.packsOpened[pack.id] ?? 0) - (base.packsOpened[pack.id] ?? 0);
			if (opened <= 0) continue;
			for (const item of pack.items) {
				if (item.kind === ItemKind.Equip && item.index === id) cap += opened * item.count;
			}
		}
		s.invenEquip[id] = math.min(s.invenEquip[id] ?? 0, cap);
	}
	enforceSaveInvariants(s, base);
	return s;
}

/**
 * Client side: apply the server's wallet to the local copy. Balances are replaced; monotonic counters
 * (packsBought, runRev, and the client-reported packsOpened/bossKills) keep the larger value so a
 * response that crossed a newer change does not roll them back.
 */
export function applyWallet(save: PlayerSaveData, raw: unknown): boolean {
	if (!typeIs(raw, "table")) return false;
	const w = raw as Record<string, unknown>;
	const L = SAVE_LIMITS;
	save.money = readInt(w.money, save.money, 0, L.MONEY_MAX);
	save.deathCount = readInt(w.deathCount, save.deathCount, 0, L.COUNTER_MAX);
	save.bestDay = readInt(w.bestDay, save.bestDay, 1, L.DAY_MAX);
	save.bossKills = math.max(save.bossKills, readInt(w.bossKills, save.bossKills, 0, L.COUNTER_MAX));
	// lifetime counters only grow: a wallet that arrives out of order must not roll them back
	const bought = readIntArray(w.packsBought, SHOP_PACKS.size(), () => L.COUNTER_MAX, save.packsBought);
	for (let i = 0; i < SHOP_PACKS.size(); i++) save.packsBought[i] = math.max(save.packsBought[i] ?? 0, bought[i]);
	const opened = readIntArray(w.packsOpened, SHOP_PACKS.size(), () => L.COUNTER_MAX, save.packsOpened);
	for (let i = 0; i < SHOP_PACKS.size(); i++) {
		save.packsOpened[i] = math.min(math.max(save.packsOpened[i] ?? 0, opened[i]), save.packsBought[i]);
	}
	save.costumes = readIntArray(w.costumes, COSTUMES.size(), () => 1, save.costumes);
	// which life this wallet was written in, read BEFORE this copy moves on to it: the life's own numbers below
	// come only from a wallet of this life or a newer one (-1 = a wallet that does not say)
	const walletRun = isFiniteNumber(w.runRev) ? math.floor(w.runRev) : -1;
	const thisLife = walletRun >= save.runRev;
	save.runRev = math.max(save.runRev, readInt(w.runRev, save.runRev, 0, L.COUNTER_MAX));
	// MON-05: the earned flags are the server's to state, like `costumes`; the kill count only grows
	save.titles = readIntArray(w.titles, TITLES.size(), () => 1, save.titles);
	save.zombieKills = math.max(save.zombieKills, readInt(w.zombieKills, save.zombieKills, 0, L.COUNTER_MAX));
	// a title the server no longer lists is not shown by this copy either
	save.equipTitle = validTitle(save, save.equipTitle);
	// v6 (CON-04): the achievement counters are the server's and only grow, like the kill count: a wallet that
	// arrives out of order never takes one back (an admin reset reaches this copy as a whole new save, not a wallet)
	if (w.achievements !== undefined) {
		const got = readIntArray(w.achievements, ACHIEVEMENTS.size(), i => ACHIEVEMENTS[i].max, save.achievements);
		for (let i = 0; i < ACHIEVEMENTS.size(); i++) {
			save.achievements[i] = math.max(save.achievements[i] ?? 0, got[i]);
		}
	}
	// the nights this life has lived are the server's alone (no client ever counts them): the wardrobe reads them;
	// and so is the life's day, from the phase the server counts days: its midnight may have refused this survivor
	// one (dead, absent, AFK), which a client that counted its own midnight would never know. Both go back to 0 / 1
	// with a new life, so unlike the counters above they are REPLACED -- and only by a wallet of this life or a newer
	// one: a push from the old life landing after the New game's reply (another remote) would hand its day back
	if (thisLife && isFiniteNumber(w.lifeNights)) {
		save.lifeNights = readInt(w.lifeNights, save.lifeNights, 0, L.DAY_MAX);
	}
	if (thisLife && MP_PHASE >= PROGRESS_SERVER_PHASE && isFiniteNumber(w.day)) {
		save.day = readInt(w.day, save.day, 1, L.DAY_MAX);
	}
	// XP and levels are the server's from PROGRESS_SERVER_PHASE on, and nothing else ever told this client: the
	// HUD's XP bar sat at 0 and a level-up never arrived (owner's playtest, 2026-09-23). Below that phase the
	// client levels itself and a wallet carrying the last REPORTED copy would roll its XP back, so it is ignored.
	// The skill points are not sent: they follow from the level by the save's own rule (enforceSaveInvariants),
	// so a skill learned here a moment before this wallet arrived is never handed back as a free point.
	if (MP_PHASE >= PROGRESS_SERVER_PHASE && isFiniteNumber(w.level)) {
		save.level = readInt(w.level, save.level, 1, L.LEVEL_MAX);
		save.exp = readInt(w.exp, save.exp, 0, expMaxInit(save.level));
		save.skillPoint = math.max(0, save.level - 1 - sum(save.skillLevels));
	}
	return true;
}
