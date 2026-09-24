/*
 * Analytics: what the Creator Hub's Economy, Funnel and Custom dashboards are built from (docs/ANALYTICS.md). SERVER
 * ONLY. The event catalogue, every rule about when an event fires and the rate guard all live in this one file; the
 * rest of the server only calls the narrow one-line hooks at the bottom.
 *
 * The rules, all of them here:
 *
 *   1. THE SERVER'S OWN NUMBERS. Every event reads the live save the server writes itself (coins, the life's day,
 *      `lifeNights`, `zombieKills`, `titles`, the level) at the instant the server changes it, or once a second
 *      (`poll`). Nothing a client reports is ever an event. The two exceptions are UX facts with no value in them
 *      that only the client can know: the answer to "Do you want to watch the tutorial?" (`tutorialDone` /
 *      `firstInstall`, read from the server's copy of the save, never from the report) and "the shop is open"
 *      (the `viewShop` ShopAction, rate-limited here, its fields all the server's). Either can only ever move that
 *      player's own funnel -- the docs' own pattern (funnel-events.md "Protect your funnels from exploiters").
 *   2. AGGREGATES, NEVER PER KILL. A horde fight makes several kills a second across six survivors; one event each
 *      would eat the whole budget in one fight. Kills are only ever a count at a natural checkpoint (the first one
 *      of a new player, a session summary), crafts and items used likewise.
 *   3. LOW CARDINALITY. The custom fields are a few fixed strings each ("Life day - 4-7", "Time - Night"): no free
 *      text, no names, no UserIds. The SKUs are the catalogue's own names (9 packs, 9 costumes and 7 more).
 *   4. UNDER THE CAP. The documented limit is 120 + 20 x CCU requests a minute per server (event-types.md). This
 *      module spends at most RATE_SHARE of it in any 60 s window (`limitNow`); what does not fit waits in a bounded
 *      queue and goes out as the window frees. An economy event that has to wait is MERGED into the same player's
 *      latest waiting one when it has the same direction and type (amounts added, the later balance kept, the SKU
 *      "Batched" if they differ), so a burst of purchases costs the dashboard its count, never a coin, and every
 *      balance still follows from the one before. The whole hour of six players stays far below the cap and never
 *      waits at all (tools/test-analytics.mjs).
 *   5. NEVER IN THE WAY. Every hook returns at once when analytics is off (a test, a missing service), and every
 *      call into the module and every call into AnalyticsService runs inside pcall: analytics can never break a
 *      tick, a purchase or a save.
 *   6. STUDIO SENDS NOTHING. The docs are explicit that events can only be sent from the server of a PUBLISHED game
 *      ("Events can't be sent from the client or Studio"). In Studio the module still runs every rule (so a
 *      playtest exercises them) but hands each event to a dry sink that only counts it -- Workspace attributes
 *      `pz_analytics_*` -- and prints it when the Workspace attribute `pz_analytics_echo` is true. A published TEST
 *      experience is its own universe with its own dashboards, which keeps test play out of the real ones.
 *
 * Why no LogProgressionEvent (nor its Start/Complete/Fail shortcuts): the engine reference still says it "does not
 * currently display in any Roblox-provided charts" (checked 2026-09-24), and no page lists it. The level curve is a
 * one-time FUNNEL instead ("Levels"), the nights are two ("NightSurvival" per life, "Night" per night), all of which
 * the Funnel page charts.
 */
import { GAME_NAME } from "shared/module";
import { COSTUMES, SHOP_PACKS, rebirthPrice } from "shared/data/shop";
import { TITLES, TitleId } from "shared/data/titles";
import { PlayerSaveData, ownsTitle } from "shared/game/save";
import { MAX_PLAYERS } from "shared/net/mpConfig";
import { crossed, isNightAt } from "shared/sim/clock";
import type { BackpackOutcome } from "../sim/craft";
import type { WipeReport } from "../sim/life";
import type { WorldEnd } from "../sim/worldReset";

// ---------------------------------------------------------------- the documented limits and our share of them

/** event-types.md "Global Rate Limit": 120 + 20 x CCU AnalyticsService requests per minute */
export const RATE_BASE = 120;
export const RATE_PER_PLAYER = 20;
export const RATE_WINDOW_S = 60;
/** the share of that cap this module ever uses in one window: the rest is headroom nobody has to think about */
export const RATE_SHARE = 0.75;
/** events waiting for the window to free (economy twins are merged, so this only fills with a flood of the rest) */
export const DEFERRED_MAX = 512;
/** how often the live saves are read (the progress that has no hook of its own) and the queue drained, seconds */
export const POLL_S = 1;
/** a player who left is forgotten this long after, so a hook that runs late in the leave (a death) still finds them */
const LEAVE_GRACE_S = 15;
/** a fault is warned at most this often (seconds): a bug here must be visible, never a flood */
const FAULT_LOG_S = 60;

/** the one currency (the save's `money`); event-types.md allows 10 resource types, the engine reference 5 */
export const CURRENCY = "Coins";

/**
 * The onboarding funnel belongs to saves born after analytics shipped: the funnel treats a step logged without the
 * earlier ones as all of them done (funnel-events.md "Skipped steps"), so a veteran's first counted kill must never
 * enter it. `titleEpoch` is the save's birth (os.time() of its first load, server/main.server.ts): 2026-09-23 00:00 UTC.
 */
export const ONBOARDING_SINCE = 1790121600;

// ---------------------------------------------------------------- the catalogue (docs/ANALYTICS.md)

/** LogOnboardingFunnelStepEvent steps, in the order the game asks them of a new player */
export const ONBOARDING_STEPS = [
	"Joined",
	"Tutorial answered",
	"Entered the city",
	"First kill",
	"First night survived",
];

/** the recurring funnel of one LIFE (funnelSessionId "life-<key>"), at the nights the difficulty climbs */
export const NIGHT_FUNNEL = "NightSurvival";
/** `lifeNights` each step needs: 0 is the life starting; the others are the wave table's and difficulty's steps */
export const NIGHT_STEPS = [0, 1, 3, 7, 9, 14, 19, 29, 49];
export const NIGHT_STEP_NAMES = [
	"Life started (day 1)",
	"Night 1 (day 2)",
	"Night 3 (day 4)",
	"Night 7 (day 8)",
	"Night 9 (day 10)",
	"Night 14 (day 15)",
	"Night 19 (day 20)",
	"Night 29 (day 30)",
	"Night 49 (day 50)",
];

/** the one-time funnel of the level curve (the level survives every death: it is the player's, not the life's) */
export const LEVEL_FUNNEL = "Levels";
export const LEVEL_STEPS = [1, 2, 3, 5, 10, 15, 20, 25, 30, 40, 50, 75, 100];

/**
 * The recurring funnel of ONE NIGHT lived in the city (funnelSessionId: a GUID drawn at 19:00, as the docs advise for
 * a funnel with no natural key). Only a survivor standing in the city at nightfall enters it -- one who walks in at
 * 23:00 would otherwise count as having lived 19:00 and 22:00 (funnel-events.md "Skipped steps") -- and the night
 * closes at their death or at a step they were not standing in the city for. The hours are the waves of the
 * original's table (19:00, 22:00, 01:00, shared/sim/clock.ts), the midnight that pays the day, and the dawn.
 */
export const NIGHT_PHASE_FUNNEL = "Night";
export const NIGHT_PHASE_HOURS = [19, 22, 0, 1, 6];
export const NIGHT_PHASE_NAMES = [
	"Wave 1 (19:00)",
	"Wave 2 (22:00)",
	"Midnight (00:00)",
	"Wave 3 (01:00)",
	"Dawn (06:00)",
];
/** a clock that moved more than this between two reads jumped (an admin's clock, a new town): nothing was lived */
const CLOCK_JUMP_H = 2;

/**
 * The recurring funnel of ONE DEATH: did it end in a paid Rebirth? funnelSessionId `death-<life>-<nth death of the
 * life>`, a natural key (funnel-events.md "Item upgrades"): the same on every server, so a Rebirth bought from the
 * lobby of another server still closes the death it answers. `lifeDeaths` counts every death of the life, the
 * life's key (`lifeKeyOf`) survives a Rebirth -- so each death is its own session and never reuses one.
 */
export const REBIRTH_FUNNEL = "Rebirth";
export const REBIRTH_STEPS = ["Died", "Rebirth bought"];

