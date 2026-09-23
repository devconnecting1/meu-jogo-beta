/*
 * Backpack (in-run inventory): Weapons / Equipment / Usables / Materials / Craft / Skills.
 *
 * The item tabs only list what the player owns. Every game rule (equip, unequip, use, craft) is
 * delegated to main.client through the callbacks; the backpack only reads the save to draw its state
 * and brings it up to date after each action. The one write it does itself is spending skill points.
 *
 * Levels: 2 = list of the current tab, 3 = item detail, 4 = recipe detail, 5 = skills.
 *
 * Built once, then only shown and updated in place. The owner: "opening the Bag and going through the tabs
 * should be instant". Creating GuiObjects is among the most expensive things the client does, and this screen
 * used to destroy its page and build it again on every tab switch and after every action (Craft alone is 80
 * rows, ~1700 Instances). Now:
 *  - the window is built on the first open(); close() hides it, the next open() shows it again;
 *  - each page (a tab's list, the item detail, the recipe detail) is built the first time it is shown, then
 *    only shown / hidden: switching tabs creates nothing, and a list keeps its scroll position;
 *  - a page renders in two steps: what it should show, computed from the save as plain data (no Instance),
 *    then the write of that onto the page's existing objects. The signature of the first step is the page's
 *    dirty flag: the page is rewritten only when it changed, in place, and its list reuses its rows (RowPool);
 *  - the dirty flag is DERIVED from the save, never set by hand: every action, every navigation and, while the
 *    Bag is open, a check every SYNC_S seconds recompute it for the page on screen, and a hidden page is checked
 *    when it is shown. So no path that changes the save -- the actions here, a server reply, an admin patch, a
 *    new save from the server -- can leave a page showing old data.
 * `npm run test:backpack` (tools/test-backpack.mjs) counts the Instances all of this creates and destroys.
 *
 * Look: a panel window with the kit's TITLE STRIP across the top (skill points at its left, key cap / back /
 * close at its right), a Sidebar of categories on the left and the current list / detail on the right. Lists,
 * rows, glyphs, chips and pips are recessed "wells"; the one main action of a page is the raised `primary`
 * plate. Every colour is a theme token (THEME / SURFACE / GAME); hover, pressed and disabled come from the kit.
 */
import { GameContext } from "shared/game/context";
import { WEAPONS, WeaponDef } from "shared/data/weapons";
import { EQUIPS } from "shared/data/equips";
import { USABLES } from "shared/data/usables";
import { ETC_ITEMS } from "shared/data/etcItems";
import { CRAFT_RECIPES, CraftRecipe } from "shared/data/crafts";
import { SKILLS, SkillDef } from "shared/data/skills";
import { AmmoPool, ItemKind, WeaponKind } from "shared/data/kinds";
import { costumeForEquip } from "shared/data/shop";
import { PlayerSaveData, equipSlotOf, ownsCostume, ownsEquip, ownsWeapon } from "shared/game/save";
import { toast } from "./popup";
import { GAME, SURFACE, TEXT, THEME, TRANSPARENCY, hex, roleFont, space } from "./theme";
import {
	BUTTON_SIZE,
	Badge,
	Button,
	ButtonVariant,
	Card,
	CardDescription,
	CardHeader,
	CardTitle,
	ListRowButton,
	RowPool,
	ScrollList,
	Separator,
	Sidebar,
	SidebarHandle,
	badgeWidth,
	cardHeaderHeight,
	fmtInt,
	fmtNum,
	fmtSeconds,
	makeFrame,
	makeLabel,
	makeListRow,
	makeScreen,
	makeScrollList,
	makeSurface,
	setBadge,
	setBadgeLook,
	setButtonEnabled,
	setButtonVariant,
	setCardBorder,
	setLabelColor,
	setSurface,
	setVisible,
	tween,
} from "./widgets";

const RunService = game.GetService("RunService");
const UserInputService = game.GetService("UserInputService");

/** while the Bag is open, how often (s) the page on screen re-checks its data for changes made elsewhere */
const SYNC_S = 0.25;

const CAT_NAMES = ["Weapons", "Equipment", "Usables", "Materials", "Craft", "Skills"];
const CAT_WEAPONS = 0;
const CAT_EQUIP = 1;
const CAT_USABLES = 2;
const CAT_CRAFT = 4;
const CAT_SKILLS = 5;

const LEVEL_LIST = 2;
const LEVEL_DETAIL = 3;
const LEVEL_RECIPE = 4;
const LEVEL_SKILLS = 5;

/** ETC_ITEMS below this index are buildables (placed from the build menu), not materials */
const MAT_START = 23;

// layout (design units; the panel is a 1000 x 570 design space)
const PANEL_W = 1000;
const PANEL_H = 570;
const PAD = space(5);
const ICON_W = BUTTON_SIZE.icon.h;
/**
 * Header = the kit's title strip (CardHeader): inset space(2) from the panel edge and
 * ceil(TEXT.xl2 * 1.3) + space(3) tall. The strip draws the centred title; the skill points badge and the
 * key cap / back / close buttons are laid over it (HEADER_Z), inside the width HEADER_ACTION reserves.
 */
const STRIP_INSET = space(2);
const HEADER_Y = STRIP_INSET;
const HEADER_H = math.ceil(TEXT.xl2 * 1.3) + space(3);
/** icon buttons hang space(1) below the strip's top edge, like the kit's Dialog close button */
const HEADER_BTN_Y = HEADER_Y + space(1);
/** the badge and the buttons sit above the strip and its title */
const HEADER_Z = 4;
const SP_W = 72;
const BADGE_H = 24;
/** the keyboard prompt of the reference art: a key cap next to the buttons it drives */
const KEY_HINT = "B";
const KEY_W = badgeWidth(KEY_HINT, TEXT.sm, BADGE_H);
/** width the strip's title gives up on each side so it never runs into the badge or the buttons */
const HEADER_ACTION = space(1) + ICON_W + space(2) + ICON_W + space(2) + KEY_W + space(2);
const BODY_Y = cardHeaderHeight(TEXT.xl2);
const BODY_H = PANEL_H - PAD - BODY_Y;
// category sidebar on the left, content on the right
const NAV_W = 180;
const NAV_ITEM_H = 44;
const CONTENT_X = PAD + NAV_W + space(5);
const CONTENT_W = PANEL_W - PAD - CONTENT_X;
const CONTENT_H = BODY_H;
// list rows: glyph + two text lines (name, info) + right-hand columns
const ROW_H = 56;
const ROW_PAD = space(4);
const GLYPH = 36;
const ROW_TEXT_X = ROW_PAD + GLYPH + space(3);
const COUNT_W = 96;
/** item rows: the count column at the right, the EQUIPPED badge left of it */
const ITEM_COUNT_X = CONTENT_W - ROW_PAD - COUNT_W;
const ITEM_BADGE_W = badgeWidth("EQUIPPED", TEXT.sm, BADGE_H);
const ITEM_BADGE_X = ITEM_COUNT_X - space(3) - ITEM_BADGE_W;
const STATION_W = 92;
const STATUS_W = 72;
const PLUS_W = 72;
const LEVEL_W = 76;
const PIP_W = 20;
const PIP_H = 8;
const PIP_GAP = 6;
const MAX_PIPS = SKILLS.reduce((m, sk) => math.max(m, sk.maxLevel), 1);
/** the status line above the craft / skills lists (a well, not the panel's title strip) */
const NOTICE_H = 36;
const LIST_GAP = space(2);
// detail pages
const CHIP_W = 142;
const CHIP_H = 64;
const CHIP_GAP = space(3);
const ACTION_W = 220;
const ACTION_H = BUTTON_SIZE.lg.h;
const ING_W = 440;
const ING_H = 40;
const ING_COUNT_W = 110;
/** most stat chips an item detail shows (a gun: damage, fire rate, mag, reload, range; a usable: 5 too) */
const MAX_CHIPS = 5;
/** most ingredients a recipe has: the recipe page builds that many lines with itself */
const MAX_INGREDIENTS = CRAFT_RECIPES.reduce((m, r) => math.max(m, r.ingredients.size()), 1);

const SLOT_NAMES = ["-", "Cloth", "Hand", "Gun", "Deco"];

interface ItemEntry {
	kind: number;
	id: number;
	name: string;
	info: string;
	count: string;
	/** `count` is a quantity ("x 3"), not a word ("Default", "Costume") */
	numeric: boolean;
	equipped: boolean;
}

// ---------------------------------------------------------------- data helpers

