/*
 * The Backpack (in-run inventory), docs/DESIGN_RULES.md UI-11: one UI-07 window -- the owner's Wardrobe, grown into an
 * inventory -- with the item icons of UI-11 instead of rows of text.
 *
 *   ┌ ? ─────────────────────────────── Backpack ─────────────────────────────── X ┐
 *   │ [# Weapons] [# Gear] [# Usables] [# Materials] [# Craft] [# Skills (2)]         │  tabs: plate + glyph + label
 *   │ ┌ grid ─────────────────────────┐ ┌ Pistol ──────────────────────── [ ×1 ] ┐ │
 *   │ │ [▣][▣][▣][▣][▣]               │ │ [ icon ]  Weapon · Pistol               │ │  left: 5 x 5 tiles on the
 *   │ │ [▣][▣][ ][ ][ ]               │ │           Damage 25 ...                 │ │  groove (scrolls when more)
 *   │ │ ...                           │ │ notes · usage hint                      │ │  right: the details panel
 *   │ └───────────────────────────────┘ │ [              Equip               ]    │ │  and its one action
 *   └──────────────────────────────────────────────────────────────────────────────┘
 *
 * - Tabs: Weapons, Gear (the equipment), Usables, Materials, Craft, Skills. All six fit at 1120 wide with the
 *   reference's tab size (the bar is about 895 of the window's 952 units), so none is merged and the bar does not scroll.
 *   Unspent skill points are a badge on the Skills tab and a line of the Skills panel (the old "SP 0" pill).
 * - Left: a grid of tiles (client/ui/bagGrid.ts) -- the item's icon, how many, EQUIPPED as the iron face and a check,
 *   the selection in blue; a recipe tile has its station and how many times it can be made now (red "×0" when an
 *   ingredient is short, a padlock over a grey icon when the station is not near); a skill tile its level pips.
 * - Right: the details panel (client/ui/bagPanel.ts): the item card grown into a panel -- the big icon, the name,
 *   the type, the stats, the notes, the usage hint on this device -- and the one action: the steel-blue plate for
 *   the main one (Equip, Use, Eat, Unequip, Craft, Learn), an iron plate for Open Craft. There is no Drop or Split
 *   in the game, so there is none here.
 * - Mouse: a click selects; the pointer over another item shows its card as a tooltip beside the tile (the
 *   selected one's card is the panel). Pad: the selection moving onto a tile selects it (the panel follows the
 *   cursor); the panel's button is to the right. Touch: a tap selects; no tooltip.
 * - Nothing pauses (UI-06): the see-through scrim, and the damage flash above it (dangerFlash.ts).
 *
 * Every game rule (equip, unequip, use, craft) is delegated to main.client through the callbacks; the Bag only reads
 * the save to draw its state and brings it up to date after each action. The one write it does itself is spending
 * skill points.
 *
 * Built once, then only shown and updated in place (the owner: "opening the Bag and going through the tabs should
 * be instant"; npm run test:backpack counts it):
 *  - the window is built on the first open(); close() hides it;
 *  - a tab's grid is built the first time the tab is shown, then only shown / hidden: its tiles are a pool keyed by
 *    what they show, so switching tabs, selecting, moving the pointer or the pad, using and crafting create at most
 *    what new data needs (a tile for an item the grid never had, an icon's extra Frames), and nothing on a revisit;
 *  - what a grid and the panel show is computed from the save as plain data first; it is written only when it
 *    changed. The dirty check is DERIVED from the save, never set by hand: every action, every navigation and, while
 *    the Bag is open, a check every SYNC_S seconds recompute it, so no path that changes the save -- a server reply,
 *    an admin patch, a new save -- can leave the Bag showing old data.
 */
import { GameContext } from "shared/game/context";
import { WEAPONS, WeaponDef } from "shared/data/weapons";
import { EQUIPS } from "shared/data/equips";
import { USABLES } from "shared/data/usables";
import { ETC_ITEMS } from "shared/data/etcItems";
import { CRAFT_RECIPES, CraftRecipe } from "shared/data/crafts";
import { SKILLS, SkillDef } from "shared/data/skills";
import { ItemKind } from "shared/data/kinds";
import { costumeForEquip } from "shared/data/shop";
import { iconOf, skillIconOf } from "shared/data/itemIcons";
import { langGet } from "shared/data/lang";
import { weaponReserve } from "shared/game/player";
import { equipSlotOf, equippedIn, ownsCostume, ownsEquip, ownsWeapon } from "shared/game/save";
import { BagGrid, BagTile, GRID_H, GRID_W, TileModel } from "./bagGrid";
import { BagPanel, PanelModel } from "./bagPanel";
import { ItemCard, ItemCardHandle, ItemCardModel } from "./itemCard";
import { IconView, drawIcon } from "./itemIcon";
import * as Info from "./itemInfo";
import { raiseBack } from "./backStack";
import { popup, toast } from "./popup";
import { GAME, TEXT, THEME, TRANSPARENCY, space } from "./theme";
import { SCHEME_TOUCH, currentScheme } from "./tutorial";
import * as W from "./widgets";
import * as Kit from "./window";

const RunService = game.GetService("RunService");

/** while the Bag is open, how often (s) it re-checks the save for changes made elsewhere */
const SYNC_S = 0.25;

// ---------------------------------------------------------------- tabs

