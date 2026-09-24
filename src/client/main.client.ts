import { GAME_NAME } from "shared/module";
import {
	carrySettings,
	equipSlotOf,
	expMaxInit,
	ownsEquip,
	ownsWeapon,
	pendingPacks,
	resetRun,
} from "shared/game/save";
import { BossState } from "shared/game/entities";
import { currentWeapon, weaponReserve } from "shared/game/player";
import { CRAFT_RECIPES } from "shared/data/crafts";
import { EQUIPS, EquipSlot } from "shared/data/equips";
import { langGet } from "shared/data/lang";
import { rebirthPrice, SHOP_PACKS } from "shared/data/shop";
import { USABLES } from "shared/data/usables";
import { MP_PHASE } from "shared/net/mpConfig";
import { ShopActionRequest, ShopActionResult } from "shared/net/net";
import { daybreakWaitSeconds } from "shared/sim/clock";
import type { GamePhase } from "shared/game/context";
import { getCtx, setPhase } from "./bootstrap";
import { GameLoop } from "./gameLoop";
import { audio, gameAudio, playFootstep, startUiAudio } from "./audio";
import { onFootstep } from "./view/footsteps";
import * as Boot from "./boot";
import {
	netActive,
	netEnterWorld,
	netHosted,
	netLeaveWorld,
	netOnTown,
	netPrewarm,
	netTownSeed,
	TownNotice,
} from "./net/netClient";
import {
	attachRun,
	DaybreakWait,
	detachRun,
	RunSummary,
	runSummary,
	showDaybreakWait,
	showRunSummary,
} from "./onboarding";
import { craft, craftBlocker, stationNear } from "./systems/craftSystem";
import { chooseWeapon } from "./systems/combat";
import { interactHint } from "./systems/interaction";
import { addItem } from "./systems/items";
import * as net from "./systems/saveClient";
import * as Bag from "./net/backpackSync";
import { showLogo } from "./ui/logo";
import { LobbyHandle, LobbyPage, LobbyStatus, RunState, showLobby } from "./ui/lobby";
import * as Flyover from "./view/townFlyover";
import { actionErrorText, showShop } from "./ui/shop";
import { showWardrobe } from "./ui/wardrobe";
import { startTitleNotices } from "./ui/titleNotice";
import { startAchievementNotices } from "./ui/achievementNotice";
import { showSettings } from "./ui/settings";
import { showCredits } from "./ui/credits";
import { showTutorial } from "./ui/tutorial";
import { showPause } from "./ui/pauseMenu";
import { popup, toast } from "./ui/popup";
import { fmtInt, nl } from "./ui/widgets";
import { Backpack } from "./ui/backpack";
import { DangerFlash } from "./ui/dangerFlash";
import { Hud } from "./ui/hud";
import { AdminHooks, startAdmin } from "./admin/adminClient";

/*
 * Screen flow + run lifecycle.
 * - a run lives in `loop` until the player starts a new one: Home/Shop/Settings from the in-run menu only
 *   SUSPEND it (the survivor leaves the world, MP-18) and Play continues it (HP, hunger and the map are kept)
 * - no screen opened OVER a run pauses anything (DESIGN_RULES UI-06): the Bag, the menu and the end-of-run
 *   screens hold the survivor still while the world keeps going -- see the frame loop in `mountRun`
 * - after a game over the run can only continue with a paid Rebirth (server) or restart at day 1 (New game)
 * - progress is reported to the server every 60 s, on a new day, on a boss kill, on death and when
 *   leaving the run; nothing is reported before the server's LoadAck was adopted
 */

const RunService = game.GetService("RunService");
const AUTOSAVE_SEC = 60;
const LOAD_FALLBACK_SEC = 8;
const NO_AMMO_COOLDOWN = 2;
/**
 * How long after daybreak the client waits for the server's revive before handing the ordinary end-of-run
 * choice back (MP-21) — and only once the session itself is gone (`netActive()` false: no MP host, a slot lost
 * in between). While the session is live the revive is on its way whatever this client's countdown says: the
 * owner's playtest of 23 Sep 2026 saw the client give up 12 s before the server stood the survivor up, and the
 * choice it fell back to ("New game") then drew a living survivor the server still held dead.
 */
const DAYBREAK_GRACE_S = 4;

const ctx = getCtx();
const loop = new GameLoop();
const hud = new Hud(ctx);
const pack = new Backpack(ctx);
/** UI-06: the red flash above the menus when the survivor is hit with one open */
const danger = new DangerFlash(ctx);

let cleanup: (() => void) | undefined;
let pauseCleanup: (() => void) | undefined;
let heartbeat: RBXScriptConnection | undefined;
let deathShown = false;
let saveTimer = 0;
/** `loop` holds a run started with the current save (alive or dead) */
let runActive = false;
let actionBusy = false;
let started = false;
/** adopted LoadAck (undefined = still waiting for the server) */
let loadInfo: net.LoadInfo | undefined;
/** the settings the save on screen started with: what the player changed since is theirs to keep (`applyLoad`) */
let settingsBase = { ...ctx.save.settings };
/** LoadAck that arrived during a run: applied when the player is back in the menus */
let pendingLoad: net.LoadInfo | undefined;
/** status message to show once the lobby is on screen */
let pendingNotice: net.LoadInfo | undefined;
/** admin layer (admin/adminClient.ts): frame hooks; the panel itself exists only for server-confirmed admins */
let admin: AdminHooks | undefined;
/** MP-21: the "wait for daybreak" screen, while this survivor is dead on a shared server */
let dawnWait: DaybreakWait | undefined;
/** real seconds of the wait still owed, counted down here exactly as server/net/mpHost.ts counts its own */
let dawnBudget = 0;
/** real seconds the wait has been over with no revive from the server (see DAYBREAK_GRACE_S) */
let dawnOverdue = 0;
/**
 * MP-21: a New game the server accepted, whose new life is still waiting for daybreak (a new life, not a new body).
 * The death screen is the wait for THAT life: no second New game on it, and its own words.
 */
let newLifeWaiting = false;
/**
 * MP-21's free way out, chosen from the lobby's Survivor screen: this same life waits for daybreak in the city
 * (enterToWait, keeping it). The dawn wait needs no proof of a server clock then -- the player chose it on a server
 * that revives -- exactly as for a new life that waits.
 */