/**
 * The recurring funnel of ONE VISIT to the shop (funnelSessionId: a GUID drawn when it opens): opened (the client's
 * `viewShop`, the one UX fact of rule 1), a buy asked for (a well-formed request, before the server decides), bought
 * (the server accepted it). A purchase with no open visit starts no funnel: it would count "Opened" as done.
 */
export const SHOP_FUNNEL = "Shop";
export const SHOP_STEPS = ["Opened", "Tried to buy", "Bought"];
/** the screens a visit can open on (the ShopAction's `screen`): the packs of client/ui/shop.ts, the wardrobe (MON-04) */
export const SHOP_SCREENS = ["Packs", "Wardrobe"];
/** a visit is over this long after it opened (s) */
export const SHOP_VISIT_S = 600;
/** a new visit opens at most this often per player (s), and at most SHOP_VISITS_MAX times in a session */
export const SHOP_OPEN_MIN_S = 1;
export const SHOP_VISITS_MAX = 30;

/**
 * The recurring funnel of ONE TRIP to a town of one's own (docs/MULTIPLAYER.md §7.4: Play solo, and the fresh-town
 * offer's New town, P0-1): asked (a request the server accepted), teleported (TeleportAsync went through), arrived (the
 * destination read the ticket). funnelSessionId: the GUID the origin drew, carried in the teleport's ticket
 * (server/match/rules.ts) -- one session on both servers, like the Rebirth funnel's natural key. Step 1's fields say
 * which way the player came, from what world day and on what day of their life.
 */
export const TOWN_FUNNEL = "NewTown";
export const TOWN_STEPS = ["Asked", "Teleported", "Arrived"];
/** a trip's route (server/match/rules.ts TripRoute) as its field says it */
export function routeName(route: string): string {
	return route === "offer" ? "Offer" : "Play solo";
}
/** where a failed trip stopped (server/match/travel.ts), and why (shared/match/matchWire.ts TripFailure) */
export const TRIP_STAGES = ["Reserve", "Teleport", "Init"];
export const TRIP_RESULTS = ["reserve", "teleport", "full", "flooded", "denied", "timeout", "cancelled"];

/** a living boss this close to a body at its death is what killed it: a needle's reach (shared/sim/ai/bossBrain.ts) */
export const BOSS_REACH = 900;

/**
 * The weapon kinds of the kill credit (shared/data/kinds.ts WeaponKind, 1-8), by name, for WeaponKills. A machine's
 * kill (a turret, a drone: MACHINE_KILL) and a kill whose weapon the credit could not name (-1) have their own.
 */
export const WEAPON_KIND_NAMES = ["Rifle", "Pistol", "MG", "Shotgun", "Sniper", "Bow", "Melee", "Special"];
export const MACHINE_KILL = 0;

/** LogCustomEvent names (100 allowed) */
export const EVENT = {
	TutorialChoice: "TutorialChoice",
	Died: "Died",
	LifeEnded: "LifeEnded",
	WorldEnded: "WorldEnded",
	TitleEarned: "TitleEarned",
	SessionKills: "SessionKills",
	Crafted: "Crafted",
	ItemsUsed: "ItemsUsed",
	/** a session ended: where the player quit from, and when (the quit point) */
	SessionEnded: "SessionEnded",
	/** a session's killing blows with one kind of weapon (one per kind used, on leaving) */
	WeaponKills: "WeaponKills",
	/** MP-26: a player ARRIVED from another public server's Servers list (server/match/townServices.ts) */
	JoinedFromList: "JoinedFromList",
	/** P0-1: a joining player was offered a town of their own (the public town was far past their record) */
	TownOffered: "TownOffered",
	/** a trip to a town of one's own ended with the player still here */
	TripFailed: "TripFailed",
} as const;

/** the economy's transaction types: the built-in names where one fits (typed against the enum), and "Admin" */
type BuiltInTx = Enum.AnalyticsEconomyTransactionType["Name"];
const TX_ONBOARDING: BuiltInTx = "Onboarding";
const TX_GAMEPLAY: BuiltInTx = "Gameplay";
const TX_SHOP: BuiltInTx = "Shop";
/** "extra lives" is the docs' own example of a contextual purchase: a Rebirth is exactly that */
const TX_CONTEXTUAL: BuiltInTx = "ContextualPurchase";
const TX_ADMIN = "Admin";

/** the SKUs that are not a pack or a costume name */
export const SKU = {
	WelcomeGift: "Welcome gift",
	DaySurvived: "Day survived",
	Milestone: "Record milestone",
	Boss: "Boss",
	Rebirth: "Rebirth",
	AdminEdit: "Admin edit",
	/** purchases of different SKUs folded together while the rate guard held them back (never in normal play) */
	Batched: "Batched",
} as const;

// ---------------------------------------------------------------- events

/** the three custom-field keys the dashboards break down by (Enum.AnalyticsCustomFieldKeys names) */
export interface CustomFields {
	CustomField01?: string;
	CustomField02?: string;
	CustomField03?: string;
}

/**
 * A funnel's breakdowns only read the fields of its FIRST step (the engine reference, LogFunnelStepEvent: "Funnel
 * breakdowns only consider the user and event values from the first step in a funnel session"), so only step 1 of a
 * funnel carries any.
 */
export type AnalyticsEvent =
	| { kind: "onboarding"; player: Player; step: number; name: string; fields?: CustomFields }
	| {
			kind: "funnel";
			player: Player;
			funnel: string;
			/** undefined = a one-time funnel (repeats of a step are ignored by the platform) */
			session: string | undefined;
			step: number;
			name: string;
			fields?: CustomFields;
	  }
	| {
			kind: "economy";
			player: Player;
			flow: "Source" | "Sink";
			amount: number;
			/** the balance AFTER the change, as LogEconomyEvent wants it */
			balance: number;
			tx: string;
			sku: string;
			fields?: CustomFields;
	  }
	| { kind: "custom"; player: Player; name: string; value: number | undefined; fields?: CustomFields };

/** where the events go: AnalyticsService in a published game, a counter in Studio, a recorder in a test */
export interface AnalyticsSink {
	deliver(ev: AnalyticsEvent): void;
}

export interface AnalyticsStats {
	/** events the rules produced */
	logged: number;
	/** handed to the sink */
	sent: number;
	/** waiting for the window right now, and the most that ever waited */
	deferred: number;
	deferredPeak: number;
	/** economy events folded into a queued twin, and events given up because the queue was full */
	merged: number;
	dropped: number;
	/** the most events any 60 s window ever held, and the limit at that moment */
	maxInWindow: number;
	/** calls that threw (the sink or a rule): counted and warned, never raised */
	faults: number;
}

// ---------------------------------------------------------------- bucketing (low cardinality)

/** "1", "2-3", "4-7", "8-14", "15-29", "30+": the difficulty's own steps, not one value per day */
export function dayBucket(day: number): string {
	if (day <= 1) return "1";
	if (day <= 3) return "2-3";
	if (day <= 7) return "4-7";
	if (day <= 14) return "8-14";
	if (day <= 29) return "15-29";
	return "30+";
}

function killBucket(kills: number): string {
	if (kills <= 0) return "0";
	if (kills < 10) return "1-9";
	if (kills < 50) return "10-49";
	if (kills < 200) return "50-199";
	return "200+";
}

/** the coins a player holds, in the steps of the catalogue's prices (packs cost 20-60, a costume more) */
export function coinBucket(coins: number): string {
	if (coins < 10) return "0-9";
	if (coins < 50) return "10-49";
	if (coins < 200) return "50-199";
	return "200+";
}

/** "1", "2", "3", "4+": which continue of the life a Rebirth is (its price climbs with each, shared/data/shop.ts) */
function continueOf(nth: number): string {
	return nth >= 4 ? "4+" : tostring(math.max(1, nth));
}

/** WeaponKills' field: the kind's name, "Machine" for a turret's or a drone's kill, "Other" when not known */
export function weaponName(kind: number): string {
	if (kind === MACHINE_KILL) return "Machine";
	return WEAPON_KIND_NAMES[kind - 1] ?? "Other";
}

/** what a body carries into its death, as far as the cause goes (a PlayerState is one) */
export interface DeathBody {
	x: number;
	y: number;
	/** 0 = starving: the hunger drain is taking hp (shared/sim/playerMove.ts) */
	hungry: number;
	buffs: { poison: number };
}