const CAT_WEAPONS = 0;
const CAT_EQUIP = 1;
const CAT_USABLES = 2;
const CAT_MATERIALS = 3;
const CAT_CRAFT = 4;
const CAT_SKILLS = 5;
/** label (lang.ts) and glyph (itemIcons.ts ICON_GLYPHS) of each tab */
const TAB_DEFS: Array<[string, string]> = [
	["Weapons", "weapons"],
	["Gear", "gear"],
	["Usables", "usables"],
	["Materials", "materials"],
	["Craft", "craft"],
	["Skills", "skills"],
];

// ---------------------------------------------------------------- layout (window design units)

const WIN_W = 1000;
const WIN_H = 585;
const PAD = space(6);
const TAB_H = 38;
const TAB_GAP = space(3);
/** a tab's glyph, at its left; the label is centred in what is left */
const TAB_ICON = 16;
const TAB_ICON_X = 14;
const TAB_LABEL_X = TAB_ICON_X + TAB_ICON + 2;
/** the Skills tab's badge (unspent points), inside the tab at its right */
const BADGE_W = 24;
const BADGE_H = 20;
/** between the grid and the panel */
const COL_GAP = space(4);
/** the tooltip card over the grid */
const TIP_W = 300;
const TIP_Z = 30;

/** the help of the "?" ("#" = a new line) */
const HELP_TEXT = [
	"Everything you carry, by kind. Pick an item to see what it is and what you can do with it.",
	"Craft makes items from materials. Some recipes need a craft desk or a lit fire next to you.",
	"Level up to earn skill points, and spend them in Skills.",
	"The backpack and the menu never stop the world: open them somewhere safe.",
].join("#");

/** what an item tab says when it is empty (the old list's copy), and whether it offers Open Craft */
const EMPTY: Array<[string, string, string, boolean]> = [
	["No weapons yet", "Find them in buildings or craft them in the Craft tab.", "cat_blade", true],
	[
		"No equipment yet",
		"Find it in buildings, craft it in the Craft tab, or unlock outfits and pets in the shop.",
		"cat_jacket",
		true,
	],
	["No usables yet", "Search buildings and fallen zombies for food and medicine.", "cat_meal", false],
	[
		"No materials yet",
		"Gather wood, stone and scrap while you explore. Materials are used in the Craft tab.",
		"wood",
		false,
	],
];

// ---------------------------------------------------------------- data helpers

const nameOf = Info.nameOf;

function stationName(r: CraftRecipe): string {
	const desk = r.needsPro ? "Pro craft desk" : r.needsDesk ? "Craft desk" : "";
	if (r.needsCook === true) return desk === "" ? "Lit fire" : `${desk} + fire`;
	if (r.needsFire === true) return desk === "" ? "Lit brazier" : `${desk} + brazier`;
	return desk === "" ? "Hand craft" : desk;
}

/** the glyph of a recipe's station (ICON_GLYPHS): cooking and smelting both show the flame */
function stationGlyph(r: CraftRecipe): string {
	if (r.needsPro) return "pro";
	if (r.needsDesk) return "desk";
	if (r.needsFire === true || r.needsCook === true) return "fire";
	return "hand";
}

/**
 * What a heated recipe's station line says (shared/sim/craftRule.ts): cooking wants any lit fire (a campfire, a
 * brazier) or a working cooker; smelting wants a lit brazier or the electric furnace -- a campfire is not hot
 * enough for metal. [needed, nearby, hint, button]
 */
const HEAT_TEXT = {
	cook: [
		"Need a lit fire",
		"Lit fire nearby",
		"Light a campfire or brazier and stand next to it, then open the backpack again.",
		"Need fire",
	],
	smelt: [
		"Need a lit brazier",
		"Lit brazier nearby",
		"Light a brazier and stand next to it (a campfire is not hot enough for metal), then open the backpack again.",
		"Need brazier",
	],
} as const;

function recipeMaking(kind: number, index: number): CraftRecipe | undefined {
	for (const r of CRAFT_RECIPES) {
		if (r.resultKind === kind && r.resultIndex === index) return r;
	}
	return undefined;
}

/** "×3" */
function times(n: number): string {
	return `×${W.fmtInt(n)}`;
}

/** the tab a key's item lives in (an item key is "kind:id") */
function keyParts(key: string): [string, number] {
	const parts = key.split(":");
	return [parts[0] ?? "", tonumber(parts[1]) ?? -1];
}

/** what the item panel's button says and does */
interface DetailAction {
	text: string;
	variant: W.ButtonVariant;
	enabled: boolean;
	run: () => void;
}

const noop = (): void => {};

function detailAction(text: string, variant: W.ButtonVariant, enabled: boolean, run: () => void): DetailAction {
	return { text, variant, enabled, run };
}

/** the survivor's side of an item: the card (what it is), the key (how many / equipped), a line, the action */
interface ItemDetail {
	card: ItemCardModel;
	state: string;
	help: string;
	act: DetailAction;
}

// ---------------------------------------------------------------- backpack