let dawnChosen = false;
/** the life that ended, as it was when New game replaced it: the wait for the new life still shows ITS numbers */
let endedLife: RunSummary | undefined;
/** MP-22: worlds that ended while this client was connected; a run action that raced one is superseded by it */
let worldResets = 0;
/**
 * The lobby (DESIGN_RULES UI-10): the one on screen, the page the player was on (a lobby rebuilt under them keeps
 * it) and, MP-22, the day the last town fell on while this client was connected (its town plate shows it). One
 * table: main.client.luau is close to Luau's 200-locals budget (npm run check:registers).
 */
const lobbyNav: { handle?: LobbyHandle; page: LobbyPage; fellOn?: number } = { page: "menu" };

/**
 * MP-21 (as the owner rewrote it on 23 Sep 2026): does the SERVER stand this survivor back up at daybreak?
 *
 * From MP_PHASE 2 it does, on EVERY server kind: a death is paid for with coins right away (Rebirth) or with the
 * rest of the night (the wait), public or private alike — server/sim/life.ts decides it, and this client only
 * offers both. It used to depend on `game.PrivateServerId` (Rebirth only in the owner's world, the wait only in a
 * shared one); that split is gone. Below MP_PHASE 2 every client simulates its own death and nobody revives it.
 */
function serverRevives(): boolean {
	return MP_PHASE >= 2;
}

// per-run trackers (rewards, HUD). The achievements are not counted here: the SERVER counts them on its own events
// (server/save/achievements.ts, CON-04) and they arrive with the wallet (client/ui/achievementNotice.ts)
const aliveBosses: Array<BossState> = [];
let lastDay = 0;
let lastLevel = 0;
let lastNoAmmo = -math.huge;
let reloadSeen = 0;
let reloadMax = 0;

function tr(key: string): string {
	return langGet(key, ctx.save.settings.langType);
}

// ---------------------------------------------------------------- save / load status

function offlineNote(): string | undefined {
	if (net.netUnavailable()) return tr("Saving is unavailable in this environment");
	if (loadInfo === undefined) return undefined;
	if (loadInfo.status === "error") return tr("Progress not loaded");
	if (!loadInfo.persist) return tr("Saving is unavailable in this environment");
	return undefined;
}

function showLoadNotice(info: net.LoadInfo): void {
	if (info.status === "error") {
		popup(
			ctx,
			tr("Progress not loaded"),
			nl(tr("Your progress could not be loaded.#Nothing will be overwritten: retry,#or play without saving.")),
			[
				{ text: tr("Play without saving"), style: "secondary" },
				{
					text: tr("Retry"),
					onClick: (): void => {
						net.requestLoad();
						toast(ctx, tr("Loading your progress..."));
					},
				},
			],
		);
	} else if (info.status === "unavailable") {
		toast(ctx, tr("Saving is unavailable in this environment"), "error");
	} else if (info.status === "new") {
		toast(ctx, tr("Welcome, survivor! Here are 20 coins to start"), "coin");
	}
}

/** takes the server's save as the local copy and arms progress reports */
function applyLoad(info: net.LoadInfo): void {
	// dialogs opened for the previous save (e.g. "Your run is over") must not act on the new one
	for (const child of ctx.uiLayer.GetChildren()) {
		if (child.Name === "PopupOverlay" || child.Name === "Achievements") child.Destroy();
	}
	// what the player changed in Settings on a save that was never the server's -- the lobby shown before the LoadAck,
	// a session that does not persist -- is kept, field by field, over the save arriving (and reported with it)
	const carried =
		(loadInfo === undefined || !loadInfo.persist) &&
		carrySettings(ctx.save.settings, settingsBase, info.save.settings);
	ctx.save = info.save;
	settingsBase = { ...info.save.settings };
	loadInfo = info;
	runActive = false; // a run in memory belonged to the previous (fallback) save
	net.activate(info);
	if (carried) net.requestSave("menu");
	pendingNotice = info;
}

function isMenuPhase(): boolean {
	return heartbeat === undefined;
}

net.setSaveSource(() => ctx.save);

net.onLoad(info => {
	if (!started) {
		applyLoad(info);
		begin();
		return;
	}
	if (!isMenuPhase()) {
		// never swap the save under a running game: apply it on the way back to the lobby
		pendingLoad = info;
		toast(ctx, tr("Your progress was loaded; it applies when you return to the lobby"));
		return;
	}
	applyLoad(info);
	// a lobby rebuilt for the loaded save stays on the page the player was on
	if (ctx.phase !== "boot") goLobby(lobbyNav.handle !== undefined ? lobbyNav.page : "menu");
});

net.onSaveAck((ack, manual) => {
	if (ack.ok) {
		if (ack.earned > 0) {
			const parts: Array<string> = [];
			if (ack.earnedDays > 0) parts.push(`${tr("Day survived")} ×${ack.earnedDays}`);
			if (ack.earnedBosses > 0) parts.push(`${tr("Boss defeated")} ×${ack.earnedBosses}`);
			toast(ctx, `+${fmtInt(ack.earned)} $   ${parts.join("  ·  ")}`, "coin");
		}
		if (manual) {
			if (net.savingPersistent()) toast(ctx, tr("Progress saved"), "success");
			else toast(ctx, tr("Saving is unavailable in this environment"), "error");
		}
	} else if (ack.reason === "readonly" || ack.reason === "stale") {
		toast(ctx, `${tr("Could not save")}: ${tr("Progress not loaded")}`, "error");
	} else if (manual) {
		toast(ctx, tr("Could not save"), "error");
	}
});

// ---------------------------------------------------------------- per-frame run trackers

function trackBefore(): void {
	aliveBosses.clear();
	for (const b of loop.getRefs().bosses) if (!b.dead) aliveBosses.push(b);
}

function trackAfter(): void {
	const save = ctx.save;
	for (const b of aliveBosses) {
		if (!b.dead) continue;
		save.bossKills += 1; // lifetime counter: the server pays coins for it (rate limited)
		net.requestSave("boss");
	}
	// MP-13 / MP-20: THIS life's day (`save.day`, moved by server/sim/progress.ts), never the world's
	const day = save.day;
	if (day > lastDay) {
		lastDay = day;
		net.requestSave("day");
	}
	if (save.level > lastLevel) {
		if (lastLevel > 0) hud.showMessage("Level UP");
		lastLevel = save.level;
	}
}

// ---------------------------------------------------------------- screens

function clearScreen(): void {
	if (cleanup !== undefined) {
		cleanup();
		cleanup = undefined;
	}
}

function closePause(): void {
	if (pauseCleanup !== undefined) {
		pauseCleanup();
		pauseCleanup = undefined;
	}
}

