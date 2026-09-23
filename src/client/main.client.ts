import { GAME_NAME } from "shared/module";
import { equipSlotOf, expMaxInit, ownsEquip, ownsWeapon, pendingPacks, resetRun, setEquipped } from "shared/game/save";
import { BossState, ZombieState } from "shared/game/entities";
import { currentWeapon, itemUseEffect, weaponReserve } from "shared/game/player";
import { ACHIEVEMENTS } from "shared/data/achievements";
import { CRAFT_RECIPES } from "shared/data/crafts";
import { EQUIPS, EquipSlot } from "shared/data/equips";
import { ETC_ITEMS } from "shared/data/etcItems";
import { WeaponKind } from "shared/data/kinds";
import { langGet } from "shared/data/lang";
import { rebirthPrice, SHOP_PACKS } from "shared/data/shop";
import { USABLES } from "shared/data/usables";
import { MP_PHASE } from "shared/net/mpConfig";
import { ShopActionRequest, ShopActionResult } from "shared/net/net";
import { daybreakWaitSeconds } from "shared/sim/clock";
import { getCtx, setPhase } from "./bootstrap";
import { GameLoop } from "./gameLoop";
import { audio, gameAudio, playFootstep, startUiAudio } from "./audio";
import { onFootstep } from "./view/footsteps";
import { netEnterWorld, netLeaveWorld, netPrewarm } from "./net/netClient";
import { attachRun, DaybreakWait, detachRun, runSummary, showDaybreakWait, showRunSummary } from "./onboarding";
import { craft, craftBlocker, stationNear } from "./systems/craftSystem";
import { switchWeapon } from "./systems/combat";
import { interactHint } from "./systems/interaction";
import { addItem } from "./systems/items";
import * as net from "./systems/saveClient";
import { showLogo } from "./ui/logo";
import { LobbyStatus, showLobby } from "./ui/lobby";
import { actionErrorText, showShop } from "./ui/shop";
import { showWardrobe } from "./ui/wardrobe";
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
 * choice back (MP-21). The revive is a reliable PlayerLife delta decided on the server, so it should be here
 * within a round trip; this only exists so that a server which is NOT going to send one (no MP host, a slot
 * lost in between) leaves the player with a way forward instead of a countdown reading 0:00 for ever.
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

// per-run trackers (achievements, rewards, HUD)
const aliveZombies: Array<ZombieState> = [];
const aliveBosses: Array<BossState> = [];
let lastDay = 0;
let lastLevel = 0;
let lastWood = 0;
let lastNoAmmo = -math.huge;
let reloadSeen = 0;
let reloadMax = 0;

const WOOD_ID = ETC_ITEMS.findIndex(e => e.name === "Wood");

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
	ctx.save = info.save;
	loadInfo = info;
	runActive = false; // a run in memory belonged to the previous (fallback) save
	net.activate(info);
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
	if (ctx.phase !== "boot") goLobby();
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

// ---------------------------------------------------------------- achievements (what this layer can observe)

function raiseAchievement(id: number, value: number): void {
	const def = ACHIEVEMENTS[id];
	if (def === undefined || def.hidden === true) return;
	const cur = ctx.save.achievements[id] ?? 0;
	if (cur >= def.max || value <= cur) return;
	const reached = math.min(def.max, value);
	ctx.save.achievements[id] = reached;
	if (reached >= def.max) toast(ctx, `${tr("Achievement unlocked")}: ${tr(def.title)}`, "success");
}

function addAchievement(id: number, amount: number): void {
	if (amount <= 0) return;
	raiseAchievement(id, (ctx.save.achievements[id] ?? 0) + amount);
}

function trackBefore(): void {
	const refs = loop.getRefs();
	aliveZombies.clear();
	for (const z of refs.zombies) if (z.hp > 0) aliveZombies.push(z);
	aliveBosses.clear();
	for (const b of refs.bosses) if (!b.dead) aliveBosses.push(b);
}