export class Backpack {
	onUse: ((itemId: number) => void) | undefined;
	onCraft: ((recipeId: number) => void) | undefined;
	onEquipWeapon: ((weaponId: number) => void) | undefined;
	onEquipItem: ((equipId: number) => void) | undefined;
	/** unequip an equipment slot (EquipSlot): 1 cloth, 2 hand, 3 gun, 4 outfit, 5 pet */
	onUnequipItem: ((slot: number) => void) | undefined;
	nearbyDesk = false;
	nearbyPro = false;
	/** a lit brazier or the electric furnace is close (smelting recipes) */
	nearbyFire = false;
	/** a lit campfire or brazier, or a working cooker, is close (cooking recipes) */
	nearbyCook = false;
	/** authoritative craft check from the game (craftSystem.craftBlocker): reason it can't be crafted, or undefined */
	craftCheck: ((recipeId: number) => string | undefined) | undefined;

	private ctx: GameContext;
	private root: Frame | undefined;
	private win: Frame | undefined;
	/** the window's X: B / Backspace's way out (client/ui/backStack.ts), raised to the top at every open */
	private closeBtn: TextButton | undefined;
	/** where the window rests (the entrance slides it up to here) */
	private winAt = new UDim2();
	/** where the grids and the panel start (window design units) */
	private bodyY = 0;
	private tabs: W.TabsHandle | undefined;
	private skillBadge: Frame | undefined;
	/** one grid per tab, built the first time the tab is shown */
	private grids: Array<BagGrid | undefined> = [];
	private panel: BagPanel | undefined;
	/** the selected item of each tab (a TileModel key; "" = none) */
	private selected: Array<string> = ["", "", "", "", "", ""];
	/** what the panel's button does now */
	private run: () => void = noop;
	private opened = false;
	private cat = CAT_WEAPONS;
	private headerSig = "";
	private syncConn: RBXScriptConnection | undefined;
	private syncClock = 0;
	/** the item card over the grid: the tile under the mouse, if it is not the selected one */
	private tip: ItemCardHandle | undefined;
	private hoverTile: BagTile | undefined;

	constructor(ctx: GameContext) {
		this.ctx = ctx;
	}

	private tr(key: string): string {
		return langGet(key, this.ctx.save.settings.langType);
	}

	isOpen(): boolean {
		return this.opened;
	}

	open(): void {
		if (this.opened) return;
		// the window is built once, and again only if something destroyed it
		let root = this.root;
		if (root === undefined || root.Parent === undefined) root = this.mount();
		// reopen on the last tab, every grid scrolled to the top
		for (const g of this.grids) if (g !== undefined) g.list.frame.CanvasPosition = new Vector2();
		this.opened = true;

		// entrance: fade the scrim in, slide the window up a little. The scrim only DIMS the street (UI-06: the Bag
		// pauses nothing, so what is coming has to stay visible round the window), and it goes through
		// worldTransparency like every surface over the world, so the player's Background Transparency holds
		root.BackgroundTransparency = 1;
		W.tween(root, 0.15, { BackgroundTransparency: W.worldTransparency(TRANSPARENCY.overWorld) });
		const win = this.win;
		if (win !== undefined) {
			win.Position = this.winAt.add(UDim2.fromScale(0, 0.025));
			W.tween(win, 0.18, { Position: this.winAt });
		}
		W.setVisible(root, true);
		// kept built: shown again, it is the screen on top for B / Backspace, over whatever the pad held before it
		if (this.closeBtn !== undefined) raiseBack(this.closeBtn);
		this.rebuild();
		this.focusSelection();

		// While open, the Bag checks the save a few times a second: a server reply, an admin patch or a new save
		// from the server changes it without going through this class, and must still show.
		this.syncClock = 0;
		this.syncConn = RunService.Heartbeat.Connect((dt: number): void => {
			this.syncClock += dt;
			if (this.syncClock < SYNC_S) return;
			this.syncClock = 0;
			this.rebuild();
		});
	}

	close(): void {
		if (!this.opened) return;
		this.opened = false;
		this.syncConn?.Disconnect();
		this.syncConn = undefined;
		// hidden, not destroyed: the next open() shows this window again, as it is
		if (this.root !== undefined) W.setVisible(this.root, false);
		this.hoverTile = undefined;
		this.refreshTip();
	}

	/** builds the window: header, tabs and the panel (the grids come as their tabs are shown) */
	private mount(): Frame {
		this.grids = [];
		this.panel = undefined;
		this.tip = undefined;
		this.hoverTile = undefined;
		this.headerSig = "";
		const at: W.DesignRect = {
			x: (W.DESIGN_W - WIN_W) / 2,
			y: math.floor((W.DESIGN_H - WIN_H) / 2),
			w: WIN_W,
			h: WIN_H,
		};
		const screen = W.makeScreen(this.ctx.uiLayer, "Backpack", {
			color: THEME.background,
			transparency: TRANSPARENCY.overWorld,
			zIndex: 200,
			content: at,
		});
		this.root = screen.root;
		const win = Kit.Window(screen.body, "Window", {
			...at,
			title: this.tr("Backpack"),
			onClose: (): void => this.close(),
			onHelp: (): void => {
				popup(this.ctx, this.tr("Backpack"), W.nl(this.tr(HELP_TEXT)), [
					{ text: this.tr("Close"), variant: "secondary" },
				]);
			},
		});
		this.win = win.frame;
		this.closeBtn = win.close;
		this.winAt = win.frame.Position;
		const tabsY = win.contentY + space(1);
		this.mountTabs(win.frame, tabsY);
		const bodyY = tabsY + TAB_H + space(3);
		this.bodyY = bodyY;
		const panelX = PAD + GRID_W + COL_GAP;
		this.panel = new BagPanel(win.frame, "Details", panelX, bodyY, WIN_W - PAD - panelX, GRID_H, (k: string) =>
			this.tr(k),
		);
		this.panel.onAction = (): void => this.run();
		return screen.root;
	}