function nameOf(kind: number, index: number): string {
	if (kind === ItemKind.Weapon) return index >= 0 && index < WEAPONS.size() ? WEAPONS[index].name : "?";
	if (kind === ItemKind.Equip) return index >= 0 && index < EQUIPS.size() ? EQUIPS[index].name : "?";
	if (kind === ItemKind.Use) return index >= 0 && index < USABLES.size() ? USABLES[index].name : "?";
	return index >= 0 && index < ETC_ITEMS.size() ? ETC_ITEMS[index].name : "?";
}

function weaponKindName(kind: number): string {
	if (kind === WeaponKind.Rifle) return "Rifle";
	if (kind === WeaponKind.Pistol) return "Pistol";
	if (kind === WeaponKind.MG) return "Machine gun";
	if (kind === WeaponKind.Shotgun) return "Shotgun";
	if (kind === WeaponKind.Sniper) return "Sniper rifle";
	if (kind === WeaponKind.Bow) return "Bow";
	if (kind === WeaponKind.Melee) return "Melee";
	if (kind === WeaponKind.Special) return "Special";
	return "Weapon";
}

function isMelee(w: WeaponDef): boolean {
	return w.kind === WeaponKind.Melee || w.mag <= 0;
}

function ammoInfo(save: PlayerSaveData, pool: number): [string, number] {
	if (pool === AmmoPool.Shotgun) return ["shotgun shells", save.ammoShotgun];
	if (pool === AmmoPool.MG) return ["machine gun ammo", save.ammoMachinegun];
	if (pool === AmmoPool.Arrow) return ["arrows", save.ammoArrow];
	if (pool === AmmoPool.Oil) return ["oil", save.oil];
	return ["normal ammo", save.ammoNormal];
}

function damageText(w: WeaponDef): string {
	return w.pellets > 1 ? `${fmtInt(w.dmg)} x${w.pellets}` : fmtInt(w.dmg);
}

function signed(v: number): string {
	return v > 0 ? `+${fmtNum(v)}` : fmtNum(v);
}

function slotValue(save: PlayerSaveData, slot: number): number {
	if (slot === 1) return save.equipCloth;
	if (slot === 2) return save.equipHand;
	if (slot === 3) return save.equipGun;
	if (slot === 4) return save.equipDeco;
	return -1;
}

function stationName(r: CraftRecipe): string {
	const desk = r.needsPro ? "Pro craft desk" : r.needsDesk ? "Craft desk" : "";
	if (r.needsFire === true) return desk === "" ? "Lit fire" : `${desk} + fire`;
	return desk === "" ? "Hand craft" : desk;
}

/** short station tag for lists */
function stationTag(r: CraftRecipe): string {
	if (r.needsPro) return "Pro desk";
	if (r.needsDesk) return "Desk";
	if (r.needsFire === true) return "Fire";
	return "Hand";
}

function recipeMaking(kind: number, index: number): CraftRecipe | undefined {
	for (const r of CRAFT_RECIPES) {
		if (r.resultKind === kind && r.resultIndex === index) return r;
	}
	return undefined;
}

/** tone of an item kind: weapons destructive, equipment info, usables success, materials material */
function kindTone(kind: number): Color3 {
	if (kind === ItemKind.Weapon) return THEME.destructive;
	if (kind === ItemKind.Equip) return GAME.info;
	if (kind === ItemKind.Use) return GAME.success;
	return GAME.material;
}

function escapeRich(s: string): string {
	return s.gsub("&", "&amp;")[0].gsub("<", "&lt;")[0].gsub(">", "&gt;")[0];
}

function colorTag(c: Color3, text: string): string {
	return `<font color="${hex(c)}">${escapeRich(text)}</font>`;
}

// ---------------------------------------------------------------- small local widgets

/** first text line of a row: the name (SemiBold, stays legible on the accent hover) */
function rowTitle(row: GuiObject, x: number, text: string, w: number, color: Color3): TextLabel {
	return makeLabel(row, "Name", text, x, space(2), w, 22, TEXT.base, color, {
		font: "heading",
		align: "left",
		zIndex: 2,
	});
}

/** second text line of a row: stats / ingredients / description */
function rowSubtitle(row: GuiObject, x: number, text: string, w: number, rich = false): TextLabel {
	return makeLabel(row, "Info", text, x, 31, w, 18, TEXT.sm, THEME.mutedForeground, {
		weight: Enum.FontWeight.Medium,
		align: "left",
		rich,
		zIndex: 2,
	});
}

/** the item's initial in a square well (drawn by setGlyph) */
interface Glyph {
	frame: Frame;
	letter: TextLabel;
}

function makeGlyph(parent: Instance, x: number, y: number): Glyph {
	const frame = makeSurface(parent, "Glyph", x, y, GLYPH, GLYPH, "well", {
		fill: SURFACE.well,
		border: SURFACE.line,
		zIndex: 2,
	});
	const letter = makeLabel(frame, "Letter", "", 0, 0, GLYPH, GLYPH, TEXT.lg, THEME.foreground, {
		weight: Enum.FontWeight.Bold,
		zIndex: 3,
	});
	return { frame, letter };
}

/**
 * Square well with the item's initial, outlined in the item kind's tone (muted: the plain well outline). Like
 * the kit's accent Badge, the tone rides the BORDER and the letter stays `foreground` (18.5:1 on the well fill),
 * one light letter for every kind. That is a choice of look, not a contrast workaround: the GAME tones would read
 * as text there too (success 4.68:1 and material 4.63:1 even on the lighter panel, `npm run test:contrast`).
 * The letter has no contour (UI-04): the well behind it is what carries it.
 */
function setGlyph(g: Glyph, name: string, tone: Color3, muted: boolean): void {
	setSurface(g.frame, "well", { fill: SURFACE.well, border: muted ? SURFACE.line : tone });
	g.letter.Text = name.sub(1, 1).upper();
	g.letter.TextColor3 = muted ? THEME.mutedForeground : THEME.foreground;
}

/** stat tile: small caption over a monospaced value */
interface Chip {
	frame: Frame;
	caption: TextLabel;
	value: TextLabel;
}

function makeChip(parent: Instance, name: string, x: number, y: number): Chip {
	const frame = Card(parent, name, { x, y, w: CHIP_W, h: CHIP_H, variant: "muted" });
	const inner = CHIP_W - space(7);
	const caption = makeLabel(frame, "Caption", "", space(3.5), space(2.5), inner, 16, TEXT.xs, THEME.mutedForeground, {
		weight: Enum.FontWeight.Medium,
		align: "left",
	});
	const value = makeLabel(frame, "Value", "", space(3.5), 30, inner, 24, TEXT.xl, THEME.foreground, {
		font: "numeric",
		align: "left",
	});
	return { frame, caption, value };
}

/** thin status line above the craft / skills lists: a well with a coloured pixel chip + one line of text */
interface Notice {
	dot: Frame;
	text: TextLabel;
}

function makeNotice(parent: Frame): Notice {
	const notice = Card(parent, "Notice", { x: 0, y: 0, w: CONTENT_W, h: NOTICE_H, variant: "muted" });
	const d = space(2);
	const dot = makeSurface(notice, "Dot", space(3.5), (NOTICE_H - d) / 2, d, d, "well", {
		fill: THEME.mutedForeground,
		border: THEME.mutedForeground,
		zIndex: 2,
	});
	const textX = space(3.5) + d + space(2.5);
	// muted-foreground (#818c96) on the well fill (#0e0f11) is 5.6:1
	const text = makeLabel(
		notice,
		"Text",
		"",
		textX,
		0,
		CONTENT_W - textX - space(3),
		NOTICE_H,
		TEXT.sm,
		THEME.mutedForeground,
		{ align: "left", zIndex: 2 },
	);
	return { dot, text };
}

function setNotice(n: Notice, text: string, dot: Color3): void {
	setSurface(n.dot, "well", { fill: dot, border: dot });
	n.text.Text = text;
}

// ---------------------------------------------------------------- pages (built once, then updated in place)

/**
 * A page of the content area (one tab's list, the item detail, the recipe detail): built the first time it is
 * shown, then only shown / hidden and rewritten in place.
 */
interface Page {
	frame: Frame;
	/**
	 * Brings the page up to date with the save: computes what it should show (plain data, no Instance) and,
	 * only when that differs from what it shows now, writes it onto the page's existing objects.
	 */
	sync: () => void;
	/** the page's scroll list; its position is kept while the page is hidden */
	list?: ScrollList;
	scroll?: Vector2;
}

/**
 * A pooled row of an item list; `entry` is the item it shows now (its click opens that one). The equipped
 * marks (bar + badge) are made the first time the row shows an equipped item.
 */
