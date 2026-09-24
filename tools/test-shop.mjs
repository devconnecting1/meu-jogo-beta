#!/usr/bin/env node
/*
 * The shop, end to end (docs/SHOP.md; DESIGN_RULES MON-01..07, BEM-02, SAV-01): every price a screen shows is the price
 * the server charges, everything bought is unlocked -- delivered, owned, wearable, drawn for everybody, still there on
 * another server -- and every price sits in the band of play the economy model gives its tier.
 *
 *   npm run test:shop                  # everything (exit code 1 on any failure)
 *   node tools/test-shop.mjs --verbose # with the server's own print/warn lines
 *   PZ_SRC=path/to/src node tools/test-shop.mjs
 *
 * Nothing here is a transcription. The prices come from shared/data/shop.ts; what a screen SHOWS is read off the REAL
 * client UI (client/ui/shop.ts, wardrobe.ts, survivor.ts, lobby.ts, onboarding/gameOver.ts) under the UI shim, in a
 * child process of this same file (`--ui`, the two fake Robloxes cannot share one process); what is CHARGED and GRANTED
 * is what the REAL server (server/main.server.ts with mpHost, the simulation, analytics and the config knob) does on a
 * fake Roblox whose DataStore outlives a server "process", through the remotes a client has.
 *
 *   1. ONE SOURCE        every price and reward lives in shared/data/shop.ts: no other file of src/ carries a price, no
 *                        game string carries a coin amount or the milestone step, a pack's contents line is written
 *                        from its items, and docs/SHOP.md's tables are the data's (every product, every number).
 *   2. THE MODEL         coins per hour for a new, an average and a strong player, from the numbers the server pays and
 *                        the real clock; every product inside its tier's band of hours of average play; the welcome gift
 *                        buys a starter pack; a pet pack is a fraction of the pet kept for good; the Rebirth curve; the
 *                        early game within reach and the long tail demanding.
 *   3. SHOWN = CHARGED   each pack, each costume and each Rebirth (continues 1-5) bought through ShopAction: the coins
 *                        taken and the answer's `price` are the number the card, the tile, the wardrobe's Buy, the
 *                        Survivor screen and the death screen show; a `price` in the request is never read; the analytics
 *                        Sink is the same number, once per purchase.
 *   4. GRANTED           a pack goes into the backpack on entering the city (every item, the count on the card); a
 *                        costume is owned, worn from the wardrobe out of the world, drawn on the wire for another player
 *                        (MON-04), and on a rejoin on ANOTHER server still owned and worn -- and the real wardrobe, shop
 *                        and lobby built from that save show it so.
 *   5. REFUSED           too few coins; a costume or a pet pack already owned (or its pet pending); junk ids; an unknown
 *                        kind; a Rebirth for a living body or a stale run; a replayed purchase (nonce) charged once; a
 *                        report carrying coins, costumes or packs; nothing moves and no Sink is logged.
 *   6. SAVED             a purchase reaches the DataStore by the event save (SAV-01); with the DataStore failing the
 *                        purchase stays in the session and lands with the retry, coins and item together; a crash before
 *                        any write loses both together, never one of them.
 *   7. EARNED            the welcome gift is the "+20" the Earn coins tab shows and the greeting says; a midnight pays
 *                        the "+3" (and the "+10" of a record day), a boss the "+8", each told once in a pushed wallet
 *                        and toasted from it ("+13 coins  Day survived ×1 · Record day ×1"); the welcome-pack knob gives
 *                        a pack, pending on its card, for no coins.
 *   8. ROBUX             only where it belongs (the server's one module, the wardrobe's one button, cosmetics only, no
 *                        "R$"); then the real server with a fake MarketplaceService: no id -> no offer, no prompt, coins
 *                        as ever; the price Roblox confirms is the one offered and shown; the SERVER prompts, only what
 *                        is not yours, and holds the coin purchase meanwhile; a receipt grants once, only after the write
 *                        with its PurchaseId landed (NotProcessedYet while the DataStore fails, granted on the retry); a
 *                        receipt for nobody here, an unknown product, junk: nothing; one already owned: acknowledged,
 *                        never coins; the admin cannot take it back; another server still has it; and the real wardrobe
 *                        shows both prices, the coin Buy first, "See Price" beside it, "Unlocked" when the receipt lands.
 *   9. REBIRTH AT 0      the daybreak came while the dead survivor waited in the lobby: the server says so
 *                        (`pz_rebirth_free`), the lobby shows the Rebirth at 0 and the server charges 0.
 *
 * Pure Node (>= 18) + the project's TypeScript, through tools/luau-shim.mjs / tools/ui-shim.mjs, plus the small fake
 * Roblox of tools/test-analytics.mjs (copied: each suite carries its own).
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { installShims } from "./luau-shim.mjs";
import { installUiShims } from "./ui-shim.mjs";

const SELF = fileURLToPath(import.meta.url);
const VERBOSE = process.argv.includes("--verbose");
const clone = v => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
/** "1,234" -> 1234 (widgets.ts fmtInt); undefined when the text holds no number */
const num = text => {
	const m = /-?\d[\d,]*/.exec(String(text ?? ""));
	return m === null ? undefined : Number(m[0].replace(/,/g, ""));
};

// ================================================================================================ the UI side (--ui)

/**
 * The child process: builds the REAL screens for the saves the server handed out and writes down what they show. It
 * decides nothing -- the parent compares.
 */
function runUi(inPath, outPath) {
	const input = JSON.parse(readFileSync(inPath, "utf8"));
	const ui = installUiShims({ seed: 1, viewport: [1120, 630] });
	const { SRC, require, flush } = ui;
	globalThis.tonumber = v => (Number.isFinite(Number(v)) ? Number(v) : undefined);
	const boot = require(join(SRC, "client/bootstrap.ts"));
	const saveClient = require(join(SRC, "client/systems/saveClient.ts"));
	saveClient.requestSave = () => true;
	saveClient.sessionReady = () => true;
	// nothing here buys: a click that reached the remote would be a bug in this suite, answered as a failure
	saveClient.invokeShopAction = () => ({ ok: false, reason: "network" });
	const SHOP = require(join(SRC, "client/ui/shop.ts"));
	const { showWardrobe } = require(join(SRC, "client/ui/wardrobe.ts"));
	const { SurvivorScreen } = require(join(SRC, "client/ui/survivor.ts"));
	const { showRunSummary } = require(join(SRC, "client/onboarding/gameOver.ts"));
	const { showLobby } = require(join(SRC, "client/ui/lobby.ts"));
	const { SHOP_PACKS, COSTUMES } = require(join(SRC, "shared/data/shop.ts"));
	const COS = require(join(SRC, "shared/data/cosmetics.ts"));
	const { EquipSlot } = require(join(SRC, "shared/data/equips.ts"));
	flush();
	const ctx = boot.getCtx();
	const layer = ctx.uiLayer;
	const deep = (root, name, cls) =>
		root?.GetDescendants().find(d => d.Name === name && (cls === undefined || d.ClassName === cls));
	const use = (save, money) => {
		Object.assign(ctx.save, clone(save));
		if (money !== undefined) ctx.save.money = money;
	};
	const noop = () => {};
	const out = {};
	if (input.mode === "robux") {
		const deps = { ctx, layer, deep, use, noop, saveClient, SRC, require, flush, COSTUMES, COS, EquipSlot };
		writeFileSync(outPath, JSON.stringify(robuxUi(input, { ...deps, showWardrobe, showLobby })));
		return;
	}

	// ---- the Shop: each card's price, its Buy, its Pending chip; the Earn coins page
	const shopView = (save, money) => {
		use(save, money);
		ctx.phase = "shop";
		const close = SHOP.showShop(ctx, noop, noop);
		flush();
		const root = layer.FindFirstChild("Shop");
		const content = deep(root, "Content");
		const cards = SHOP_PACKS.map(p => {
			const card = deep(content, `Pack${p.id}`);
			const buy = deep(card, "Buy");
			const pending = deep(card, "Pending");
			return {
				id: p.id,
				price: deep(card, "Price")?.Text,
				buy: buy?.Text,
				disabled: buy?.GetAttribute("Disabled") === true,
				pending: pending?.Visible === true ? deep(pending, "Text")?.Text : undefined,
			};
		});
		const earn = deep(root, "Earn");
		const rows = [0, 1, 2, 3].map(i => {
			const r = deep(earn, `Earn${i}`);
			return { label: deep(r, "Label")?.Text, how: deep(r, "How")?.Text, chip: deep(r, "Amount")?.Text };
		});
		close();
		flush();
		return { cards, earn: rows };
	};
	out.shopBroke = shopView(input.fresh, 0);
	out.shopRich = shopView(input.fresh, 1e6);
	out.shopOwned = shopView(input.owned);
	out.shopWelcomed = shopView(input.welcomed);

	// ---- the Wardrobe: each tile's lock and price, and the details panel once the tile is picked
	const wardrobeView = (save, money) => {
		use(save, money);
		ctx.phase = "shop";
		const close = showWardrobe(ctx, { onBack: noop, onEquip: noop, onUnequip: noop });
		flush();
		const root = layer.FindFirstChild("Wardrobe");
		const details = () => deep(root, "Details");
		const tiles = [];
		const pages = [EquipSlot.Outfit, EquipSlot.Pet];
		for (let pi = 0; pi < pages.length; pi++) {
			deep(root, "Tabs")?.FindFirstChild(`Tab${pi}`)?.Activated.Fire();
			flush();
			const page = deep(root, `Page${pi}`);
			const items = COSTUMES.filter(c => c.equipId >= 0 && COS.cosmeticSlotOf(c.equipId) === pages[pi]);
			for (let j = 0; j < items.length; j++) {
				const tile = deep(page, `Tile${j}`);
				const lock = tile?.FindFirstChild("Lock")?.Visible === true;
				const amount = deep(tile, "Price")?.Visible === true ? deep(tile, "Amount")?.Text : undefined;
				tile?.Activated.Fire();
				flush();
				const action = deep(details(), "Action");
				const keep = deep(details(), "Keep");
				tiles.push({
					id: items[j].id,
					lock,
					amount,
					title: details()?.FindFirstChild("Title")?.Text,
					status: deep(deep(details(), "Status"), "Legend")?.Text,
					action: action?.Visible === true ? action.Text : undefined,
					actionDisabled: action?.GetAttribute("Disabled") === true,
					keep: keep?.Visible === true ? keep.Text : undefined,
				});
			}
			tiles.push({ page: pi, count: deep(deep(page, "Count"), "Legend")?.Text });
		}
		close();
		flush();
		return tiles;
	};
	out.wardrobeRich = wardrobeView(input.fresh, 1e6);
	out.wardrobeBroke = wardrobeView(input.fresh, 0);
	out.wardrobeOwned = wardrobeView(input.owned);

	// ---- the Rebirth: the Survivor screen's button and the death screen's price, continue by continue
	out.rebirth = [];
	for (let d = 0; d <= 5; d++) {
		use(input.fresh, 0);
		ctx.save.deathCount = d;
		ctx.save.runOver = true;
		ctx.phase = "lobby";
		const screen = new SurvivorScreen(layer, ctx, {
			onBack: noop,
			onPlay: noop,
			onRebirth: noop,
			onWaitDawn: noop,
			onNewRun: noop,
			onWardrobe: noop,
			onTutorial: noop,
		});
		screen.refresh({ run: "over", hosted: true, canWait: true, hour: 22 });
		flush();
		const survivorButton = deep(screen.frame, "Rebirth", "TextButton")?.Text;
		const survivorNote = deep(screen.frame, "Note")?.Text ?? "";
		screen.destroy();
		flush();
		ctx.phase = "dead";
		const close = showRunSummary(
			ctx,
			{ days: 3, bestDay: 3, level: 2, kills: 5, bosses: 0, first: d === 0 },
			{ onRebirth: noop, onNewRun: noop, onHome: noop },
		);
		flush();
		const deathPrice = deep(deep(layer.FindFirstChild("RunOver"), "Rebirth"), "Price")?.Text;
		close();
		flush();
		out.rebirth.push({ deaths: d, survivorButton, survivorNote, deathPrice });
	}

	// ---- the lobby's Wardrobe plate: the collection count
	const lobbyCount = save => {
		use(save);
		ctx.phase = "lobby";
		const handlers = new Proxy({}, { get: () => noop });
		const lobby = showLobby(ctx, handlers, { loading: false, run: "fresh", hosted: false, seed: 7331 }, "menu");
		flush();
		const text = deep(deep(layer.FindFirstChild("Lobby"), "Nav1"), "Sub")?.Text;
		lobby.close();
		flush();
		return text;
	};
	out.lobbyFresh = lobbyCount(input.fresh);
	out.lobbyOwned = lobbyCount(input.owned);

	// ---- the toasts: a new save's greeting, and what the server's pushed wallets said was earned
	out.welcome = SHOP.welcomeText(0);
	out.earned = input.acks.map(a => SHOP.earnedText(a, 0));
	writeFileSync(outPath, JSON.stringify(out));
}

/**
 * The child's Robux mode: the REAL wardrobe with the offer the server published (`input.offer`, the attribute's text on
 * ReplicatedStorage.Net), every costume's details panel; a click on See Price (what it sends), a refusal's toast, the
 * receipt's wallet ("Unlocked"); and the lobby's Rebirth before and after the server says the daybreak made it free.
 */
