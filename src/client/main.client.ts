import { GAME_NAME } from "shared/module";
import { equipSlotOf, expMaxInit, ownsEquip, ownsWeapon, pendingPacks, resetRun } from "shared/game/save";
import { BossState, ZombieState } from "shared/game/entities";
import { currentWeapon, itemUseEffect, weaponReserve } from "shared/game/player";
import { ACHIEVEMENTS } from "shared/data/achievements";
import { CRAFT_RECIPES } from "shared/data/crafts";
import { EQUIPS } from "shared/data/equips";
import { ETC_ITEMS } from "shared/data/etcItems";
import { WeaponKind } from "shared/data/kinds";
import { langGet } from "shared/data/lang";
import { rebirthPrice, SHOP_PACKS } from "shared/data/shop";
import { USABLES } from "shared/data/usables";
import { getCtx, setPhase } from "./bootstrap";
import { GameLoop } from "./gameLoop";
import { craft, craftBlocker, stationNear } from "./systems/craftSystem";
import { switchWeapon } from "./systems/combat";
import { interactHint } from "./systems/interaction";
import { addItem } from "./systems/items";
import * as net from "./systems/saveClient";
import { showLogo } from "./ui/logo";
import { LobbyStatus, showLobby } from "./ui/lobby";
import { actionErrorText, showShop } from "./ui/shop";
import { showSettings } from "./ui/settings";
import { showCredits } from "./ui/credits";
import { showTutorial } from "./ui/tutorial";
import { showPause } from "./ui/pauseMenu";
import { popup, toast } from "./ui/popup";
import { fmtInt, nl } from "./ui/widgets";
import { Backpack } from "./ui/backpack";
import { Hud } from "./ui/hud";

/*
 * Screen flow + run lifecycle.
 * - a run lives in `loop` until the player starts a new one: Home/Shop/Settings from the pause menu only
 *   SUSPEND it and Play continues it (HP, hunger, time and the map are kept)
 * - after a game over the run can only continue with a paid Rebirth (server) or restart at day 1 (New game)
 * - progress is reported to the server every 60 s, on a new day, on a boss kill, on death and when
 *   leaving the run; nothing is reported before the server's LoadAck was adopted
 */

const RunService = game.GetService("RunService");
const AUTOSAVE_SEC = 60;
const LOAD_FALLBACK_SEC = 8;
const NO_AMMO_COOLDOWN = 2;

const ctx = getCtx();
const loop = new GameLoop();
const hud = new Hud(ctx);
const pack = new Backpack(ctx);

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
	const day = refs.daynight.day;
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

/** stops the frame loop and hides the in-game UI; the run itself stays in `loop` */
function stopGame(): void {
	if (heartbeat !== undefined) {
		heartbeat.Disconnect();
		heartbeat = undefined;
		// leaving the game screen: no world sprites / night overlay behind the menus
		loop.hideWorld();
	}
	hud.unmount();
	pack.close();
	closePause();
	deathShown = false;
}

function lobbyStatus(): LobbyStatus {
	return {
		loading: loadInfo === undefined && !net.netUnavailable(),
		suspended: runActive && !loop.getRefs().player.dead,
		offlineNote: offlineNote(),
	};
}

/** `back` is where the shop's Back button goes: the lobby by default, or the paused run when opened from pause. */
function openShop(back: () => void = goLobby): void {
	clearScreen();
	setPhase("shop");
	cleanup = showShop(ctx, back);
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
		day: dn.day,
		dayTime: dn.dayTime,
		isNight: dn.isNight,
		showClock,
		weaponName: tr(w.name),
		mag: rt.ammoCount,
		magSize: w.mag,
		reloading: rt.reloading,
		reloadRatio,
		ammoPool: weaponReserve(save, w),
		hitFlash: p.hitFlash ?? 0,
	});
	hud.setInteractHint(pack.isOpen() || pauseCleanup !== undefined ? undefined : interactHint(refs));
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
				// opened from pause: Back should return to the paused run, not drop to the lobby
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
	pauseCleanup = showPause(ctx, 2, {
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
	heartbeat = RunService.Heartbeat.Connect(dt => {
		const input = ctx.input;
		if (input.backpackPressed) toggleBackpack();
		if (input.pausePressed && ctx.phase === "playing") {
			if (pauseCleanup === undefined) openPause();
			else closePause();
		}
		// the world is frozen while the pause menu, the backpack or the game over screen is open
		const simulate = ctx.phase === "playing" && pauseCleanup === undefined && !pack.isOpen();
		if (simulate) {
			warnNoAmmo();
			trackBefore();
			loop.update(dt);
			trackAfter();
			saveTimer += dt;
			if (saveTimer >= AUTOSAVE_SEC) {
				saveTimer = 0;
				net.requestSave("auto");
			}
		} else {
			input.beginFrame();
		}
		loop.render();
		pushHud();
		if (ctx.phase === "dead" && !deathShown) openDeath();
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
	refs.onMessage = msg => hud.showMessage(msg);
	lastDay = refs.daynight.day;
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
	deathShown = false;
	if (heartbeat === undefined) {
		resumeRun();
	} else {
		setPhase("playing");
	}
	hud.showMessage("Rebirth");
	net.requestSave("death");
}

function doRebirth(): void {
	if (actionBusy || !ctx.save.runOver) return; // a stale dialog: there is no game over to continue
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
	const res = net.invokeShopAction({ kind: "rebirth", runRev: target.runRev });
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
		const res = net.invokeShopAction({ kind: "newRun", runRev: target.runRev });
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
	craft(loop.getRefs(), id);
};

pack.craftCheck = id => {
	const r = CRAFT_RECIPES[id];
	return r === undefined ? "Unknown recipe" : craftBlocker(loop.getRefs(), r);
};

pack.onEquipWeapon = id => {
	if (!ownsWeapon(ctx.save, id)) return;
	switchWeapon(loop.getRefs(), id);
};

pack.onEquipItem = id => {
	if (!ownsEquip(ctx.save, id)) return;
	const slot = equipSlotOf(id);
	if (slot === 1) ctx.save.equipCloth = id;
	else if (slot === 2) ctx.save.equipHand = id;
	else if (slot === 3) ctx.save.equipGun = id;
	else if (slot === 4) ctx.save.equipDeco = id;
};

pack.onUnequipItem = slot => {
	if (slot === 1) ctx.save.equipCloth = -1;
	else if (slot === 2) ctx.save.equipHand = -1;
	else if (slot === 3) ctx.save.equipGun = -1;
	else if (slot === 4) ctx.save.equipDeco = -1;
};

// ---------------------------------------------------------------- boot

function begin(): void {
	if (started) return;
	started = true;
	showLogo(() => {
		goLobby();
	});
}

net.startNet();
task.delay(LOAD_FALLBACK_SEC, begin);

print(`[${GAME_NAME}] client ready`);