interface ItemRow {
	frame: TextButton;
	glyph: Glyph;
	name: TextLabel;
	info: TextLabel;
	count: TextLabel;
	mark?: Frame;
	equipped?: Frame;
	/** entryKey() of what the row shows ("" = blank) */
	key: string;
	entry?: ItemEntry;
}

/** which item a row of an item list is (the row pool's key) */
function itemId(e: ItemEntry): string {
	return `${e.kind}:${e.id}`;
}

/** everything an item row shows (two entries with the same key draw the same row) */
function entryKey(e: ItemEntry): string {
	return `${e.kind}:${e.id}:${e.name}:${e.info}:${e.count}:${e.numeric}:${e.equipped}`;
}

/** a pooled row of the craft list; `recipeId` is the recipe it shows now */
interface RecipeRow {
	frame: TextButton;
	glyph: Glyph;
	name: TextLabel;
	info: TextLabel;
	station: Frame;
	status: TextLabel;
	/** the ingredient line with its colours, and the plain one the accent hover shows */
	rich: string;
	plain: string;
	key: string;
	recipeId: number;
}

/** one row per skill (the skill list never changes); the MAX badge and the + button are made when first needed */
interface SkillRow {
	frame: Frame;
	name: TextLabel;
	pips: Array<Frame>;
	level: TextLabel;
	plus?: TextButton;
	max?: Frame;
	key: string;
}

/** what the one action button of a detail page says and does */
interface DetailAction {
	text: string;
	variant: ButtonVariant;
	enabled: boolean;
	run: () => void;
}

/**
 * The page's action button (centred at the bottom). Hierarchy: the real action of the page (Equip / Use /
 * Craft) is "default", the raised `primary` (green) plate of the reference art; neutral actions (Unequip,
 * Open Craft) are "secondary"; anything impossible is disabled, which the kit draws as a well with muted
 * text (~5.6:1) and whose label says why.
 */
function detailAction(text: string, variant: ButtonVariant, enabled: boolean, run: () => void): DetailAction {
	return { text, variant, enabled, run };
}

const noop = (): void => {};

/** what a detail page (item or recipe) shows, computed from the save */
interface DetailModel {
	caption: string;
	name: string;
	equipped: boolean;
	stats: Array<[string, string]>;
	act: DetailAction;
}

interface ItemDetailModel extends DetailModel {
	owned: string;
	ownedColor: Color3;
	help: string;
}

interface IngredientModel {
	name: string;
	count: string;
	tone: Color3;
}

interface RecipeModel extends DetailModel {
	ingredients: Array<IngredientModel>;
	station: string;
	stationColor: Color3;
	stationBorder: Color3;
	hint: string;
}

/** signature of what a detail page draws (the button's handler is not drawn: it is refreshed on every sync) */
function detailSig(m: DetailModel): string {
	let s = `${m.caption}|${m.name}|${m.equipped}|${m.act.text}|${m.act.variant}|${m.act.enabled}`;
	for (const [caption, value] of m.stats) s += `|${caption}=${value}`;
	return s;
}

/** header, stat chips and action button: the part the item and recipe pages share */
interface DetailView {
	parent: Frame;
	caption: TextLabel;
	name: TextLabel;
	equipped: Frame;
	chips: Array<Chip>;
	action: TextButton;
	/** what the action button does now */
	run: () => void;
}

function makeDetailView(parent: Frame, chips: number): DetailView {
	const caption = makeLabel(parent, "Caption", "", 0, 0, CONTENT_W - 120, 20, TEXT.sm, THEME.mutedForeground, {
		font: "label",
		align: "left",
	});
	const name = makeLabel(parent, "Name", "", 0, 24, CONTENT_W - 120, 44, TEXT.xl3, THEME.foreground, {
		font: "title",
		align: "left",
	});
	const h = 26;
	const w = badgeWidth("EQUIPPED", TEXT.sm, h);
	const equipped = Badge(parent, "Equipped", "EQUIPPED", {
		x: CONTENT_W - w,
		y: 24 + (44 - h) / 2,
		w,
		h,
		textSize: TEXT.sm,
		color: GAME.success,
	});
	equipped.Visible = false;
	const list: Array<Chip> = [];
	for (let i = 0; i < chips; i++) list.push(makeChip(parent, `Stat${i}`, i * (CHIP_W + CHIP_GAP), 88));
	let view: DetailView | undefined;
	const action = Button(parent, "Action", "", {
		x: (CONTENT_W - ACTION_W) / 2,
		y: CONTENT_H - ACTION_H - space(3),
		w: ACTION_W,
		size: "lg",
		variant: "default",
		onClick: (): void => view?.run(),
	});
	view = { parent, caption, name, equipped, chips: list, action, run: noop };
	return view;
}

function applyDetail(v: DetailView, m: DetailModel): void {
	v.caption.Text = m.caption;
	v.name.Text = m.name;
	v.equipped.Visible = m.equipped;
	// a model with more stats than the page ever showed grows it (the page is built with MAX_CHIPS)
	while (v.chips.size() < m.stats.size()) {
		const i = v.chips.size();
		v.chips.push(makeChip(v.parent, `Stat${i}`, i * (CHIP_W + CHIP_GAP), 88));
	}
	for (let i = 0; i < v.chips.size(); i++) {
		const chip = v.chips[i];
		const stat = m.stats[i];
		chip.frame.Visible = stat !== undefined;
		if (stat === undefined) continue;
		chip.caption.Text = stat[0].upper();
		chip.value.Text = stat[1];
	}
	v.action.Text = m.act.text;
	setButtonVariant(v.action, m.act.variant);
	setButtonEnabled(v.action, m.act.enabled);
}

/** one line of the recipe page's ingredient list */
interface IngredientLine {
	frame: Frame;
	name: TextLabel;
	count: TextLabel;
}

function makeIngredientLine(parent: Frame, i: number): IngredientLine {
	const frame = Card(parent, `Ing${i}`, {
		x: 0,
		y: 196 + i * (ING_H + space(2)),
		w: ING_W,
		h: ING_H,
		variant: "muted",
		border: SURFACE.line,
	});
	const nameW = ING_W - space(8) - ING_COUNT_W;
	const name = makeLabel(frame, "Name", "", space(4), 0, nameW, ING_H, TEXT.base, THEME.foreground, {
		align: "left",
	});
	const count = makeLabel(
		frame,
		"Count",
		"",
		ING_W - space(4) - ING_COUNT_W,
		0,
		ING_COUNT_W,
		ING_H,
		TEXT.base,
		THEME.foreground,
		{
			font: "numeric",
			align: "right",
		},
	);
	frame.Visible = false;
	return { frame, name, count };
}

// ---------------------------------------------------------------- backpack

export class Backpack {
	onUse: ((itemId: number) => void) | undefined;
	onCraft: ((recipeId: number) => void) | undefined;
	onEquipWeapon: ((weaponId: number) => void) | undefined;
	onEquipItem: ((equipId: number) => void) | undefined;
	/** unequip an equipment slot: 1 cloth, 2 hand, 3 gun, 4 deco */
	onUnequipItem: ((slot: number) => void) | undefined;
	nearbyDesk = false;
	nearbyPro = false;
	/** a lit campfire/brazier is close (smelting recipes) */
	nearbyFire = false;
	/** authoritative craft check from the game (craftSystem.craftBlocker): reason it can't be crafted, or undefined */
	craftCheck: ((recipeId: number) => string | undefined) | undefined;

	private ctx: GameContext;
	private root: Frame | undefined;
	private panel: Frame | undefined;
	/** where the panel rests (the entrance slides it up to here) */
	private panelAt = new UDim2();
	private content: Frame | undefined;
	private spBadge: Frame | undefined;
	private keyHint: Frame | undefined;
	private backBtn: TextButton | undefined;
	private nav: SidebarHandle | undefined;
	private opened = false;
	/** the pages built so far, by pageKey(): built when first shown, kept while the window lives */
	private pages = new Map<string, Page>();
	/** the page on screen */
	private page: Page | undefined;
	/** what the header shows ("" = not drawn yet); it is rewritten only when this changes */
	private headerSig = "";
	private syncConn: RBXScriptConnection | undefined;
	private syncClock = 0;
	private level = LEVEL_LIST;
	private cat = CAT_WEAPONS;
	private selItem = 0;
	private selKind = 0;
	private selRecipe = 0;

	constructor(ctx: GameContext) {
		this.ctx = ctx;
	}

	isOpen(): boolean {
		return this.opened;
	}