/** a boss as far as the cause goes (a BossState is one) */
export interface DeathBoss {
	x: number;
	y: number;
	hp: number;
}

/**
 * Why a survivor died, from what the server holds at that instant (the damage itself carries no source): starving,
 * poisoned, a living boss within a needle's reach, or else the horde. Low cardinality by construction: four values.
 */
export function causeOfDeath(body: DeathBody | undefined, bosses: ReadonlyArray<DeathBoss> | undefined): string {
	if (body === undefined) return "Cause - Unknown";
	if (body.hungry <= 0) return "Cause - Hunger";
	if (body.buffs.poison > 0) return "Cause - Poison";
	if (bosses !== undefined) {
		for (const b of bosses) {
			const dx = b.x - body.x;
			const dy = b.y - body.y;
			if (b.hp > 0 && dx * dx + dy * dy <= BOSS_REACH * BOSS_REACH) return "Cause - Boss";
		}
	}
	return "Cause - Horde";
}

/** a life's funnel session: `runRev` less the continues bought in it -- a paid Rebirth moves both, a new life resets
 * `deathCount` and moves `runRev`, so the key holds through a life and every later life gets a larger one */
export function lifeKeyOf(save: PlayerSaveData): number {
	return save.runRev - save.deathCount;
}

/** the key of one death's Rebirth funnel: the same for the death and for the Rebirth that answers it */
export function deathKeyOf(save: PlayerSaveData): string {
	return `death-${lifeKeyOf(save)}-${save.lifeDeaths}`;
}

/** the highest step of `steps` that `value` reached (1-based), or 0 */
function stepOf(steps: ReadonlyArray<number>, value: number): number {
	let step = 0;
	for (let i = 0; i < steps.size(); i++) {
		if (value >= steps[i]) step = i + 1;
	}
	return step;
}

/** any trace of a body in the city: the hp written on leaving, a death, a kill, a night, XP, a Rebirth */
function playedBefore(save: PlayerSaveData): boolean {
	return (
		save.runHp > 0 ||
		save.runOver ||
		save.runRev > 0 ||
		save.zombieKills > 0 ||
		save.lifeNights > 0 ||
		save.level > 1 ||
		save.exp > 0 ||
		save.day > 1 ||
		save.deathCount > 0
	);
}

// ---------------------------------------------------------------- the per-player state

interface Entry {
	player: Player;
	userId: number;
	save: PlayerSaveData;
	/** a session that will never be written (status "error" / "unavailable"): its coins are nobody's */
	ephemeral: boolean;
	/** in the onboarding funnel (a save born since ONBOARDING_SINCE, not yet a Survivor) */
	onboarding: boolean;
	/** the highest onboarding step sent (or known to be behind this player) */
	onboardStep: number;
	/** `tutorialDone` when last read: the choice is logged on the false -> true edge */
	tutorialSeen: boolean;
	/** had a body in the city this session */
	entered: boolean;
	levelStep: number;
	lifeKey: number;
	nightStep: number;
	/** the life as it was last seen (a life that ends is reset by the time its hook runs) */
	lastDay: number;
	lastDeaths: number;
	/** this life has never stood (a New game still waiting for daybreak): a world end is not its end */
	unlived: boolean;
	killsAtLoad: number;
	crafted: number;
	cooked: number;
	smelted: number;
	used: number;
	/** killing blows of this session by weapon kind (`weaponName`), counted per kill, sent once on leaving */
	weaponKills: Map<number, number>;
	/** clock() when the player left, or undefined */
	leftAt?: number;
	summarized: boolean;
	/** a first visit (the save was created this session) */
	fresh: boolean;
	/** clock() when the save loaded: the session's length on leaving */
	loadedAt: number;
	/** where the last read found them (`poll`): a body in the city, and the world's hour a night one */
	inWorld: boolean;
	atNight: boolean | undefined;
	/** tonight's Night funnel session, while it is open */
	night?: { id: string; step: number };
	/** the shop visit that is open, and the rate guard on opening one */
	shop?: { id: string; at: number; step: number };
	shopOpenedAt: number;
	shopVisits: number;
}

/**
 * The world as analytics reads it, bound by server/net/mpHost.ts once the town stands (`bindWorld`): the clock the
 * Night funnel follows and where each player is. Absent (MP_PHASE 0, the pure tests) the funnel that needs it is off.
 */
export interface WorldView {
	/** the world clock's hour, 0-24 */
	dayTime(): number;
	/** the world's day (it turns at midnight) */
	day(): number;
	/** this player's body in the city, or undefined in the lobby */
	bodyOf(player: Player): { dead: boolean } | undefined;
	/** survivors standing in the city (alive) */
	standing(): number;
}

export interface AnalyticsOptions {
	/** seconds (os.clock on the server) */
	clock: () => number;
	/** the CCU the cap is computed for; defaults to the players this module tracks */
	players?: () => number;
	/** a new funnelSessionId (HttpService:GenerateGUID in the game, a counter in a test) */
	newId?: () => string;
}

/**
 * The rules. Pure: no Instances and no services -- the adapter below (`startAnalytics`) feeds it the clock and the
 * sink, and tools/test-analytics.mjs drives it directly for the hour of six players.
 */
export class ServerAnalytics {
	readonly stats: AnalyticsStats = {
		logged: 0,
		sent: 0,
		deferred: 0,
		deferredPeak: 0,
		merged: 0,
		dropped: 0,
		maxInWindow: 0,
		faults: 0,
	};
	private readonly sink: AnalyticsSink;
	private readonly clock: () => number;
	private readonly playerCount?: () => number;
	private readonly entries = new Map<Player, Entry>();
	private readonly bySave = new Map<PlayerSaveData, Entry>();
	/** MP-26: who arrived from another server's list and has no loaded save yet (`arrivedFromList`) */
	private readonly arrivals = new Map<Player, { day: number; players: number }>();
	/** send times of the current window, a ring as large as the largest cap */
	private readonly ring = new Array<number>();
	private ringHead = 0;
	private ringCount = 0;
	private readonly deferred = new Array<AnalyticsEvent>();
	private lastFault = -math.huge;
	private readonly newId: () => string;
	private idSerial = 0;
	private world?: WorldView;
	/** the world clock at the last read, to find the hours crossed since (the Night funnel) */
	private lastHour?: number;
	private lastDay?: number;

	constructor(sink: AnalyticsSink, options: AnalyticsOptions) {
		this.sink = sink;
		this.clock = options.clock;
		this.playerCount = options.players;
		this.newId =
			options.newId ??
			(() => {
				this.idSerial += 1;
				return `s${this.idSerial}`;
			});
	}

	/** the town the Night funnel follows (server/net/mpHost.ts); undefined when it stops */
	bindWorld(world: WorldView | undefined): void {
		this.world = world;
		this.lastHour = undefined;
		this.lastDay = undefined;
	}

	// ------------------------------------------------------------ the rate guard

	/**
	 * The CCU the cap is computed for: the players still here whose save loaded (one who left is not counted, even
	 * while the module keeps them for LEAVE_GRACE_S; one still loading is not counted either -- both err low).
	 */
	private ccu(): number {
		let here = 0;
		if (this.playerCount !== undefined) {
			here = this.playerCount();
		} else {
			for (const [, e] of this.entries) {
				if (e.leftAt === undefined) here += 1;
			}
		}
		return math.clamp(here, 1, MAX_PLAYERS);
	}

	/** events this module may send in the current window: RATE_SHARE of 120 + 20 x CCU */
	limitNow(): number {
		return math.floor(RATE_SHARE * (RATE_BASE + RATE_PER_PLAYER * this.ccu()));
	}

	/** the documented cap itself, for the same CCU (the tests compare against it) */
	capNow(): number {
		return RATE_BASE + RATE_PER_PLAYER * this.ccu();
	}

	private expire(now: number): void {
		const cap = this.ring.size();
		while (this.ringCount > 0 && this.ring[this.ringHead] <= now - RATE_WINDOW_S) {
			this.ringHead = (this.ringHead + 1) % cap;
			this.ringCount -= 1;
		}
	}

	/** one send's worth of the window, if there is one left */
	private take(now: number): boolean {
		const size = RATE_BASE + RATE_PER_PLAYER * MAX_PLAYERS;
		while (this.ring.size() < size) this.ring.push(-math.huge);
		this.expire(now);
		if (this.ringCount >= this.limitNow()) return false;
		this.ring[(this.ringHead + this.ringCount) % size] = now;
		this.ringCount += 1;
		if (this.ringCount > this.stats.maxInWindow) this.stats.maxInWindow = this.ringCount;
		return true;
	}