	/** the reference's tab bar: one plate per tab, each with its glyph; the Skills tab carries the points badge */
	private mountTabs(parent: Frame, y: number): void {
		const names = TAB_DEFS.map(([label]) => this.tr(label));
		const widths = names.map((n, i) => W.tabWidth(n) + TAB_LABEL_X - space(4) + (i === CAT_SKILLS ? BADGE_W : 0));
		let total = 0;
		for (const w of widths) total += w;
		total += TAB_GAP * (widths.size() - 1);
		const tabs = W.Tabs(parent, "Tabs", {
			x: PAD,
			y,
			w: total,
			h: TAB_H,
			items: names,
			widths,
			value: this.cat,
			gap: TAB_GAP,
			onChange: (i: number): void => this.selectCat(i),
		});
		this.tabs = tabs;
		for (let i = 0; i < tabs.triggers.size(); i++) {
			const t = tabs.triggers[i];
			const w = widths[i];
			const glyph = IconView(t, "Glyph", TAB_ICON_X, (TAB_H - TAB_ICON) / 2, TAB_ICON, t.ZIndex + 1);
			drawIcon(glyph, TAB_DEFS[i][1], { ink: THEME.foreground });
			// the label is centred in the room right of the glyph (and left of the badge)
			const label = t.FindFirstChild("Label");
			if (label !== undefined) {
				const pad = new Instance("UIPadding");
				pad.PaddingLeft = new UDim(TAB_LABEL_X / w, 0);
				pad.PaddingRight = new UDim((i === CAT_SKILLS ? BADGE_W + 8 : 8) / w, 0);
				pad.Parent = label;
			}
			if (i === CAT_SKILLS) {
				this.skillBadge = W.Badge(t, "Points", "", {
					x: w - BADGE_W - 8,
					y: (TAB_H - BADGE_H) / 2,
					w: BADGE_W,
					h: BADGE_H,
					color: GAME.xp,
					textSize: TEXT.xs,
					zIndex: t.ZIndex + 2,
				});
				this.skillBadge.Visible = false;
			}
		}
	}

	// ------------------------------------------------------------ navigation

	private selectCat(index: number): void {
		if (index === this.cat) return;
		this.cat = index;
		this.hoverTile = undefined;
		this.rebuild();
		this.focusSelection();
	}

	/** a tile of the tab on screen was clicked / tapped / reached with the pad */
	private select(key: string): void {
		if (this.selected[this.cat] === key) return;
		this.selected[this.cat] = key;
		this.rebuild();
	}

	/** with a pad, the selection lands on the selected tile (or the first), so the Bag is usable without a mouse */
	private focusSelection(): void {
		const grid = this.grids[this.cat];
		const t = grid?.tileOf(this.selected[this.cat]) ?? grid?.itemTiles()[0];
		if (t !== undefined) W.autoFocus(t.button);
		else if (this.panel !== undefined) W.autoFocus(this.panel.button());
	}

	private refreshHeader(): void {
		const sp = this.ctx.save.skillPoint;
		const sig = `${sp}|${this.cat}`;
		if (sig === this.headerSig) return;
		this.headerSig = sig;
		this.tabs?.setActive(this.cat);
		const badge = this.skillBadge;
		if (badge !== undefined) {
			badge.Visible = sp > 0;
			if (sp > 0) W.setBadge(badge, sp > 9 ? "9+" : `${sp}`);
		}
	}

	/**
	 * Brings the screen up to date: the header, the grid of the tab on screen (built the first time; the others are
	 * only hidden) and the panel of its selection. Every write is skipped when nothing changed, so this is cheap to
	 * call from every action, every navigation and the open Bag's periodic check.
	 */
	private rebuild(): void {
		const win = this.win;
		const panel = this.panel;
		if (win === undefined || panel === undefined || !this.opened) return;
		this.refreshHeader();
		let grid = this.grids[this.cat];
		if (grid === undefined) {
			grid = new BagGrid(win, `Page${this.cat}`, PAD, this.bodyY, {
				onSelect: (key: string): void => this.select(key),
				onHover: (tile: BagTile, on: boolean): void => {
					if (on) this.hoverTile = tile;
					else if (this.hoverTile === tile) this.hoverTile = undefined;
					this.refreshTip();
				},
			});
			this.grids[this.cat] = grid;
		}
		for (let i = 0; i < this.grids.size(); i++) {
			const g = this.grids[i];
			if (g !== undefined) W.setVisible(g.frame, i === this.cat);
		}
		const models = this.models(this.cat);
		grid.render(models);
		let sel = this.selected[this.cat];
		if (!models.some(m => m.key === sel)) {
			sel = models[0]?.key ?? "";
			this.selected[this.cat] = sel;
		}
		grid.setSelected(sel);
		const [model, run] = this.panelOf(this.cat, sel);
		this.run = run;
		panel.set(model);
		this.refreshTip();
	}

	// ------------------------------------------------------------ the tooltip card (mouse only)