	open(): void {
		if (this.opened) return;
		// reopen on the last tab (Weapons the first time), always at its list and scrolled to the top
		this.level = this.cat === CAT_SKILLS ? LEVEL_SKILLS : LEVEL_LIST;
		// the window is built once, and again only if something destroyed it
		let root = this.root;
		if (root === undefined || root.Parent === undefined) root = this.mount();
		for (const [, page] of this.pages) {
			page.scroll = undefined;
			if (page.list !== undefined) page.list.frame.CanvasPosition = new Vector2();
		}
		// the key cap is for keyboards (one can be plugged in between two opens)
		if (this.keyHint !== undefined) this.keyHint.Visible = UserInputService.KeyboardEnabled;
		this.opened = true;

		// entrance: fade the scrim in, slide the panel up a little
		root.BackgroundTransparency = 1;
		tween(root, 0.15, { BackgroundTransparency: TRANSPARENCY.overlay });
		const panel = this.panel;
		if (panel !== undefined) {
			panel.Position = this.panelAt.add(UDim2.fromScale(0, 0.025));
			tween(panel, 0.18, { Position: this.panelAt });
		}
		setVisible(root, true);
		this.rebuild();

		// While open, the page on screen checks its data a few times a second: a server reply, an admin patch or
		// a new save from the server changes the save without going through this class, and must still show.
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
		// hidden, not destroyed: the next open() shows this window and its pages again, as they are
		if (this.root !== undefined) setVisible(this.root, false);
	}

	/** builds the window: title strip, category rail, an empty content area (the pages come as they are shown) */
	private mount(): Frame {
		this.pages.clear();
		this.page = undefined;
		this.headerSig = "";
		const screen = makeScreen(this.ctx.uiLayer, "Backpack", {
			color: THEME.background,
			transparency: TRANSPARENCY.overlay,
			zIndex: 200,
		});
		this.root = screen.root;
		const panel = Card(screen.body, "Panel", { x: 60, y: 30, w: PANEL_W, h: PANEL_H });
		this.panel = panel;
		this.panelAt = panel.Position;

		// header: the title strip, with the skill points at its left and the key cap / back / close at its right
		const contentY = CardHeader(panel, "Backpack", undefined, { action: HEADER_ACTION });
		this.spBadge = Badge(panel, "SkillPoints", "", {
			x: STRIP_INSET + space(2),
			y: HEADER_Y + (HEADER_H - BADGE_H) / 2,
			w: SP_W,
			h: BADGE_H,
			textSize: TEXT.sm,
			color: GAME.xp,
			zIndex: HEADER_Z,
		});
		const closeX = PANEL_W - STRIP_INSET - space(1) - ICON_W;
		const navX = closeX - space(2) - ICON_W;
		// a raised key cap (Badge "default"), not a caption: muted text would not clear 4.5:1 on the strip
		this.keyHint = Badge(panel, "KeyHint", KEY_HINT, {
			x: navX - space(2) - KEY_W,
			y: HEADER_Y + (HEADER_H - BADGE_H) / 2,
			w: KEY_W,
			h: BADGE_H,
			textSize: TEXT.sm,
			zIndex: HEADER_Z,
		});
		this.backBtn = Button(panel, "Nav", "<", {
			x: navX,
			y: HEADER_BTN_Y,
			w: ICON_W,
			size: "icon",
			variant: "secondary",
			zIndex: HEADER_Z,
			onClick: (): void => this.goBack(),
		});
		Button(panel, "Close", "X", {
			x: closeX,
			y: HEADER_BTN_Y,
			w: ICON_W,
			size: "icon",
			variant: "destructive",
			zIndex: HEADER_Z,
			onClick: (): void => this.close(),
		});

		// categories: sidebar on the left (contentY is BODY_Y: the strip's height comes from the kit)
		const nav = Sidebar(panel, "Categories", {
			x: PAD,
			y: contentY,
			w: NAV_W,
			h: BODY_H,
			items: CAT_NAMES,
			value: this.cat,
			itemH: NAV_ITEM_H,
			textSize: TEXT.base,
			onChange: (index: number): void => this.selectCat(index),
		});
		this.nav = nav;
		this.content = makeFrame(panel, "Content", CONTENT_X, contentY, CONTENT_W, CONTENT_H, THEME.card, {
			transparency: 1,
		});
		return screen.root;
	}

	// ------------------------------------------------------------ navigation

	private selectCat(index: number): void {
		this.cat = index;
		this.level = index === CAT_SKILLS ? LEVEL_SKILLS : LEVEL_LIST;
		this.rebuild();
	}

	private goBack(): void {
		if (this.level === LEVEL_DETAIL || this.level === LEVEL_RECIPE) {
			this.level = LEVEL_LIST;
			this.rebuild();
			return;
		}
		this.close();
	}

	private openDetail(kind: number, id: number): void {
		this.selKind = kind;
		this.selItem = id;
		this.level = LEVEL_DETAIL;
		this.rebuild();
	}

	private openRecipe(recipeId: number): void {
		this.selRecipe = recipeId;
		this.level = LEVEL_RECIPE;
		this.rebuild();
	}

	private refreshHeader(): void {
		const sp = this.ctx.save.skillPoint;
		const inDetail = this.level === LEVEL_DETAIL || this.level === LEVEL_RECIPE;
		const sig = `${sp}|${this.cat}|${inDetail}`;
		if (sig === this.headerSig) return;
		this.headerSig = sig;
		if (this.spBadge !== undefined) {
			// xp badge while there are points to spend, secondary otherwise
			setBadge(this.spBadge, `SP ${sp}`, sp > 0 ? GAME.xp : THEME.secondary);
		}
		// unspent skill points on the Skills item of the rail
		this.nav?.setBadge(
			CAT_SKILLS,
			sp > 0 && this.cat !== CAT_SKILLS ? (sp > 9 ? "9+" : `${sp}`) : undefined,
			GAME.xp,
		);
		this.nav?.setActive(this.cat);
		if (this.backBtn !== undefined) setButtonEnabled(this.backBtn, inDetail);
	}

	/**
	 * Brings the screen up to date: the header, then the page of the current level / tab (built the first time it
	 * is needed; the previous page is only hidden), which rewrites itself only if its data changed. Every action,
	 * every navigation and the open Bag's periodic check call this, and it is cheap when nothing changed. (The
	 * name is from when it destroyed the page and built it again.)
	 */
	private rebuild(): void {
		const content = this.content;
		if (content === undefined || !this.opened) return;
		this.refreshHeader();
		const key = this.pageKey();
		let page = this.pages.get(key);
		if (page === undefined) {
			page = this.mountPage(key, content);
			this.pages.set(key, page);
		}
		if (page !== this.page) {
			if (this.page !== undefined) this.hidePage(this.page);
			this.page = page;
			this.showPage(page);
		}
		page.sync();
	}

	private pageKey(): string {
		if (this.level === LEVEL_DETAIL) return "Detail";
		if (this.level === LEVEL_RECIPE) return "Recipe";
		return `Tab${this.cat}`;
	}

	private mountPage(key: string, content: Frame): Page {
		// every page fills the content area; one is visible at a time
		const frame = makeFrame(content, key, 0, 0, CONTENT_W, CONTENT_H, THEME.card, { transparency: 1 });
		if (key === "Detail") return this.mountDetail(frame);
		if (key === "Recipe") return this.mountRecipe(frame);
		if (this.cat === CAT_SKILLS) return this.mountSkills(frame);
		if (this.cat === CAT_CRAFT) return this.mountCraft(frame);
		return this.mountItems(frame, this.cat);
	}

	private showPage(page: Page): void {
		setVisible(page.frame, true);
		// the list kept its place while hidden; restored in case the engine clamped it meanwhile
		if (page.list !== undefined && page.scroll !== undefined) page.list.frame.CanvasPosition = page.scroll;
	}

	private hidePage(page: Page): void {
		if (page.list !== undefined) page.scroll = page.list.frame.CanvasPosition;
		setVisible(page.frame, false);
	}

	/** scroll list of a page */
	private makeList(parent: Frame, y: number, h: number): ScrollList {
		const list = makeScrollList(parent, "List", 0, y, CONTENT_W, h);
		// keep the row outlines clear of the ScrollingFrame clipping
		const pad = list.frame.FindFirstChildOfClass("UIPadding");
		if (pad !== undefined) {
			pad.PaddingLeft = new UDim(0, 2);
			pad.PaddingTop = new UDim(0, 2);
			pad.PaddingBottom = new UDim(0, 2);
		}
		return list;
	}

	// ------------------------------------------------------------ item tabs