	private send(ev: AnalyticsEvent): void {
		this.stats.logged += 1;
		// in order: nothing overtakes what is already waiting (which goes first, as far as the window allows)
		if (this.deferred.size() > 0) this.drain();
		if (this.deferred.size() > 0 || !this.take(this.clock())) {
			this.defer(ev);
			return;
		}
		this.deliver(ev);
	}

	private deliver(ev: AnalyticsEvent): void {
		const [ok, err] = pcall(() => this.sink.deliver(ev));
		if (ok) this.stats.sent += 1;
		else this.fault("sink", err);
	}

	private defer(ev: AnalyticsEvent): void {
		if (ev.kind === "economy") {
			// only into this player's LATEST waiting economy event, so every balance still follows from the one before;
			// a different SKU makes it a batch (only ever while the guard holds events back, never in normal play)
			for (let i = this.deferred.size() - 1; i >= 0; i--) {
				const q = this.deferred[i];
				if (q.kind !== "economy" || q.player !== ev.player) continue;
				if (q.flow !== ev.flow || q.tx !== ev.tx) break;
				q.amount += ev.amount;
				q.balance = ev.balance;
				if (q.sku !== ev.sku) q.sku = SKU.Batched;
				this.stats.merged += 1;
				return;
			}
		}
		if (this.deferred.size() >= DEFERRED_MAX) {
			// the coins are what must balance: an economy event takes the place of the oldest non-economy one
			let evict = -1;
			if (ev.kind === "economy") {
				for (let i = 0; i < this.deferred.size(); i++) {
					if (this.deferred[i].kind !== "economy") {
						evict = i;
						break;
					}
				}
			}
			if (evict < 0) {
				this.stats.dropped += 1;
				return;
			}
			this.deferred.remove(evict);
			this.stats.dropped += 1;
		}
		this.deferred.push(ev);
		this.stats.deferred = this.deferred.size();
		if (this.stats.deferred > this.stats.deferredPeak) this.stats.deferredPeak = this.stats.deferred;
	}

	/** sends what waited, as far as the window allows */
	drain(): void {
		const now = this.clock();
		while (this.deferred.size() > 0 && this.take(now)) {
			const ev = this.deferred.shift();
			if (ev !== undefined) this.deliver(ev);
		}
		this.stats.deferred = this.deferred.size();
	}

	fault(where: string, err: unknown): void {
		this.stats.faults += 1;
		const now = this.clock();
		if (now - this.lastFault < FAULT_LOG_S) return;
		this.lastFault = now;
		// the Error Report groups by message (error-report.md): the running count would make every warning a new row,
		// so it goes to the log line after it (and to `stats.faults`, which the admin panel reads)
		warn(`[${GAME_NAME}] analytics: ${where} failed: ${tostring(err)}`);
		print(`[${GAME_NAME}] analytics: ${this.stats.faults} failure(s) so far`);
	}

	// ------------------------------------------------------------ the emitters

	private custom(e: Entry, name: string, value: number | undefined, fields?: CustomFields): void {
		this.send({ kind: "custom", player: e.player, name, value, fields });
	}

	private economy(
		e: Entry,
		flow: "Source" | "Sink",
		amount: number,
		balance: number,
		tx: string,
		sku: string,
		fields?: CustomFields,
	): void {
		// a session that is never written spends coins that are nobody's; an amount must be positive (the API)
		if (e.ephemeral || !(amount > 0)) return;
		this.send({ kind: "economy", player: e.player, flow, amount, balance: math.max(0, balance), tx, sku, fields });
	}

	private onboardingStep(e: Entry, step: number, fields?: CustomFields): void {
		e.onboardStep = step;
		this.send({ kind: "onboarding", player: e.player, step, name: ONBOARDING_STEPS[step - 1], fields });
	}

	private funnel(
		e: Entry,
		funnel: string,
		session: string | undefined,
		step: number,
		name: string,
		fields?: CustomFields,
	): void {
		this.send({ kind: "funnel", player: e.player, funnel, session, step, name, fields });
	}

	// ------------------------------------------------------------ sessions

	private entryOfSave(save: PlayerSaveData): Entry | undefined {
		return this.bySave.get(save);
	}

	private entryOfUser(userId: number): Entry | undefined {
		for (const [, e] of this.entries) {
			if (e.userId === userId && e.leftAt === undefined) return e;
		}
		return undefined;
	}

	/** the number of players tracked (the CCU the cap is computed for, when no `players` option is given) */
	tracked(): number {
		return this.entries.size();
	}

	/**
	 * A session's save finished loading (server/main.server.ts `loadSession`, also on a retry). `status` "new" is a
	 * first visit: the funnel's first step and the welcome gift. The save table is the session's LIVE one, which the
	 * server writes in place for the whole session. `arm` is what an experiment decided for this new save
	 * (server/config/experiments.ts, e.g. "Welcome pack - None"): the first step carries it, which is the only step a
	 * funnel's breakdown reads -- the onboarding funnel of each arm, side by side.
	 */
	sessionLoaded(player: Player, status: string, save: PlayerSaveData, arm?: string): void {
		const old = this.entries.get(player);
		if (old !== undefined) this.bySave.delete(old.save);
		const ephemeral = status !== "ok" && status !== "new";
		const fresh = status === "new";
		const e: Entry = {
			player,
			userId: player.UserId,
			save,
			ephemeral,
			onboarding:
				!ephemeral && (fresh || (save.titleEpoch >= ONBOARDING_SINCE && !ownsTitle(save, TitleId.Survivor))),
			onboardStep: 0,
			tutorialSeen: save.tutorialDone,
			entered: old !== undefined && old.entered,
			levelStep: 0,
			lifeKey: lifeKeyOf(save),
			nightStep: 0,
			lastDay: save.day,
			lastDeaths: save.deathCount,
			unlived: false,
			killsAtLoad: save.zombieKills,
			crafted: old?.crafted ?? 0,
			cooked: old?.cooked ?? 0,
			smelted: old?.smelted ?? 0,
			used: old?.used ?? 0,
			weaponKills: old?.weaponKills ?? new Map<number, number>(),
			summarized: false,
			fresh: fresh || (old !== undefined && old.fresh),
			loadedAt: old?.loadedAt ?? this.clock(),
			inWorld: old !== undefined && old.inWorld,
			atNight: old?.atNight,
			shopOpenedAt: old?.shopOpenedAt ?? -math.huge,
			shopVisits: old?.shopVisits ?? 0,
		};
		this.entries.set(player, e);
		this.bySave.set(save, e);
		// MP-26: they arrived from another server's Servers list before their save was here (`arrivedFromList`)
		const arrival = this.arrivals.get(player);
		if (arrival !== undefined) {
			this.arrivals.delete(player);
			this.logArrival(e, arrival.day, arrival.players);
		}
		if (fresh) {
			this.onboardingStep(e, 1, arm !== undefined ? { CustomField01: arm } : undefined);
			// freshSave's gift: a brand-new save holds nothing else yet
			this.economy(e, "Source", save.money, save.money, TX_ONBOARDING, SKU.WelcomeGift);
		} else if (e.onboarding) {
			// a later session of a new player: what the save shows already happened was sent back then
			let step = 1;
			if (save.tutorialDone) step = 2;
			if (playedBefore(save)) step = 3;
			if (save.zombieKills >= 1) step = 4;
			e.onboardStep = step;
		}
	}

	/** the player has a body in the city (server/net/mpHost.ts `admit`) */
	enteredWorld(player: Player): void {
		const e = this.entries.get(player);
		if (e === undefined) return;
		e.entered = true;
		e.inWorld = true;
		if (e.onboarding) this.advanceOnboarding(e);
	}

	/** the player left the server: the session's aggregates, once (Players.PlayerRemoving, BindToClose) */
	playerLeft(player: Player): void {
		this.arrivals.delete(player);
		const e = this.entries.get(player);
		if (e === undefined) return;
		if (e.leftAt === undefined) e.leftAt = this.clock();
		this.summarize(e);
	}