function robuxUi(input, d) {
	const { ctx, layer, deep, use, noop, saveClient, SRC, require, flush, COSTUMES, COS, EquipSlot } = d;
	const out = {};
	const POP = require(join(SRC, "client/ui/popup.ts"));
	const toasts = [];
	POP.toast = (_ctx, text, kind) => toasts.push({ text, kind });
	const RS = game.GetService("ReplicatedStorage");
	let netFolder = RS.FindFirstChild("Net");
	if (netFolder === undefined) {
		netFolder = new Instance("Folder");
		netFolder.Name = "Net";
		netFolder.Parent = RS;
	}
	const requests = [];
	let answer = { ok: true, price: 0 };
	saveClient.invokeShopAction = req => {
		requests.push(clone(req));
		return answer;
	};
	let walletFn;
	saveClient.onWalletChanged = fn => {
		walletFn = fn;
		return () => {};
	};
	const btn = (root, name) => {
		const b = deep(root, name);
		if (b === undefined) return undefined;
		return {
			visible: b.Visible === true,
			text: b.Text,
			disabled: b.GetAttribute("Disabled") === true,
			selectable: b.Selectable !== false,
			variant: b.GetAttribute("Variant"),
			// the kit places in scale of the parent's design size (widgets.ts `place`)
			x: b.Position.X.Scale,
			right: b.NextSelectionRight?.Name,
		};
	};
	const pages = [EquipSlot.Outfit, EquipSlot.Pet];
	const open = (save, money, offer) => {
		netFolder.SetAttribute("pz_robux_products", offer);
		use(save, money);
		ctx.phase = "shop";
		const close = d.showWardrobe(ctx, { onBack: noop, onEquip: noop, onUnequip: noop });
		flush();
		const root = layer.FindFirstChild("Wardrobe");
		const details = () => deep(root, "Details");
		const pick = id => {
			for (let pi = 0; pi < pages.length; pi++) {
				const items = COSTUMES.filter(c => c.equipId >= 0 && COS.cosmeticSlotOf(c.equipId) === pages[pi]);
				const j = items.findIndex(c => c.id === id);
				if (j < 0) continue;
				deep(root, "Tabs")?.FindFirstChild(`Tab${pi}`)?.Activated.Fire();
				flush();
				deep(deep(root, `Page${pi}`), `Tile${j}`)?.Activated.Fire();
				flush();
				const dt = details();
				return {
					id,
					status: deep(deep(dt, "Status"), "Legend")?.Text,
					action: btn(dt, "Action"),
					coin: btn(dt, "CoinBuy"),
					robux: btn(dt, "RobuxBuy"),
					keep: btn(dt, "Keep"),
				};
			}
			return undefined;
		};
		return {
			details,
			pick,
			close: () => {
				close();
				flush();
			},
		};
	};
	const all = (save, money, offer) => {
		const w = open(save, money, offer);
		const tiles = COSTUMES.map(c => w.pick(c.id));
		w.close();
		return tiles;
	};
	out.rich = all(input.fresh, 1e6, input.offer);
	out.broke = all(input.fresh, 0, input.offer);
	out.owned = all(input.owned, undefined, input.offer);
	out.none = all(input.fresh, 1e6, undefined);
	// See Price, clicked: what goes to the server; then a refusal; then the receipt's pushed wallet
	const w = open(input.fresh, 1e6, input.offer);
	w.pick(input.target);
	const sent = requests.length;
	deep(w.details(), "RobuxBuy")?.Activated.Fire();
	flush();
	out.clicked = requests.slice(sent);
	answer = { ok: false, reason: "pending" };
	deep(w.details(), "RobuxBuy")?.Activated.Fire();
	flush();
	answer = { ok: true, price: 0 };
	out.pendingToast = toasts.at(-1)?.text;
	const shown = toasts.length;
	ctx.save.costumes[input.target] = 1;
	walletFn?.();
	flush();
	walletFn?.();
	flush();
	out.unlockToasts = toasts.slice(shown).map(t => t.text);
	out.afterGrant = w.pick(input.target);
	w.close();

	// the lobby's Rebirth, a dead survivor with 3 continues bought and no coins, before and after pz_rebirth_free
	const me = game.GetService("Players").LocalPlayer;
	use(input.fresh, 0);
	ctx.save.deathCount = 3;
	ctx.save.runOver = true;
	ctx.phase = "lobby";
	const handlers = new Proxy({}, { get: () => noop });
	const lobby = d.showLobby(ctx, handlers, { loading: false, run: "over", hosted: true, seed: 7331 }, "survivor");
	flush();
	const lobbyRoot = layer.FindFirstChild("Lobby");
	const read = () => {
		const screen = deep(lobbyRoot, "Survivor", "Frame");
		return { button: deep(screen, "Rebirth", "TextButton")?.Text, note: deep(screen, "Note")?.Text ?? "" };
	};
	out.rebirthPaid = read();
	me.SetAttribute("pz_rebirth_free", true);
	flush();
	out.rebirthFree = read();
	me.SetAttribute("pz_rebirth_free", undefined);
	flush();
	out.rebirthBack = read();
	lobby.close();
	flush();
	return out;
}

// ================================================================================================ the server side