	/**
	 * The card of the item under the mouse, beside its tile: only on an item tab, never for the selected item (its
	 * card is the panel), never on touch (no pointer) and never for the pad (its cursor selects). One card, built on
	 * first use and rewritten in place.
	 */
	private refreshTip(): void {
		const win = this.win;
		const t = this.hoverTile;
		const m = t?.model;
		let card: ItemCardModel | undefined;
		if (this.opened && win !== undefined && t !== undefined && m !== undefined && this.cat <= CAT_MATERIALS) {
			const [kind, id] = keyParts(m.key);
			const onScreen = t.button.Visible && this.grids[this.cat]?.tileOf(m.key) === t;
			if (onScreen && m.key !== this.selected[this.cat] && currentScheme() !== SCHEME_TOUCH) {
				card = Info.describeItem(this.ctx.save, tonumber(kind) ?? 0, id, {
					tag: m.tag ? this.tr("EQUIPPED") : m.count,
					tagColor: m.tag ? GAME.success : THEME.mutedForeground,
				});
			}
		}
		if (card === undefined || win === undefined || t === undefined) {
			if (this.tip !== undefined) W.setVisible(this.tip.frame, false);
			return;
		}
		let tip = this.tip;
		if (tip === undefined) {
			tip = ItemCard(win, "Tooltip", { x: 0, y: 0, w: TIP_W, zIndex: TIP_Z });
			this.tip = tip;
		}
		tip.set(card);
		// beside the tile (right, or left when there is no room), kept inside the window
		const k = win.AbsoluteSize.X / WIN_W;
		const b = t.button;
		let x = PAD + GRID_W + COL_GAP;
		let y = tip.frame.Position.Y.Scale * WIN_H;
		if (k > 0) {
			const left = (b.AbsolutePosition.X - win.AbsolutePosition.X) / k;
			const right = left + b.AbsoluteSize.X / k;
			x = right + space(2) + TIP_W <= WIN_W - space(2) ? right + space(2) : left - space(2) - TIP_W;
			y = (b.AbsolutePosition.Y - win.AbsolutePosition.Y) / k;
		}
		y = math.clamp(y, space(2), math.max(space(2), WIN_H - tip.height - space(2)));
		tip.frame.Position = UDim2.fromScale(x / WIN_W, y / WIN_H);
		W.setVisible(tip.frame, true);
	}

	// ------------------------------------------------------------ what the grids show

	private models(cat: number): Array<TileModel> {
		if (cat === CAT_CRAFT) return this.recipeModels();
		if (cat === CAT_SKILLS) return this.skillModels();
		return this.itemModels(cat);
	}

	private itemModels(cat: number): Array<TileModel> {
		const save = this.ctx.save;
		const out: Array<TileModel> = [];
		const tile = (kind: number, id: number, count: string, equipped: boolean, ammo = ""): TileModel => ({
			key: `${kind}:${id}`,
			name: this.tr(nameOf(kind, id)),
			icon: iconOf(kind, id).key,
			dim: false,
			equipped,
			tag: equipped,
			count,
			short: false,
			ammo,
			corner: "",
			locked: false,
			pips: 0,
			pipsOn: 0,
		});
		if (cat === CAT_WEAPONS) {
			for (const w of WEAPONS) {
				if (!ownsWeapon(save, w.id)) continue;
				const n = save.invenWeapon[w.id] ?? 0;
				const ammo = Info.showsReserve(w) ? W.fmtInt(weaponReserve(save, w)) : "";
				out.push(tile(ItemKind.Weapon, w.id, n > 1 ? times(n) : "", save.equipWeapon === w.id, ammo));
			}
		} else if (cat === CAT_EQUIP) {
			for (const e of EQUIPS) {
				if (!ownsEquip(save, e.id)) continue;
				const n = save.invenEquip[e.id] ?? 0;
				out.push(
					tile(ItemKind.Equip, e.id, n > 1 ? times(n) : "", equippedIn(save, equipSlotOf(e.id)) === e.id),
				);
			}
		} else if (cat === CAT_USABLES) {
			for (const u of USABLES) {
				const n = save.invenUse[u.id] ?? 0;
				if (n > 0) out.push(tile(ItemKind.Use, u.id, times(n), false));
			}
		} else {
			for (let i = Info.MAT_START; i < ETC_ITEMS.size(); i++) {
				const n = save.invenEtc[ETC_ITEMS[i].id] ?? 0;
				if (n > 0) out.push(tile(ItemKind.Etc, ETC_ITEMS[i].id, times(n), false));
			}
		}
		return out;
	}

	/** the recipes: what can be made now first, then what this station allows, then what needs another station */
	private recipeModels(): Array<TileModel> {
		const ready: Array<CraftRecipe> = [];
		const missing: Array<CraftRecipe> = [];
		const locked: Array<CraftRecipe> = [];
		for (const r of CRAFT_RECIPES) {
			if (!this.recipeAvailable(r)) locked.push(r);
			else if (this.hasIngredients(r)) ready.push(r);
			else missing.push(r);
		}
		const out: Array<TileModel> = [];
		for (const group of [ready, missing, locked]) {
			for (const r of group) {
				const avail = this.recipeAvailable(r);
				const n = this.craftable(r);
				out.push({
					key: `r:${r.id}`,
					name: this.tr(nameOf(r.resultKind, r.resultIndex)),
					icon: iconOf(r.resultKind, r.resultIndex).key,
					dim: !avail,
					equipped: false,
					tag: false,
					count: avail ? times(n) : "",
					short: n === 0,
					ammo: "",
					corner: stationGlyph(r),
					locked: !avail,
					pips: 0,
					pipsOn: 0,
				});
			}
		}
		return out;
	}