	private summarize(e: Entry): void {
		if (e.summarized) return;
		e.summarized = true;
		if (e.ephemeral) return;
		// the quit point, lobby sessions included (a new player who never walks in is the drop-off that matters most).
		// Where and when come from the last once-a-second read, never from now: the host's own PlayerRemoving may
		// already have taken the body out of the city (the two handlers run in no set order)
		const minutes = math.max(0, (e.leftAt ?? this.clock()) - e.loadedAt) / 60;
		const where = e.save.runOver ? "Dead" : e.inWorld ? "City" : "Lobby";
		const fields: CustomFields = {
			CustomField01: `Where - ${where}`,
			CustomField03: e.fresh ? "Visit - First" : "Visit - Returning",
		};
		if (e.atNight !== undefined) fields.CustomField02 = e.atNight ? "Time - Night" : "Time - Day";
		this.custom(e, EVENT.SessionEnded, math.floor(minutes * 10 + 0.5) / 10, fields);
		if (!e.entered) return;
		const kills = math.max(0, e.save.zombieKills - e.killsAtLoad);
		this.custom(e, EVENT.SessionKills, kills, { CustomField01: `Kills - ${killBucket(kills)}` });
		// one per kind actually used, in the kinds' order: a session is 1-3 of them, never one per kill
		for (let kind = -1; kind <= WEAPON_KIND_NAMES.size(); kind++) {
			const n = e.weaponKills.get(kind) ?? 0;
			if (n > 0) this.custom(e, EVENT.WeaponKills, n, { CustomField01: `Weapon - ${weaponName(kind)}` });
		}
		if (e.crafted > 0) this.custom(e, EVENT.Crafted, e.crafted, { CustomField01: "Kind - Crafted" });
		if (e.cooked > 0) this.custom(e, EVENT.Crafted, e.cooked, { CustomField01: "Kind - Cooked" });
		if (e.smelted > 0) this.custom(e, EVENT.Crafted, e.smelted, { CustomField01: "Kind - Smelted" });
		if (e.used > 0) this.custom(e, EVENT.ItemsUsed, e.used);
	}

	/** BindToClose: every session still here is summarized, and the queue gets what the window still allows */
	shutdown(): void {
		for (const [, e] of this.entries) this.summarize(e);
		this.drain();
	}

	// ------------------------------------------------------------ the once-a-second read of the live saves

	poll(): void {
		const now = this.clock();
		const gone = new Array<Player>();
		const hours = this.hoursCrossed();
		for (const [player, e] of this.entries) {
			// a removal this module missed (a Player already parented to nil) is a leave too
			if (e.leftAt === undefined && player.Parent === undefined) this.playerLeft(player);
			if (e.leftAt !== undefined) {
				if (now - e.leftAt >= LEAVE_GRACE_S) gone.push(player);
				continue;
			}
			this.pollEntry(e);
			for (const step of hours) this.nightPhase(e, step);
		}
		for (const player of gone) {
			const e = this.entries.get(player);
			this.entries.delete(player);
			if (e !== undefined) this.bySave.delete(e.save);
		}
		this.drain();
	}

	/**
	 * The Night funnel's steps whose hour the world clock crossed since the last read, in the night's order (one at a
	 * time at 1 Hz; several after a hitch). None on the first read, nor across a jump -- an admin's clock or a new town
	 * lived through nothing.
	 */
	private hoursCrossed(): Array<number> {
		const out = new Array<number>();
		const w = this.world;
		if (w === undefined) return out;
		const hour = w.dayTime();
		const day = w.day();
		const prevHour = this.lastHour;
		const prevDay = this.lastDay;
		this.lastHour = hour;
		this.lastDay = day;
		if (prevHour === undefined || prevDay === undefined) return out;
		let elapsed = -1;
		if (day === prevDay) elapsed = hour - prevHour;
		else if (day === prevDay + 1) elapsed = hour + 24 - prevHour;
		if (elapsed <= 0 || elapsed > CLOCK_JUMP_H) return out;
		for (let i = 0; i < NIGHT_PHASE_HOURS.size(); i++) {
			if (crossed(prevHour, hour, NIGHT_PHASE_HOURS[i])) out.push(i + 1);
		}
		return out;
	}

	/** one hour of the Night funnel for one player: nightfall opens tonight's session, each later hour moves it on */
	private nightPhase(e: Entry, step: number): void {
		const w = this.world;
		if (w === undefined || e.ephemeral) return;
		const body = w.bodyOf(e.player);
		const standing = body !== undefined && !body.dead;
		if (step === 1) {
			e.night = undefined;
			if (!standing) return;
			e.night = { id: this.newId(), step: 1 };
			const world = w.day();
			this.funnel(e, NIGHT_PHASE_FUNNEL, e.night.id, 1, NIGHT_PHASE_NAMES[0], {
				CustomField01: `World day - ${dayBucket(world)}`,
				CustomField02: `Life day - ${dayBucket(e.save.day)}`,
				CustomField03: w.standing() <= 1 ? "Survivors - Solo" : "Survivors - Group",
			});
			return;
		}
		const night = e.night;
		if (night === undefined) return;
		// not standing in the city for this hour (dead, in the lobby), or an hour missed: tonight is over for them
		if (!standing || step !== night.step + 1) {
			e.night = undefined;
			return;
		}
		night.step = step;
		this.funnel(e, NIGHT_PHASE_FUNNEL, night.id, step, NIGHT_PHASE_NAMES[step - 1]);
		if (step >= NIGHT_PHASE_HOURS.size()) e.night = undefined;
	}

	private pollEntry(e: Entry): void {
		const save = e.save;
		const w = this.world;
		if (w !== undefined) {
			e.inWorld = w.bodyOf(e.player) !== undefined;
			e.atNight = isNightAt(w.dayTime());
		}
		const key = lifeKeyOf(save);
		if (key !== e.lifeKey) {
			// a new life (New game, a world's end) -- or, rarely, a free Rebirth or an admin edit moving the key
			e.lifeKey = key;
			e.nightStep = 0;
		}
		e.lastDay = save.day;
		e.lastDeaths = save.deathCount;
		if (!save.runOver) e.unlived = false;
		if (e.onboarding) this.advanceOnboarding(e);
		if (!e.entered || e.ephemeral) return;
		const level = stepOf(LEVEL_STEPS, save.level);
		if (level > e.levelStep) {
			e.levelStep = level;
			this.send({
				kind: "funnel",
				player: e.player,
				funnel: LEVEL_FUNNEL,
				session: undefined,
				step: level,
				name: `Level ${LEVEL_STEPS[level - 1]}`,
			});
		}
		// a life enters its funnel once its body stands in the city: a New game still waiting for daybreak has not
		// started living (and may be replaced by a world's end before it does)
		if (save.runOver) return;
		const night = stepOf(NIGHT_STEPS, save.lifeNights);
		if (night > e.nightStep) {
			e.nightStep = night;
			this.send({
				kind: "funnel",
				player: e.player,
				funnel: NIGHT_FUNNEL,
				session: `life-${key}`,
				step: night,
				name: NIGHT_STEP_NAMES[night - 1],
			});
		}
	}

	/**
	 * The onboarding funnel moves forward only, one step at a time, each at most once per session (the platform
	 * dedupes across sessions): 2 when the question was answered (or the city entered: the question comes first),
	 * 3 the city, 4 a killing blow, 5 the Survivor title. A later step reached before an earlier one is sent alone --
	 * the funnel counts the skipped ones as done (funnel-events.md), which is the game's own order anyway.
	 */
	private advanceOnboarding(e: Entry): void {
		const save = e.save;
		if (!e.tutorialSeen && save.tutorialDone) {
			e.tutorialSeen = true;
			// "No" clears both flags at once (declineTutorial); "Yes" leaves the coach's flag set until it is done
			this.custom(e, EVENT.TutorialChoice, undefined, {
				CustomField01: save.firstInstall ? "Choice - Accepted" : "Choice - Declined",
			});
		}
		for (let step = e.onboardStep + 1; step <= ONBOARDING_STEPS.size(); step++) {
			let reached: boolean;
			if (step === 2) reached = save.tutorialDone || e.entered;
			else if (step === 3) reached = e.entered;
			else if (step === 4) reached = save.zombieKills >= 1;
			else if (step === 5) reached = ownsTitle(save, TitleId.Survivor);
			else reached = false;
			if (reached) this.onboardingStep(e, step);
		}
		if (e.onboardStep >= ONBOARDING_STEPS.size()) e.onboarding = false;
	}

	// ------------------------------------------------------------ the server's decisions