function main() {
	const { SRC, ROOT, require } = installShims({ seed: 1 });

	// ------------------------------------------------------------------------------------------ reporting
	let failures = 0;
	let checks = 0;
	function check(ok, what, detail) {
		checks += 1;
		const tail = detail === undefined ? "" : `  (${detail})`;
		if (ok) console.log(`  ok    ${what}${tail}`);
		else {
			failures += 1;
			console.log(`  FAIL  ${what}${tail}`);
		}
		return ok;
	}
	const info = msg => console.log(`        ${msg}`);
	/** PZ_SHOP_ONLY=3 runs only the sections whose title starts with it (the server phases always run) */
	const ONLY = process.env.PZ_SHOP_ONLY;
	function section(title, fn) {
		if (ONLY !== undefined && !title.startsWith(ONLY)) return;
		console.log(`\n${title}`);
		try {
			fn();
		} catch (e) {
			failures += 1;
			console.log(`  FAIL  the section threw: ${e?.stack?.split("\n").slice(0, 4).join(" | ") ?? e}`);
		}
	}

	// ------------------------------------------------------------------------------------------ the fake Roblox
	class Yield extends Error {}
	function runThread(fn, args) {
		try {
			return fn(...args);
		} catch (e) {
			if (e instanceof Yield) return undefined;
			throw e;
		}
	}
	let clockNow = 1000;
	const timers = [];
	const tickErrors = [];
	globalThis.print = (...a) => {
		if (VERBOSE) console.log("        [print]", ...a);
	};
	globalThis.warn = (...a) => {
		const line = a.join(" ");
		if (line.includes("tick failed")) tickErrors.push(line);
		if (VERBOSE) console.log("        [warn]", line);
	};
	const TIME0 = 1_800_000_000;
	globalThis.os = { clock: () => clockNow, time: () => Math.floor(TIME0 + clockNow) };
	globalThis.task = {
		spawn: (fn, ...args) => runThread(fn, args),
		defer: (fn, ...args) => runThread(fn, args),
		delay: (s, fn, ...args) => timers.push({ at: clockNow + s, fn: () => runThread(fn, args) }),
		wait: () => {
			throw new Yield();
		},
	};
	globalThis.pcall = (fn, ...args) => {
		try {
			return [true, fn(...args)];
		} catch (e) {
			if (e instanceof Yield) throw e;
			return [false, e instanceof Error ? e.message : e];
		}
	};
	globalThis.tostring = v => String(v);
	globalThis.tonumber = v => (Number.isFinite(Number(v)) ? Number(v) : undefined);
	globalThis.$tuple = (...a) => a[0];
	globalThis.utf8 = { len: s => [Array.from(String(s)).length], offset: (s, n) => n };
	globalThis.string = {
		char: (...codes) => String.fromCharCode(...codes),
		match: () => [undefined],
		format: (fmt, ...args) => {
			let i = 0;
			return fmt.replace(/%([-0]*)(\d+)?(?:\.(\d+))?([dsfixq%])/g, (m, flags, width, prec, conv) => {
				if (conv === "%") return "%";
				const v = args[i++];
				let s;
				if (conv === "d" || conv === "i") s = String(Math.trunc(Number(v)));
				else if (conv === "f") s = Number(v).toFixed(prec === undefined ? 6 : Number(prec));
				else if (conv === "x") s = (Number(v) >>> 0).toString(16);
				else s = String(v);
				if (width !== undefined && s.length < Number(width))
					s = s.padStart(Number(width), flags.includes("0") ? "0" : " ");
				return s;
			});
		},
	};
	globalThis.Enum = new Proxy({}, { get: (_, a) => new Proxy({}, { get: (__, b) => `${String(a)}.${String(b)}` }) });

	class Signal {
		constructor() {
			this.handlers = [];
		}
		Connect(fn) {
			const h = { fn, on: true };
			this.handlers.push(h);
			return {
				Connected: true,
				Disconnect: () => {
					h.on = false;
					this.handlers = this.handlers.filter(x => x !== h);
				},
			};
		}
		Fire(...args) {
			for (const h of [...this.handlers]) if (h.on) runThread(h.fn, args);
		}
		Wait() {
			throw new Yield();
		}
	}

	class Inst {
		constructor(className) {
			this.ClassName = className;
			this.Name = className;
			this._children = [];
			this._parent = undefined;
			this._attrs = new Map();
			this.ChildAdded = new Signal();
			if (className.endsWith("RemoteEvent")) {
				this.OnServerEvent = new Signal();
				this.OnClientEvent = new Signal();
				this.sent = [];
			}
		}
		get Parent() {
			return this._parent;
		}
		set Parent(p) {
			if (this._parent !== undefined) this._parent._children = this._parent._children.filter(c => c !== this);
			this._parent = p;
			if (p !== undefined) {
				p._children.push(this);
				p.ChildAdded.Fire(this);
			}
		}
		FindFirstChild(name) {
			return this._children.find(c => c.Name === name);
		}
		WaitForChild(name) {
			return this.FindFirstChild(name);
		}
		GetChildren() {
			return [...this._children];
		}
		IsA(className) {
			return this.ClassName === className || className === "Instance";
		}
		Destroy() {
			this.Parent = undefined;
		}
		SetAttribute(k, v) {
			this._attrs.set(k, v);
		}
		GetAttribute(k) {
			return this._attrs.get(k);
		}
		FireClient(player, ...args) {
			this.sent.push({ to: player, args });
			if (this.sent.length > 8000) this.sent.splice(0, 4000);
		}
		FireAllClients(...args) {
			this.sent.push({ to: undefined, args });
			if (this.sent.length > 8000) this.sent.splice(0, 4000);
		}
	}
	globalThis.Instance = Inst;

	/** Roblox's DataStores outlive a server: one map per store name for the whole run, with fault injection */
	const stores = new Map();
	function fakeStore(name) {
		let s = stores.get(name);
		if (s !== undefined) return s;
		const data = new Map();
		s = {
			data,
			/** how many of the next UpdateAsync calls throw, as a DataStore outage does */
			fail: { update: 0 },
			UpdateAsync(key, transform) {
				if (s.fail.update > 0) {
					s.fail.update -= 1;
					throw new Error(`injected UpdateAsync failure on ${name}`);
				}
				const next = transform(clone(data.get(key)));
				if (next !== undefined) data.set(key, clone(next));
				return [next];
			},
			GetAsync(key) {
				return [clone(data.get(key))];
			},
			SetAsync: (key, v) => data.set(key, clone(v)),
		};
		stores.set(name, s);
		return s;
	}

	/** AnalyticsService, recording every economy event (the rest is counted, not decoded) */
	function makeAnalyticsService(log) {
		const row = (player, r) => log.push({ ...r, userId: player?.UserId, t: clockNow });
		return {
			LogOnboardingFunnelStepEvent: (player, step, name, fields) =>
				row(player, { kind: "onboarding", step, name, fields }),
			LogFunnelStepEvent: (player, funnel, session, step, name, fields) =>
				row(player, { kind: "funnel", funnel, session, step, name, fields }),
			LogEconomyEvent: (player, flow, currency, amount, balance, tx, sku, fields) =>
				row(player, {
					kind: "economy",
					flow: String(flow).endsWith("Source") ? "Source" : "Sink",
					currency,
					amount,
					balance,
					tx,
					sku,
					fields,
				}),
			LogCustomEvent: (player, name, value, fields) => row(player, { kind: "custom", name, value, fields }),
		};
	}

	/** a ConfigService whose player snapshots read `values` (key -> value, or a function of the player) */
	function makeConfigService(values = {}) {
		return {
			GetConfigForPlayerAsync(player) {
				const table = typeof values === "function" ? values(player) : values;
				return { GetValue: key => table[key] };
			},
			GetConfigAsync() {
				throw new Error("the game must never read an experiment through GetConfigAsync");
			},
		};
	}

	/**
	 * MarketplaceService: GetProductInfo answers from `prices` (product id -> { price, forSale }), the prompts are
	 * recorded, and ProcessReceipt is whatever the server set (the tests call it as Roblox would, receipt by receipt)
	 */
	function makeMarket() {
		const m = {
			prices: new Map(),
			prompts: [],
			infoCalls: 0,
			ProcessReceipt: undefined,
			PromptProductPurchaseFinished: new Signal(),
			GetProductInfo(id, infoType) {
				m.infoCalls += 1;
				if (infoType !== "InfoType.Product") throw new Error(`GetProductInfo asked with ${infoType}`);
				const p = m.prices.get(id);
				if (p === undefined) throw new Error("HTTP 400 (no such product)");
				return { ProductId: id, Name: `product ${id}`, PriceInRobux: p.price, IsForSale: p.forSale !== false };
			},
			PromptProductPurchase(player, id) {
				m.prompts.push({ userId: player.UserId, id });
			},
		};
		return m;
	}

	let guid = 0;
	function makeGame(config, market) {
		const ReplicatedStorage = new Inst("ReplicatedStorage");
		const Workspace = new Inst("Workspace");
		Workspace.GetServerTimeNow = () => clockNow;
		const Players = {
			list: [],
			PlayerAdded: new Signal(),
			PlayerRemoving: new Signal(),
			MaxPlayers: 6,
			CharacterAutoLoads: true,
			GetPlayers() {
				return [...this.list];
			},
			GetPlayerByUserId(id) {
				return this.list.find(p => p.UserId === id);
			},
		};
		const RunService = {
			Heartbeat: new Signal(),
			IsStudio: () => false,
			IsServer: () => true,
			IsClient: () => false,
		};
		const HttpService = {
			GenerateGUID: () => `{${(++guid).toString(16).padStart(8, "0")}-feed-beef}`,
			JSONEncode: v => JSON.stringify(v),
			JSONDecode: s => JSON.parse(s),
		};
		const DataStoreService = {
			GetDataStore: name => fakeStore(name),
			GetRequestBudgetForRequestType: () => 100,
		};
		const log = [];
		const services = {
			ReplicatedStorage,
			Workspace,
			Players,
			RunService,
			HttpService,
			DataStoreService,
			TextChatService: new Inst("TextChatService"),
			TextService: {},
			AnalyticsService: makeAnalyticsService(log),
			ConfigService: config ?? makeConfigService(),
		};
		// only where a section asks for it: without one, the server's Robux shop does not start (the coin shop is alone)
		if (market !== undefined) services.MarketplaceService = market;
		const closers = [];
		globalThis.game = {
			GetService(name) {
				const s = services[name];
				if (s === undefined) throw new Error(`the fake Roblox has no ${name}`);
				return s;
			},
			JobId: `job-${++guid}`,
			PrivateServerId: "",
			PrivateServerOwnerId: 0,
			PlaceId: 1,
			PlaceVersion: 1,
			BindToClose: fn => closers.push(fn),
		};
		return { services, closers, log };
	}

	function makePlayer(userId, name) {
		const p = new Inst("Player");
		p.Name = name;
		p.UserId = userId;
		p.DisplayName = name;
		p.Kick = () => {
			p.kicked = true;
		};
		p.GetNetworkPing = () => 0.05;
		return p;
	}

	/** a server "process": every module under src loaded again, sharing nothing with the last one but the DataStore */
	function bootServer(config, market) {
		for (const k of Object.keys(require.cache)) if (k.startsWith(SRC)) delete require.cache[k];
		const env = makeGame(config, market);
		require(join(SRC, "server/main.server.ts"));
		const host = require(join(SRC, "server/net/mpHost.ts")).activeMpHost();
		if (host === undefined) throw new Error("main.server.ts did not start the MP host (MP_PHASE < 1?)");
		const P = require(join(SRC, "shared/net/protocol.ts"));
		const { SAVE_STORE } = require(join(SRC, "server/save/stores.ts"));
		const { Players, RunService, ReplicatedStorage } = env.services;
		const net = ReplicatedStorage.FindFirstChild("Net");
		const remote = name => {
			const r = net.FindFirstChild(name);
			if (r === undefined) throw new Error(`no remote ${name}`);
			return r;
		};
		const seqs = new Map();
		const server = {
			env,
			host,
			P,
			log: env.log,
			sim: host.simulation,
			remote,
			join(userId, name = `p${userId}`) {
				const p = makePlayer(userId, name);
				p._parent = Players;
				Players.list.push(p);
				Players.PlayerAdded.Fire(p);
				remote("LoadRequest").OnServerEvent.Fire(p);
				return p;
			},
			quit(p) {
				Players.list = Players.list.filter(x => x !== p);
				Players.PlayerRemoving.Fire(p);
				p._parent = undefined;
			},
			/** the LoadAck the client got: the session's live save, and its status */
			loadAck(p) {
				const acks = remote("LoadAck").sent.filter(e => e.to === p);
				return acks[acks.length - 1]?.args[0];
			},
			save(p) {
				return server.loadAck(p)?.save;
			},
			token(p) {
				return server.loadAck(p)?.token;
			},
			intent(p, kind) {
				remote("Intent").OnServerEvent.Fire(p, P.encodeIntent(kind));
			},
			/** one backpack verb on the Intent remote (the wardrobe's Equip goes this way, out of the world too) */
			verb(p, kind, arg, atSeq = 0, nonce = 0) {
				remote("Intent").OnServerEvent.Fire(p, P.encodeIntentArgs(kind, atSeq, arg, nonce));
			},
			enter(p) {
				server.intent(p, P.IntentKind.EnterWorld);
				server.run(0.6);
				return host.playerOf(p);
			},
			exit(p) {
				server.intent(p, P.IntentKind.LeaveWorld);
				server.run(0.3);
			},
			press(p) {
				const seq = (seqs.get(p) ?? 0) + 1;
				seqs.set(p, seq);
				const cmds = [];
				for (let k = 0; k < 3 && seq - k >= 1; k++)
					cmds.push(P.makeCommand(seq - k, 0, 0, 0, 0, 1 << P.EdgeShift.Reload));
				remote("Input").OnServerEvent.Fire(p, P.encodeInput({ viewTick: 0, viewFrac: 0, cmds }));
			},
			/** ShopAction, as the client's RemoteFunction reaches it (the flood line and all) */
			shop(p, req) {
				return remote("ShopAction").OnServerInvoke(p, req);
			},
			/** a client progress report of the live save with `fields` over it */
			report(p, fields) {
				const json = JSON.stringify({ ...server.save(p), ...fields });
				remote("SaveRequest").OnServerEvent.Fire(p, server.token(p), json);
			},
			/** the SaveAck pushes this player got (the server's own wallet pushes) */
			pushes(p) {
				return remote("SaveAck")
					.sent.filter(e => e.to === p && e.args[0]?.push === true)
					.map(e => e.args[0]);
			},
			/** every World event this player was sent, decoded */
			worldEventsTo(p) {
				const out = [];
				for (const e of remote("World").sent) {
					if (e.to !== undefined && e.to !== p) continue;
					const batch = P.decodeWorld(e.args[0]);
					if (batch !== undefined) out.push(...batch.events);
				}
				return out;
			},
			kill(p) {
				const sp = host.playerOf(p);
				server.immortal.delete(p);
				sp.state.godMode = false;
				server.sim.combat.damageActor(sp.slot, sp.state, sp.save, sp.state.hpMax * 10, true);
				server.beat();
				server.beat();
				return sp;
			},
			/** a boss down with `ps` in the fight (each did a tenth of its hp) */
			killBoss(ps) {
				server.bossId = (server.bossId ?? 800000) + 1;
				for (const p of ps)
					server.sim.progress.noteBossDamage(server.bossId, host.playerOf(p).slot, 1000, clockNow);
				return server.sim.progress.bossKilled(server.bossId, 100, 10000, host.playerOf(ps[0]).slot);
			},
			/** the stored document, as the next session anywhere would load it */
			stored(userId) {
				const doc = fakeStore(SAVE_STORE).data.get(String(userId));
				if (doc === undefined || doc.data === undefined) return undefined;
				return typeof doc.data === "string" ? JSON.parse(doc.data) : doc.data;
			},
			storeSave(userId, data) {
				fakeStore(SAVE_STORE).data.set(String(userId), { data: JSON.stringify(data), lock: undefined });
			},
			saveStore: () => fakeStore(SAVE_STORE),
			immortal: new Set(),
			active: new Set(),
			beat(dt = 1 / 60) {
				clockNow += dt;
				for (let i = timers.length - 1; i >= 0; i--) {
					if (timers[i].at <= clockNow) {
						const t = timers.splice(i, 1)[0];
						t.fn();
					}
				}
				for (const p of server.immortal) {
					const sp = host.playerOf(p);
					if (sp !== undefined && !sp.state.dead) {
						sp.state.godMode = true;
						sp.state.hungry = Math.max(sp.state.hungry, sp.state.hungryMax);
					}
				}
				for (const p of server.active) if (host.playerOf(p) !== undefined) server.press(p);
				RunService.Heartbeat.Fire(dt);
				if (tickErrors.length > 0)
					throw new Error(`the simulation tick failed: ${tickErrors.splice(0).join(" | ")}`);
			},
			run(seconds, dt = 1 / 60) {
				const n = Math.round(seconds / dt);
				for (let i = 0; i < n; i++) server.beat(dt);
			},
			runUntil(pred, limit, dt = 1 / 60) {
				let t = 0;
				while (t < limit) {
					if (pred()) return t;
					server.beat(dt);
					t += dt;
				}
				return pred() ? t : -1;
			},
			economy(userId) {
				return env.log.filter(r => r.userId === userId && r.kind === "economy");
			},
		};
		return server;
	}

	let nextUser = 9100;
	const newUser = () => ++nextUser;

	const SHOP = require(join(SRC, "shared/data/shop.ts"));
	const { ECONOMY, SHOP_PACKS, COSTUMES, INCOME_PROFILES, PRICE_TIERS, ECONOMY_TARGETS, rebirthPrice } = SHOP;
	const { EQUIPS } = require(join(SRC, "shared/data/equips.ts"));
	const COS = require(join(SRC, "shared/data/cosmetics.ts"));
	const { LANG_TABLE } = require(join(SRC, "shared/data/lang.ts"));
	const read = rel => readFileSync(join(ROOT, rel), "utf8");
	const costume = name => COSTUMES.find(c => c.name === name);
	const packNamed = name => SHOP_PACKS.find(p => p.name === name);
	const nameOf = (kind, index) => {
		const tables = [
			require(join(SRC, "shared/data/weapons.ts")).WEAPONS,
			EQUIPS,
			require(join(SRC, "shared/data/usables.ts")).USABLES,
			require(join(SRC, "shared/data/etcItems.ts")).ETC_ITEMS,
		];
		return tables[kind - 1]?.[index]?.name;
	};
	const avg = SHOP.coinsPerHour(INCOME_PROFILES.average);
	const hours = price => price / avg;

	// ================================================================================================ 1. one source

	section("1) one source: every price and reward in shared/data/shop.ts, and docs/SHOP.md says the same", () => {
		// every file of src/ that names a price: only the data module writes one
		const files = [];
		const walk = dir => {
			for (const f of readdirSync(dir)) {
				const p = join(dir, f);
				if (statSync(p).isDirectory()) walk(p);
				else if (p.endsWith(".ts")) files.push(p);
			}
		};
		walk(SRC);
		const pricey = [];
		for (const f of files) {
			if (f.endsWith(join("shared", "data", "shop.ts"))) continue;
			// code only (a comment may quote a request's `price: 0`); `price = 0` is the free actions' (a title, a New game)
			const text = readFileSync(f, "utf8")
				.replace(/\/\*[\s\S]*?\*\//g, "")
				.replace(/\/\/.*$/gm, "");
			if (/\bprice\s*[:=]\s*[1-9]/.test(text) || /\b(rebirthPrice|STARTING_COINS)\s*=\s*\d/.test(text))
				pricey.push(f.slice(SRC.length + 1));
		}
		check(pricey.length === 0, "no file of src/ but shared/data/shop.ts writes a price literal", pricey.join(", "));
		// the screens that show a price read it from the data (the same module the server charges from)
		const shows = {
			"client/ui/shop.ts": /from "shared\/data\/shop"/,
			"client/ui/wardrobe.ts": /from "shared\/data\/shop"/,
			"client/ui/survivor.ts": /rebirthPrice/,
			"client/onboarding/gameOver.ts": /rebirthPrice/,
			"client/main.client.ts": /rebirthPrice/,
			"server/main.server.ts": /from "shared\/data\/shop"/,
			"server/save/costumes.ts": /COSTUMES\[costumeId\]\.price/,
			"server/sim/progress.ts": /ECONOMY\.COINS_PER_DAY/,
		};
		const missing = Object.entries(shows)
			.filter(([f, re]) => !re.test(read(`src/${f}`)))
			.map(([f]) => f);
		check(missing.length === 0, "every screen and the server read the numbers from it", missing.join(", "));
		// no game string carries a coin amount or the milestone step: a number in a sentence would lie on the next change
		const liars = LANG_TABLE.filter(
			s => /\d+\s*(coins?\b|more needed)/i.test(s) || /(multiple of|every)\s+\d+/i.test(s),
		);
		check(
			liars.length === 0,
			"no lang.ts string carries a coin amount or the record step (they follow ECONOMY in code)",
			liars.join(" | "),
		);
		// a pack's contents line is written from its items (one source for what a pack holds)
		const lines = SHOP_PACKS.filter(
			p => p.contents !== p.items.map(it => `${it.count} × ${nameOf(it.kind, it.index)}`).join("#"),
		);
		check(lines.length === 0, "every pack's contents line is its items, in order", lines.map(p => p.name).join());
		// docs/SHOP.md: its product table is the data, row by row
		const doc = read("docs/SHOP.md");
		const rows = new Map();
		for (const line of doc.split("\n")) {
			const cells = line.split("|").map(c => c.trim().replace(/\*\*/g, ""));
			if (cells.length < 6 || !line.trim().startsWith("|")) continue;
			rows.set(cells[1], cells);
		}
		const docPrice = name => num(rows.get(name)?.[4]);
		const wrong = [];
		for (const p of SHOP_PACKS) if (docPrice(p.name) !== p.price) wrong.push(`${p.name}: doc ${docPrice(p.name)}`);
		for (const c of COSTUMES) if (docPrice(c.name) !== c.price) wrong.push(`${c.name}: doc ${docPrice(c.name)}`);
		const sources = [
			["Welcome gift", ECONOMY.STARTING_COINS],
			["Day survived", ECONOMY.COINS_PER_DAY],
			["Record day", ECONOMY.MILESTONE_BONUS],
			["Boss defeated", ECONOMY.COINS_PER_BOSS],
			["Rebirth", rebirthPrice(0)],
		];
		for (const [name, v] of sources)
			if (docPrice(name) !== v) wrong.push(`${name}: doc ${docPrice(name)}, data ${v}`);
		check(
			wrong.length === 0,
			`docs/SHOP.md's product table has every pack, costume, source and the Rebirth at the data's number`,
			wrong.join("; "),
		);
		// docs/ANALYTICS.md's economy table names the amounts too ("o presente de 20", "(3)", "múltiplo de 5 (10)", "(8)")
		const analytics = new Map();
		for (const line of read("docs/ANALYTICS.md").split("\n")) {
			const cells = line.split("|").map(c => c.trim());
			if (cells.length >= 7 && (cells[1] === "Source" || cells[1] === "Sink")) analytics.set(cells[3], cells[5]);
		}
		const ints = text => (String(text ?? "").match(/\d+/g) ?? []).map(Number);
		const said = [
			["Welcome gift", [ECONOMY.STARTING_COINS]],
			["Day survived", [ECONOMY.COINS_PER_DAY]],
			["Record milestone", [ECONOMY.MILESTONE_EVERY, ECONOMY.MILESTONE_BONUS]],
			["Boss", [ECONOMY.COINS_PER_BOSS]],
		].filter(([sku, want]) => JSON.stringify(ints(analytics.get(sku))) !== JSON.stringify(want));
		check(
			said.length === 0,
			"docs/ANALYTICS.md's economy table names the amounts the server pays",
			said.map(([sku]) => `${sku}: "${analytics.get(sku)}"`).join("; "),
		);
		// …and its tier column is the data's
		const tiers = [...SHOP_PACKS, ...COSTUMES].filter(x => !(rows.get(x.name)?.[3] ?? "").includes(x.tier));
		check(tiers.length === 0, "…and the tier of every product", tiers.map(x => x.name).join(", "));
		// the model's table: the coins per hour of each profile, as the data computes them (one decimal); its rows start
		// with the profile's key ("`average` (médio)")
		const modelRows = Object.entries(INCOME_PROFILES).filter(([name, prof]) => {
			let row;
			for (const [first, cells] of rows) if (first.replace(/`/g, "").split(" ")[0] === name) row = cells;
			return (
				row === undefined || Number(row[5]?.replace(",", ".")) !== Number(SHOP.coinsPerHour(prof).toFixed(1))
			);
		});
		check(
			modelRows.length === 0,
			"…and the model's coins per hour for the new, average and strong player",
			modelRows.map(([n]) => n).join(", "),
		);
	});

	// ================================================================================================ 2. the model

	section("2) the model: coins per hour from the real pay and clock; every price inside its tier's band", () => {
		const CLOCK = require(join(SRC, "shared/sim/clock.ts"));
		// the day the model counts is the clock's own: integrate one whole day with the world's step
		let t = 6;
		let seconds = 0;
		while (seconds < 2000) {
			const next = CLOCK.advanceClock(t, 1 / 60);
			seconds += 1 / 60;
			if (next >= 24) {
				t = next - 24;
				if (t >= 6) break;
			} else {
				if (t < 6 && next >= 6 && seconds > 1) break;
				t = next;
			}
		}
		check(
			Math.abs(seconds - SHOP.GAME_DAY_SECONDS) < 0.5,
			`a game day is ${SHOP.GAME_DAY_SECONDS.toFixed(1)} real seconds, as the world's clock runs it`,
			`${seconds.toFixed(1)} s integrated`,
		);
		for (const [name, prof] of Object.entries(INCOME_PROFILES)) {
			const perHour = SHOP.coinsPerHour(prof);
			const byHand =
				(3600 / SHOP.GAME_DAY_SECONDS) * prof.paidDays * ECONOMY.COINS_PER_DAY +
				prof.recordsPerHour * ECONOMY.MILESTONE_BONUS +
				prof.bossesPerHour * ECONOMY.COINS_PER_BOSS;
			check(
				Math.abs(perHour - byHand) < 1e-9 && prof.paidDays > 0 && prof.paidDays <= 1,
				`${name} player: ${perHour.toFixed(1)} coins an hour (days ${prof.paidDays}, bosses ${prof.bossesPerHour}/h, records ${prof.recordsPerHour}/h)`,
			);
		}
		const n = SHOP.coinsPerHour(INCOME_PROFILES.new);
		const s = SHOP.coinsPerHour(INCOME_PROFILES.strong);
		check(n < avg && avg < s, "a new player earns less than an average one, who earns less than a strong one");
		// every product in its band
		const out = [];
		for (const x of [...SHOP_PACKS, ...COSTUMES]) {
			const band = PRICE_TIERS[x.tier];
			const h = hours(x.price);
			if (band === undefined || !(h >= band.min && h <= band.max))
				out.push(`${x.name} ${x.price}: ${h.toFixed(1)} h, ${x.tier} is ${band?.min}-${band?.max} h`);
			if (!Number.isInteger(x.price) || x.price <= 0) out.push(`${x.name}: ${x.price} is not a whole price`);
		}
		check(
			out.length === 0,
			"every pack and cosmetic costs the hours of average play its tier promises",
			out.join("; "),
		);
		for (const c of COSTUMES)
			info(
				`${c.name.padEnd(13)} ${String(c.price).padStart(4)} coins  ${c.tier.padEnd(6)} ${hours(c.price).toFixed(1)} h`,
			);
		for (const p of SHOP_PACKS)
			info(
				`${p.name.padEnd(18)} ${String(p.price).padStart(3)} coins  ${p.tier.padEnd(7)} ${hours(p.price).toFixed(1)} h`,
			);
		check(
			COSTUMES.every(c => ["common", "rare", "top"].includes(c.tier)) &&
				SHOP_PACKS.every(p => ["starter", "supply", "rental"].includes(p.tier)),
			"a cosmetic kept for good is common, rare or top; a pack is a starter, a supply or a rental",
		);
		// the tiers are ordered: each cosmetic tier costs more than every cosmetic of the one below
		const byTier = tier => COSTUMES.filter(c => c.tier === tier).map(c => c.price);
		check(
			byTier("common").length > 0 &&
				byTier("rare").length > 0 &&
				byTier("top").length > 0 &&
				Math.max(...byTier("common")) < Math.min(...byTier("rare")) &&
				Math.max(...byTier("rare")) < Math.min(...byTier("top")),
			"common < rare < top, with something in each",
		);
		// the early game: the gift buys a starter pack at once, and play alone buys one soon
		const starters = SHOP_PACKS.filter(p => p.tier === "starter");
		check(
			starters.length > 0 && starters.every(p => p.price <= ECONOMY.STARTING_COINS),
			`the welcome gift (${ECONOMY.STARTING_COINS}) buys any starter pack on the first visit`,
			starters.map(p => `${p.name} ${p.price}`).join(", "),
		);
		const cheapest = Math.min(...SHOP_PACKS.map(p => p.price));
		check(
			cheapest / n <= ECONOMY_TARGETS.newPlayerFirstPackHours,
			`a new player's play alone buys the cheapest pack within ${ECONOMY_TARGETS.newPlayerFirstPackHours} h`,
			`${(cheapest / n).toFixed(1)} h`,
		);
		const firstCommon = Math.min(...byTier("common"));
		info(
			`a new player's first common cosmetic: ${((firstCommon - 0) / n).toFixed(1)} h of play (${((firstCommon - ECONOMY.STARTING_COINS) / n).toFixed(1)} h with the gift kept)`,
		);
		// the long tail: the top tier costs even a strong player a long time; the whole wardrobe much more
		const top = Math.min(...byTier("top"));
		check(
			top / s >= ECONOMY_TARGETS.topTierStrongHours,
			`a top-tier cosmetic costs even a strong player ${ECONOMY_TARGETS.topTierStrongHours} h or more`,
			`${(top / s).toFixed(1)} h`,
		);
		const all = COSTUMES.reduce((a, c) => a + c.price, 0);
		info(
			`the whole wardrobe: ${all} coins -- ${hours(all).toFixed(0)} h of average play, ${(all / s).toFixed(0)} h strong`,
		);
		// a pet pack rents the pet: a fraction of keeping it for good, never more
		const rentals = SHOP_PACKS.filter(p => p.tier === "rental");
		const badRent = rentals.filter(p => {
			const pet = SHOP.petOfPack(p);
			const kept = SHOP.costumeForEquip(pet);
			return pet < 0 || kept === undefined || p.price > kept.price * SHOP.PET_RENTAL_SHARE;
		});
		check(
			rentals.length > 0 && badRent.length === 0,
			`a pet pack costs at most ${SHOP.PET_RENTAL_SHARE * 100}% of the same pet kept for good`,
			badRent.map(p => p.name).join(", "),
		);
		check(
			SHOP_PACKS.every(p => (p.tier === "rental") === SHOP.petOfPack(p) >= 0),
			"the rentals are exactly the pet packs",
		);
		// ...and a rental lasts ONE LIFE: a New game or the town's end (MP-22) takes the pet (`resetRun`), so it is priced
		// against the life it lasts, and renting it life after life soon costs more than keeping it
		const life = INCOME_PROFILES.average.lifeHours;
		const share = ECONOMY_TARGETS.rentalShareOfLife;
		const lifeBad = rentals.filter(p => hours(p.price) > share * life);
		check(
			rentals.length > 0 && lifeBad.length === 0,
			`a pet pack costs at most ${share * 100}% of the average life it lasts (${life} h), so that life earns it back`,
			rentals.map(p => `${p.name} ${hours(p.price).toFixed(1)} h`).join(", "),
		);
		check(
			INCOME_PROFILES.new.lifeHours < life && life < INCOME_PROFILES.strong.lifeHours,
			"a new player's life is shorter than an average one's, which is shorter than a strong one's",
		);
		for (const p of rentals) {
			const kept = SHOP.costumeForEquip(SHOP.petOfPack(p));
			const lives = kept.price / p.price;
			info(
				`${p.name}: renting it every life passes keeping it for good after ${lives.toFixed(1)} lives (~${(lives * life).toFixed(0)} h of average play)`,
			);
		}
		// Robux (MON-07 as amended): the same cosmetic, at the Robux its coin price's hours of play are worth
		const band = ECONOMY_TARGETS.robuxPerHour;
		const robuxOut = COSTUMES.filter(c => {
			const r = SHOP.ROBUX_TIER_PRICE[c.tier];
			return r === undefined || !(r / hours(c.price) >= band.min && r / hours(c.price) <= band.max);
		});
		check(
			robuxOut.length === 0,
			`every costume's Robux price is ${band.min}-${band.max} Robux per hour of average play its coin price asks`,
			COSTUMES.map(
				c =>
					`${c.name} ${SHOP.ROBUX_TIER_PRICE[c.tier]}: ${(SHOP.ROBUX_TIER_PRICE[c.tier] / hours(c.price)).toFixed(1)}/h`,
			).join(", "),
		);
		check(
			Object.keys(SHOP.ROBUX_TIER_PRICE).every(t => ["common", "rare", "top"].includes(t)) &&
				SHOP.ROBUX_TIER_PRICE.common < SHOP.ROBUX_TIER_PRICE.rare &&
				SHOP.ROBUX_TIER_PRICE.rare < SHOP.ROBUX_TIER_PRICE.top,
			"only the cosmetic tiers have a Robux price (never a pack, a rental or a Rebirth), common < rare < top",
			JSON.stringify(SHOP.ROBUX_TIER_PRICE),
		);
		// the Rebirth: cheap enough for a first mistake, a real decision by the third, dear by the fifth
		const r = d => hours(rebirthPrice(d));
		const T = ECONOMY_TARGETS;
		check(
			r(0) >= T.firstRebirth.min && r(0) <= T.firstRebirth.max,
			`the first Rebirth of a life: ${rebirthPrice(0)} coins, ${r(0).toFixed(1)} h (${T.firstRebirth.min}-${T.firstRebirth.max} h)`,
		);
		check(r(2) >= T.thirdRebirthMinHours, `the third: ${rebirthPrice(2)} coins, ${r(2).toFixed(1)} h`);
		check(r(4) >= T.fifthRebirthMinHours, `the fifth: ${rebirthPrice(4)} coins, ${r(4).toFixed(1)} h`);
		const steps = [0, 1, 2, 3, 4, 5, 6, 7].map(rebirthPrice);
		check(
			steps.every((v, i) => i === 0 || v - steps[i - 1] > (i >= 2 ? steps[i - 1] - steps[i - 2] : 0)),
			"each continue costs more than the last, by more each time",
			steps.join(", "),
		);
	});

	/** the REAL client screens, built in a child process (the two fake Robloxes cannot share one): what they show */
	function uiRun(input) {
		const dir = mkdtempSync(join(tmpdir(), "pz-shop-"));
		try {
			const inPath = join(dir, "in.json");
			const outPath = join(dir, "out.json");
			writeFileSync(inPath, JSON.stringify(input));
			try {
				execFileSync(process.execPath, [SELF, "--ui", inPath, outPath], {
					stdio: ["ignore", "pipe", "pipe"],
					env: process.env,
				});
			} catch (e) {
				throw new Error(`the UI process failed: ${String(e.stderr ?? e).slice(0, 800)}`);
			}
			return JSON.parse(readFileSync(outPath, "utf8"));
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	}

	// ================================================================================================ the server phases

	const P = require(join(SRC, "shared/net/protocol.ts"));
	const charged = { packs: {}, costumes: {}, rebirth: {} };
	const results = {};

	section("3) shown = charged, granted = unlocked: every pack, costume and Rebirth through the real server", () => {
		const s = bootServer();
		const INV = require(join(SRC, "shared/sim/inventory.ts"));
		const SAVE = require(join(SRC, "shared/game/save.ts"));
		s.sim.clock.setClock(10);
		const buyer = s.join(newUser(), "buyer");
		results.buyerId = buyer.UserId;
		const watcher = s.join(newUser(), "watcher");
		const ack = s.loadAck(buyer);
		results.fresh = clone(ack.save);
		const save = s.save(buyer);
		check(
			ack.status === "new" && save.money === ECONOMY.STARTING_COINS,
			`a new save starts with the welcome gift: ${save.money} coins (status ${ack.status})`,
		);
		const gift = s.economy(buyer.UserId).find(r => r.sku === "Welcome gift");
		check(gift?.amount === ECONOMY.STARTING_COINS, "…logged once as the Welcome gift Source of that amount");
		s.immortal.add(watcher);
		s.immortal.add(buyer);
		s.enter(watcher);

		// ---- packs: bought in the lobby, charged the catalogue's price, delivered on entering
		const sinksBefore = s.economy(buyer.UserId).filter(r => r.flow === "Sink").length;
		for (const p of SHOP_PACKS) {
			s.run(0.6);
			save.money = p.price + 5;
			const before = save.money;
			const r = s.shop(buyer, { kind: "buyPack", packId: p.id, nonce: 500 + p.id, price: 0, money: 1e6 });
			charged.packs[p.id] = {
				ok: r.ok,
				price: r.price,
				taken: before - save.money,
				bought: save.packsBought[p.id],
			};
			s.run(0.6);
			const again = s.shop(buyer, { kind: "buyPack", packId: p.id, nonce: 500 + p.id });
			charged.packs[p.id].replay = again.ok === true && before - save.money === p.price;
		}
		const packBad = SHOP_PACKS.filter(p => {
			const c = charged.packs[p.id];
			return !(c.ok && c.price === p.price && c.taken === p.price && c.bought === 1 && c.replay);
		});
		check(
			packBad.length === 0,
			"every pack: accepted, the answer's price and the coins taken are the catalogue price (a `price: 0` and a `money` in the request are never read); replayed, charged once",
			packBad.map(p => `${p.name} ${JSON.stringify(charged.packs[p.id])}`).join("; "),
		);
		const packSinks = s
			.economy(buyer.UserId)
			.filter(r => r.flow === "Sink")
			.slice(sinksBefore);
		check(
			packSinks.length === SHOP_PACKS.length &&
				SHOP_PACKS.every((p, i) => packSinks[i]?.sku === p.name && packSinks[i].amount === p.price),
			"analytics: one Shop Sink per pack, its catalogue name and price -- none for the replays",
			packSinks.map(r => `${r.sku} ${r.amount}`).join(", "),
		);
		// a second pet pack while the first is on its way: the pet is coming, nothing to sell (packPetOwned)
		const pigeonPack = packNamed("Pet Pigeon");
		s.run(0.6);
		save.money = 1000;
		const dup = s.shop(buyer, { kind: "buyPack", packId: pigeonPack.id });
		check(
			dup.ok === false && dup.reason === "owned" && save.money === 1000 && save.packsBought[pigeonPack.id] === 1,
			"a second Pet Pigeon while the first is pending: refused as owned, nothing charged",
			`${dup.reason}, ${save.money}`,
		);
		// delivered: on entering the city, every item of every pack, the count its card shows
		const before = SHOP_PACKS.map(p => p.items.map(it => INV.countItem(save, it.kind, it.index)));
		s.enter(buyer);
		s.run(0.6);
		const undelivered = [];
		SHOP_PACKS.forEach((p, i) =>
			p.items.forEach((it, k) => {
				const now = INV.countItem(save, it.kind, it.index);
				// the same item in two packs (Steel) counts both
				const expected =
					before[i][k] +
					SHOP_PACKS.reduce(
						(a, q) =>
							a +
							q.items
								.filter(x => x.kind === it.kind && x.index === it.index)
								.reduce((b, x) => b + x.count, 0),
						0,
					);
				if (now !== expected) undelivered.push(`${p.name}: ${nameOf(it.kind, it.index)} ${now} != ${expected}`);
			}),
		);
		check(
			undelivered.length === 0 && SHOP_PACKS.every(p => save.packsOpened[p.id] === save.packsBought[p.id]),
			"every pack is delivered into the backpack on entering the city, item by item, exactly once",
			undelivered.slice(0, 4).join("; "),
		);
		s.run(0.6);
		const had = s.shop(buyer, { kind: "buyPack", packId: pigeonPack.id });
		check(
			had.ok === false && had.reason === "owned",
			"with its pigeon in the backpack, the Pet Pigeon is refused as owned",
			had.reason,
		);

		// ---- costumes: charged the catalogue's price, owned, refused a second time
		s.exit(buyer);
		const costumeSinks0 = s.economy(buyer.UserId).filter(r => r.flow === "Sink").length;
		for (const c of COSTUMES) {
			s.run(0.6);
			save.money = c.price + 3;
			const r = s.shop(buyer, { kind: "buyCostume", costumeId: c.id, price: 1 });
			charged.costumes[c.id] = { ok: r.ok, price: r.price, taken: c.price + 3 - save.money };
			s.run(0.6);
			const again = s.shop(buyer, { kind: "buyCostume", costumeId: c.id });
			charged.costumes[c.id].again = again.reason;
			charged.costumes[c.id].after = save.money;
		}
		const costumeBad = COSTUMES.filter(c => {
			const x = charged.costumes[c.id];
			return !(
				x.ok &&
				x.price === c.price &&
				x.taken === c.price &&
				x.again === "owned" &&
				x.after === 3 &&
				save.costumes[c.id] === 1
			);
		});
		check(
			costumeBad.length === 0,
			"every costume: the answer's price and the coins taken are the catalogue's (a `price: 1` is never read), it is owned, and a second purchase is refused as owned for nothing",
			costumeBad.map(c => `${c.name} ${JSON.stringify(charged.costumes[c.id])}`).join("; "),
		);
		const costumeSinks = s
			.economy(buyer.UserId)
			.filter(r => r.flow === "Sink")
			.slice(costumeSinks0);
		check(
			costumeSinks.length === COSTUMES.length &&
				COSTUMES.every(
					(c, i) =>
						costumeSinks[i]?.sku === c.name &&
						costumeSinks[i].amount === c.price &&
						costumeSinks[i].fields?.CustomField01 === "Category - Costume",
				),
			"analytics: one Shop Sink per costume, its name and price, Category - Costume",
		);
		// worn from the wardrobe, out of the world (the Equip verb), and drawn for everybody (MON-04)
		const cowboy = costume("Cowboy");
		const eagle = costume("Eagle");
		s.verb(buyer, P.IntentKind.Equip, cowboy.equipId, 0, 1);
		s.verb(buyer, P.IntentKind.Equip, eagle.equipId, 0, 2);
		s.run(0.3);
		check(
			save.equipOutfit === cowboy.equipId && save.equipPet === eagle.equipId,
			"the wardrobe's Equip wears the bought Cowboy and Eagle (out of the world, on the session's save)",
			`${save.equipOutfit} / ${save.equipPet}`,
		);
		s.remote("World").sent.length = 0;
		s.enter(buyer);
		s.run(0.6);
		const seen = s
			.worldEventsTo(watcher)
			.filter(
				e => (e.t === P.WorldEv.PlayerJoined && e.userId === buyer.UserId) || e.t === P.WorldEv.PlayerProfile,
			);
		const buyerSlot = s.host.playerOf(buyer).slot;
		const look = seen.filter(e => e.slot === buyerSlot).pop();
		check(
			look !== undefined && look.outfit === COS.OutfitLook.Cowboy && look.pet === COS.PetLook.Eagle,
			"another player is sent the buyer's Cowboy and Eagle on the wire (MON-04: what is bought is seen)",
			JSON.stringify(look),
		);
		check(
			SAVE.outfitLookOf(save) === COS.OutfitLook.Cowboy && SAVE.petLookOf(save) === COS.PetLook.Eagle,
			"…the looks the server itself draws from the save (outfitLookOf / petLookOf)",
		);

		// ---- the Rebirth: continue after continue, the price of rebirthPrice(deathCount), in a life
		const rebirthSinks0 = s.economy(buyer.UserId).filter(r => r.sku === "Rebirth").length;
		for (let d = 0; d <= 4; d++) {
			s.run(0.6);
			const price = rebirthPrice(save.deathCount);
			save.money = price - 1;
			s.kill(buyer);
			s.run(0.3);
			const poor = s.shop(buyer, { kind: "rebirth", runRev: save.runRev });
			s.run(0.6);
			save.money = price + 2;
			const deaths = save.deathCount;
			const r = s.shop(buyer, { kind: "rebirth", runRev: save.runRev });
			charged.rebirth[deaths] = {
				ok: r.ok,
				price: r.price,
				taken: price + 2 - save.money,
				poor: poor.reason,
				standing: s.host.playerOf(buyer)?.state.dead === false,
			};
			s.immortal.add(buyer);
			s.run(0.3);
		}
		const rebirthBad = [0, 1, 2, 3, 4].filter(d => {
			const x = charged.rebirth[d];
			return !(
				x &&
				x.ok &&
				x.price === rebirthPrice(d) &&
				x.taken === rebirthPrice(d) &&
				x.poor === "funds" &&
				x.standing
			);
		});
		check(
			rebirthBad.length === 0,
			"Rebirths 1 to 5 of a life: refused one coin short, then charged exactly rebirthPrice(deathCount), standing up",
			rebirthBad.map(d => `${d}: ${JSON.stringify(charged.rebirth[d])}`).join("; "),
		);
		const rebirthSinks = s
			.economy(buyer.UserId)
			.filter(r => r.sku === "Rebirth")
			.slice(rebirthSinks0);
		check(
			rebirthSinks.length === 5 && rebirthSinks.every((r, i) => r.amount === rebirthPrice(i)),
			"analytics: one Rebirth Sink per continue, at its price",
			rebirthSinks.map(r => r.amount).join(", "),
		);

		// ---- refusals: nothing moves, nothing is logged
		s.run(3);
		save.money = 1000;
		const snapshot = () => JSON.stringify({ m: save.money, b: save.packsBought, c: save.costumes, r: save.runRev });
		const before2 = snapshot();
		const logged = s.log.filter(r => r.kind === "economy").length;
		const junk = [];
		const ask = req => {
			s.run(0.6);
			junk.push([JSON.stringify(req), s.shop(buyer, req).reason]);
		};
		for (const id of [99, -1, 0.5, "0", null, {}]) ask({ kind: "buyPack", packId: id });
		for (const id of [COSTUMES.length, -1, 1.5, "2", undefined]) ask({ kind: "buyCostume", costumeId: id });
		ask({ kind: "buyCostume", costumeId: cowboy.id });
		ask({ kind: "buyCoins", amount: 100 });
		ask({ kind: "rebirth", runRev: save.runRev });
		ask({ kind: "rebirth", runRev: save.runRev - 1 });
		ask({ kind: "grant", costumeId: 0 });
		check(
			snapshot() === before2 && s.log.filter(r => r.kind === "economy").length === logged,
			"refused: junk pack and costume ids, a costume already owned, an unknown kind, a Rebirth for a living body or a stale run -- nothing moved, no Sink",
			junk.map(([q, r]) => `${r}`).join(","),
		);
		check(
			junk.slice(0, 11).every(([, r]) => r === "invalid") &&
				junk[11][1] === "owned" &&
				junk[13][1] === "invalid" &&
				junk[14][1] === "outdated",
			"…each for its reason: invalid, owned, invalid (alive), outdated (stale run)",
			junk.map(([, r]) => r).join(","),
		);
		// a report cannot write coins, costumes, packs or the Rebirth count
		s.run(11);
		s.report(buyer, {
			money: 99999,
			costumes: COSTUMES.map(() => 0),
			packsBought: SHOP_PACKS.map(() => 9),
			packsOpened: SHOP_PACKS.map(() => 0),
			deathCount: 0,
			runRev: save.runRev,
		});
		s.run(0.3);
		check(
			snapshot() === before2 && save.deathCount === 5,
			"a report saying money 99999, no costumes, 9 of every pack and no Rebirths moves none of them",
			`${save.money}, deaths ${save.deathCount}`,
		);

		// ---- saved: the purchase reaches the DataStore by the event save (SAV-01), coins and costume together
		s.run(20);
		const stored = s.stored(buyer.UserId);
		check(
			stored !== undefined &&
				stored.money === save.money &&
				COSTUMES.every(c => stored.costumes[c.id] === 1) &&
				stored.equipOutfit === cowboy.equipId &&
				stored.equipPet === eagle.equipId,
			"the purchases are in the DataStore within the event-save delay: the coins left, every costume, what is worn",
			stored === undefined ? "nothing stored" : `money ${stored.money}`,
		);

		// ---- the DataStore failing: the purchase waits in the session, and lands with the retry, whole
		const santa = costume("Santa");
		const unluckyId = newUser();
		const stake = SAVE.defaultSave();
		Object.assign(stake, { money: santa.price + 11, tutorialDone: true, firstInstall: false });
		s.storeSave(unluckyId, stake);
		const unlucky = s.join(unluckyId, "unlucky");
		const us = s.save(unlucky);
		s.run(20);
		const beforeFail = s.stored(unluckyId);
		// the DataStore is down for the first 10 s after the purchase: every write in that window throws
		s.saveStore().fail.update = 1e9;
		const bought = s.shop(unlucky, { kind: "buyCostume", costumeId: santa.id });
		let torn = false;
		let landed = -1;
		let duringOutage;
		for (let i = 0; i < 60; i++) {
			if (i === 10) {
				duringOutage = s.stored(unluckyId);
				s.saveStore().fail.update = 0;
			}
			s.run(1);
			const st = s.stored(unluckyId);
			const paid = st?.money === 11;
			const owns = st?.costumes[santa.id] === 1;
			if (paid !== owns) torn = true;
			if (paid && owns && landed < 0) landed = i + 1;
		}
		check(
			bought.ok &&
				us.money === 11 &&
				us.costumes[santa.id] === 1 &&
				beforeFail?.money === santa.price + 11 &&
				beforeFail.costumes[santa.id] === 0,
			"a purchase while the DataStore fails is still made in the session (the store held the coins, no costume)",
		);
		check(
			duringOutage?.money === santa.price + 11 && duringOutage.costumes[santa.id] === 0 && !torn && landed > 10,
			"…the failed writes land nothing, the retry after the outage lands the coins and the costume together, never one alone",
			`landed after ${landed} s`,
		);

		// ---- leave cleanly: the next server finds everything
		s.quit(buyer);
		s.run(1);
		const left = s.stored(buyer.UserId);
		results.leftMoney = left?.money;
		check(
			left !== undefined && COSTUMES.every(c => left.costumes[c.id] === 1),
			"leaving writes the save with everything bought",
		);

		// ---- a crash before any write: coins and costume are lost TOGETHER (nobody pays for nothing)
		const crasherId = newUser();
		const base = SAVE.defaultSave();
		base.money = 500;
		base.tutorialDone = true;
		base.firstInstall = false;
		s.storeSave(crasherId, base);
		const crasher = s.join(crasherId, "crasher");
		const cs = s.save(crasher);
		const zombie = costume("Zombie");
		cs.money = zombie.price + 7;
		const crashBuy = s.shop(crasher, { kind: "buyCostume", costumeId: zombie.id });
		results.crash = { id: crasherId, bought: crashBuy.ok };
		// the process dies here: no BindToClose, no leave, no timers of it ever run again
		timers.length = 0;
		globalThis.__crashed = s;
	});

	section("4) another server: what was bought is still owned and worn; a crash lost coins and item together", () => {
		const a = globalThis.__crashed;
		if (a === undefined) throw new Error("section 3 did not leave its server");
		// a crashed server's lock goes stale before anybody can take the save over (LOCK_STALE)
		clockNow += 400;
		const s = bootServer();
		const buyer = s.join(results.buyerId, "buyer");
		s.run(0.3);
		const ack = s.loadAck(buyer);
		const save = ack?.save;
		results.owned = clone(save);
		check(
			ack?.status === "ok" && COSTUMES.every(c => save.costumes[c.id] === 1) && save.money === results.leftMoney,
			"a rejoin on a new server loads every costume owned and the coins as they were left",
			`${ack?.status}, money ${save?.money}`,
		);
		check(
			save.equipOutfit === costume("Cowboy").equipId && save.equipPet === costume("Eagle").equipId,
			"…and the outfit and pet still worn",
		);
		const crasher = s.join(results.crash.id, "crasher");
		s.run(0.3);
		const cs = s.save(crasher);
		check(
			results.crash.bought && cs.money === 500 && cs.costumes[costume("Zombie").id] === 0,
			"the crashed server's purchase never landed: the next server has the coins AND no costume (never one alone)",
			`money ${cs.money}, zombie ${cs.costumes[costume("Zombie").id]}`,
		);
		globalThis.__second = s;
	});

	section(
		"5) earned: the welcome pack knob, a midnight with its record, a boss -- pushed once, and what they paid",
		() => {
			const s0 = globalThis.__second;
			if (s0 === undefined) throw new Error("section 4 did not leave its server");
			// the welcome-pack knob (docs/ANALYTICS.md §12): a new save is given pack 0, pending, for no coins
			const s = bootServer(makeConfigService({ pz_welcome_pack: 0 }));
			const welcomed = s.join(newUser(), "welcomed");
			const ws = s.save(welcomed);
			results.welcomed = clone(ws);
			check(
				ws.packsBought[0] === 1 && ws.money === ECONOMY.STARTING_COINS,
				`pz_welcome_pack 0: the ${SHOP_PACKS[0].name} is pending and the gift is intact (${ws.money})`,
			);
			check(
				s.economy(welcomed.UserId).every(r => r.flow === "Source"),
				"…and no Sink: a gift is not a purchase",
			);
			// a veteran on day 4 of a life with a record of 4: midnight makes day 5, a new record on a multiple of 5
			const { defaultSave } = require(join(SRC, "shared/game/save.ts"));
			const vetId = newUser();
			const vet = defaultSave();
			Object.assign(vet, { day: 4, bestDay: 4, money: 100, tutorialDone: true, firstInstall: false });
			s.storeSave(vetId, vet);
			const earner = s.join(vetId, "earner");
			const es = s.save(earner);
			s.sim.clock.setClock(23.7);
			s.immortal.add(earner);
			s.enter(earner);
			s.active.add(earner);
			const pushes0 = s.pushes(earner).length;
			const moneyAt = es.money;
			const t = s.runUntil(() => s.sim.clock.day >= 2, 60);
			s.run(1);
			const dayPushes = s
				.pushes(earner)
				.slice(pushes0)
				.filter(a => a.earned > 0);
			const paid = es.money - moneyAt;
			const want = ECONOMY.COINS_PER_DAY + ECONOMY.MILESTONE_BONUS;
			check(
				t >= 0 && paid === want && es.day === 5 && es.bestDay === 5,
				`midnight paid day 5 and its record: +${paid} coins (${ECONOMY.COINS_PER_DAY} + ${ECONOMY.MILESTONE_BONUS})`,
			);
			check(
				dayPushes.length === 1 &&
					dayPushes[0].earned === want &&
					dayPushes[0].earnedDays === 1 &&
					dayPushes[0].earnedRecords === 1 &&
					dayPushes[0].earnedBosses === 0,
				"…told ONCE, in the pushed wallet: earned, one day, one record (the coin toast's source)",
				JSON.stringify(dayPushes.map(a => [a.earned, a.earnedDays, a.earnedRecords, a.earnedBosses])),
			);
			const dayEvents = s
				.economy(earner.UserId)
				.filter(r => r.sku === "Day survived" || r.sku === "Record milestone");
			check(
				dayEvents.length === 2 &&
					dayEvents[0].amount === ECONOMY.COINS_PER_DAY &&
					dayEvents[1].amount === ECONOMY.MILESTONE_BONUS &&
					dayEvents[1].balance === es.money,
				"analytics: a Day survived Source and a Record milestone Source, ending at the balance",
				JSON.stringify(dayEvents.map(r => [r.sku, r.amount, r.balance])),
			);
			const p1 = s.pushes(earner).length;
			const m1 = es.money;
			s.killBoss([earner]);
			s.run(1);
			const bossPushes = s
				.pushes(earner)
				.slice(p1)
				.filter(a => a.earned > 0);
			check(
				es.money - m1 === ECONOMY.COINS_PER_BOSS &&
					bossPushes.length === 1 &&
					bossPushes[0].earned === ECONOMY.COINS_PER_BOSS &&
					bossPushes[0].earnedBosses === 1,
				`a boss pays +${ECONOMY.COINS_PER_BOSS}, told once in the next push`,
				JSON.stringify(bossPushes.map(a => [a.earned, a.earnedBosses])),
			);
			// every coin of this session is one economy event, and each balance follows from the one before
			let money = 100;
			let chained = true;
			for (const r of s.economy(earner.UserId)) {
				money += r.flow === "Source" ? r.amount : -r.amount;
				if (r.balance !== money) chained = false;
			}
			check(
				chained && money === es.money,
				"analytics: the sources less the sinks are the change in coins, balance after balance",
				`100 -> ${money} (save ${es.money})`,
			);
			const later = s.pushes(earner).slice(p1 + 1);
			check(
				later.every(a => !(a.earned > 0)),
				"…and never again: the pushes after it earn nothing",
			);
			results.acks = [dayPushes[0], bossPushes[0]].filter(Boolean);
			results.dayPaid = paid;
			void s0;
		},
	);

	// ================================================================================================ the screens

	section("6) what the screens show: the real UI, built from the server's saves, against what it charged", () => {
		if (results.fresh === undefined || results.owned === undefined || results.welcomed === undefined)
			throw new Error("the server sections did not run");
		const shown = uiRun({
			fresh: results.fresh,
			owned: results.owned,
			welcomed: results.welcomed,
			acks: results.acks ?? [],
		});

		// ---- packs: the card's price = the coins taken = the answer's price
		const cardBad = SHOP_PACKS.filter((p, i) => {
			const card = shown.shopBroke.cards[i];
			const c = charged.packs[p.id];
			return !(
				num(card.price) === c.taken &&
				num(card.price) === c.price &&
				card.buy === `${p.price} more needed` &&
				card.disabled
			);
		});
		check(
			cardBad.length === 0,
			"every pack card shows the price the server takes; with 0 coins its Buy says that price is missing, disabled",
			cardBad
				.map(
					p =>
						`${p.name}: ${JSON.stringify(shown.shopBroke.cards[p.id])} vs ${JSON.stringify(charged.packs[p.id])}`,
				)
				.join("; "),
		);
		check(
			shown.shopRich.cards.every(c => c.buy === "Buy" && !c.disabled),
			"with coins, every card offers Buy (a fresh survivor owns no pet)",
			shown.shopRich.cards.map(c => c.buy).join(","),
		);
		// ---- costumes: the tile's price = the details' price = the Buy = the coins taken
		const tiles = shown.wardrobeRich.filter(t => t.id !== undefined);
		const tileBad = COSTUMES.filter(c => {
			const t = tiles.find(x => x.id === c.id);
			const x = charged.costumes[c.id];
			return !(
				t &&
				t.lock &&
				num(t.amount) === x.taken &&
				t.status === `${c.price} coins` &&
				t.action === `Buy for ${c.price} coins` &&
				!t.actionDisabled &&
				x.taken === x.price
			);
		});
		check(
			tiles.length === COSTUMES.length && tileBad.length === 0,
			"every wardrobe tile, its price line and its Buy show the price the server takes",
			tileBad.map(c => `${c.name}: ${JSON.stringify(tiles.find(x => x.id === c.id))}`).join("; "),
		);
		const brokeTiles = shown.wardrobeBroke.filter(t => t.id !== undefined);
		check(
			COSTUMES.every(c => {
				const t = brokeTiles.find(x => x.id === c.id);
				return t && t.action === `${c.price} more needed` && t.actionDisabled;
			}),
			"with 0 coins every Buy says how many are missing (the price), disabled",
		);
		// ---- the Rebirth: both screens, continue by continue
		const rebBad = shown.rebirth.filter(r => {
			const c = charged.rebirth[r.deaths];
			const price = rebirthPrice(r.deaths);
			if (num(r.deathPrice) !== price || num(r.survivorButton?.split("·")[1]) !== price) return true;
			if (!r.survivorNote.includes(`Not enough coins: ${price} more needed`)) return true;
			return c !== undefined && c.taken !== price;
		});
		check(
			rebBad.length === 0 && shown.rebirth.length === 6,
			"the death screen and the Survivor screen show each continue's price, the server takes that price (continues 1-5)",
			rebBad.map(r => JSON.stringify(r)).join("; "),
		);
		// ---- the Earn coins page: its chips are what the server pays
		const chips = shown.shopBroke.earn.map(r => num(r.chip));
		check(
			chips[0] === ECONOMY.COINS_PER_DAY &&
				chips[1] === ECONOMY.MILESTONE_BONUS &&
				chips[2] === ECONOMY.COINS_PER_BOSS &&
				chips[3] === ECONOMY.STARTING_COINS &&
				results.dayPaid === chips[0] + chips[1] &&
				results.fresh.money === chips[3],
			"Earn coins: +day, +record, +boss, +gift are what midnight, the record, a boss and a new save paid",
			chips.join(" "),
		);
		check(
			shown.shopBroke.earn[1].how.endsWith(`multiple of ${ECONOMY.MILESTONE_EVERY}.`),
			"the record row says the step the server pays on",
			shown.shopBroke.earn[1].how,
		);
		// ---- the toasts
		check(
			shown.welcome.includes(`+${results.fresh.money} coins`),
			"a new save's greeting says the gift the server gave",
			shown.welcome,
		);
		check(
			shown.earned.length === 2 &&
				shown.earned[0] === `+${results.dayPaid} coins   Day survived ×1  ·  Record day ×1` &&
				shown.earned[1] === `+${ECONOMY.COINS_PER_BOSS} coins   Boss defeated ×1`,
			"the coin toast, from the server's pushes: a midnight with its record, a boss",
			shown.earned.join(" | "),
		);
		// ---- after the rejoin: the wardrobe, the shop and the lobby show everything owned
		const owned = shown.wardrobeOwned.filter(t => t.id !== undefined);
		const cowboy = costume("Cowboy");
		const eagle = costume("Eagle");
		const ownBad = COSTUMES.filter(c => {
			const t = owned.find(x => x.id === c.id);
			const worn = c.id === cowboy.id || c.id === eagle.id;
			return !(
				t &&
				!t.lock &&
				t.status === (worn ? "Equipped" : "Owned") &&
				t.action === (worn ? "Unequip" : "Equip")
			);
		});
		check(
			ownBad.length === 0,
			"after the rejoin the wardrobe shows every costume owned, the Cowboy and the Eagle equipped, each with its action",
			ownBad.map(c => `${c.name}: ${JSON.stringify(owned.find(x => x.id === c.id))}`).join("; "),
		);
		const counts = shown.wardrobeOwned.filter(t => t.page !== undefined).map(t => t.count);
		const outfits = COSTUMES.filter(c => COS.cosmeticSlotOf(c.equipId) === 4).length;
		const pets = COSTUMES.length - outfits;
		check(
			counts[0] === `${outfits} / ${outfits}` && counts[1] === `${pets} / ${pets}`,
			"…its counts are full",
			counts.join(", "),
		);
		check(
			shown.lobbyOwned === `${COSTUMES.length} / ${COSTUMES.length}` &&
				shown.lobbyFresh === `0 / ${COSTUMES.length}`,
			"the lobby's Wardrobe plate counts the collection: 0 before, all after",
			`${shown.lobbyFresh} -> ${shown.lobbyOwned}`,
		);
		const petCards = SHOP_PACKS.filter(p => SHOP.petOfPack(p) >= 0).map(p => shown.shopOwned.cards[p.id]);
		check(
			petCards.length > 0 && petCards.every(c => c.buy === "Owned" && c.disabled),
			"the shop's pet packs say Owned and do not sell (the pets are kept for good)",
			petCards.map(c => c.buy).join(","),
		);
		check(
			shown.shopWelcomed.cards[0].pending === "Pending ×1",
			"the welcome pack's card says Pending ×1 until the city",
			String(shown.shopWelcomed.cards[0].pending),
		);
	});

	// ================================================================================================ 7. Robux, statically

	section(
		"7) Robux only where it belongs: the server's one module, the wardrobe's one button, cosmetics only",
		() => {
			const files = [];
			const walk = dir => {
				for (const f of readdirSync(dir)) {
					const p = join(dir, f);
					if (statSync(p).isDirectory()) walk(p);
					else if (p.endsWith(".ts")) files.push(p);
				}
			};
			walk(SRC);
			const rel = f =>
				f
					.slice(SRC.length + 1)
					.split("\\")
					.join("/");
			const code = f =>
				readFileSync(f, "utf8")
					.replace(/\/\*[\s\S]*?\*\//g, "")
					.replace(/\/\/.*$/gm, "");
			const receipts = files.filter(f => /ProcessReceipt|PromptProductPurchase\b/.test(code(f))).map(rel);
			check(
				receipts.length === 1 && receipts[0] === "server/save/robux.ts",
				"ProcessReceipt and PromptProductPurchase live in server/save/robux.ts alone: the client never opens a prompt",
				receipts.join(", "),
			);
			const robuxCode = code(join(SRC, "server/save/robux.ts"));
			check(
				!/\.money\b/.test(robuxCode) && !/packsBought|deathCount|\.exp\b|skillPoint/.test(robuxCode),
				"the Robux module never touches coins, packs, a Rebirth or XP (MON-01: cosmetics only)",
			);
			const asking = files.filter(f => rel(f).startsWith("client/") && /robuxCostume/.test(code(f))).map(rel);
			check(
				asking.length === 1 && asking[0] === "client/ui/wardrobe.ts",
				"only the wardrobe asks for a Robux prompt (never the death screen, the match menu, the pack shop or a night: BEM-02)",
				asking.join(", "),
			);
			check(
				!LANG_TABLE.some(t => /R\$/.test(t)) &&
					LANG_TABLE.includes("See Price") &&
					LANG_TABLE.includes("Robux"),
				'the game says "Robux" and "See Price" (BEM-02), never "R$" (MON-06: no real-money sign)',
			);
			const RP = require(join(SRC, "shared/data/robuxProducts.ts"));
			const names = Object.keys(RP.ROBUX_PRODUCT_IDS).sort();
			const ids = Object.values(RP.ROBUX_PRODUCT_IDS).filter(v => v !== 0);
			check(
				JSON.stringify(names) === JSON.stringify(COSTUMES.map(c => c.name).sort()) &&
					Object.values(RP.ROBUX_PRODUCT_IDS).every(v => v === 0 || (Number.isInteger(v) && v > 0)) &&
					[...new Set(ids)].length === ids.length,
				"ROBUX_PRODUCT_IDS: one entry per costume by name, 0 or a product id, no id twice",
				names.join(", "),
			);
			// docs/SHOP.md's products table (what the owner creates): every costume, at its tier's price
			const rows = new Map();
			for (const line of read("docs/SHOP.md").split("\n")) {
				const cells = line.split("|").map(c => c.trim());
				if (cells.length >= 6 && cells[1].startsWith("Last Town — ")) rows.set(cells[1].slice(12), cells);
			}
			const docBad = COSTUMES.filter(c => {
				const row = rows.get(c.name);
				return row === undefined || num(row[2]) !== SHOP.ROBUX_TIER_PRICE[c.tier] || row[3] !== c.tier;
			});
			check(
				[...rows.keys()].length === COSTUMES.length && docBad.length === 0,
				"docs/SHOP.md lists the 9 developer products, each at its tier's Robux price",
				docBad.map(c => c.name).join(", "),
			);
			check(!/Nenhum produto em Robux/.test(read("docs/SHOP.md")), "…and no longer says there is none");
		},
	);

	// ================================================================================================ 8. Robux, live

	section(
		"8) Robux: the same costume, the server's own prompt, one grant per receipt and only once it is written",
		() => {
			const baseTypeIs = globalThis.typeIs;
			globalThis.typeIs = (v, t) =>
				t === "EnumItem"
					? typeof v === "object" && v !== null && typeof v.EnumType === "string"
					: baseTypeIs(v, t);
			const GRANTED = "ProductPurchaseDecision.PurchaseGranted";
			const LATER = "ProductPurchaseDecision.NotProcessedYet";
			const IN_GAME = { EnumType: "ProductPurchaseChannel", Name: "InExperience" };
			const market = makeMarket();
			const productOf = c => 70000 + c.id;
			const priceOf = c => SHOP.ROBUX_TIER_PRICE[c.tier];
			const receipt = (userId, c, purchaseId) => ({
				PlayerId: userId,
				ProductId: productOf(c),
				PurchaseId: purchaseId,
				CurrencySpent: priceOf(c),
				CurrencyType: "CurrencyType.Robux",
				PlaceIdWherePurchased: 1,
				ProductPurchaseChannel: IN_GAME,
			});
			const santa = costume("Santa");
			const zombie = costume("Zombie");
			const eagle = costume("Eagle");
			const carolina = costume("Carolina");
			const doberman = costume("Doberman");
			const white = costume("White pigeon");

			// ---- no product configured (how the game ships): no offer, no GetProductInfo, no prompt, coins as ever
			const s = bootServer(undefined, market);
			const net = s.env.services.ReplicatedStorage.FindFirstChild("Net");
			let ROBUX = require(join(SRC, "server/save/robux.ts"));
			let RP = require(join(SRC, "shared/data/robuxProducts.ts"));
			check(
				ROBUX.activeRobuxShop() !== undefined && typeof market.ProcessReceipt === "function",
				"the server sets ProcessReceipt at boot where there is a MarketplaceService",
			);
			const plain = s.join(newUser(), "plain");
			const ps = s.save(plain);
			s.run(0.6);
			const refused = s.shop(plain, { kind: "robuxCostume", costumeId: santa.id });
			check(
				net.GetAttribute(RP.ROBUX_OFFER_ATTR) === undefined &&
					market.infoCalls === 0 &&
					market.prompts.length === 0 &&
					refused.ok === false &&
					refused.reason === "invalid",
				"no product id configured: no offer published, no GetProductInfo, See Price refused (invalid) with no prompt",
				`${net.GetAttribute(RP.ROBUX_OFFER_ATTR)}, ${market.infoCalls} info calls, ${refused.reason}`,
			);
			ps.money = santa.price;
			s.run(0.6);
			const coins = s.shop(plain, { kind: "buyCostume", costumeId: santa.id });
			check(
				coins.ok && coins.price === santa.price && ps.money === 0 && ps.costumes[santa.id] === 1,
				"…and the coin purchase is exactly as it was",
			);
			const stray = market.ProcessReceipt({ ...receipt(plain.UserId, eagle, "stray-1"), ProductId: 555 });
			check(
				stray === LATER && ps.robuxReceipts.length === 0 && ps.costumes[eagle.id] === 0,
				"a receipt for a product no costume has: NotProcessedYet, nothing granted",
			);

			// ---- the products: one per costume at its tier's price -- one priced otherwise, one off sale
			const configure = () => {
				RP = require(join(SRC, "shared/data/robuxProducts.ts"));
				ROBUX = require(join(SRC, "server/save/robux.ts"));
				for (const c of COSTUMES) RP.ROBUX_PRODUCT_IDS[c.name] = productOf(c);
				ROBUX.activeRobuxShop().verify();
			};
			for (const c of COSTUMES) market.prices.set(productOf(c), { price: priceOf(c), forSale: true });
			market.prices.set(productOf(doberman), { price: 99, forSale: true });
			market.prices.set(productOf(white), { price: priceOf(white), forSale: false });
			configure();
			const offerText = net.GetAttribute(RP.ROBUX_OFFER_ATTR);
			/** what GetProductInfo said when the offer was made (a price changes later in this section) */
			const confirmed = new Map(COSTUMES.map(c => [c.id, market.prices.get(productOf(c)).price]));
			const offer = RP.decodeRobuxOffer(offerText);
			const sold = COSTUMES.filter(c => c !== doberman && c !== white);
			check(
				sold.every(c => offer.get(c.id) === priceOf(c)) && [...offer].length === sold.length,
				"the offer on Net is every costume whose product Roblox confirms at its tier's price (49 / 149 / 349)",
				[...offer].map(([id, p]) => `${COSTUMES[id].name} ${p}`).join(", "),
			);
			check(
				!offer.has(doberman.id) && !offer.has(white.id),
				"a product priced otherwise in the Creator Hub (Doberman at 99) or off sale (White pigeon) is not offered",
			);

			// ---- the prompt: the server's, only what is not yours, and the coin purchase held meanwhile
			const buyerId = newUser();
			const buyer = s.join(buyerId, "robux");
			const bs = s.save(buyer);
			results.robuxFresh = clone(bs);
			bs.money = carolina.price;
			s.run(0.6);
			s.shop(buyer, { kind: "buyCostume", costumeId: carolina.id });
			s.run(0.6);
			s.shop(buyer, { kind: "viewShop", screen: 1 });
			const ask = c => {
				s.run(0.6);
				return s.shop(buyer, { kind: "robuxCostume", costumeId: c.id, price: 1, productId: 1 });
			};
			const own = ask(carolina);
			const unverified = ask(doberman);
			check(
				own.reason === "owned" && unverified.reason === "invalid" && market.prompts.length === 0,
				"See Price for a costume already yours: owned; for one Roblox did not confirm: invalid -- no prompt either way",
				`${own.reason}, ${unverified.reason}`,
			);
			const opened = ask(santa);
			check(
				opened.ok &&
					opened.price === 0 &&
					market.prompts.length === 1 &&
					market.prompts[0].id === productOf(santa) &&
					market.prompts[0].userId === buyerId &&
					bs.money === 0,
				"See Price for Santa: the SERVER opens Roblox's prompt for Santa's product (a `productId` in the request is never read), no coin moves",
				JSON.stringify(market.prompts),
			);
			bs.money = santa.price + 1;
			s.run(0.6);
			const race = s.shop(buyer, { kind: "buyCostume", costumeId: santa.id });
			const second = ask(zombie);
			check(
				race.reason === "pending" &&
					bs.money === santa.price + 1 &&
					bs.costumes[santa.id] === 0 &&
					second.reason === "pending" &&
					market.prompts.length === 1,
				"while it is open: Santa for coins is refused (pending, nothing charged), and no second prompt opens",
				`${race.reason}, ${second.reason}`,
			);
			market.PromptProductPurchaseFinished.Fire(buyerId, productOf(santa), false);
			const reopened = ask(santa);
			check(
				reopened.ok && market.prompts.length === 2,
				"cancelled: the costume is free again, and the prompt opens again",
			);
			market.PromptProductPurchaseFinished.Fire(buyerId, productOf(santa), true);
			s.run(0.6);
			check(bs.costumes[santa.id] === 0, "the prompt closing as purchased grants nothing (only a receipt does)");

			// ---- the receipt: granted, and WRITTEN before the answer
			const log0 = s.log.length;
			const econ0 = s.economy(buyerId).length;
			const robuxEvents = () =>
				s.log
					.slice(log0)
					.filter(
						r =>
							r.kind === "custom" &&
							r.userId === buyerId &&
							(r.name === "RobuxPurchase" || r.name === "RobuxOwned"),
					);
			const r1 = market.ProcessReceipt(receipt(buyerId, santa, "R-SANTA-1"));
			const st1 = s.stored(buyerId);
			check(
				r1 === GRANTED && bs.costumes[santa.id] === 1 && bs.money === santa.price + 1,
				"Santa's receipt: PurchaseGranted, the costume is theirs, no coin moved",
			);
			check(
				st1?.costumes[santa.id] === 1 && st1.robuxReceipts.includes(`${santa.id}:R-SANTA-1`),
				"…and the DataStore already holds the costume and the PurchaseId when it answers (not at the cadence's next write)",
				JSON.stringify(st1?.robuxReceipts),
			);
			const r1b = market.ProcessReceipt(receipt(buyerId, santa, "R-SANTA-1"));
			check(
				r1b === GRANTED &&
					bs.robuxReceipts.filter(e => e.endsWith(":R-SANTA-1")).length === 1 &&
					robuxEvents().length === 1,
				"the same receipt again: PurchaseGranted, granted once, one PurchaseId kept, one event",
			);
			const ev = robuxEvents()[0];
			check(
				ev?.name === "RobuxPurchase" &&
					ev.value === priceOf(santa) &&
					ev.fields?.CustomField01 === "Category - Costume" &&
					ev.fields?.CustomField02 === `Tier - ${santa.tier}` &&
					ev.fields?.CustomField03 === "Channel - In game",
				"analytics: one RobuxPurchase -- the Robux spent, Category - Costume, its tier, In game",
				JSON.stringify(ev),
			);
			check(s.economy(buyerId).length === econ0, "…and no Coins economy event: no coin moved");
			const funnel = s.log.filter(r => r.kind === "funnel" && r.userId === buyerId && r.funnel === "Shop");
			check(
				JSON.stringify(funnel.map(r => r.step)) === "[1,2,3]" &&
					funnel.every(r => r.session === funnel[0].session),
				"the Shop funnel of the visit: opened, tried (See Price), bought (the receipt)",
				JSON.stringify(funnel.map(r => r.step)),
			);
			s.run(0.6);
			check(
				s.pushes(buyer).at(-1)?.wallet?.costumes?.[santa.id] === 1,
				"the pushed wallet brings the costume to the wardrobe",
			);
			check(ask(santa).reason === "owned", "and See Price for it now: owned");

			// ---- the DataStore failing: NotProcessedYet, and granted once when Roblox asks again after it
			check(ask(zombie).ok === true, "(the Zombie's prompt)");
			const zombieEvents = () => robuxEvents().filter(r => r.fields?.CustomField02 === "Tier - top");
			s.saveStore().fail.update = 1e9;
			const r2 = market.ProcessReceipt(receipt(buyerId, zombie, "R-ZOMBIE-1"));
			const st2 = s.stored(buyerId);
			check(
				r2 === LATER &&
					bs.costumes[zombie.id] === 1 &&
					st2.costumes[zombie.id] === 0 &&
					!st2.robuxReceipts.some(e => e.endsWith(":R-ZOMBIE-1")) &&
					zombieEvents().length === 0,
				"the DataStore failing: NotProcessedYet -- the costume stays in the session, the store has neither it nor the PurchaseId, no event",
			);
			s.saveStore().fail.update = 0;
			const r2b = market.ProcessReceipt(receipt(buyerId, zombie, "R-ZOMBIE-1"));
			const st3 = s.stored(buyerId);
			check(
				r2b === GRANTED &&
					st3.costumes[zombie.id] === 1 &&
					st3.robuxReceipts.includes(`${zombie.id}:R-ZOMBIE-1`) &&
					bs.robuxReceipts.filter(e => e.endsWith(":R-ZOMBIE-1")).length === 1,
				"…Roblox asks again after the outage: the write lands, PurchaseGranted, granted once",
			);
			check(
				zombieEvents().length === 1 &&
					zombieEvents()[0].name === "RobuxPurchase" &&
					zombieEvents()[0].value === priceOf(zombie),
				"…and its RobuxPurchase goes out once, with the write that landed",
			);

			// ---- nothing for a receipt that is nobody's here, of an unknown product, or junk
			const kept = bs.robuxReceipts.length;
			const decisions = [
				market.ProcessReceipt(receipt(424242, eagle, "R-GONE")),
				market.ProcessReceipt({ ...receipt(buyerId, eagle, "R-UNKNOWN"), ProductId: 9999 }),
				market.ProcessReceipt({ ...receipt(buyerId, eagle, "x"), PurchaseId: undefined }),
				market.ProcessReceipt(receipt(buyerId, eagle, "a:b")),
				market.ProcessReceipt(receipt(buyerId, eagle, "x".repeat(65))),
				market.ProcessReceipt({ ...receipt(buyerId, eagle, "R-NOPLAYER"), PlayerId: "1" }),
				market.ProcessReceipt("junk"),
			];
			check(
				decisions.every(d => d === LATER) && bs.costumes[eagle.id] === 0 && bs.robuxReceipts.length === kept,
				"NotProcessedYet and nothing granted: a buyer not in this server, an unknown product, no PurchaseId, one we cannot keep, a PlayerId that is not a number, junk",
				decisions.join(","),
			);
			// the receipt's PlayerId picks the save, and nothing from a client does
			const other = s.join(newUser(), "other");
			const os2 = s.save(other);
			const r4 = market.ProcessReceipt(receipt(other.UserId, eagle, "R-OTHER"));
			check(
				r4 === GRANTED && os2.costumes[eagle.id] === 1 && bs.costumes[eagle.id] === 0,
				"another player's receipt grants THEIR save, never this buyer's",
			);
			s.run(11);
			s.report(buyer, {
				robuxReceipts: [`${eagle.id}:FAKE`],
				costumes: COSTUMES.map(() => 1),
				runRev: bs.runRev,
			});
			s.run(0.6);
			const ownedByReport = COSTUMES.filter(c => bs.costumes[c.id] === 1).map(c => c.name);
			check(
				bs.costumes[eagle.id] === 0 &&
					!bs.robuxReceipts.some(e => e.includes("FAKE")) &&
					ownedByReport.length === 3,
				"a report claiming a receipt and every costume moves neither (Carolina, Santa, Zombie stay the only ones)",
				ownedByReport.join(", "),
			);

			// ---- already owned: acknowledged, nothing new, never coins -- reported for the owner to make good
			const moneyNow = bs.money;
			const owned0 = robuxEvents().length;
			const r3 = market.ProcessReceipt(receipt(buyerId, carolina, "R-CAROLINA"));
			const ownedEv = robuxEvents().slice(owned0);
			check(
				r3 === GRANTED &&
					bs.money === moneyNow &&
					bs.robuxReceipts.includes(`${carolina.id}:R-CAROLINA`) &&
					ownedEv.length === 1 &&
					ownedEv[0].name === "RobuxOwned",
				"a receipt for a costume already owned (bought with coins): PurchaseGranted, nothing new, no coins, one RobuxOwned",
				JSON.stringify(ownedEv.map(r => r.name)),
			);

			// ---- the admin cannot take it back; a reset keeps it
			const adminId = newUser();
			require(join(SRC, "shared/admin/config.ts")).ADMIN_USER_IDS.push(adminId);
			const adm = s.join(adminId, "Owner");
			adm.LocaleId = "en-us";
			const RF = s.env.services.ReplicatedStorage.FindFirstChild("PZAdminNet")?.FindFirstChild("AdminRequest");
			clockNow += 0.3;
			const revoke = RF?.OnServerInvoke(adm, {
				kind: "edit",
				userId: buyerId,
				ops: [{ op: "costume", id: santa.id, owned: false }],
			});
			check(
				revoke?.ok === false && /Robux/.test(revoke.error ?? "") && bs.costumes[santa.id] === 1,
				"the admin panel cannot take back a costume paid in Robux: the edit is refused whole",
				JSON.stringify(revoke),
			);
			clockNow += 0.3;
			const reset = RF?.OnServerInvoke(adm, { kind: "resetSave", userId: buyerId });
			const paid = COSTUMES.filter(c => bs.costumes[c.id] === 1).map(c => c.name);
			check(
				reset?.ok === true &&
					bs.money === ECONOMY.STARTING_COINS &&
					bs.costumes[santa.id] === 1 &&
					bs.costumes[zombie.id] === 1 &&
					bs.robuxReceipts.length === kept + 1,
				"an admin reset makes a new player's save -- and what was bought with Robux stays: receipts and costumes",
				`${reset?.ok}, money ${bs.money}, ${paid.join(", ")}`,
			);

			// ---- another server: still theirs, and Roblox retrying an old receipt there grants nothing twice
			s.run(1);
			s.quit(buyer);
			s.run(1);
			const s2 = bootServer(undefined, market);
			configure();
			const net2 = s2.env.services.ReplicatedStorage.FindFirstChild("Net");
			const back = s2.join(buyerId, "robux");
			s2.run(0.3);
			const bs2 = s2.save(back);
			check(
				s2.loadAck(back)?.status === "ok" &&
					bs2.costumes[santa.id] === 1 &&
					bs2.costumes[zombie.id] === 1 &&
					bs2.robuxReceipts.includes(`${santa.id}:R-SANTA-1`),
				"another server: Santa and Zombie are still theirs, with their receipts",
			);
			const late = market.ProcessReceipt(receipt(buyerId, santa, "R-SANTA-1"));
			check(
				late === GRANTED && bs2.robuxReceipts.filter(e => e.endsWith(":R-SANTA-1")).length === 1,
				"Roblox asking again for an old receipt on the next server: PurchaseGranted, nothing twice",
			);
			s2.run(0.6);
			check(
				s2.shop(back, { kind: "robuxCostume", costumeId: santa.id }).reason === "owned",
				"See Price there: owned",
			);
			// a price changed in the Creator Hub later: caught by the next check, and no longer offered
			market.prices.set(productOf(eagle), { price: 199, forSale: true });
			ROBUX.activeRobuxShop().verify();
			s2.run(0.6);
			const changed = s2.shop(back, { kind: "robuxCostume", costumeId: eagle.id });
			check(
				changed.reason === "invalid" &&
					!RP.decodeRobuxOffer(net2.GetAttribute(RP.ROBUX_OFFER_ATTR)).has(eagle.id),
				"a price changed in the Creator Hub (the Eagle at 199): no longer offered, See Price refused",
				changed.reason,
			);

			// ---- a receipt that comes before the save: waited for (never for one who left), then decided
			const SAVE = require(join(SRC, "shared/game/save.ts"));
			const realWait = globalThis.task.wait;
			globalThis.task.wait = sec => {
				clockNow += sec ?? 0;
			};
			try {
				let calls = 0;
				const slow = {
					save: SAVE.defaultSave(),
					state: () => (++calls <= 3 ? "loading" : "ok"),
					commit: () => true,
				};
				const u1 = new ROBUX.RobuxShop(market, { net: undefined, session: () => slow });
				const d1 = u1.processReceipt(receipt(buyerId, eagle, "R-WAIT"));
				check(
					d1 === GRANTED && slow.save.costumes[eagle.id] === 1 && calls >= 4,
					"a receipt before the save loaded: waited for the load, then granted",
					`${d1}, ${calls} looks`,
				);
				const never = { save: SAVE.defaultSave(), state: () => "loading", commit: () => true };
				const u2 = new ROBUX.RobuxShop(market, { net: undefined, session: () => never });
				const t0 = clockNow;
				const d2 = u2.processReceipt(receipt(buyerId, eagle, "R-NEVER"));
				check(
					d2 === LATER &&
						u2.results.at(-1)?.outcome === "loading" &&
						clockNow - t0 >= ROBUX.RECEIPT_LOAD_WAIT_S &&
						never.save.costumes[eagle.id] === 0,
					`…a load that never ends: NotProcessedYet after ${ROBUX.RECEIPT_LOAD_WAIT_S} s, nothing granted`,
				);
				const leaving = {
					save: SAVE.defaultSave(),
					state: () => {
						back._parent = undefined;
						return "loading";
					},
					commit: () => true,
				};
				const u3 = new ROBUX.RobuxShop(market, { net: undefined, session: () => leaving });
				const d3 = u3.processReceipt(receipt(buyerId, eagle, "R-LEFT"));
				back._parent = s2.env.services.Players;
				check(
					d3 === LATER && u3.results.at(-1)?.outcome === "absent" && leaving.save.costumes[eagle.id] === 0,
					"…the buyer leaving while it waits: NotProcessedYet at once (Roblox asks again at their next join)",
				);
				const readonly = { save: SAVE.defaultSave(), state: () => "readonly", commit: () => true };
				const u4 = new ROBUX.RobuxShop(market, { net: undefined, session: () => readonly });
				check(
					u4.processReceipt(receipt(buyerId, eagle, "R-RO")) === LATER &&
						readonly.save.costumes[eagle.id] === 0,
					"…a session that cannot record a purchase (read-only, no DataStore, the lock lost): NotProcessedYet, nothing granted",
				);
			} finally {
				globalThis.task.wait = realWait;
			}

			// ---- the real wardrobe with that offer
			if (results.owned === undefined) throw new Error("section 4 did not leave the owned save");
			const shown = uiRun({
				mode: "robux",
				fresh: results.robuxFresh,
				owned: results.owned,
				offer: offerText,
				target: santa.id,
			});
			results.robuxUi = shown;
			const unequip = shown.owned.find(t => t.id === costume("Cowboy").id)?.action;
			const plainBuy = shown.rich.find(t => t.id === doberman.id)?.action;
			const richBad = COSTUMES.filter(c => {
				const t = shown.rich.find(x => x?.id === c.id);
				if (t === undefined) return true;
				const r = offer.get(c.id);
				if (r === undefined) {
					return !(
						t.status === `${c.price} coins` &&
						t.action.visible &&
						t.action.text === `Buy for ${c.price} coins` &&
						!t.coin.visible &&
						!t.robux.visible
					);
				}
				return !(
					t.status === `${c.price} coins  ·  ${r} Robux` &&
					r === confirmed.get(c.id) &&
					!t.action.visible &&
					t.coin.visible &&
					t.coin.text === `Buy for ${c.price} coins` &&
					!t.coin.disabled &&
					t.coin.variant === plainBuy.variant &&
					t.robux.visible &&
					t.robux.text === "See Price" &&
					!t.robux.disabled &&
					t.robux.variant === unequip.variant &&
					t.coin.x < t.robux.x &&
					t.coin.right === "RobuxBuy"
				);
			});
			check(
				richBad.length === 0 && plainBuy?.variant !== unequip?.variant,
				'the wardrobe shows both prices, the coins\' and the one Roblox confirmed ("250 coins  ·  149 Robux"); the coin Buy is the primary on the left, "See Price" the secondary at its right; a costume not offered is the coin panel alone',
				richBad.map(c => `${c.name}: ${JSON.stringify(shown.rich.find(x => x?.id === c.id))}`).join("; "),
			);
			const brokeBad = COSTUMES.filter(c => {
				const t = shown.broke.find(x => x?.id === c.id);
				if (!offer.has(c.id)) return false;
				return !(
					t.coin.text === `${c.price} more needed` &&
					t.coin.disabled &&
					!t.coin.selectable &&
					t.robux.visible &&
					!t.robux.disabled
				);
			});
			check(
				brokeBad.length === 0,
				"without coins the coin Buy says what is missing, disabled and out of the pad's way -- it never turns into the Robux button",
				brokeBad.map(c => c.name).join(", "),
			);
			check(
				shown.owned.every(t => !t.robux.visible && !t.coin.visible),
				"a costume already yours shows no Robux button (nor a coin Buy)",
			);
			check(
				shown.none.every(t => !t.robux.visible && !t.coin.visible && t.action.visible),
				"no offer on Net: the wardrobe is exactly the coin one, no Robux anywhere",
			);
			check(
				JSON.stringify(shown.clicked) === JSON.stringify([{ kind: "robuxCostume", costumeId: santa.id }]),
				"See Price sends the costume id and nothing else",
				JSON.stringify(shown.clicked),
			);
			check(
				shown.pendingToast === "Finish the Robux purchase first",
				"a refusal says why (pending)",
				shown.pendingToast,
			);
			check(
				JSON.stringify(shown.unlockToasts) === JSON.stringify(["Unlocked: Santa"]) &&
					!shown.afterGrant.robux.visible &&
					shown.afterGrant.action.visible &&
					shown.afterGrant.action.text === "Equip" &&
					shown.afterGrant.status === "Owned",
				'the receipt\'s wallet: "Unlocked: Santa" once, and the panel offers Equip',
				JSON.stringify({ toasts: shown.unlockToasts, after: shown.afterGrant }),
			);
			globalThis.typeIs = baseTypeIs;
		},
	);

	// ================================================================================================ 9. Rebirth at 0

	section(
		"9) the daybreak came in the lobby: the server says the Rebirth is free, the lobby shows 0, it charges 0",
		() => {
			const s = bootServer();
			const w = s.join(newUser(), "witness");
			s.immortal.add(w);
			s.enter(w);
			const a = s.join(newUser(), "patient");
			s.enter(a);
			const save = s.save(a);
			save.money = 0;
			save.deathCount = 3;
			const { DESIGN } = require(join(SRC, "shared/engine/constants.ts"));
			s.sim.clock.setClock(6 - 1.5 * DESIGN.TIME_SPEED * 1.2);
			s.kill(a);
			s.exit(a);
			const waiting = a.GetAttribute(SHOP.REBIRTH_FREE_ATTR);
			s.run(3);
			const due = a.GetAttribute(SHOP.REBIRTH_FREE_ATTR);
			check(
				waiting === undefined && due === true,
				"pz_rebirth_free: absent while the daybreak is still to come, true once it came in the lobby",
				`${waiting} -> ${due}`,
			);
			const res = s.shop(a, { kind: "rebirth", runRev: save.runRev });
			check(
				res.ok && res.price === 0 && save.money === 0 && save.deathCount === 3,
				"…and the Rebirth asked then is charged 0 (and is no continue)",
				JSON.stringify(res),
			);
			s.run(0.6);
			check(a.GetAttribute(SHOP.REBIRTH_FREE_ATTR) === undefined, "standing again: the attribute is gone");
			const ui = results.robuxUi;
			if (ui === undefined) throw new Error("section 8 did not run the screens");
			check(
				num(ui.rebirthPaid.button?.split("·")[1]) === rebirthPrice(3) &&
					ui.rebirthPaid.note.includes(`Not enough coins: ${rebirthPrice(3)} more needed`) &&
					num(ui.rebirthFree.button?.split("·")[1]) === 0 &&
					!ui.rebirthFree.note.includes("Not enough coins") &&
					ui.rebirthBack.button === ui.rebirthPaid.button,
				"the lobby's Rebirth follows the attribute: the continue's price, then 0 with nothing missing, then the price again",
				JSON.stringify([ui.rebirthPaid.button, ui.rebirthFree.button, ui.rebirthBack.button]),
			);
		},
	);

	console.log(failures === 0 ? `\nall ${checks} checks passed` : `\n${failures} of ${checks} check(s) FAILED`);
	process.exit(failures === 0 ? 0 : 1);
}

if (process.argv[2] === "--ui") runUi(process.argv[3], process.argv[4]);
else main();