/** takes the MP-21 wait off the screen (it came back, or the player left before it ended) */
function closeDawnWait(): void {
	if (dawnWait === undefined) return;
	dawnWait.close();
	dawnWait = undefined;
	dawnOverdue = 0;
}

/**
 * Stops the frame loop and hides the in-game UI; the run itself stays in `loop`. `keepBody`: the survivor stays in
 * the world (MP-22's rebuild around a new town, which remounts at once), so the body and the slot are not given back.
 */
function stopGame(keepBody = false): void {
	if (heartbeat !== undefined) {
		heartbeat.Disconnect();
		heartbeat = undefined;
		// leaving the game screen: no world sprites / night overlay behind the menus
		loop.hideWorld();
		// ...and nothing from the run keeps playing behind them either
		gameAudio.stopRun();
	}
	// leaving the run: give the body and the slot back instead of standing in the street from the menus
	if (!keepBody) netLeaveWorld();
	hud.unmount();
	detachRun();
	pack.close();
	closePause();
	closeDawnWait();
	danger.reset();
	deathShown = false;
}

function lobbyStatus(): LobbyStatus {
	const hosted = serverRevives() && netHosted();
	// what START leads to (DESIGN_RULES UI-10): the very tests startRun makes, read without acting on them
	let run: RunState = runActive && !loop.getRefs().player.dead ? "suspended" : "fresh";
	if (ctx.save.runOver) run = newLifeWaiting && hosted ? "newLife" : "over";
	return {
		loading: loadInfo === undefined && !net.netUnavailable(),
		run,
		hosted,
		clockDriven: loop.getRefs().daynight.serverDriven(),
		seed: netTownSeed(),
		fellOn: lobbyNav.fellOn,
		offlineNote: offlineNote(),
	};
}

/**
 * A menu screen in place of the one on screen (DESIGN_RULES UI-10): see-through, over the town flyover that stays
 * pinned behind every menu -- the very glide the lobby showed, never restarted -- until a run mounts and releases it.
 */
function menuScreen(phase: GamePhase): void {
	clearScreen();
	setPhase(phase);
	Flyover.pinFlyover(ctx.backdropLayer, netTownSeed());
}

/** `back` is where the shop's Back button goes: the lobby by default, or the suspended run when opened from the menu. */
function openShop(back: () => void = goLobby): void {
	menuScreen("shop");
	// the shop's "Wardrobe" is a door: its X comes back to this shop, whose Back still goes where it went before
	cleanup = showShop(ctx, back, () => openWardrobe(() => openShop(back)));
}

/** MON-04: outfits and pets, tried on, bought (by the server) and worn -- from the lobby or from the shop */
function openWardrobe(back: () => void, slot?: number): void {
	menuScreen("shop");
	cleanup = showWardrobe(ctx, { onBack: back, onEquip: equipItem, onUnequip: unequipSlot, slot });
}

function openSettings(): void {
	menuScreen("settings");
	cleanup = showSettings(ctx, goLobby, openCredits);
}

function openCredits(): void {
	menuScreen("credits");
	cleanup = showCredits(ctx, goLobby);
}

/**
 * Settings from the in-run menu (DESIGN_RULES UI-06): OVER the running match, like the menu it came from -- the street
 * keeps moving behind its see-through scrim, the survivor stands held, the red flash warns of a hit -- and its X goes
 * back to that menu. It used to leave the world and draw an opaque page (and its X dropped the player in the lobby).
 * No credits row there: that page is text straight on the screen, which a bright street would wash out.
 * The HUD reads its size when it mounts, so a HUD size changed here remounts it on the way out: a setting applies
 * when it is changed, not at the next run.
 */
function settingsOverRun(): void {
	closePause();
	const hudSize = ctx.save.settings.uiSize;
	const close = showSettings(
		ctx,
		() => {
			closePause();
			openPause();
		},
		undefined,
		true,
	);
	pauseCleanup = () => {
		close();
		if (ctx.save.settings.uiSize === hudSize || heartbeat === undefined) return;
		hud.unmount();
		hud.mount();
	};
}

function openTutorial(thenPlay: boolean): void {
	menuScreen("tutorial");
	cleanup = showTutorial(ctx, () => {
		net.requestSave("menu");
		// back to the lobby first, so a "still loading" prompt has a screen behind it: the Survivor screen, when the
		// tutorial was the first-run prompt's answer on the way into the city
		goLobby(thenPlay ? "survivor" : "menu");
		if (thenPlay) playPressed();
	});
}

/** the lobby (DESIGN_RULES UI-10) on `page`: the title screen, or the Survivor screen the city is entered from */
function goLobby(page: LobbyPage = "menu"): void {
	clearScreen();
	stopGame();
	const late = pendingLoad;
	if (late !== undefined) {
		pendingLoad = undefined;
		applyLoad(late);
	}
	setPhase("lobby");
	net.requestSave("lobby");
	const handle = showLobby(
		ctx,
		{
			onPlay: playPressed,
			onRebirth: doRebirth,
			// MP-21's free way out: this same life, dead in the city until 06:00, when the server stands it up
			onWaitDawn: () => {
				if (actionBusy || !ctx.save.runOver) return;
				dawnChosen = true;
				enterToWait();
			},
			onNewRun: doNewRun,
			onShop: () => openShop(),
			// the wardrobe's X comes back to the page it was opened from; the Survivor screen's OUTFIT / PET tile opens it
			// on that slot's tab
			onWardrobe: (from: LobbyPage, slot?: number) => openWardrobe(() => goLobby(from), slot),
			onSettings: openSettings,
			onCredits: openCredits,
			onTutorial: (thenPlay?: boolean) => openTutorial(thenPlay === true),
			onPage: (p: LobbyPage) => {
				lobbyNav.page = p;
			},
		},
		lobbyStatus(),
		page,
	);
	lobbyNav.handle = handle;
	lobbyNav.page = page;
	Boot.warmLobby(handle);
	cleanup = (): void => {
		if (lobbyNav.handle === handle) lobbyNav.handle = undefined;
		handle.close();
	};
	const notice = pendingNotice;
	if (notice !== undefined) {
		pendingNotice = undefined;
		showLoadNotice(notice);
	}
}

// ---------------------------------------------------------------- run lifecycle

/**
 * The packs bought in the shop and not opened yet go into the backpack. From WORLD_SERVER_PHASE the SERVER opens them
 * into its own save as soon as the survivor is in the world (server/sim/backpack.ts `deliverPacks`) and the items
 * come back in the bag: this client only says so, and stops asking again.
 */