	/** midnight paid this life's day (server/sim/progress.ts `creditDaySurvived`); `coins` includes `milestone` */
	dayCoins(save: PlayerSaveData, coins: number, milestone: number): void {
		const e = this.entryOfSave(save);
		if (e === undefined) return;
		this.economy(e, "Source", coins - milestone, save.money - milestone, TX_GAMEPLAY, SKU.DaySurvived);
		this.economy(e, "Source", milestone, save.money, TX_GAMEPLAY, SKU.Milestone);
	}

	/** a boss went down with this survivor in the fight (server/sim/progress.ts `creditBossKill`) */
	bossCoins(save: PlayerSaveData, coins: number): void {
		const e = this.entryOfSave(save);
		if (e !== undefined) this.economy(e, "Source", coins, save.money, TX_GAMEPLAY, SKU.Boss);
	}

	/**
	 * A ShopAction the server ACCEPTED (server/main.server.ts `handleAction`, after the save changed): the coins it
	 * took, and -- for a New game -- the end of the life it gave up. `price` is what was charged.
	 */
	shopAction(player: Player, req: Record<string, unknown>, price: number): void {
		const e = this.entries.get(player);
		if (e === undefined) return;
		const save = e.save;
		if (req.kind === "buyPack" && typeIs(req.packId, "number")) {
			const pack = SHOP_PACKS[req.packId];
			if (pack === undefined) return;
			// the category is the one breakdown that puts every pack against every costume in the same chart
			this.economy(e, "Sink", price, save.money, TX_SHOP, pack.name, { CustomField01: "Category - Pack" });
			this.shopStep(e, 3);
		} else if (req.kind === "buyCostume" && typeIs(req.costumeId, "number")) {
			const costume = COSTUMES[req.costumeId];
			if (costume === undefined) return;
			this.economy(e, "Sink", price, save.money, TX_SHOP, costume.name, { CustomField01: "Category - Costume" });
			this.shopStep(e, 3);
		} else if (req.kind === "rebirth") {
			this.economy(e, "Sink", price, save.money, TX_CONTEXTUAL, SKU.Rebirth, {
				CustomField01: `Continue - ${continueOf(save.deathCount)}`,
			});
			// a PAID Rebirth answers the death it closes (the key survives the sale: `deathKeyOf`). One the daybreak
			// already paid for (price 0, not a continue) is a free stand-up, not a conversion
			if (price > 0 && !e.ephemeral) this.funnel(e, REBIRTH_FUNNEL, deathKeyOf(save), 2, REBIRTH_STEPS[1]);
		} else if (req.kind === "newRun") {
			this.lifeEnded(e, "New game");
			// the new life waits for daybreak: it has not been lived until it stands
			e.unlived = true;
		}
	}

	private lifeEnded(e: Entry, how: string): void {
		const deaths = e.lastDeaths >= 3 ? "3+" : tostring(e.lastDeaths);
		this.custom(e, EVENT.LifeEnded, e.lastDay, {
			CustomField01: `End - ${how}`,
			CustomField02: `Life day - ${dayBucket(e.lastDay)}`,
			CustomField03: `Rebirths - ${deaths}`,
		});
		e.lastDay = 1;
		e.lastDeaths = 0;
	}

	/**
	 * An admin edited or reset this save (server/main.server.ts `adminEdit`, before the edit lands): coins an admin
	 * gave or took are logged as such so the balances still add up, and the funnels are moved to where the edit put
	 * the save WITHOUT an event -- an admin setting a level is not a player reaching it.
	 */
	adminEdit(save: PlayerSaveData, edited: PlayerSaveData): void {
		const e = this.entryOfSave(save);
		if (e === undefined) return;
		const delta = edited.money - save.money;
		if (delta > 0) this.economy(e, "Source", delta, edited.money, TX_ADMIN, SKU.AdminEdit);
		else if (delta < 0) this.economy(e, "Sink", -delta, edited.money, TX_ADMIN, SKU.AdminEdit);
		e.levelStep = math.max(e.levelStep, stepOf(LEVEL_STEPS, edited.level));
		e.lifeKey = lifeKeyOf(edited);
		e.nightStep = math.max(e.nightStep, stepOf(NIGHT_STEPS, edited.lifeNights));
		e.lastDay = edited.day;
		e.lastDeaths = edited.deathCount;
	}

	/**
	 * The server killed this survivor (server/sim/life.ts `died`, after `lifeDeaths` counted it). `survivors` is who
	 * is in the world with them (kept for the callers; the group question moved to the Night funnel's first step);
	 * `body` and `bosses` are what the cause is read from (`causeOfDeath`).
	 */
	death(
		save: PlayerSaveData,
		dayTime: number,
		survivors: number,
		body?: DeathBody,
		bosses?: ReadonlyArray<DeathBoss>,
	): void {
		const e = this.entryOfSave(save);
		if (e === undefined) return;
		e.lastDay = save.day;
		e.lastDeaths = save.deathCount;
		// tonight is over for them: a Rebirth before the next hour is a new body, not a night lived through
		e.night = undefined;
		this.custom(e, EVENT.Died, save.day, {
			CustomField01: `Life day - ${dayBucket(save.day)}`,
			CustomField02: isNightAt(dayTime) ? "Time - Night" : "Time - Day",
			CustomField03: causeOfDeath(body, bosses),
		});
		if (e.ephemeral) return;
		// the Rebirth funnel of this death: which continue it would be, whether the coins are there for it, how long
		// the life it would save has lasted -- the three things the price of a Rebirth is weighed against
		const price = rebirthPrice(save.deathCount);
		this.funnel(e, REBIRTH_FUNNEL, deathKeyOf(save), 1, REBIRTH_STEPS[0], {
			CustomField01: `Continue - ${continueOf(save.deathCount + 1)}`,
			CustomField02: save.money >= price ? "Afford - Yes" : "Afford - No",
			CustomField03: `Life day - ${dayBucket(save.day)}`,
		});
	}

	/**
	 * A killing blow the server credited to this survivor (server/sim/progress.ts `creditKill` / `creditMachineKill`,
	 * past the assisted-run gate that `zombieKills` has too). Counted only -- the session's WeaponKills go out on
	 * leaving (rule 2).
	 */
	kill(save: PlayerSaveData, weaponKind: number): void {
		const e = this.entryOfSave(save);
		if (e === undefined) return;
		const kind = weaponKind === MACHINE_KILL || WEAPON_KIND_NAMES[weaponKind - 1] !== undefined ? weaponKind : -1;
		e.weaponKills.set(kind, (e.weaponKills.get(kind) ?? 0) + 1);
	}

	/**
	 * The client says the shop (screen 0, packs) or the wardrobe (1) just opened (server/main.server.ts `viewShop`):
	 * a new visit, and the Shop funnel's first step. Everything the step carries is the server's -- the coins in the
	 * save, whether a body is in the city -- and the guard below is what the docs ask of a client-fired step
	 * (funnel-events.md "Protect your funnels from exploiters"): a known screen, one visit per SHOP_OPEN_MIN_S, at
	 * most SHOP_VISITS_MAX a session. A client that lies moves its own funnel and nothing else.
	 */
	shopViewed(player: Player, screen: unknown): void {
		const e = this.entries.get(player);
		if (e === undefined || e.ephemeral || e.leftAt !== undefined) return;
		if (!typeIs(screen, "number") || screen % 1 !== 0 || SHOP_SCREENS[screen] === undefined) return;
		const now = this.clock();
		if (now - e.shopOpenedAt < SHOP_OPEN_MIN_S || e.shopVisits >= SHOP_VISITS_MAX) return;
		e.shopOpenedAt = now;
		e.shopVisits += 1;
		e.shop = { id: this.newId(), at: now, step: 1 };
		const inCity = this.world !== undefined ? this.world.bodyOf(player) !== undefined : e.inWorld;
		this.funnel(e, SHOP_FUNNEL, e.shop.id, 1, SHOP_STEPS[0], {
			CustomField01: `Screen - ${SHOP_SCREENS[screen]}`,
			CustomField02: `Coins - ${coinBucket(e.save.money)}`,
			CustomField03: inCity ? "Where - City" : "Where - Lobby",
		});
	}