	private itemEntries(cat: number): Array<ItemEntry> {
		const save = this.ctx.save;
		const out: Array<ItemEntry> = [];
		if (cat === CAT_WEAPONS) {
			for (const w of WEAPONS) {
				if (!ownsWeapon(save, w.id)) continue;
				const count = save.invenWeapon[w.id] ?? 0;
				let info = `${weaponKindName(w.kind)} · Damage ${damageText(w)}`;
				if (!isMelee(w)) info += ` · Mag ${fmtInt(w.mag)}`;
				const isDefault = w.id === 0 && count === 0;
				out.push({
					kind: ItemKind.Weapon,
					id: w.id,
					name: w.name,
					info,
					count: isDefault ? "Default" : `x ${fmtInt(count)}`,
					numeric: !isDefault,
					equipped: save.equipWeapon === w.id,
				});
			}
		} else if (cat === CAT_EQUIP) {
			for (const e of EQUIPS) {
				if (!ownsEquip(save, e.id)) continue;
				const count = save.invenEquip[e.id] ?? 0;
				const slot = equipSlotOf(e.id);
				let info = `${SLOT_NAMES[slot] ?? "-"} slot`;
				if (e.def !== 0) info += ` · Defense ${fmtNum(e.def)}`;
				if (e.speed !== 0) info += ` · Speed ${signed(e.speed)}`;
				out.push({
					kind: ItemKind.Equip,
					id: e.id,
					name: e.name,
					info,
					count: count > 0 ? `x ${fmtInt(count)}` : "Costume",
					numeric: count > 0,
					equipped: slotValue(save, slot) === e.id,
				});
			}
		} else if (cat === CAT_USABLES) {
			for (const u of USABLES) {
				const count = save.invenUse[u.id] ?? 0;
				if (count <= 0) continue;
				let info = `HP ${signed(u.hp)} · Hunger ${signed(u.hunger)}`;
				if (u.speed !== 0) info += ` · Speed ${fmtNum(u.speed)} min`;
				if (u.calm !== 0) info += ` · Calm ${fmtNum(u.calm)} min`;
				if (u.pain !== 0) info += ` · Pain ${fmtNum(u.pain)} min`;
				out.push({
					kind: ItemKind.Use,
					id: u.id,
					name: u.name,
					info,
					count: `x ${fmtInt(count)}`,
					numeric: true,
					equipped: false,
				});
			}
		} else {
			for (let i = MAT_START; i < ETC_ITEMS.size(); i++) {
				const m = ETC_ITEMS[i];
				const count = save.invenEtc[m.id] ?? 0;
				if (count <= 0) continue;
				const uses = this.recipesUsing(m.id).size();
				out.push({
					kind: ItemKind.Etc,
					id: m.id,
					name: m.name,
					info: uses > 0 ? `Material · used in ${uses} recipe${uses === 1 ? "" : "s"}` : "Material",
					count: `x ${fmtInt(count)}`,
					numeric: true,
					equipped: false,
				});
			}
		}
		return out;
	}

	private mountItems(frame: Frame, cat: number): Page {
		const list = this.makeList(frame, 0, CONTENT_H);
		const rows = new RowPool<ItemRow>(list, (l, i) => this.makeItemRow(l, i));
		let empty: Frame | undefined;
		// signature of the rows on screen: the page's dirty flag (undefined = never drawn)
		let shown: string | undefined;
		return {
			frame,
			list,
			sync: (): void => {
				const entries = this.itemEntries(cat);
				const keys = entries.map(entryKey);
				const sig = keys.join(";");
				if (sig === shown) return;
				shown = sig;
				const none = entries.size() === 0;
				if (none && empty === undefined) empty = this.buildEmpty(frame, cat);
				if (empty !== undefined) setVisible(empty, none);
				setVisible(list.frame, !none);
				rows.begin();
				for (let i = 0; i < entries.size(); i++) {
					this.fillItemRow(rows.acquire(itemId(entries[i])), entries[i], keys[i]);
				}
				rows.finish();
			},
		};
	}

	private makeItemRow(list: ScrollList, index: number): ItemRow {
		let row: ItemRow | undefined;
		const frame = ListRowButton(list, `Row${index}`, index, ROW_H, (): void => {
			const e = row?.entry;
			if (e !== undefined) this.openDetail(e.kind, e.id);
		});
		const glyph = makeGlyph(frame, ROW_PAD, (ROW_H - GLYPH) / 2);
		const textW = ITEM_BADGE_X - space(3) - ROW_TEXT_X;
		const name = rowTitle(frame, ROW_TEXT_X, "", textW, THEME.foreground);
		const info = rowSubtitle(frame, ROW_TEXT_X, "", textW);
		const count = makeLabel(frame, "Count", "", ITEM_COUNT_X, 0, COUNT_W, ROW_H, TEXT.base, THEME.mutedForeground, {
			font: "numeric",
			align: "right",
			zIndex: 2,
		});
		row = { frame, glyph, name, info, count, key: "" };
		return row;
	}

	private fillItemRow(row: ItemRow, e: ItemEntry, key: string): void {
		row.entry = e;
		if (key === row.key) return;
		row.key = key;
		if (e.equipped && row.mark === undefined) {
			row.mark = makeFrame(row.frame, "Mark", 0, space(2), 3, ROW_H - space(4), GAME.success, { zIndex: 2 });
			row.equipped = Badge(row.frame, "Equipped", "EQUIPPED", {
				x: ITEM_BADGE_X,
				y: (ROW_H - BADGE_H) / 2,
				w: ITEM_BADGE_W,
				h: BADGE_H,
				textSize: TEXT.sm,
				color: GAME.success,
			});
		}
		if (row.mark !== undefined) row.mark.Visible = e.equipped;
		if (row.equipped !== undefined) row.equipped.Visible = e.equipped;
		setGlyph(row.glyph, e.name, kindTone(e.kind), false);
		row.name.Text = e.name;
		row.info.Text = e.info;
		row.count.Text = e.count;
		row.count.FontFace = roleFont(e.numeric ? "numeric" : "label");
	}

	private buildEmpty(parent: Frame, cat: number): Frame {
		let title = "No materials yet";
		let body = "Gather wood, stone and scrap while you explore. Materials are used in the Craft tab.";
		let craftShortcut = false;
		if (cat === CAT_WEAPONS) {
			title = "No weapons yet";
			body = "Find them in buildings or craft them in the Craft tab.";
			craftShortcut = true;
		} else if (cat === CAT_EQUIP) {
			title = "No equipment yet";
			body = "Find it in buildings, craft it in the Craft tab, or unlock decos with costumes in the shop.";
			craftShortcut = true;
		} else if (cat === CAT_USABLES) {
			title = "No usables yet";
			body = "Search buildings and fallen zombies for food and medicine.";
		}
		const w = 520;
		const titleY = space(7);
		const titleH = 30;
		const bodyY = titleY + titleH + space(3);
		const bodyH = 44;
		const buttonH = BUTTON_SIZE.default.h;
		const h = bodyY + bodyH + space(7) + (craftShortcut ? buttonH + space(7) : 0);
		const card = Card(parent, "Empty", { x: (CONTENT_W - w) / 2, y: space(16), w, h });
		CardTitle(card, title, { y: titleY, h: titleH, size: TEXT.xl2, align: "center" });
		CardDescription(card, body, { y: bodyY, h: bodyH, size: TEXT.base, align: "center" });
		if (craftShortcut) {
			const buttonW = 180;
			// navigation, not the "one main action" of a page: a raised `secondary` plate, not the green one
			Button(card, "ToCraft", "Open Craft", {
				x: (w - buttonW) / 2,
				y: h - space(7) - buttonH,
				w: buttonW,
				variant: "secondary",
				onClick: (): void => this.selectCat(CAT_CRAFT),
			});
		}
		return card;
	}

	// ------------------------------------------------------------ item detail

	private mountDetail(frame: Frame): Page {
		const view = makeDetailView(frame, MAX_CHIPS);
		Separator(frame, "Divider", { x: 0, y: 170, length: CONTENT_W });
		const owned = makeLabel(frame, "Owned", "", 0, 184, 600, 26, TEXT.lg, THEME.foreground, {
			font: "heading",
			align: "left",
		});
		const help = makeLabel(frame, "Help", "", 0, 218, CONTENT_W, 100, TEXT.base, THEME.mutedForeground, {
			align: "left",
			valign: "top",
		});
		let shown: string | undefined;
		return {
			frame,
			sync: (): void => {
				const m = this.itemDetail();
				if (m === undefined) {
					this.level = LEVEL_LIST;
					this.rebuild();
					return;
				}
				view.run = m.act.run;
				const sig = `${detailSig(m)}|${m.owned}|${hex(m.ownedColor)}|${m.help}`;
				if (sig === shown) return;
				shown = sig;
				applyDetail(view, m);
				owned.Text = m.owned;
				owned.TextColor3 = m.ownedColor;
				help.Text = m.help;
			},
		};
	}