function deliverPacks(): void {
	const save = ctx.save;
	const serverDelivers = Bag.owned();
	const names: Array<string> = [];
	for (const p of SHOP_PACKS) {
		const n = pendingPacks(save, p.id);
		if (n <= 0) continue;
		for (const item of p.items) {
			if (item.index >= 0 && !serverDelivers) addItem(save, item.kind, item.index, item.count * n);
		}
		save.packsOpened[p.id] = save.packsBought[p.id];
		names.push(n > 1 ? `${tr(p.name)} ×${n}` : tr(p.name));
	}
	if (names.size() > 0) {
		toast(ctx, `${tr("Delivered")}: ${names.join(", ")}`, "success");
		if (!serverDelivers) net.requestSave("packs");
	}
}

function refreshDeskFlags(): void {
	const refs = loop.getRefs();
	const pro = stationNear(refs, "pro") !== undefined;
	pack.nearbyPro = pro;
	pack.nearbyDesk = pro || stationNear(refs, "desk") !== undefined;
	pack.nearbyFire = stationNear(refs, "fire") !== undefined;
	pack.nearbyCook = stationNear(refs, "cook") !== undefined;
}

function toggleBackpack(): void {
	if (ctx.phase !== "playing" || pauseCleanup !== undefined) return;
	if (pack.isOpen()) {
		pack.close();
	} else {
		refreshDeskFlags();
		pack.open();
	}
}

function pushHud(): void {
	const refs = loop.getRefs();
	const p = refs.player;
	const save = ctx.save;
	const w = currentWeapon(p);
	const rt = p.weapon;
	// reload progress: combat publishes reloadTotal; fall back to the largest count seen
	let total = rt.reloadTotal ?? 0;
	if (rt.reloading) {
		if (rt.reloadCount > reloadSeen + 1e-4) reloadMax = rt.reloadCount;
		reloadSeen = rt.reloadCount;
		if (total <= 0) total = reloadMax;
	} else {
		reloadSeen = 0;
		reloadMax = 0;
	}
	const reloadRatio = rt.reloading && total > 0 ? 1 - math.clamp(rt.reloadCount / total, 0, 1) : 0;
	const dn = refs.daynight;
	const hand = save.equipHand >= 0 ? EQUIPS[save.equipHand] : undefined;
	const showClock =
		hand !== undefined &&
		(hand.name === "Watch" || hand.name === "Digital Watch" || (hand.name === "Sundial" && !dn.isNight));
	hud.update({
		hp: p.hp,
		hpMax: p.hpMax,
		hunger: p.hungry,
		hungerMax: p.hungryMax,
		level: save.level,
		exp: save.exp,
		expMax: expMaxInit(save.level),
		// MP-13's two numbers: the town's day (shared, from the server's clock) and this life's (personal,
		// back to 1 after a "New game"). The HUD decides for itself when the second one is worth printing.
		day: dn.day,
		lifeDay: save.day,
		dayTime: dn.dayTime,
		isNight: dn.isNight,
		showClock,
		// the hotbar's blue tile (the blade for a hand that chose nothing, -1); the tiles themselves are the list keys 1-5
		// pick from (shared/game/weaponSlots.ts) -- and none while the weapon is put away (ITM-06)
		weaponId: w.id,
		holstered: p.holstered === true,
		weaponName: tr(w.name),
		mag: rt.ammoCount,
		magSize: w.mag,
		reloading: rt.reloading,
		reloadRatio,
		ammoPool: weaponReserve(save, w),
		hitFlash: p.hitFlash ?? 0,
		// VIT-01: the wait before healing, for the vitals' cue (the HP glow, the fork on FOOD)
		sinceHurt: p.sinceHurt,
	});
	// the compass or the GPS in hand (E2): the needle to the camp, or the map of the streets around you
	hud.updateNav(refs.world, p.x, p.y, save);
	// no "E: ..." prompt for a survivor who cannot act: a screen over the run, or dead (UI-06: the loop, and this,
	// now run behind the MP-21 wait for daybreak too)
	const held = pack.isOpen() || pauseCleanup !== undefined || dawnWait !== undefined || p.dead;
	hud.setInteractHint(held ? undefined : interactHint(refs));
}

function warnNoAmmo(): void {
	const refs = loop.getRefs();
	const p = refs.player;
	const w = currentWeapon(p);
	const input = ctx.input;
	// (ITM-06) a weapon put away fires nothing, so it has nothing to be out of
	if (w.mag <= 0 || p.weapon.reloading || p.holstered === true) return;
	if (!input.reloadPressed && !(input.attackPressed && p.weapon.ammoCount <= 0)) return;
	if (weaponReserve(ctx.save, w) > 0) return;
	if (input.reloadPressed && p.weapon.ammoCount >= w.mag) return;
	const now = os.clock();
	if (now - lastNoAmmo < NO_AMMO_COOLDOWN) return;
	lastNoAmmo = now;
	hud.showMessage("No ammo");
	gameAudio.emptyMagazine(refs);
}

function openPause(): void {
	if (pauseCleanup !== undefined) return;
	pack.close();
	pauseCleanup = showPause(
		ctx,
		0,
		{
			onResume: closePause,
			onSave: () => {
				if (net.requestSave("manual")) toast(ctx, tr("Saving..."));
				else toast(ctx, offlineNote() ?? tr("Could not save"), "error");
			},
			onHome: goLobby,
			onShop: () => {
				stopGame();
				net.requestSave("lobby");
				// opened from the menu: Back should return to the suspended run, not drop to the lobby
				openShop(() => {
					resumeRun();
					openPause();
				});
			},
			onSettings: settingsOverRun,
		},
		{ note: offlineNote() },
	);
}