	/** the open visit's next step (2 a buy asked for, 3 bought), once each; nothing without an open visit */
	private shopStep(e: Entry, step: number): void {
		const visit = e.shop;
		if (visit === undefined) return;
		if (this.clock() - visit.at > SHOP_VISIT_S) {
			e.shop = undefined;
			return;
		}
		if (visit.step >= step) return;
		visit.step = step;
		this.funnel(e, SHOP_FUNNEL, visit.id, step, SHOP_STEPS[step - 1]);
	}

	/**
	 * A ShopAction arrived (server/main.server.ts `handleAction`, before it is decided): a well-formed purchase is the
	 * visit's "Tried to buy" -- refused or not, which is what the step after it measures.
	 */
	shopRequest(player: Player, req: Record<string, unknown>): void {
		const e = this.entries.get(player);
		if (e === undefined || e.shop === undefined) return;
		const pack = req.kind === "buyPack" && typeIs(req.packId, "number") && SHOP_PACKS[req.packId] !== undefined;
		const costume =
			req.kind === "buyCostume" && typeIs(req.costumeId, "number") && COSTUMES[req.costumeId] !== undefined;
		if (pack || costume) this.shopStep(e, 2);
	}

	/** MON-05: the server granted a title (server/net/mpHost.ts `onTitleUnlocked`), once per title per save */
	titleEarned(save: PlayerSaveData, titleId: number): void {
		const e = this.entryOfSave(save);
		if (e === undefined) return;
		const title = TITLES[titleId];
		if (title === undefined) return;
		this.custom(e, EVENT.TitleEarned, undefined, { CustomField01: `Title - ${title.name}` });
		if (e.onboarding) this.advanceOnboarding(e);
	}

	/**
	 * MP-22: a world ended and a new one stands (server/net/mpHost.ts, after `endWorld` succeeded). Every fallen
	 * survivor given a new life ended the old one here; the world itself is one event, on the first of them still
	 * connected (a world is nobody's, but LogCustomEvent needs a player). A keeper's restart (MP-26, reason "restart")
	 * may have nobody down: the event then goes on the keeper who asked, "Reason - Restarted".
	 */
	worldEnded(report: WipeReport, outcome: WorldEnd): void {
		let first: Entry | undefined;
		for (const life of outcome.lives) {
			const e = this.entryOfUser(life.userId);
			if (e === undefined) continue;
			if (first === undefined) first = e;
			if (!e.unlived) this.lifeEnded(e, "World end");
			e.unlived = false;
		}
		if (first === undefined) {
			for (const userId of report.dead) {
				first = this.entryOfUser(userId);
				if (first !== undefined) break;
			}
		}
		if (first === undefined && report.by !== undefined) first = this.entryOfUser(report.by);
		if (first === undefined) return;
		const fallen = outcome.ended.fallen;
		const reason =
			report.reason === "declined"
				? "Reason - Declined"
				: report.reason === "restart"
					? "Reason - Restarted"
					: "Reason - Timeout";
		this.custom(first, EVENT.WorldEnded, outcome.ended.days, {
			CustomField01: reason,
			// a restart can end a town nobody fell in
			CustomField02:
				fallen <= 0 ? "Fallen - 0" : fallen === 1 ? "Fallen - 1" : fallen === 2 ? "Fallen - 2" : "Fallen - 3+",
			CustomField03: `World day - ${dayBucket(outcome.ended.days)}`,
		});
	}

	/**
	 * MP-26: this player ARRIVED here from another public server's Servers list (server/match/townServices.ts: the
	 * join data carries the list's flag, from this very place) -- a join is counted where it lands, not when it was
	 * sent (review of 0b44458, L5). The value is this town's world day; the fields are what the player chose: how full
	 * it was when they came, how old, and their best day (the list sorts by the day closest to it). The save is not
	 * loaded yet when they join: the event waits for `sessionLoaded`, once per session. The flag passes through the
	 * client -- it moves this one event and nothing else.
	 */
	arrivedFromList(player: Player, day: number, players: number): void {
		const e = this.entries.get(player);
		if (e === undefined) {
			this.arrivals.set(player, { day, players });
			return;
		}
		this.logArrival(e, day, players);
	}

	private logArrival(e: Entry, day: number, players: number): void {
		if (e.leftAt !== undefined) return;
		this.custom(e, EVENT.JoinedFromList, math.max(1, math.floor(day)), {
			CustomField01: players <= 1 ? "Players - 1" : players <= 3 ? "Players - 2-3" : "Players - 4+",
			CustomField02: `World day - ${dayBucket(day)}`,
			CustomField03: `Best day - ${dayBucket(e.save.bestDay)}`,
		});
	}

	/**
	 * P0-1: the server offered this player, as they joined, a town of their own (server/match/matchHost.ts): the public
	 * town's day was far past their record. The value is that day; the fields are the server's (the world day, the
	 * record, a first visit or not). How many of them said yes is the NewTown funnel's `Route - Offer`.
	 */
	townOffered(player: Player, worldDay: number, save: PlayerSaveData, first: boolean): void {
		const e = this.entries.get(player);
		if (e === undefined || e.leftAt !== undefined) return;
		this.custom(e, EVENT.TownOffered, worldDay, {
			CustomField01: `World day - ${dayBucket(worldDay)}`,
			CustomField02: `Best day - ${dayBucket(save.bestDay)}`,
			CustomField03: first ? "Visit - First" : "Visit - Returning",
		});
	}

	/**
	 * The NewTown funnel (server/match/*): step 1 when the server accepted the request (with its fields: the route, the
	 * world day it leaves, the life's day), 2 when TeleportAsync went through, 3 on the DESTINATION when the ticket was
	 * read. `id` is the trip's GUID, which the ticket carried from one server to the other.
	 */
	townTrip(player: Player, step: number, id: string, route: string, worldDay?: number, save?: PlayerSaveData): void {
		const e = this.entries.get(player);
		const name = TOWN_STEPS[step - 1];
		if (e === undefined || name === undefined) return;
		if (step === 1) {
			const life = save ?? e.save;
			this.funnel(e, TOWN_FUNNEL, id, 1, name, {
				CustomField01: `Route - ${routeName(route)}`,
				CustomField02: `World day - ${dayBucket(worldDay ?? 1)}`,
				CustomField03: `Life day - ${dayBucket(life.day)}`,
			});
			return;
		}
		this.funnel(e, TOWN_FUNNEL, id, step, name);
	}

	/** a trip that ended with the player still here: where it stopped and why; the value is the teleports it tried */
	tripFailed(player: Player, stage: string, why: string, route: string, attempts: number): void {
		const e = this.entries.get(player);
		if (e === undefined) return;
		const where = TRIP_STAGES.includes(stage) ? stage : "Init";
		const result = TRIP_RESULTS.includes(why) ? why : "teleport";
		this.custom(e, EVENT.TripFailed, attempts, {
			CustomField01: `Stage - ${where}`,
			CustomField02: `Result - ${result}`,
			CustomField03: `Route - ${routeName(route)}`,
		});
	}

	/** a backpack verb the server APPLIED (server/sim/simulation.ts `onBackpack`): counted, summarized on leaving */
	backpack(save: PlayerSaveData, outcome: BackpackOutcome): void {
		const e = this.entryOfSave(save);
		if (e === undefined) return;
		if (outcome.kind === "crafted") {
			if (outcome.heat === "cook") e.cooked += 1;
			else if (outcome.heat === "smelt") e.smelted += 1;
			else e.crafted += 1;
		} else if (outcome.kind === "used") {
			e.used += 1;
		}
	}
}

// ---------------------------------------------------------------- the Roblox side

/** the running instance (undefined = analytics is off: every hook below returns at once) */
let active: ServerAnalytics | undefined;

/** AnalyticsService, as event-types.md / the engine reference call it (economy-events.md for the flow enum) */
function serviceSink(svc: AnalyticsService): AnalyticsSink {
	return {
		deliver(ev: AnalyticsEvent): void {
			if (ev.kind === "onboarding") {
				svc.LogOnboardingFunnelStepEvent(ev.player, ev.step, ev.name, ev.fields);
			} else if (ev.kind === "funnel") {
				svc.LogFunnelStepEvent(ev.player, ev.funnel, ev.session, ev.step, ev.name, ev.fields);
			} else if (ev.kind === "economy") {
				const flow =
					ev.flow === "Source" ? Enum.AnalyticsEconomyFlowType.Source : Enum.AnalyticsEconomyFlowType.Sink;
				svc.LogEconomyEvent(ev.player, flow, CURRENCY, ev.amount, ev.balance, ev.tx, ev.sku, ev.fields);
			} else {
				svc.LogCustomEvent(ev.player, ev.name, ev.value, ev.fields);
			}
		},
	};
}