function trackAfter(): void {
	const refs = loop.getRefs();
	const save = ctx.save;
	let kills = 0;
	let special = 0;
	for (const z of aliveZombies) {
		if (z.hp <= 0) {
			kills++;
			if (z.type !== 1) special++;
		}
	}
	if (kills > 0) {
		addAchievement(12, kills);
		addAchievement(13, special);
		const kind = currentWeapon(refs.player).kind;
		if (kind === WeaponKind.Melee) addAchievement(2, kills);
		else if (kind === WeaponKind.Bow) addAchievement(3, kills);
		else if (kind === WeaponKind.Sniper) addAchievement(7, kills);
	}
	for (const b of aliveBosses) {
		if (!b.dead) continue;
		save.bossKills += 1; // lifetime counter: the server pays coins for it (rate limited)
		addAchievement(7 + b.type, 1); // boss types 1..4 → centipede, rafflesia, giant, hedgehog slayer
		net.requestSave("boss");
	}
	// MP-13 / MP-20: these are about THIS life, so they read the survivor's own day (`save.day`, moved by
	// server/sim/progress.ts and mirrored by the client clock) and never the world's. Reading the town's day
	// here would hand "Good day" and "Never die" to anybody who happened to join a server on day 30.
	const day = save.day;
	if (day > lastDay) {
		lastDay = day;
		if (day >= 2) raiseAchievement(15, 1);
		if (save.deathCount === 0) raiseAchievement(17, day - 1);
		net.requestSave("day");
	}
	if (save.level > lastLevel) {
		if (lastLevel > 0) hud.showMessage("Level UP");
		lastLevel = save.level;
	}
	if (WOOD_ID >= 0) {
		const wood = save.invenEtc[WOOD_ID] ?? 0;
		if (wood > lastWood) addAchievement(14, wood - lastWood);
		lastWood = wood;
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

/** stops the frame loop and hides the in-game UI; the run itself stays in `loop` */
function stopGame(): void {
	if (heartbeat !== undefined) {
		heartbeat.Disconnect();
		heartbeat = undefined;
		// leaving the game screen: no world sprites / night overlay behind the menus
		loop.hideWorld();
		// ...and nothing from the run keeps playing behind them either
		gameAudio.stopRun();
	}
	// leaving the run: give the body and the slot back instead of standing in the street from the menus
	netLeaveWorld();
	hud.unmount();
	detachRun();
	pack.close();
	closePause();
	closeDawnWait();
	danger.reset();
	deathShown = false;
}

function lobbyStatus(): LobbyStatus {
	return {
		loading: loadInfo === undefined && !net.netUnavailable(),
		suspended: runActive && !loop.getRefs().player.dead,
		offlineNote: offlineNote(),
	};
}

/** `back` is where the shop's Back button goes: the lobby by default, or the suspended run when opened from the menu. */
function openShop(back: () => void = goLobby): void {
	clearScreen();
	setPhase("shop");
	// the shop's "Wardrobe" is a door: its X comes back to this shop, whose Back still goes where it went before
	cleanup = showShop(ctx, back, () => openWardrobe(() => openShop(back)));
}

/** MON-04: outfits and pets, tried on, bought (by the server) and worn -- from the lobby or from the shop */
function openWardrobe(back: () => void): void {
	clearScreen();
	setPhase("shop");
	cleanup = showWardrobe(ctx, { onBack: back, onEquip: equipItem, onUnequip: unequipSlot });
}

function openSettings(): void {
	clearScreen();
	setPhase("settings");
	cleanup = showSettings(ctx, goLobby, () => {
		clearScreen();
		setPhase("credits");
		cleanup = showCredits(ctx, goLobby);
	});
}

function openCredits(): void {
	clearScreen();
	setPhase("credits");
	cleanup = showCredits(ctx, goLobby);
}

function openTutorial(thenPlay: boolean): void {
	clearScreen();
	setPhase("tutorial");
	cleanup = showTutorial(ctx, () => {
		net.requestSave("menu");
		// back to the lobby first, so a "still loading" prompt or the game-over choice has a screen behind it
		goLobby();
		if (thenPlay) playPressed();
	});
}

function goLobby(): void {
	clearScreen();
	stopGame();
	const late = pendingLoad;
	if (late !== undefined) {
		pendingLoad = undefined;
		applyLoad(late);
	}
	setPhase("lobby");
	net.requestSave("lobby");
	cleanup = showLobby(
		ctx,
		{
			onPlay: playPressed,
			onShop: openShop,
			onWardrobe: () => openWardrobe(goLobby),
			onSettings: openSettings,
			onCredits: openCredits,
			onTutorial: (thenPlay?: boolean) => openTutorial(thenPlay === true),
		},
		lobbyStatus(),
	);
	const notice = pendingNotice;
	if (notice !== undefined) {
		pendingNotice = undefined;
		showLoadNotice(notice);
	}
}

// ---------------------------------------------------------------- run lifecycle

function deliverPacks(): void {
	const save = ctx.save;
	const names: Array<string> = [];
	for (const p of SHOP_PACKS) {
		const n = pendingPacks(save, p.id);
		if (n <= 0) continue;
		for (const item of p.items) {
			if (item.index >= 0) addItem(save, item.kind, item.index, item.count * n);
		}
		save.packsOpened[p.id] = save.packsBought[p.id];
		names.push(n > 1 ? `${tr(p.name)} ×${n}` : tr(p.name));
	}
	if (names.size() > 0) {
		toast(ctx, `${tr("Delivered")}: ${names.join(", ")}`, "success");
		net.requestSave("packs");
	}
}

function refreshDeskFlags(): void {
	const refs = loop.getRefs();
	const pro = stationNear(refs, "pro") !== undefined;
	pack.nearbyPro = pro;
	pack.nearbyDesk = pro || stationNear(refs, "desk") !== undefined;
	pack.nearbyFire = stationNear(refs, "fire") !== undefined;
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
		// the hotbar's blue tile; the tiles themselves are the list keys 1-5 pick from (shared/game/weaponSlots.ts)
		weaponId: rt.pointer,
		weaponName: tr(w.name),
		mag: rt.ammoCount,
		magSize: w.mag,
		reloading: rt.reloading,
		reloadRatio,
		ammoPool: weaponReserve(save, w),
		hitFlash: p.hitFlash ?? 0,
	});
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
	if (w.mag <= 0 || p.weapon.reloading) return;
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
			onSettings: () => {
				stopGame();
				net.requestSave("lobby");
				openSettings();
			},
		},
		{ note: offlineNote() },
	);
}