function openDeath(): void {
	deathShown = true;
	pack.close();
	closePause();
	// a wait already on screen is being opened again for the new life a New game chose: the same night
	const counting = dawnWait !== undefined;
	closeDawnWait();
	ctx.save.runOver = true;
	net.requestSave("death");
	const summary = newLifeWaiting && endedLife !== undefined ? endedLife : runSummary(ctx, ctx.save.deathCount <= 1);
	// `serverDriven` is the one honest test for "somebody out there will stand me back up": the hour on this
	// screen comes from the server's clock, which is the same server that runs the revive. Without it (a
	// session that never completed its handshake) the wait would only end when the grace timer below gave up
	// on it, and MP-21's short wait would read as a hang. A new life the server just granted (New game) needs
	// no such proof: the server that accepted it is the one that holds the body.
	if (serverRevives() && (loop.getRefs().daynight.serverDriven() || newLifeWaiting || dawnChosen)) {
		/*
		 * MP-21: a death is a night lost, not a run ended, on every server kind. The survivor watches the town
		 * carry on and the server puts them back on the street at 06:00 (server/sim/life.ts) — or right now, for
		 * coins (Rebirth), or in a new town if nobody is left standing (MP-22). "New game" starts a new life,
		 * which still waits for daybreak; the per-frame half of this lives in `updateDawnWait`.
		 */
		if (!counting) dawnBudget = daybreakWaitSeconds(loop.getRefs().daynight.dayTime);
		dawnOverdue = 0;
		dawnWait = showDaybreakWait(
			ctx,
			summary,
			{ onRebirth: doRebirth, onNewRun: newLifeWaiting ? undefined : doNewRun, onHome: goLobby },
			newLifeWaiting,
		);
		return;
	}
	// what the player KEEPS comes before what a new run costs (client/onboarding/gameOver.ts)
	pauseCleanup = showRunSummary(ctx, summary, {
		onRebirth: doRebirth,
		onNewRun: doNewRun,
		onHome: goLobby,
	});
}

/**
 * MP-21: into the world with a body the server holds DEAD — a New game's new life, waiting for daybreak. The survivor
 * is dead from the very first frame and the wait opens at once: never a living survivor drawn first and struck down
 * by the next PlayerLife (the owner's playtest: "spawns and dies at the same instant, every click"). The welcome says
 * the truth either way (server/net/replication.ts tells a newcomer its own state): if daybreak came while this
 * client was in the lobby, or a world ended and gave it a new life (MP-22), that is an Up, and the wait closes.
 */
function enterToWait(): void {
	runActive = false;
	newWorld();
	const p = loop.getRefs().player;
	p.dead = true;
	p.hp = 0;
	setPhase("dead");
}

/**
 * One frame of the MP-21 wait: refresh the countdown, and take the screen away the moment the server has put
 * this survivor back on their feet — `refs.player.dead` is written by the reliable PlayerLife delta (§4.5,
 * §7.1), so it is the server's answer and not a guess made here.
 *
 * The grace timer is the escape hatch: if 06:00 goes by and no revive arrives because there is no session left to
 * send one (a server not running the MP host, a slot lost in between), the ordinary end-of-run choice comes back.
 * A screen that can only ever be left by the server is a screen that can strand a player — but a live session
 * WILL answer, and giving up on it early is what put a stale "New game" in front of the owner (DAYBREAK_GRACE_S).
 */
function updateDawnWait(dt: number): void {
	const wait = dawnWait;
	if (wait === undefined) return;
	const refs = loop.getRefs();
	if (!refs.player.dead) {
		closeDawnWait();
		deathShown = false;
		newLifeWaiting = false;
		dawnChosen = false;
		endedLife = undefined;
		// the wait WAS the price: the run continues, so the save has to stop saying it is over
		ctx.save.runOver = false;
		net.requestSave("death");
		setPhase("playing");
		hud.showMessage("Back on your feet");
		return;
	}
	// two clocks, and the tighter one wins: `secondsUntilDayBreak` is read straight off the world clock, so
	// at night the count on screen IS the night ticking away and stays right through a resync; `dawnBudget`
	// is the same capped wait the server armed, and it is what answers a death in broad daylight.
	dawnBudget = math.max(0, dawnBudget - math.max(0, dt));
	const left = math.min(refs.daynight.secondsUntilDayBreak(), dawnBudget);
	wait.setRemaining(left);
	if (left > 0) {
		dawnOverdue = 0;
		return;
	}
	dawnOverdue += math.max(0, dt);
	if (dawnOverdue < DAYBREAK_GRACE_S) return;
	// the session is live: the server's answer (daybreak, or a new world) is on its way, late clock or not
	if (netActive()) return;
	closeDawnWait();
	warn("[PZ] daybreak passed without a revive and the session is gone; falling back to the end-of-run choice");
	pauseCleanup = showRunSummary(ctx, runSummary(ctx, ctx.save.deathCount <= 1), {
		onRebirth: doRebirth,
		onNewRun: newLifeWaiting ? undefined : doNewRun,
		onHome: goLobby,
	});
}

/**
 * Starts the frame loop and in-game UI for the run held by `loop`. `enterWorld` false: the survivor never left it
 * (MP-22's rebuild around a new town), so no body is asked for.
 */
function mountRun(enterWorld = true): void {
	// the menus' town flyover (UI-10) goes with them: every Frame of it, not only hidden (the run draws its own town)
	Flyover.releaseFlyover();
	setPhase("playing");
	hud.onPause = () => {
		if (pauseCleanup === undefined && ctx.phase === "playing") openPause();
	};
	hud.onBackpack = toggleBackpack;
	hud.onAction = () => {
		ctx.input.actionPressed = true;
	};
	hud.mount();
	deathShown = false;
	saveTimer = 0;
	// F1: a run is the only reason to have a body in the world -- ask for one now, not at connect time
	if (enterWorld) netEnterWorld();
	gameAudio.startRun(loop.getRefs());
	// onboarding: the coach (first run only) and the aim-assist targets live as long as the run does
	attachRun(ctx, loop.getRefs());
	// only a run's frame clears the one-shot presses (GameLoop.update -> beginFrame): a P, B, Start or LB pressed in the
	// menus was still pending here, and the first frame opened the Menu or the Bag on entering the city
	ctx.input.beginFrame();
	heartbeat = RunService.Heartbeat.Connect(dt => {
		const input = ctx.input;
		if (input.backpackPressed) toggleBackpack();
		// the pad's Back / Select: the match scoreboard (MP-23; Q held and the HUD's chip are the HUD's own). While it is
		// up the D-pad sorts it (scoreboard.ts), so it switches no weapon (ITM-06: the D-pad cycles them otherwise)
		if (input.scoreboardPressed) hud.toggleScoreboard();
		if (hud.scoreboard()?.isOpen() === true) input.weaponCycle = 0;
		if (input.pausePressed && ctx.phase === "playing") {
			if (pauseCleanup === undefined) openPause();
			else closePause();
		}
		// DESIGN_RULES UI-06: NO screen pauses the world -- not the Bag, not the menu, not the end-of-run
		// screens, and not in solo either, so the rule is one. The town is the server's and shared: a client
		// that stopped stepping here only drew a still photograph of a street that kept moving (a playtest
		// lost 65 HP behind a Bag that "paused"). What a screen stops is the SURVIVOR: held, they stand still
		// with empty hands (InputState.setHeld), while the horde, the allies, the clock and the damage go on --
		// and the flash below says so the moment a hit lands.
		const refs = loop.getRefs();
		const alive = !refs.player.dead;
		const menuOpen = pauseCleanup !== undefined || pack.isOpen() || dawnWait !== undefined;
		input.setHeld(menuOpen || !alive);
		if (alive) {
			warnNoAmmo();
			trackBefore();
		}
		admin?.beforeUpdate(dt);
		gameAudio.beforeUpdate(refs);
		// MicroProfiler labels (docs/research/performance.md): pz.update holds pz.net and pz.mirror, pz.render pz.world
		// and pz.light (client/gameLoop.ts)
		debug.profilebegin("pz.update");
		loop.update(dt);
		debug.profileend();
		if (alive) trackAfter();
		gameAudio.afterUpdate(refs, dt);
		admin?.afterUpdate(dt);
		// the run's autosave -- but not from behind the owner's own end-of-run screen, which has already saved
		// the death and waits for Rebirth or New game (the MP-21 wait for daybreak IS a run still going)
		if (ctx.phase === "playing" || dawnWait !== undefined) {
			saveTimer += dt;
			if (saveTimer >= AUTOSAVE_SEC) {
				saveTimer = 0;
				net.requestSave("auto");
			}
		}
		danger.frame(dt, menuOpen && !refs.player.dead, refs.player.hp);
		// the listener follows the camera, and whatever is still queued in refs.fx is played before
		// GameLoop.render() consumes (and clears) it — so no cosmetic event is ever heard twice
		gameAudio.frame(refs, ctx.cam.x, ctx.cam.y);
		debug.profilebegin("pz.render");
		loop.render();
		debug.profileend();
		admin?.afterRender(dt);
		debug.profilebegin("pz.hud");
		pushHud();
		debug.profileend();
		if (ctx.phase === "dead" && !deathShown) openDeath();
		updateDawnWait(dt);
	});
	// idle time: the Bag is built out of sight, so the first B press mid-fight builds nothing (client/boot/warmup.ts)
	Boot.warmRun(pack, () => heartbeat !== undefined);
}