	private skillModels(): Array<TileModel> {
		const save = this.ctx.save;
		return SKILLS.map(sk => {
			const lvl = save.skillLevels[sk.id] ?? 0;
			return {
				key: `s:${sk.id}`,
				name: this.tr(sk.name),
				icon: skillIconOf(sk.id),
				dim: lvl === 0,
				equipped: false,
				tag: false,
				count: "",
				short: false,
				ammo: "",
				corner: "",
				locked: false,
				pips: sk.maxLevel,
				pipsOn: lvl,
			};
		});
	}

	// ------------------------------------------------------------ what the panel shows

	/** the panel of tab `cat` with `key` selected, and what its button does */
	private panelOf(cat: number, key: string): [PanelModel, () => void] {
		const [head, id] = keyParts(key);
		if (key !== "" && cat === CAT_CRAFT) {
			const r = CRAFT_RECIPES.find(x => x.id === id);
			if (r !== undefined) return this.recipePanel(r);
		} else if (key !== "" && cat === CAT_SKILLS) {
			const sk = SKILLS[id];
			if (sk !== undefined) return this.skillPanel(sk);
		} else if (key !== "") {
			const d = this.itemDetail(tonumber(head) ?? 0, id);
			if (d !== undefined) return this.itemPanel(d);
		}
		return this.emptyPanel(cat);
	}

	private blankPanel(title: string): PanelModel {
		return {
			title,
			state: "",
			icon: "",
			dim: false,
			type: "",
			stats: [],
			body: "",
			notes: "",
			extra: "",
			extraXp: false,
			hints: [],
			ingredients: [],
			station: undefined,
			action: undefined,
		};
	}

	private itemPanel(d: ItemDetail): [PanelModel, () => void] {
		const m = this.blankPanel(d.card.name);
		m.state = d.state;
		m.icon = iconOf(d.card.kind, d.card.id).key;
		m.type = d.card.type;
		m.stats = d.card.stats;
		m.notes = d.card.notes;
		m.extra = d.help;
		m.hints = d.card.hints;
		m.action = { text: d.act.text, variant: d.act.variant, enabled: d.act.enabled };
		return [m, d.act.run];
	}

	private emptyPanel(cat: number): [PanelModel, () => void] {
		const def = EMPTY[cat] ?? EMPTY[CAT_MATERIALS];
		const m = this.blankPanel(this.tr(def[0]));
		m.icon = def[2];
		m.dim = true;
		m.body = this.tr(def[1]);
		if (def[3]) {
			m.action = { text: this.tr("Open Craft"), variant: "secondary", enabled: true };
			return [m, (): void => this.selectCat(CAT_CRAFT)];
		}
		return [m, noop];
	}

	/** the item card of `kind` / `id` and the survivor's side of it (undefined: no such item) */
	private itemDetail(kind: number, id: number): ItemDetail | undefined {
		if (kind === ItemKind.Weapon && WEAPONS[id] !== undefined) return this.weaponDetail(WEAPONS[id]);
		if (kind === ItemKind.Equip && EQUIPS[id] !== undefined) return this.equipDetail(id);
		if (kind === ItemKind.Use && USABLES[id] !== undefined) return this.usableDetail(id);
		if (kind === ItemKind.Etc && ETC_ITEMS[id] !== undefined) return this.materialDetail(id);
		return undefined;
	}

	private cardOf(kind: number, id: number): ItemCardModel | undefined {
		return Info.describeItem(this.ctx.save, kind, id);
	}

	private weaponDetail(w: WeaponDef): ItemDetail | undefined {
		const save = this.ctx.save;
		const id = w.id;
		const owned = ownsWeapon(save, id);
		const count = save.invenWeapon[id] ?? 0;
		const equipped = save.equipWeapon === id;
		let help = "";
		if (equipped) {
			help = this.tr("This is the weapon in your hands.");
		} else if (!owned) {
			const r = recipeMaking(ItemKind.Weapon, id);
			help = r !== undefined ? `You don't have it yet. Craft it: ${stationName(r)}.` : "You don't have it yet.";
		}
		let state = equipped ? this.tr("EQUIPPED") : times(count);
		if (!equipped && id === 0 && count === 0) state = this.tr("DEFAULT");
		let act: DetailAction;
		if (!owned) act = detailAction(this.tr("Not owned"), "secondary", false, noop);
		else if (equipped) act = detailAction(this.tr("Equipped"), "secondary", false, noop);
		else act = detailAction(this.tr("Equip"), "default", true, (): void => this.equipWeapon(id));
		const card = this.cardOf(ItemKind.Weapon, id);
		return card !== undefined ? { card, state, help, act } : undefined;
	}