function describe(ev: AnalyticsEvent): string {
	if (ev.kind === "onboarding") return `onboarding ${ev.step} ${ev.name}`;
	if (ev.kind === "funnel") return `funnel ${ev.funnel} ${ev.session ?? "-"} ${ev.step} ${ev.name}`;
	if (ev.kind === "economy") {
		return `economy ${ev.flow} ${ev.amount} ${CURRENCY} -> ${ev.balance} (${ev.tx}, ${ev.sku})`;
	}
	return `custom ${ev.name} ${ev.value ?? "-"}`;
}

/** Studio: nothing is sent (the docs: events only go out from a published game); counted, and echoed on request */
function drySink(): AnalyticsSink {
	const Workspace = game.GetService("Workspace");
	return {
		deliver(ev: AnalyticsEvent): void {
			if (Workspace.GetAttribute("pz_analytics_echo") === true) {
				print(`[${GAME_NAME}] analytics (Studio, not sent): ${ev.player.Name} ${describe(ev)}`);
			}
		},
	};
}

/**
 * Starts analytics on this server (server/main.server.ts, once, before any session loads). Off -- every hook a
 * no-op -- when AnalyticsService cannot be had (a test's fake Roblox, a platform without it).
 */
export function start(): ServerAnalytics | undefined {
	if (active !== undefined) return active;
	// the server's boot must never depend on this: anything that throws here leaves analytics off, and that is all
	const [ok, result] = pcall(boot);
	if (ok) return result;
	active = undefined;
	warn(`[${GAME_NAME}] analytics could not start (${tostring(result)}); the game runs without it`);
	return undefined;
}

function boot(): ServerAnalytics | undefined {
	const RunService = game.GetService("RunService");
	const Players = game.GetService("Players");
	const Workspace = game.GetService("Workspace");
	const HttpService = game.GetService("HttpService");
	const [studioOk, studio] = pcall(() => RunService.IsStudio());
	const inStudio = studioOk && studio === true;
	let sink: AnalyticsSink;
	if (inStudio) {
		sink = drySink();
	} else {
		const [ok, svc] = pcall(() => game.GetService("AnalyticsService"));
		if (!ok || svc === undefined) return undefined;
		sink = serviceSink(svc as AnalyticsService);
	}
	// funnelSessionIds with no natural key are GUIDs, as the engine reference recommends (LogFunnelStepEvent)
	const core = new ServerAnalytics(sink, {
		clock: () => os.clock(),
		newId: () => HttpService.GenerateGUID(false),
	});
	active = core;
	let acc = 0;
	let shown = "";
	RunService.Heartbeat.Connect(dt => {
		acc += dt;
		if (acc < POLL_S) return;
		acc = 0;
		// its own bar in a server dump (MicroProfiler, Timers mode), beside the simulation's PZ.* phases
		debug.profilebegin("PZ.analytics");
		const [ok, err] = pcall(() => core.poll());
		debug.profileend();
		if (!ok) core.fault("poll", err);
		const s = core.stats;
		const line = `${s.sent}|${s.deferred}|${s.dropped}`;
		if (line === shown) return;
		shown = line;
		pcall(() => {
			Workspace.SetAttribute("pz_analytics_sent", s.sent);
			Workspace.SetAttribute("pz_analytics_deferred", s.deferred);
			Workspace.SetAttribute("pz_analytics_dropped", s.dropped);
		});
	});
	Players.PlayerRemoving.Connect(player => guard(c => c.playerLeft(player)));
	game.BindToClose(() => guard(c => c.shutdown()));
	print(`[${GAME_NAME}] analytics on${inStudio ? " (Studio: counted, never sent)" : ""}`);
	return core;
}

/** the running instance, for the admin panel and the tests */
export function current(): ServerAnalytics | undefined {
	return active;
}

/** runs one rule inside pcall; nothing here may ever reach the caller */
function guard(fn: (core: ServerAnalytics) => void): void {
	const core = active;
	if (core === undefined) return;
	const [ok, err] = pcall(() => fn(core));
	if (!ok) core.fault("hook", err);
}

// ---------------------------------------------------------------- the one-line hooks

/** server/main.server.ts `loadSession`: the save loaded (`status` "new" = a first visit; `arm`, its experiment) */
export function sessionLoaded(player: Player, status: string, save: PlayerSaveData, arm?: string): void {
	guard(c => c.sessionLoaded(player, status, save, arm));
}

/** server/net/mpHost.ts: the town the Night funnel follows (undefined when the host stops) */
export function bindWorld(world: WorldView | undefined): void {
	guard(c => c.bindWorld(world));
}

/** server/net/mpHost.ts `admit`: a body in the city */
export function enteredWorld(player: Player): void {
	guard(c => c.enteredWorld(player));
}

/** server/sim/progress.ts `creditDaySurvived`, after the coins landed */
export function dayCoins(save: PlayerSaveData, coins: number, milestone: number): void {
	guard(c => c.dayCoins(save, coins, milestone));
}

/** server/sim/progress.ts `creditBossKill`, after the coins landed */
export function bossCoins(save: PlayerSaveData, coins: number): void {
	guard(c => c.bossCoins(save, coins));
}

/** server/main.server.ts `handleAction`, on success */
export function shopAction(player: Player, req: Record<string, unknown>, price: number): void {
	guard(c => c.shopAction(player, req, price));
}

/** server/main.server.ts `adminEdit`, before the edit is copied into the live save */
export function adminEdit(save: PlayerSaveData, edited: PlayerSaveData): void {
	guard(c => c.adminEdit(save, edited));
}

/** server/sim/life.ts `died`: the body and the bosses are read for the cause, inside the guard */
export function death(
	save: PlayerSaveData,
	dayTime: number,
	survivors: number,
	body?: DeathBody,
	bosses?: ReadonlyArray<DeathBoss>,
): void {
	guard(c => c.death(save, dayTime, survivors, body, bosses));
}

/** server/sim/progress.ts `creditKill` / `creditMachineKill`: counted, never an event of its own */
export function kill(save: PlayerSaveData, weaponKind: number): void {
	guard(c => c.kill(save, weaponKind));
}

/** server/main.server.ts `handleAction`, `viewShop`: the client opened the shop (0) or the wardrobe (1) */
export function shopViewed(player: Player, screen: unknown): void {
	guard(c => c.shopViewed(player, screen));
}

/** server/main.server.ts `handleAction`, before the request is decided */
export function shopRequest(player: Player, req: Record<string, unknown>): void {
	guard(c => c.shopRequest(player, req));
}

/** server/net/mpHost.ts `onTitleUnlocked` */
export function titleEarned(save: PlayerSaveData, titleId: number): void {
	guard(c => c.titleEarned(save, titleId));
}

/** server/net/mpHost.ts `onWorldWiped`, once the new town stands */
export function worldEnded(report: WipeReport, outcome: WorldEnd): void {
	guard(c => c.worldEnded(report, outcome));
}

/** server/match/serverList.ts: the Servers list sent `player` to another public town (MP-26) */
/** server/match/townServices.ts: `player` arrived from another server's Servers list (MP-26), logged on arrival */
export function arrivedFromList(player: Player, day: number, players: number): void {
	guard(c => c.arrivedFromList(player, day, players));
}

/** server/main.server.ts `sim.onBackpack`: a craft, a use, an equip the server applied */
export function backpack(save: PlayerSaveData, outcome: BackpackOutcome): void {
	guard(c => c.backpack(save, outcome));
}

/** server/match/matchHost.ts: a joining player was offered a town of their own (P0-1) */
export function townOffered(player: Player, worldDay: number, save: PlayerSaveData, first: boolean): void {
	guard(c => c.townOffered(player, worldDay, save, first));
}

/** server/match/*: the NewTown funnel's step (1 asked, 2 teleported, 3 arrived on the destination) */
export function townTrip(
	player: Player,
	step: number,
	id: string,
	route: string,
	worldDay?: number,
	save?: PlayerSaveData,
): void {
	guard(c => c.townTrip(player, step, id, route, worldDay, save));
}

/** server/match/travel.ts: a trip ended with the player still here */
export function tripFailed(player: Player, stage: string, why: string, route: string, attempts: number): void {
	guard(c => c.tripFailed(player, stage, why, route, attempts));
}