function openDeath(): void {
	deathShown = true;
	pack.close();
	closePause();
	ctx.save.runOver = true;
	net.requestSave("death");
	const summary = runSummary(ctx, ctx.save.deathCount <= 1);
	// `serverDriven` is the one honest test for "somebody out there will stand me back up": the hour on this
	// screen comes from the server's clock, which is the same server that runs the revive. Without it (a
	// session that never completed its handshake) the wait would only end when the grace timer below gave up
	// on it, and MP-21's short wait would read as a hang.
	if (serverRevives() && loop.getRefs().daynight.serverDriven()) {
		/*
		 * MP-21: a death is a night lost, not a run ended, on every server kind. The survivor watches the town
		 * carry on and the server puts them back on the street at 06:00 (server/sim/life.ts) — or right now, for
		 * coins (Rebirth). "New game" starts a new life, which still waits for daybreak; the per-frame half of
		 * this lives in `updateDawnWait`.
		 */
		dawnBudget = daybreakWaitSeconds(loop.getRefs().daynight.dayTime);
		dawnOverdue = 0;
		dawnWait = showDaybreakWait(ctx, summary, { onRebirth: doRebirth, onNewRun: doNewRun, onHome: goLobby });
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
 * One frame of the MP-21 wait: refresh the countdown, and take the screen away the moment the server has put
 * this survivor back on their feet — `refs.player.dead` is written by the reliable PlayerLife delta (§4.5,
 * §7.1), so it is the server's answer and not a guess made here.
 *
 * The grace timer is the escape hatch: if 06:00 goes by and no revive arrives (a server not running the MP
 * host, a slot lost in between), the ordinary end-of-run choice comes back. A screen that can only ever be
 * left by the server is a screen that can strand a player.
 */
function updateDawnWait(dt: number): void {
	const wait = dawnWait;
	if (wait === undefined) return;
	const refs = loop.getRefs();
	if (!refs.player.dead) {
		closeDawnWait();
		deathShown = false;
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
	closeDawnWait();
	warn("[PZ] daybreak passed without a revive from the server; falling back to the end-of-run choice");
	pauseCleanup = showRunSummary(ctx, runSummary(ctx, ctx.save.deathCount <= 1), {
		onRebirth: doRebirth,
		onNewRun: doNewRun,
		onHome: goLobby,
	});
}

/** starts the frame loop and in-game UI for the run held by `loop` */
function mountRun(): void {
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
	netEnterWorld();
	gameAudio.startRun(loop.getRefs());
	// onboarding: the coach (first run only) and the aim-assist targets live as long as the run does
	attachRun(ctx, loop.getRefs());
	heartbeat = RunService.Heartbeat.Connect(dt => {
		const input = ctx.input;
		if (input.backpackPressed) toggleBackpack();
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
		loop.update(dt);
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
		loop.render();
		admin?.afterRender(dt);
		pushHud();
		if (ctx.phase === "dead" && !deathShown) openDeath();
		updateDawnWait(dt);
	});
}

/** a fresh map for the current save (new game, or a run that was not kept in memory) */
function newWorld(): void {
	clearScreen();
	stopGame();
	deliverPacks();
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
	lastWood = WOOD_ID >= 0 ? (ctx.save.invenEtc[WOOD_ID] ?? 0) : 0;
	raiseAchievement(0, 1);
	mountRun();
}

function resumeRun(): void {
	clearScreen();
	stopGame();
	deliverPacks();
	mountRun();
}

/** brings the dead player of the run in memory back (or a fresh map at the same day) */
function revive(): void {
	ctx.save.runOver = false;
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
		toast(ctx, `${tr("Not enough coins")} (need ${fmtInt(price)})`, "error");
		return;
	}
	if (!net.sessionReady()) {
		// the save shown is the offline fallback: a rebirth would charge the real save
		toast(ctx, tr("Still loading your progress"), "error");
		return;
	}
	const target = ctx.save;
	actionBusy = true;
	const res = invokeRunAction("rebirth");
	actionBusy = false;
	if (ctx.save !== target) return; // the save was replaced while waiting
	if (!res.ok) {
		toast(ctx, actionErrorText(res.reason, ctx.save.settings.langType), "error");
		return;
	}
	revive();
}

function doNewRun(): void {
	if (actionBusy || !ctx.save.runOver) return; // a stale dialog: the run is not over
	const target = ctx.save;
	if (net.savingEnabled()) {
		actionBusy = true;
		const res = invokeRunAction("newRun");
		actionBusy = false;
		if (ctx.save !== target) return;
		if (!res.ok) {
			toast(ctx, actionErrorText(res.reason, ctx.save.settings.langType), "error");
			return;
		}
	}
	// same reset as the server (offline: local only, nothing is saved anyway)
	resetRun(ctx.save);
	runActive = false;
	newWorld();
}

function showGameOverChoice(): void {
	// the same two ways out on every server kind (MP-21 as the owner rewrote it): pay to continue, or a new life
	const price = rebirthPrice(ctx.save.deathCount);
	const short = price - ctx.save.money;
	let body = nl(
		tr("Rebirth to continue this run, or start a new game from day 1.#Level, skills, coins and packs are kept."),
	);
	// the Rebirth button below stays enabled either way (destructive-styled when unaffordable); spell
	// out the missing amount here so it isn't a silent no-op if the player taps it anyway
	if (short > 0) body += `\n${tr("Not enough coins")} (need ${fmtInt(short)} more)`;
	popup(ctx, tr("Your run is over"), body, [
		{ text: tr("Close"), variant: "outline" },
		// starting over throws the current run away → destructive; paying to continue is the main action
		{ text: tr("New game"), variant: "destructive", onClick: doNewRun },
		{ text: `${tr("Rebirth")} · ${fmtInt(price)}`, variant: "default", onClick: doRebirth },
	]);
}

function startRun(): void {
	if (ctx.save.runOver) {
		showGameOverChoice();
		return;
	}
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

pack.onUse = id => {
	if ((ctx.save.invenUse[id] ?? 0) <= 0) return;
	if (itemUseEffect(loop.getRefs().player, ctx.save, id)) return;
	// itemUseEffect only refuses a held, known item when it would do nothing (hp/hunger already
	// maxed, no buff, no poison cure) — pick the wording that matches what the item targets.
	const u = USABLES[id];
	if (u !== undefined && u.hunger > 0) toast(ctx, tr("You're already full"), "error");
	else if (u !== undefined && u.hp > 0) toast(ctx, tr("Already at full health"), "error");
	else toast(ctx, tr("You can't use that now"), "error");
};

pack.onCraft = id => {
	// a refused recipe answers with a message (and the UI's error toast): only a real craft is heard
	if (craft(loop.getRefs(), id)) gameAudio.crafted();
};

pack.craftCheck = id => {
	const r = CRAFT_RECIPES[id];
	return r === undefined ? "Unknown recipe" : craftBlocker(loop.getRefs(), r);
};

pack.onEquipWeapon = id => {
	if (!ownsWeapon(ctx.save, id)) return;
	switchWeapon(loop.getRefs(), id);
};

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
	if (setEquipped(ctx.save, slot, id)) cosmeticChanged(slot);
}

function unequipSlot(slot: number): void {
	if (setEquipped(ctx.save, slot, -1)) cosmeticChanged(slot);
}

pack.onEquipItem = equipItem;
pack.onUnequipItem = unequipSlot;

// ---------------------------------------------------------------- boot

function begin(): void {
	if (started) return;
	started = true;
	showLogo(() => {
		goLobby();
	});
}

// audio (src/client/audio): the mixer boots with the client, reads the Settings sliders straight from the
// save (so it follows a LoadAck that swaps `ctx.save`) and hooks the interface by watching the ScreenGui.
audio.start();
audio.bindSettings(() => ctx.save.settings);
startUiAudio(ctx);
// the walk cycle only reports the moment a foot lands; until something listens, nothing is heard
onFootstep(playFootstep);

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
// F1: assina os remotes do host agora, nao no primeiro quadro da partida -- o servidor admite o jogador
// assim que ele entra e ja comeca a mandar snapshot (client/net/netClient.ts: netPrewarm)
netPrewarm();
task.delay(LOAD_FALLBACK_SEC, begin);

print(`[${GAME_NAME}] client ready`);