	private equipDetail(id: number): ItemDetail | undefined {
		const save = this.ctx.save;
		const slot = equipSlotOf(id);
		const owned = ownsEquip(save, id);
		const count = save.invenEquip[id] ?? 0;
		const costume = costumeForEquip(id);
		const viaCostume = costume !== undefined && ownsCostume(save, costume.id);
		const current = equippedIn(save, slot);
		const equipped = current === id;
		// the slot and what a cosmetic does and does not do (MON-01 / MON-04) are on the card
		const help: Array<string> = [];
		if (equipped) {
			help.push(this.tr("Currently equipped."));
		} else if (current >= 0 && EQUIPS[current] !== undefined) {
			help.push(`Equipping it replaces ${EQUIPS[current].name}.`);
		} else {
			help.push(this.tr("Nothing is worn in this slot now."));
		}
		if (costume !== undefined) {
			help.push(
				viaCostume
					? `Unlocked by the ${costume.name} costume.`
					: `Unlock it with the ${costume.name} costume in the shop.`,
			);
		}
		let state = this.tr("Not owned");
		if (equipped) state = this.tr("EQUIPPED");
		else if (count > 0) state = times(count);
		else if (viaCostume) state = this.tr("COSTUME");
		let act: DetailAction;
		if (!owned) {
			act = detailAction(this.tr("Not owned"), "secondary", false, noop);
		} else if (equipped) {
			// the one action of an item you wear: the main (blue) plate
			act = detailAction(this.tr("Unequip"), "default", this.onUnequipItem !== undefined, (): void =>
				this.unequipItem(id, slot),
			);
		} else {
			act = detailAction(this.tr("Equip"), "default", true, (): void => this.equipItem(id, slot));
		}
		const card = this.cardOf(ItemKind.Equip, id);
		return card !== undefined ? { card, state, help: help.join(" "), act } : undefined;
	}

	private usableDetail(id: number): ItemDetail | undefined {
		const count = this.ctx.save.invenUse[id] ?? 0;
		const card = this.cardOf(ItemKind.Use, id);
		if (card === undefined) return undefined;
		// food is eaten, medicine is used: the same call either way (main.client onUse)
		const verb = card.type === this.tr("Food") ? "Eat" : "Use";
		const act = detailAction(this.tr(count > 0 ? verb : "None left"), "default", count > 0, (): void =>
			this.useItem(id),
		);
		return { card, state: times(count), help: this.tr("Consumed when used."), act };
	}

	private materialDetail(id: number): ItemDetail | undefined {
		const count = this.ctx.save.invenEtc[id] ?? 0;
		const act = detailAction(this.tr("Open Craft"), "secondary", true, (): void => this.selectCat(CAT_CRAFT));
		const card = this.cardOf(ItemKind.Etc, id);
		return card !== undefined ? { card, state: times(count), help: "", act } : undefined;
	}

	// ------------------------------------------------------------ actions (rules live in main.client)

	private equipWeapon(id: number): void {
		if (!ownsWeapon(this.ctx.save, id) || this.ctx.save.equipWeapon === id) return;
		this.onEquipWeapon?.(id);
		if (this.ctx.save.equipWeapon === id) toast(this.ctx, `Equipped ${nameOf(ItemKind.Weapon, id)}`);
		this.rebuild();
	}

	private equipItem(id: number, slot: number): void {
		if (!ownsEquip(this.ctx.save, id) || equippedIn(this.ctx.save, slot) === id) return;
		this.onEquipItem?.(id);
		if (equippedIn(this.ctx.save, slot) === id) toast(this.ctx, `Equipped ${nameOf(ItemKind.Equip, id)}`);
		this.rebuild();
	}

	private unequipItem(id: number, slot: number): void {
		if (equippedIn(this.ctx.save, slot) !== id) return;
		this.onUnequipItem?.(slot);
		if (equippedIn(this.ctx.save, slot) !== id) toast(this.ctx, `Unequipped ${nameOf(ItemKind.Equip, id)}`);
		this.rebuild();
	}

	private useItem(id: number): void {
		if ((this.ctx.save.invenUse[id] ?? 0) <= 0) return;
		this.onUse?.(id);
		this.rebuild();
	}

	// ------------------------------------------------------------ craft

	private recipeAvailable(r: CraftRecipe): boolean {
		if (r.needsCook === true && !this.nearbyCook) return false;
		if (r.needsFire === true && !this.nearbyFire) return false;
		if (r.needsPro) return this.nearbyPro;
		if (r.needsDesk) return this.nearbyDesk;
		return true;
	}

	private ingredientCount(kind: number, index: number): number {
		const save = this.ctx.save;
		if (kind === ItemKind.Weapon) return save.invenWeapon[index] ?? 0;
		if (kind === ItemKind.Equip) return save.invenEquip[index] ?? 0;
		if (kind === ItemKind.Use) return save.invenUse[index] ?? 0;
		return save.invenEtc[index] ?? 0;
	}

	private hasIngredients(r: CraftRecipe): boolean {
		return this.craftable(r) > 0;
	}

	/** how many times `r` can be made with what the survivor carries */
	private craftable(r: CraftRecipe): number {
		let n = math.huge;
		for (const ing of r.ingredients) {
			n = math.min(n, math.floor(this.ingredientCount(ing.kind, ing.index) / ing.count));
		}
		return n === math.huge ? 0 : n;
	}

	/** the stations near the survivor, in one compact line */
	private nearbyText(): string {
		const near: Array<string> = [];
		if (this.nearbyPro) near.push(this.tr("pro craft desk"));
		else if (this.nearbyDesk) near.push(this.tr("craft desk"));
		if (this.nearbyCook) near.push(this.tr("lit fire"));
		if (this.nearbyFire) near.push(this.tr("smelter"));
		if (near.size() === 0) return this.tr("Nothing near you: hand recipes only.");
		return `${this.tr("Near you")}: ${near.join(", ")}`;
	}