/** a fresh map for the current save (new game, or a run that was not kept in memory) */
function newWorld(): void {
	clearScreen();
	stopGame();
	deliverPacks();
	buildRun();
	mountRun();
}

/** `loop` builds the server's town around the current save, and the run's trackers start from it */
function buildRun(): void {
	loop.init(ctx.save);
	runActive = true;
	const refs = loop.getRefs();
	refs.onMessage = msg => {
		hud.showMessage(msg);
		// the clock announcements (waves at 19h/22h/1h, dawn at 7h) also carry the stingers
		gameAudio.onMessage(msg);
	};
	// MP-13: the counter a run is measured by is the survivor's own day, not the town's. Seeding this from
	// the world's day would fire "a new day survived" on the first frame for anyone joining an old server.
	lastDay = ctx.save.day;
	lastLevel = ctx.save.level;
}

/** MP-22: "The town fell on day N. A new town rises: day 1." */
function townFellText(day: number): string {
	return `${tr("The town fell on day")} ${fmtInt(day)}. ${tr("A new town rises: day 1")}`;
}

/**
 * MP-22: what the server says about its town (client/net/netClient.ts `netOnTown`) — the InitBegin of every entry,
 * and the WorldReset of a world that ended because nobody was left alive in it.
 *
 * It runs INSIDE the World event, ahead of the rest of its batch: the day-1 Clock and the PlayerLife that the server
 * sends right behind a WorldReset must land on the rebuilt town, not be wiped by the rebuild (`netReset`).
 *
 *   - a new life (this survivor fell with the old world): the same reset the server made, as New game mirrors it —
 *     life day 1 and the starter kit, level, skills, coins and packs kept (MP-20) — and `runRev` moves on with it,
 *     so a report of the old life's backpack is refused as outdated;
 *   - in the menus: the run in memory stood in the old town, so the next Play builds the new one;
 *   - in the street: the run is rebuilt in place around the new town WITHOUT leaving the world — the server has
 *     already put this survivor's new body there — exactly as `newWorld` builds one, minus Leave/Enter. The same
 *     rebuild answers an InitBegin whose town is not the one this client built (it guessed before entering).
 */
function onTown(notice: TownNotice): void {
	const fellOn = notice.endedDay;
	if (fellOn !== undefined) {
		worldResets += 1;
		lobbyNav.fellOn = fellOn;
	}
	if (fellOn !== undefined && notice.newLife) {
		// THIS survivor's new life ends whatever it was waiting for; a reset that named somebody else ends nothing of
		// ours — a new life the server still owes us arrives with our own save (review of f851ad2, L4)
		newLifeWaiting = false;
		dawnChosen = false;
		endedLife = undefined;
		resetRun(ctx.save);
		// the runRev the SERVER wrote, never ours + 1: a wallet that already carried it (a report answered in the
		// same instant) would have made that one too many, and every report after it "outdated" for the rest of
		// the session (review B2). Monotonic like applyWallet, so a wallet from after the reset is not undone
		const rev = notice.runRev;
		if (rev !== undefined) ctx.save.runRev = math.max(ctx.save.runRev, rev);
		// a "Your run is over" still open in the lobby is about a death that is over
		for (const child of ctx.uiLayer.GetChildren()) {
			if (child.Name === "PopupOverlay") child.Destroy();
		}
	}
	if (heartbeat === undefined) {
		if (fellOn === undefined) return;
		runActive = false;
		if (ctx.phase !== "boot") toast(ctx, townFellText(fellOn));
		// the lobby on screen shows the new town (its flyover, its day) and the new life, not a death that is over
		lobbyNav.handle?.refresh(lobbyStatus());
		return;
	}
	// the everyday case: the InitBegin of an entry confirms the town this client already built
	if (fellOn === undefined && notice.seed === loop.townSeed) return;
	// a death this notice does not end stays a death — a survivor who entered to wait, whose town had to be built
	// again; one not given a new life (never the case for a survivor in the world at a wipe). The PlayerLife that
	// follows settles it either way; a rebuilt survivor must not stand in between
	const keepDead = loop.getRefs().player.dead && !(fellOn !== undefined && notice.newLife);
	clearScreen();
	stopGame(true);
	deliverPacks();
	buildRun();
	mountRun(false);
	if (keepDead) {
		const p = loop.getRefs().player;
		p.dead = true;
		p.hp = 0;
		setPhase("dead");
	}
	if (fellOn !== undefined) hud.showMessage(townFellText(fellOn));
}