	/** what the item detail shows for the selected item (undefined: no such item) */
	private itemDetail(): ItemDetailModel | undefined {
		const kind = this.selKind;
		const id = this.selItem;
		if (kind === ItemKind.Weapon && WEAPONS[id] !== undefined) return this.weaponDetail(WEAPONS[id]);
		if (kind === ItemKind.Equip && EQUIPS[id] !== undefined) return this.equipDetail(id);
		if (kind === ItemKind.Use && USABLES[id] !== undefined) return this.usableDetail(id);
		if (kind === ItemKind.Etc && ETC_ITEMS[id] !== undefined) return this.materialDetail(id);
		return undefined;
	}

	private weaponDetail(w: WeaponDef): ItemDetailModel {
		const save = this.ctx.save;
		const id = w.id;
		const owned = ownsWeapon(save, id);
		const count = save.invenWeapon[id] ?? 0;
		const equipped = save.equipWeapon === id;

		const stats: Array<[string, string]> = [
			["Damage", damageText(w)],
			["Fire rate", fmtSeconds(w.cooldown)],
		];
		if (!isMelee(w)) {
			stats.push(["Mag", fmtInt(w.mag)]);
			stats.push(["Reload", fmtSeconds(w.reload)]);
		}
		stats.push(["Range", fmtNum(w.range)]);

		const help: Array<string> = [];
		if (isMelee(w)) {
			help.push("Melee weapon: no ammo needed.");
		} else {
			const [ammoName, ammoCount] = ammoInfo(save, w.ammoPool);
			help.push(`Uses ${ammoName}. You carry ${fmtInt(ammoCount)}.`);
		}
		if (w.pellets > 1) help.push(`Fires ${w.pellets} pellets per shot.`);
		if (equipped) {
			help.push("This is the weapon in your hands.");
		} else if (!owned) {
			const r = recipeMaking(ItemKind.Weapon, id);
			help.push(
				r !== undefined ? `You don't have it yet. Craft it: ${stationName(r)}.` : "You don't have it yet.",
			);
		}
		let ownedText = owned ? `Owned x ${fmtInt(count)}` : "Not owned";
		if (id === 0 && count === 0) ownedText = "Default weapon";

		let act: DetailAction;
		if (!owned) act = detailAction("Not owned", "secondary", false, noop);
		else if (equipped) act = detailAction("Equipped", "secondary", false, noop);
		else act = detailAction("Equip", "default", true, (): void => this.equipWeapon(id));
		return {
			caption: `WEAPON · ${weaponKindName(w.kind).upper()}`,
			name: w.name,
			equipped,
			stats,
			owned: ownedText,
			ownedColor: owned ? THEME.foreground : THEME.mutedForeground,
			help: help.join(" "),
			act,
		};
	}

	private equipDetail(id: number): ItemDetailModel {
		const save = this.ctx.save;
		const e = EQUIPS[id];
		const slot = equipSlotOf(id);
		const slotName = SLOT_NAMES[slot] ?? "-";
		const owned = ownsEquip(save, id);
		const count = save.invenEquip[id] ?? 0;
		const costume = costumeForEquip(id);
		const viaCostume = costume !== undefined && ownsCostume(save, costume.id);
		const current = slotValue(save, slot);
		const equipped = current === id;

		const stats: Array<[string, string]> = [["Slot", slotName]];
		if (slot === 1 || e.def !== 0) stats.push(["Defense", fmtNum(e.def)]);
		if (slot === 1 || e.speed !== 0) stats.push(["Speed", signed(e.speed)]);

		const help: Array<string> = [`Goes in the ${slotName} slot.`];
		if (equipped) {
			help.push("Currently equipped.");
		} else if (current >= 0 && EQUIPS[current] !== undefined) {
			help.push(`Equipping it replaces ${EQUIPS[current].name}.`);
		}
		if (costume !== undefined) {
			help.push(
				viaCostume
					? `Unlocked by the ${costume.name} costume.`
					: `Unlock it with the ${costume.name} costume in the shop.`,
			);
		}
		let ownedText = "Not owned";
		if (count > 0) ownedText = `Owned x ${fmtInt(count)}`;
		else if (viaCostume) ownedText = "Unlocked by costume";

		let act: DetailAction;
		if (!owned) {
			act = detailAction("Not owned", "secondary", false, noop);
		} else if (equipped) {
			act = detailAction("Unequip", "secondary", this.onUnequipItem !== undefined, (): void =>
				this.unequipItem(id, slot),
			);
		} else {
			act = detailAction("Equip", "default", true, (): void => this.equipItem(id, slot));
		}
		return {
			caption: `EQUIPMENT · ${slotName.upper()} SLOT`,
			name: e.name,
			equipped,
			stats,
			owned: ownedText,
			ownedColor: owned ? THEME.foreground : THEME.mutedForeground,
			help: help.join(" "),
			act,
		};
	}

	private usableDetail(id: number): ItemDetailModel {
		const save = this.ctx.save;
		const u = USABLES[id];
		const count = save.invenUse[id] ?? 0;

		const stats: Array<[string, string]> = [
			["HP", signed(u.hp)],
			["Hunger", signed(u.hunger)],
		];
		if (u.speed !== 0) stats.push(["Speed", `${fmtNum(u.speed)} min`]);
		if (u.calm !== 0) stats.push(["Calm", `${fmtNum(u.calm)} min`]);
		if (u.pain !== 0) stats.push(["Pain", `${fmtNum(u.pain)} min`]);

		const help: Array<string> = ["Consumed when used."];
		if (u.cook >= 0 && USABLES[u.cook] !== undefined) help.push(`Can be cooked into ${USABLES[u.cook].name}.`);
		return {
			caption: "USABLE",
			name: u.name,
			equipped: false,
			stats,
			owned: `Owned x ${fmtInt(count)}`,
			ownedColor: count > 0 ? THEME.foreground : THEME.mutedForeground,
			help: help.join(" "),
			act: detailAction(count > 0 ? "Use" : "None left", "default", count > 0, (): void => this.useItem(id)),
		};
	}

	private recipesUsing(etcId: number): Array<CraftRecipe> {
		const out: Array<CraftRecipe> = [];
		for (const r of CRAFT_RECIPES) {
			for (const ing of r.ingredients) {
				if (ing.kind === ItemKind.Etc && ing.index === etcId) {
					out.push(r);
					break;
				}
			}
		}
		return out;
	}

	private materialDetail(id: number): ItemDetailModel {
		const save = this.ctx.save;
		const count = save.invenEtc[id] ?? 0;
		const uses = this.recipesUsing(id);

		let help = "Not used in any recipe.";
		if (uses.size() > 0) {
			const names: Array<string> = [];
			const shown = math.min(uses.size(), 5);
			for (let i = 0; i < shown; i++) {
				names.push(nameOf(uses[i].resultKind, uses[i].resultIndex));
			}
			help = `Used to craft ${names.join(", ")}`;
			help += uses.size() > shown ? ` and ${uses.size() - shown} more.` : ".";
		}
		return {
			caption: "MATERIAL",
			name: ETC_ITEMS[id].name,
			equipped: false,
			stats: [
				["Owned", fmtInt(count)],
				["Recipes", fmtInt(uses.size())],
			],
			owned: `Owned x ${fmtInt(count)}`,
			ownedColor: count > 0 ? THEME.foreground : THEME.mutedForeground,
			help,
			act: detailAction("Open Craft", "secondary", true, (): void => this.selectCat(CAT_CRAFT)),
		};
	}

	// ------------------------------------------------------------ actions (rules live in main.client)

	private equipWeapon(id: number): void {
		if (!ownsWeapon(this.ctx.save, id) || this.ctx.save.equipWeapon === id) return;
		this.onEquipWeapon?.(id);
		if (this.ctx.save.equipWeapon === id) toast(this.ctx, `Equipped ${nameOf(ItemKind.Weapon, id)}`);
		this.rebuild();
	}

	private equipItem(id: number, slot: number): void {
		if (!ownsEquip(this.ctx.save, id) || slotValue(this.ctx.save, slot) === id) return;
		this.onEquipItem?.(id);
		if (slotValue(this.ctx.save, slot) === id) toast(this.ctx, `Equipped ${nameOf(ItemKind.Equip, id)}`);
		this.rebuild();
	}

	private unequipItem(id: number, slot: number): void {
		if (slotValue(this.ctx.save, slot) !== id) return;
		this.onUnequipItem?.(slot);
		if (slotValue(this.ctx.save, slot) !== id) toast(this.ctx, `Unequipped ${nameOf(ItemKind.Equip, id)}`);
		this.rebuild();
	}

	private useItem(id: number): void {
		if ((this.ctx.save.invenUse[id] ?? 0) <= 0) return;
		this.onUse?.(id);
		this.rebuild();
	}

