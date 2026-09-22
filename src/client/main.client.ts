import { GAME_NAME } from "shared/module";
import { expMaxInit } from "shared/game/save";
import { currentWeapon, itemUseEffect, weaponAmmoPool } from "shared/game/player";
import { WEAPONS } from "shared/data/weapons";
import { EQUIPS } from "shared/data/equips";
import { getCtx, setPhase } from "./bootstrap";
import { GameLoop } from "./gameLoop";
import { craft } from "./systems/craftSystem";
import { loadPlayerSave, persistSave } from "./systems/saveClient";
import { showLogo } from "./ui/logo";
import { showLobby } from "./ui/lobby";
import { showShop } from "./ui/shop";
import { showSettings } from "./ui/settings";
import { showCredits } from "./ui/credits";
import { showTutorial } from "./ui/tutorial";
import { showPause } from "./ui/pauseMenu";
import { Backpack } from "./ui/backpack";
import { Hud, HudState } from "./ui/hud";

const RunService = game.GetService("RunService");
const AUTOSAVE_SEC = 5;
const DESK_SCAN_RANGE = 180;

const ctx = getCtx();
const loop = new GameLoop();
const hud = new Hud(ctx);
const pack = new Backpack(ctx);

let cleanup: (() => void) | undefined;
let pauseCleanup: (() => void) | undefined;
let heartbeat: RBXScriptConnection | undefined;
let paused = false;
let deathShown = false;
let saveTimer = 0;

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
	paused = false;
}

function stopGame(): void {
	if (heartbeat !== undefined) {
		heartbeat.Disconnect();
		heartbeat = undefined;
	}
	hud.unmount();
	pack.close();
	closePause();
	deathShown = false;
}

function refreshDeskFlags(): void {
	const refs = loop.getRefs();
	let desk = false;
	let pro = false;
	for (const s of refs.world.solids) {
		if (s.kind !== "structure") {
			continue;
		}
		const cx = s.x + s.w / 2;
		const cy = s.y + s.h / 2;
		const d = math.max(math.abs(cx - refs.player.x) - s.w / 2, math.abs(cy - refs.player.y) - s.h / 2);
		if (d < DESK_SCAN_RANGE) {
			if (s.tags === "craftdesk_pro") {
				pro = true;
			} else if (s.tags === "craftdesk") {
				desk = true;
			}
		}
	}
	pack.nearbyDesk = desk || pro;
	pack.nearbyPro = pro;
}

function pushHud(): void {
	const refs = loop.getRefs();
	const p = refs.player;
	const save = ctx.save;
	const w = currentWeapon(p);
	const state: HudState = {
		hp: p.hp,
		hpMax: p.hpMax,
		hunger: p.hungry,
		hungerMax: p.hungryMax,
		level: save.level,
		exp: save.exp,
		expMax: expMaxInit(save.level),
		day: refs.daynight.day,
		weaponName: w.name,
		mag: p.weapon.ammoCount,
		magSize: w.mag,
		reloadRatio: 0,
		ammoPool: weaponAmmoPool(save, w.ammoPool),
	};
	hud.update(state);
	hud.setInteractHint(undefined);
}

function openPause(): void {
	if (pauseCleanup !== undefined) {
		return;
	}
	paused = true;
	pack.close();
	pauseCleanup = showPause(ctx, 0, {
		onResume: () => {
			closePause();
		},
		onSave: () => {
			persistSave(ctx.save);
			hud.showMessage("Saved");
			closePause();
		},
		onHome: () => {
			persistSave(ctx.save);
			goLobby();
		},
		onShop: () => {
			persistSave(ctx.save);
			stopGame();
			clearScreen();
			setPhase("shop");
			cleanup = showShop(ctx, goLobby);
		},
		onSettings: () => {
			stopGame();
			clearScreen();
			setPhase("settings");
			cleanup = showSettings(ctx, goLobby, () => {
				clearScreen();
				setPhase("credits");
				cleanup = showCredits(ctx, goLobby);
			});
		},
	});
}