netOnTown(onTown);
// MON-05: "Title unlocked: [Survivor]" the moment the server grants one; CON-04: "Achievement unlocked" the moment
// the server's counter reaches its goal
startTitleNotices(ctx);
startAchievementNotices(ctx);

function resumeRun(): void {
	clearScreen();
	stopGame();
	deliverPacks();
	mountRun();
}

/** brings the dead player of the run in memory back (or a fresh map at the same day) */
function revive(): void {
	ctx.save.runOver = false;
	newLifeWaiting = false;
	dawnChosen = false;
	endedLife = undefined;
	if (!runActive) {
		newWorld();
		return;
	}
	const refs = loop.getRefs();
	refs.player.hp = refs.player.hpMax;
	refs.player.hungry = refs.player.hungryMax;
	refs.player.dead = false;
	refs.zombies.clear();
	refs.bosses.clear();
	closePause();
	closeDawnWait();
	deathShown = false;
	if (heartbeat === undefined) {
		resumeRun();
	} else {
		setPhase("playing");
	}
	hud.showMessage("Rebirth");
	net.requestSave("death");
}

/**
 * A run action (Rebirth / New game) that names the run it acts on, with ONE automatic retry when the server
 * answers "outdated". YIELDS, like `invokeShopAction` does.
 *
 * "outdated" means `req.runRev !== save.runRev` (server/main.server.ts, `handleAction`): this client asked
 * about a run the session has already moved past. That happens without anybody cheating — an admin edit
 * bumps `runRev` on the session and the patch is DEFERRED on a client that is mid-run (client/admin/
 * patches.ts), and a wallet can land on a save object that was swapped while the call was in flight. The
 * refusal itself carries the server's wallet, and `applyWallet` has already corrected `ctx.save.runRev` by
 * the time the call returns — so the request the player would send by clicking a second time is exactly the
 * one sent here, for them. That second click WAS the bug: "New game" appeared to do nothing, said "Please
 * try again", and worked when pressed again.
 *
 * Retrying is safe precisely because the server refused: "outdated" is decided before anything is charged or
 * reset, so the first attempt had no effect at all. It is tried once, and only when the runRev really did
 * move, so a genuine disagreement can never turn into a loop.
 */
function invokeRunAction(kind: "rebirth" | "newRun"): ShopActionResult {
	const request = (runRev: number): ShopActionRequest =>
		kind === "rebirth" ? { kind: "rebirth", runRev } : { kind: "newRun", runRev };
	const asked = ctx.save.runRev;
	const first = net.invokeShopAction(request(asked));
	if (first.ok || first.reason !== "outdated") return first;
	const fresh = ctx.save.runRev;
	if (fresh === asked) return first; // the refusal taught us nothing: do not ask the same question twice
	return net.invokeShopAction(request(fresh));
}

function doRebirth(): void {
	if (actionBusy || !ctx.save.runOver) return; // a stale dialog: there is no game over to continue
	// MP-21 (owner's rule, 23 Sep 2026): a paid Rebirth is legal on every server kind; the server checks the death
	// the Rebirth button stays clickable even when it's styled as "can't afford" (destructive) -
	// check locally first so the player gets an exact, instant reason instead of just nothing happening
	const price = rebirthPrice(ctx.save.deathCount);
	if (ctx.save.money < price) {
		toast(ctx, `${tr("Not enough coins")}: ${fmtInt(price - ctx.save.money)} ${tr("more needed")}`, "error");
		return;
	}
	if (!net.sessionReady()) {
		// the save shown is the offline fallback: a rebirth would charge the real save
		toast(ctx, tr("Still loading your progress"), "error");
		return;
	}
	const target = ctx.save;
	const resets = worldResets;
	actionBusy = true;
	const res = invokeRunAction("rebirth");
	actionBusy = false;
	if (ctx.save !== target) return; // the save was replaced while waiting
	// MP-22: a world ended while we asked; its new life (already mirrored by `onTown`) is the answer (review L2)
	if (worldResets !== resets) return;
	if (!res.ok) {
		if (!aliveAfterAll(res)) toast(ctx, actionErrorText(res.reason, ctx.save.settings.langType), "error");
		return;
	}
	revive();
}

/**
 * A Rebirth or a New game refused as "invalid": for those two that means the server holds this survivor ALIVE
 * (server/sim/life.ts `runActionRefusal`) — a daybreak, a new world, or a new life a world owed them got there first.
 * The client believes it rather than strand the player on a death that is over (review of f851ad2, L1): the run is on
 * again. Returns true when that is what happened, so the caller has no error to show.
 */
function aliveAfterAll(res: ShopActionResult): boolean {
	if (res.ok || res.reason !== "invalid" || !serverRevives()) return false;
	ctx.save.runOver = false;
	newLifeWaiting = false;
	endedLife = undefined;
	closeDawnWait();
	closePause();
	for (const child of ctx.uiLayer.GetChildren()) {
		if (child.Name === "PopupOverlay") child.Destroy();
	}
	if (heartbeat !== undefined) {
		loop.getRefs().player.dead = false;
		deathShown = false;
		setPhase("playing");
	}
	toast(ctx, tr("Back on your feet"), "success");
	return true;
}

/**
 * New game: a new LIFE (MP-20) — day 1 and the starter kit; level, skills, coins and packs kept.
 *
 * Where the server owns the death (MP-21, `hosted`), that life is NOT a new body: the server keeps it dead until
 * daybreak, a Rebirth, or the end of the world (MP-22: if nobody is left standing, the world ends and everybody
 * wakes in a new town — solo, a New game is exactly that, at once, since the only survivor just declined to pay).
 * So the client stays on the wait, now for the new life, and never draws a living survivor. It used to run
 * `newWorld()` — a fresh, standing survivor that the next PlayerLife struck down: the owner's "spawns and dies at the
 * same instant, every click" (playtest of 23 Sep 2026). Offline the client owns its death and nothing waits.
 */