	private recipePanel(r: CraftRecipe): [PanelModel, () => void] {
		const avail = this.recipeAvailable(r);
		const enough = this.hasIngredients(r);
		const card = this.cardOf(r.resultKind, r.resultIndex);
		const m = this.blankPanel(this.tr(nameOf(r.resultKind, r.resultIndex)));
		m.state = `${this.tr("MAKES")} ${times(r.resultCount)}`;
		m.icon = iconOf(r.resultKind, r.resultIndex).key;
		m.dim = !avail;
		m.type = card !== undefined ? card.type : "";
		m.stats = card !== undefined ? card.stats : [];
		for (const ing of r.ingredients) {
			const have = this.ingredientCount(ing.kind, ing.index);
			m.ingredients.push({
				name: this.tr(nameOf(ing.kind, ing.index)),
				icon: iconOf(ing.kind, ing.index).key,
				count: `${W.fmtInt(have)} / ${W.fmtInt(ing.count)}`,
				short: have < ing.count,
			});
		}
		let station = "No desk needed";
		if (r.needsPro) station = this.nearbyPro ? "Pro craft desk nearby" : "Need a pro craft desk";
		else if (r.needsDesk) station = this.nearbyDesk ? "Craft desk nearby" : "Need a craft desk";
		// cooking (a lit fire) and smelting (a lit brazier) are each their own station (shared/sim/craftRule.ts)
		const heat = r.needsCook === true ? HEAT_TEXT.cook : r.needsFire === true ? HEAT_TEXT.smelt : undefined;
		const heatNear = r.needsCook === true ? this.nearbyCook : this.nearbyFire;
		if (heat !== undefined && !heatNear) station = heat[0];
		else if (heat !== undefined && station === "No desk needed") station = heat[1];
		// the game's own check also covers things the Bag can't see (e.g. a build in progress)
		const blocker = avail && enough ? this.craftCheck?.(r.id) : undefined;
		let hint = "You can craft this here.";
		if (blocker !== undefined) {
			hint = blocker;
		} else if (!avail && heat !== undefined && !heatNear) {
			hint = heat[2];
		} else if (!avail) {
			hint = "Stand next to the right desk, then open the backpack again.";
		} else if (!enough) {
			hint = "Gather what is missing (in red), then craft.";
		}
		m.station = {
			glyph: stationGlyph(r),
			text: this.tr(station),
			ok: avail,
			hint: this.tr(hint),
			nearby: this.nearbyText(),
		};
		let label = "Craft";
		if (!avail) {
			label = heat !== undefined && !heatNear ? heat[3] : r.needsPro ? "Need pro desk" : "Need craft desk";
		} else if (!enough) {
			label = "Missing items";
		} else if (blocker !== undefined) {
			label = "Can't craft";
		}
		m.action = { text: this.tr(label), variant: "default", enabled: avail && enough && blocker === undefined };
		return [
			m,
			(): void => {
				if (!this.recipeAvailable(r) || !this.hasIngredients(r)) return;
				if (this.craftCheck?.(r.id) !== undefined) return;
				this.onCraft?.(r.id);
				this.rebuild();
			},
		];
	}

	// ------------------------------------------------------------ skills

	private skillPanel(sk: SkillDef): [PanelModel, () => void] {
		const save = this.ctx.save;
		const lvl = save.skillLevels[sk.id] ?? 0;
		const sp = save.skillPoint;
		const maxed = lvl >= sk.maxLevel;
		const m = this.blankPanel(this.tr(sk.name));
		m.state = `LV ${lvl} / ${sk.maxLevel}`;
		m.icon = skillIconOf(sk.id);
		m.dim = lvl === 0;
		const kind = sk.kind === 1 ? "Survival skill" : sk.kind === 2 ? "Fighting skill" : "Utility skill";
		m.type = this.tr(kind);
		m.stats = [
			{ label: this.tr("Level"), value: `${lvl} / ${sk.maxLevel}`, tone: "value" },
			{
				label: this.tr("Next level"),
				value: maxed ? this.tr("Max") : `${lvl + 1}`,
				tone: maxed ? "text" : "value",
			},
		];
		m.notes = this.tr(sk.detail);
		m.extra =
			sp > 0
				? `${sp} ${this.tr(sp === 1 ? "skill point to spend." : "skill points to spend.")}`
				: this.tr("No skill points to spend. Level up to earn more.");
		m.extraXp = sp > 0;
		let label = "Learn";
		if (maxed) label = "Max level";
		else if (sp <= 0) label = "No skill points";
		m.action = { text: this.tr(label), variant: "default", enabled: sp > 0 && !maxed };
		return [m, (): void => this.learnSkill(sk)];
	}

	private learnSkill(sk: SkillDef): void {
		const save = this.ctx.save;
		const current = save.skillLevels[sk.id] ?? 0;
		if (save.skillPoint > 0 && current < sk.maxLevel) {
			save.skillLevels[sk.id] = current + 1;
			save.skillPoint -= 1;
			toast(this.ctx, `Learned ${sk.name}`);
			this.rebuild();
		}
	}
}