function openDeath(): void {
	if (pauseCleanup !== undefined) {
		return;
	}
	deathShown = true;
	persistSave(ctx.save);
	pauseCleanup = showPause(ctx, 2, {
		onRebirth: () => {
			const price = ctx.save.deathCount * ctx.save.deathCount * 10 + 10;
			if (ctx.save.money < price) {
				hud.showMessage("Not enough coins");
				return;
			}
			ctx.save.money -= price;
			ctx.save.deathCount += 1;
			const refs = loop.getRefs();
			refs.player.hp = refs.player.hpMax;
			refs.player.hungry = refs.player.hungryMax;
			refs.player.dead = false;
			refs.zombies.clear();
			refs.bosses.clear();
			persistSave(ctx.save);
			closePause();
			deathShown = false;
			setPhase("playing");
			hud.showMessage("Rebirth");
		},
		onHome: () => {
			goLobby();
		},
	});
}

function startGame(): void {
	clearScreen();
	stopGame();
	setPhase("playing");
	loop.init(ctx.save);
	const refs = loop.getRefs();
	refs.onMessage = msg => {
		print(msg);
		hud.showMessage(msg);
	};
	hud.onPause = () => {
		if (!pack.isOpen()) {
			openPause();
		}
	};
	hud.onBackpack = () => {
		if (!paused && ctx.phase === "playing") {
			if (pack.isOpen()) {
				pack.close();
			} else {
				refreshDeskFlags();
				pack.open();
			}
		}
	};
	hud.mount();
	paused = false;
	deathShown = false;
	saveTimer = 0;
	heartbeat = RunService.Heartbeat.Connect(dt => {
		if (ctx.input.backpackPressed) {
			if (!paused && ctx.phase === "playing") {
				if (pack.isOpen()) {
					pack.close();
				} else {
					refreshDeskFlags();
					pack.open();
				}
			}
		}
		if (ctx.input.pausePressed) {
			if (ctx.phase === "playing" && !pack.isOpen() && pauseCleanup === undefined) {
				openPause();
			}
		}
		if (!paused && pauseCleanup === undefined && ctx.phase === "playing") {
			loop.update(dt);
		} else {
			ctx.input.beginFrame();
		}
		loop.render();
		pushHud();
		saveTimer += dt;
		if (saveTimer >= AUTOSAVE_SEC) {
			saveTimer = 0;
			persistSave(ctx.save);
		}
		if (ctx.phase === "dead" && !deathShown) {
			openDeath();
		}
	});
}

function goLobby(): void {
	clearScreen();
	stopGame();
	setPhase("lobby");
	cleanup = showLobby(ctx, {
		onPlay: () => {
			persistSave(ctx.save);
			startGame();
		},
		onShop: () => {
			clearScreen();
			setPhase("shop");
			cleanup = showShop(ctx, goLobby);
		},
		onSettings: () => {
			clearScreen();
			setPhase("settings");
			cleanup = showSettings(ctx, goLobby, () => {
				clearScreen();
				setPhase("credits");
				cleanup = showCredits(ctx, goLobby);
			});
		},
		onTutorial: () => {
			clearScreen();
			setPhase("tutorial");
			cleanup = showTutorial(ctx, () => {
				persistSave(ctx.save);
				goLobby();
			});
		},
	});
}

pack.onUse = id => {
	const refs = loop.getRefs();
	itemUseEffect(refs.player, ctx.save, id);
};

pack.onCraft = id => {
	craft(loop.getRefs(), id);
};

pack.onEquipWeapon = id => {
	ctx.save.equipWeapon = id;
	const w = WEAPONS[id];
	if (w === undefined) {
		return;
	}
	const refs = loop.getRefs();
	refs.player.weapon.pointer = id;
	refs.player.weapon.ammoCount = w.mag;
};

pack.onEquipItem = id => {
	const e = EQUIPS[id];
	if (e === undefined) {
		return;
	}
	if (e.kind === 1) {
		ctx.save.equipCloth = id;
	} else if (e.kind === 2) {
		ctx.save.equipHand = id;
	} else if (e.kind === 3) {
		ctx.save.equipGun = id;
	} else {
		ctx.save.equipDeco = id;
	}
};

loadPlayerSave().then(loaded => {
	if (loaded) {
		ctx.save = loaded;
	}
	showLogo(() => {
		goLobby();
	});
});

print(`[${GAME_NAME}] client ready`);