	// ------------------------------------------------------------ craft

	private recipeAvailable(r: CraftRecipe): boolean {
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
		for (const ing of r.ingredients) {
			if (this.ingredientCount(ing.kind, ing.index) < ing.count) return false;
		}
		return true;
	}

	private resultName(r: CraftRecipe): string {
		const n = nameOf(r.resultKind, r.resultIndex);
		return r.resultCount > 1 ? `${n} x${r.resultCount}` : n;
	}

	/** the status line of the craft list: what the station nearby allows */
	private craftNotice(): [string, Color3] {
		const fire = this.nearbyFire ? " A lit fire is nearby: smelting works." : " Smelting needs a lit fire.";
		if (this.nearbyPro) return [`Pro craft desk nearby: every desk recipe works here.${fire}`, GAME.success];
		if (this.nearbyDesk) return [`Craft desk nearby. Pro recipes need a pro desk.${fire}`, GAME.warning];
		return [
			`No craft desk nearby: hand recipes only.${fire}`,
			this.nearbyFire ? GAME.warning : THEME.mutedForeground,
		];
	}

	/** everything a recipe row draws follows from: the recipe, whether the station allows it, the counts it reads */
	private recipeKey(r: CraftRecipe): string {
		let key = `${r.id}:${this.recipeAvailable(r)}`;
		for (const ing of r.ingredients) key += `:${this.ingredientCount(ing.kind, ing.index)}`;
		return key;
	}

	private mountCraft(frame: Frame): Page {
		const notice = makeNotice(frame);
		const list = this.makeList(frame, NOTICE_H + LIST_GAP, CONTENT_H - NOTICE_H - LIST_GAP);
		const rows = new RowPool<RecipeRow>(list, (l, i) => this.makeRecipeRow(l, i));
		let shown: string | undefined;
		return {
			frame,
			list,
			sync: (): void => {
				const [text, dot] = this.craftNotice();
				// craftable now first, then what this station allows, then recipes that need another desk
				const ready: Array<CraftRecipe> = [];
				const missing: Array<CraftRecipe> = [];
				const locked: Array<CraftRecipe> = [];
				for (const r of CRAFT_RECIPES) {
					if (!this.recipeAvailable(r)) locked.push(r);
					else if (this.hasIngredients(r)) ready.push(r);
					else missing.push(r);
				}
				const order: Array<CraftRecipe> = [];
				const keys: Array<string> = [];
				for (const group of [ready, missing, locked]) {
					for (const r of group) {
						order.push(r);
						keys.push(this.recipeKey(r));
					}
				}
				const sig = `${text}|${hex(dot)}|${keys.join(";")}`;
				if (sig === shown) return;
				shown = sig;
				setNotice(notice, text, dot);
				// rows follow their recipe: a re-sort moves them, and only a recipe whose key changed is rewritten
				rows.begin();
				for (let i = 0; i < order.size(); i++) {
					this.fillRecipeRow(rows.acquire(`${order[i].id}`), order[i], keys[i]);
				}
				rows.finish();
			},
		};
	}

	private makeRecipeRow(list: ScrollList, index: number): RecipeRow {
		let row: RecipeRow | undefined;
		const frame = ListRowButton(list, `Recipe${index}`, index, ROW_H, (): void => {
			if (row !== undefined) this.openRecipe(row.recipeId);
		});
		const glyph = makeGlyph(frame, ROW_PAD, (ROW_H - GLYPH) / 2);
		const statusX = CONTENT_W - ROW_PAD - STATUS_W;
		const stationX = statusX - space(3) - STATION_W;
		const textW = stationX - space(3) - ROW_TEXT_X;
		const name = rowTitle(frame, ROW_TEXT_X, "", textW, THEME.foreground);
		const info = rowSubtitle(frame, ROW_TEXT_X, "", textW, true);
		const station = Badge(frame, "Station", "", {
			x: stationX,
			y: (ROW_H - BADGE_H) / 2,
			w: STATION_W,
			h: BADGE_H,
			textSize: TEXT.sm,
			variant: "secondary",
		});
		const status = makeLabel(frame, "Status", "", statusX, 0, STATUS_W, ROW_H, TEXT.sm, THEME.destructive, {
			font: "heading",
			align: "right",
			zIndex: 2,
		});
		const r: RecipeRow = { frame, glyph, name, info, station, status, rich: "", plain: "", key: "", recipeId: -1 };
		row = r;
		// the kit turns the row's labels accent-foreground on the accent hover / selection; <font> tags would keep
		// their tones (unreadable on accent), so the line goes plain meanwhile
		info.GetPropertyChangedSignal("TextColor3").Connect((): void => {
			info.Text = info.TextColor3 === THEME.accentForeground ? r.plain : r.rich;
		});
		return r;
	}

	private fillRecipeRow(row: RecipeRow, r: CraftRecipe, key: string): void {
		row.recipeId = r.id;
		if (key === row.key) return;
		row.key = key;
		const avail = this.recipeAvailable(r);
		const enough = this.hasIngredients(r);
		const name = this.resultName(r);
		setGlyph(row.glyph, name, kindTone(r.resultKind), !avail);
		row.name.Text = name;
		setLabelColor(row.name, avail ? THEME.foreground : THEME.mutedForeground);

		// ingredients: have / need in success or destructive
		const coloured: Array<string> = [];
		const plain: Array<string> = [];
		for (const ing of r.ingredients) {
			const have = this.ingredientCount(ing.kind, ing.index);
			const text = `${nameOf(ing.kind, ing.index)} ${fmtInt(have)}/${fmtInt(ing.count)}`;
			coloured.push(colorTag(have >= ing.count ? GAME.success : THEME.destructive, text));
			plain.push(escapeRich(text));
		}
		row.rich = coloured.join(colorTag(THEME.mutedForeground, "  ·  "));
		row.plain = plain.join("  ·  ");
		row.info.Text = row.info.TextColor3 === THEME.accentForeground ? row.plain : row.rich;

		setBadge(row.station, stationTag(r).upper());
		setBadgeLook(row.station, avail ? "secondary" : "destructive");
		let status = "Missing";
		let statusColor = THEME.destructive;
		if (!avail) {
			status = "Locked";
			statusColor = THEME.mutedForeground;
		} else if (enough) {
			status = "Ready";
			statusColor = GAME.success;
		}
		row.status.Text = status;
		setLabelColor(row.status, statusColor);
	}

	private mountRecipe(frame: Frame): Page {
		const view = makeDetailView(frame, 3);
		makeLabel(frame, "IngTitle", "INGREDIENTS", 0, 170, 400, 20, TEXT.xs, THEME.mutedForeground, {
			weight: Enum.FontWeight.Medium,
			align: "left",
		});
		const lines: Array<IngredientLine> = [];
		for (let i = 0; i < MAX_INGREDIENTS; i++) lines.push(makeIngredientLine(frame, i));

		// station card
		const cardX = ING_W + space(5);
		const cardW = CONTENT_W - cardX;
		const inner = cardW - space(8);
		const card = Card(frame, "Station", {
			x: cardX,
			y: 196,
			w: cardW,
			h: 136,
			variant: "muted",
			border: SURFACE.line,
		});
		makeLabel(card, "Caption", "STATION", space(4), space(3.5), inner, 16, TEXT.xs, THEME.mutedForeground, {
			weight: Enum.FontWeight.Medium,
			align: "left",
		});
		const value = makeLabel(card, "Value", "", space(4), 36, inner, 26, TEXT.lg, GAME.success, {
			font: "heading",
			align: "left",
		});
		const hint = makeLabel(card, "Hint", "", space(4), 70, inner, 52, TEXT.sm, THEME.mutedForeground, {
			align: "left",
			valign: "top",
		});

		let shown: string | undefined;
		return {
			frame,
			sync: (): void => {
				const m = this.recipeDetail();
				if (m === undefined) {
					this.level = LEVEL_LIST;
					this.rebuild();
					return;
				}
				view.run = m.act.run;
				let sig = `${detailSig(m)}|${m.station}|${hex(m.stationColor)}|${hex(m.stationBorder)}|${m.hint}`;
				for (const ing of m.ingredients) sig += `;${ing.name}=${ing.count}:${hex(ing.tone)}`;
				if (sig === shown) return;
				shown = sig;
				applyDetail(view, m);
				// a recipe with more ingredients than any before grows the list (built with MAX_INGREDIENTS)
				while (lines.size() < m.ingredients.size()) lines.push(makeIngredientLine(frame, lines.size()));
				for (let i = 0; i < lines.size(); i++) {
					const line = lines[i];
					const ing = m.ingredients[i];
					line.frame.Visible = ing !== undefined;
					if (ing === undefined) continue;
					setCardBorder(line.frame, ing.tone);
					line.name.Text = ing.name;
					line.count.Text = ing.count;
					line.count.TextColor3 = ing.tone;
				}
				setCardBorder(card, m.stationBorder);
				value.Text = m.station;
				value.TextColor3 = m.stationColor;
				hint.Text = m.hint;
			},
		};
	}