function doNewRun(): void {
	if (actionBusy || !ctx.save.runOver) return; // a stale dialog: the run is not over
	const target = ctx.save;
	const resets = worldResets;
	const hosted = serverRevives() && netHosted();
	if (net.savingEnabled() || hosted) {
		actionBusy = true;
		const res = invokeRunAction("newRun");
		actionBusy = false;
		if (ctx.save !== target) return;
		// MP-22: a world ended while we asked, and the new life it gave (already mirrored by `onTown`) replaces this
		if (worldResets !== resets) return;
		if (!res.ok) {
			if (!aliveAfterAll(res)) toast(ctx, actionErrorText(res.reason, ctx.save.settings.langType), "error");
			return;
		}
	}
	if (hosted) endedLife = runSummary(ctx, ctx.save.deathCount <= 1);
	// same reset as the server (offline: local only, nothing is saved anyway)
	resetRun(ctx.save);
	if (hosted) {
		// the server's save says the same (server/sim/life.ts `newLife`): the death stands until daybreak
		ctx.save.runOver = true;
		newLifeWaiting = true;
		dawnChosen = false;
		if (heartbeat !== undefined) openDeath();
		else enterToWait();
		return;
	}
	runActive = false;
	newWorld();
}

function startRun(): void {
	if (ctx.save.runOver) {
		// a new life already chosen, waiting for daybreak (MP-21): the city goes back to that wait, not to a choice
		// that was already made. Otherwise the choice itself -- Rebirth or New game -- lives on the Survivor screen
		// (DESIGN_RULES UI-10), in place, never as a popup over the lobby
		if (newLifeWaiting && serverRevives() && netHosted()) enterToWait();
		else goLobby("survivor");
		return;
	}
	// a living body enters: a free wait chosen earlier was answered (the server stood it up while in the lobby)
	dawnChosen = false;
	if (runActive && !loop.getRefs().player.dead) resumeRun();
	else newWorld();
}

function playPressed(): void {
	if (loadInfo === undefined && !net.netUnavailable()) {
		popup(ctx, tr("Still loading your progress"), tr("Play without saving") + "?", [
			{ text: tr("Back"), style: "secondary" },
			{ text: tr("Play without saving"), onClick: startRun },
		]);
		return;
	}
	startRun();
}

// ---------------------------------------------------------------- backpack actions

// From WORLD_SERVER_PHASE each verb below is the server's (client/net/backpackSync.ts): predicted here at once by the
// server's own rule, sent as an intent, and reconciled with the bag the server sends back (QA sweep NET-1..4).
pack.onUse = id => {
	if ((ctx.save.invenUse[id] ?? 0) <= 0) return;
	if (Bag.useItem(loop.getRefs().player, ctx.save, id)) return;
	// eight verbs still in flight: the click waits for their answers, and "already full" would be a lie
	if (Bag.busy()) return;
	// a use is only refused for a held, known item when it would do nothing (hp/hunger already
	// maxed, no buff, no poison cure) — pick the wording that matches what the item targets.
	const u = USABLES[id];
	if (u !== undefined && u.hunger > 0) toast(ctx, tr("You're already full"), "error");
	else if (u !== undefined && u.hp > 0) toast(ctx, tr("Already at full health"), "error");
	else toast(ctx, tr("You can't use that now"), "error");
};

pack.onCraft = id => {
	// a refused recipe answers with a message (and the UI's error toast): only a real craft is heard
	const refs = loop.getRefs();
	if (!craft(refs, id)) return;
	gameAudio.crafted();
	// the recipe ate the weapon in hand (a pistol into an auto pistol): the blade comes back to the hands, and the
	// magazine back to its pool -- the same rule as an admin patch that takes the weapon away (admin/patches.ts)
	if (!ownsWeapon(ctx.save, refs.player.weapon.pointer)) chooseWeapon(refs, 0);
};

pack.craftCheck = id => {
	const r = CRAFT_RECIPES[id];
	return r === undefined ? "Unknown recipe" : craftBlocker(loop.getRefs(), r);
};

pack.onEquipWeapon = id => {
	if (!ownsWeapon(ctx.save, id)) return;
	// ITM-06: the weapon in hand, chosen again, is put away or drawn back (combat.ts `chooseWeapon`)
	chooseWeapon(loop.getRefs(), id);
};
pack.weaponAway = () => loop.getRefs().player.holstered === true;

// 1 cloth, 2 hand, 3 gun, 4 outfit, 5 pet (EquipSlot). An outfit or a pet is what OTHER people see (MON-04), so
// changing one asks for a report now: the server re-checks ownership and replicates the look (PlayerProfile)
// within one report window instead of at the next minute's autosave.
function cosmeticChanged(slot: number): void {
	if (slot === EquipSlot.Outfit || slot === EquipSlot.Pet) net.requestSave("equip");
}

/** the Bag's Equip and the wardrobe's (MON-04) are ONE path: owned, into its slot, and reported */
function equipItem(id: number): void {
	if (!ownsEquip(ctx.save, id)) return;
	const slot = equipSlotOf(id);
	if (Bag.equip(ctx.save, id, slot)) cosmeticChanged(slot);
}

function unequipSlot(slot: number): void {
	if (Bag.unequip(ctx.save, slot)) cosmeticChanged(slot);
}

pack.onEquipItem = equipItem;
pack.onUnequipItem = unequipSlot;
pack.onLearned = Bag.learned;

// ---------------------------------------------------------------- boot

function begin(): void {
	if (started) return;
	started = true;
	showLogo(ctx.uiLayer, () => {
		goLobby();
	});
	// the town behind the lobby (UI-10) is generated while the logo holds still (its fades end at 1.25 s, the lobby
	// opens at 1.5 s), not when the lobby opens
	task.delay(1.3, () => Flyover.prewarmTown(netTownSeed()));
}

// audio (src/client/audio): the mixer boots with the client, reads the Settings sliders straight from the
// save (so it follows a LoadAck that swaps `ctx.save`) and hooks the interface by watching the HUD and menu layers.
audio.start();
audio.bindSettings(() => ctx.save.settings);
startUiAudio(ctx);
// the walk cycle only reports the moment a foot lands; until something listens, nothing is heard
onFootstep(playFootstep);
// one ordered preload (client/boot/preloadPlan.ts): the skin and the lobby's town, the signs and characters, the sounds
Boot.startPreload(ids => audio.preloadSounds(ids));

// save patches / announcements for everyone; the admin panel only when the server marks this player as admin
admin = startAdmin({
	ctx,
	loop,
	endRun: () => {
		// an admin reset the save: the run in memory belonged to the old one
		runActive = false;
		goLobby();
	},
});
net.startNet();
// F3: the systems learn who owns the world, and the wallet's bag has somewhere to go (client/net/backpackSync.ts)
Bag.start();
// F1: assina os remotes do host agora, nao no primeiro quadro da partida -- o servidor admite o jogador
// assim que ele entra e ja comeca a mandar snapshot (client/net/netClient.ts: netPrewarm)
netPrewarm();
task.delay(LOAD_FALLBACK_SEC, begin);

print(`[${GAME_NAME}] client ready`);