	/** what the recipe page shows for the selected recipe (undefined: no such recipe) */
	private recipeDetail(): RecipeModel | undefined {
		let recipe: CraftRecipe | undefined;
		for (const r of CRAFT_RECIPES) {
			if (r.id === this.selRecipe) recipe = r;
		}
		if (recipe === undefined) return undefined;
		const r = recipe;
		const avail = this.recipeAvailable(r);
		const enough = this.hasIngredients(r);

		const ingredients: Array<IngredientModel> = [];
		for (const ing of r.ingredients) {
			const have = this.ingredientCount(ing.kind, ing.index);
			ingredients.push({
				name: nameOf(ing.kind, ing.index),
				count: `${fmtInt(have)} / ${fmtInt(ing.count)}`,
				tone: have >= ing.count ? GAME.success : THEME.destructive,
			});
		}

		let stationText = "No desk needed";
		if (r.needsPro) stationText = this.nearbyPro ? "Pro craft desk nearby" : "Need a pro craft desk";
		else if (r.needsDesk) stationText = this.nearbyDesk ? "Craft desk nearby" : "Need a craft desk";
		if (r.needsFire === true && !this.nearbyFire) stationText = "Need a lit fire";
		else if (r.needsFire === true && stationText === "No desk needed") stationText = "Lit fire nearby";
		// the game's own check also covers things the list can't see (e.g. a build in progress)
		const blocker = avail && enough ? this.craftCheck?.(r.id) : undefined;
		const hint =
			blocker !== undefined
				? blocker
				: avail
					? "You can craft this here."
					: r.needsFire === true && !this.nearbyFire
						? "Light a campfire or brazier and stand next to it, then open the backpack again."
						: "Stand next to the right desk, then open the backpack again.";

		let label = "Craft";
		if (!avail) {
			label =
				r.needsFire === true && !this.nearbyFire
					? "Need fire"
					: r.needsPro
						? "Need pro desk"
						: "Need craft desk";
		} else if (!enough) {
			label = "Missing items";
		} else if (blocker !== undefined) {
			label = "Can't craft";
		}
		return {
			caption: `RECIPE · ${stationName(r).upper()}`,
			name: nameOf(r.resultKind, r.resultIndex),
			equipped: false,
			stats: [
				["Makes", `x ${fmtInt(r.resultCount)}`],
				["Station", stationTag(r)],
				["You have", fmtInt(this.ingredientCount(r.resultKind, r.resultIndex))],
			],
			ingredients,
			station: stationText,
			stationColor: avail ? GAME.success : THEME.destructive,
			// the plain well outline while the station is fine, `destructive` when it is what blocks the craft
			stationBorder: avail ? SURFACE.line : THEME.destructive,
			hint,
			act: detailAction(label, "default", avail && enough && blocker === undefined, (): void => {
				if (!this.recipeAvailable(r) || !this.hasIngredients(r)) return;
				if (this.craftCheck?.(r.id) !== undefined) return;
				this.onCraft?.(r.id);
				this.rebuild();
			}),
		};
	}

	// ------------------------------------------------------------ skills

	private mountSkills(frame: Frame): Page {
		const notice = makeNotice(frame);
		const list = this.makeList(frame, NOTICE_H + LIST_GAP, CONTENT_H - NOTICE_H - LIST_GAP);
		// the skill list never changes: one row per skill, built with the page
		const rows: Array<SkillRow> = [];
		for (let i = 0; i < SKILLS.size(); i++) rows.push(this.makeSkillRow(list, i, SKILLS[i]));
		let shown: string | undefined;
		return {
			frame,
			list,
			sync: (): void => {
				const save = this.ctx.save;
				const sp = save.skillPoint;
				let sig = `${sp}`;
				for (const sk of SKILLS) sig += `;${save.skillLevels[sk.id] ?? 0}`;
				if (sig === shown) return;
				shown = sig;
				if (sp > 0) {
					const text = `${sp} skill point${sp === 1 ? "" : "s"} to spend. Press + to learn a level.`;
					setNotice(notice, text, GAME.xp);
				} else {
					setNotice(notice, "No skill points to spend. Level up to earn more.", THEME.mutedForeground);
				}
				for (let i = 0; i < rows.size(); i++) this.fillSkillRow(rows[i], SKILLS[i]);
			},
		};
	}

	private makeSkillRow(list: ScrollList, index: number, sk: SkillDef): SkillRow {
		const frame = makeListRow(list, `Skill${index}`, index, ROW_H);
		const plusX = CONTENT_W - ROW_PAD - PLUS_W;
		const levelX = plusX - space(3) - LEVEL_W;
		const pipsX = levelX - space(3) - (MAX_PIPS * PIP_W + (MAX_PIPS - 1) * PIP_GAP);
		const textW = pipsX - space(3) - ROW_PAD;
		const name = rowTitle(frame, ROW_PAD, sk.name, textW, THEME.mutedForeground);
		rowSubtitle(frame, ROW_PAD, sk.detail, textW);
		// one recessed slot per level: learned ones are filled with the xp accent, the rest stay empty wells
		const pips: Array<Frame> = [];
		for (let p = 0; p < sk.maxLevel; p++) {
			pips.push(
				makeSurface(
					frame,
					`Pip${p}`,
					pipsX + p * (PIP_W + PIP_GAP),
					(ROW_H - PIP_H) / 2,
					PIP_W,
					PIP_H,
					"well",
					{
						fill: SURFACE.well,
						border: SURFACE.line,
						zIndex: 2,
					},
				),
			);
		}
		const level = makeLabel(frame, "Level", "", levelX, 0, LEVEL_W, ROW_H, TEXT.sm, THEME.mutedForeground, {
			font: "numeric",
			align: "right",
			zIndex: 2,
		});
		return { frame, name, pips, level, key: "" };
	}

	private fillSkillRow(row: SkillRow, sk: SkillDef): void {
		const save = this.ctx.save;
		const lvl = save.skillLevels[sk.id] ?? 0;
		const maxed = lvl >= sk.maxLevel;
		const canBuy = save.skillPoint > 0 && !maxed;
		const key = `${lvl}:${canBuy}`;
		if (key === row.key) return;
		row.key = key;
		setLabelColor(row.name, lvl > 0 ? THEME.foreground : THEME.mutedForeground);
		for (let p = 0; p < row.pips.size(); p++) {
			const learned = p < lvl;
			setSurface(row.pips[p], "well", {
				fill: learned ? GAME.xp : SURFACE.well,
				border: learned ? GAME.xp : SURFACE.line,
			});
		}
		row.level.Text = `Lv ${lvl} / ${sk.maxLevel}`;
		// `foreground` when maxed: the MAX badge right next to it already carries the success accent on its border,
		// one accent per row is enough. A choice of emphasis, not of contrast (GAME.success reads as text here too:
		// 4.68:1 even on the lighter panel, `npm run test:contrast`).
		row.level.TextColor3 = maxed ? THEME.foreground : THEME.mutedForeground;
		const plusX = CONTENT_W - ROW_PAD - PLUS_W;
		if (maxed) {
			if (row.plus !== undefined) setVisible(row.plus, false);
			if (row.max === undefined) {
				const w = badgeWidth("MAX", TEXT.sm, BADGE_H);
				row.max = Badge(row.frame, "Max", "MAX", {
					x: plusX + PLUS_W - w,
					y: (ROW_H - BADGE_H) / 2,
					w,
					h: BADGE_H,
					textSize: TEXT.sm,
					color: GAME.success,
				});
			}
			row.max.Visible = true;
			return;
		}
		if (row.max !== undefined) row.max.Visible = false;
		if (row.plus === undefined) {
			// a raised plate on the row's well: what you press stands out; without points the kit sinks it and mutes it
			row.plus = Button(row.frame, "Plus", "+", {
				x: plusX,
				y: (ROW_H - BUTTON_SIZE.sm.h) / 2,
				w: PLUS_W,
				size: "sm",
				variant: "secondary",
				disabled: !canBuy,
				textSize: TEXT.lg,
				zIndex: 3,
				onClick: (): void => this.learnSkill(sk),
			});
		} else {
			setVisible(row.plus, true);
			setButtonEnabled(row.plus, canBuy);
		}
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
