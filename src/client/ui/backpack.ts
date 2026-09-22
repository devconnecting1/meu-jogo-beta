/*
 * Backpack (in-run inventory): Weapons / Equipment / Usables / Materials / Craft / Skills.
 *
 * The item tabs only list what the player owns. Every game rule (equip, unequip, use, craft) is
 * delegated to main.client through the callbacks; the backpack only reads the save to draw its state
 * and rebuilds after each action. The one write it does itself is spending skill points.
 *
 * Levels: 2 = list of the current tab, 3 = item detail, 4 = recipe detail, 5 = skills.
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
import { GAME, SURFACE, TEXT, THEME, TRANSPARENCY, hex, space } from "./theme";
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
	ScrollList,
	Separator,
	Sidebar,
	SidebarHandle,
	badgeWidth,
	cardHeaderHeight,
	clearChildren,
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
	setButtonEnabled,
	tween,
} from "./widgets";

const UserInputService = game.GetService("UserInputService");

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

/**
 * Square well with the item's initial, outlined in the item kind's tone (muted: the plain well outline).
 * Like the kit's accent Badge, the tone rides the BORDER and the letter stays `foreground` (~18.7:1 on the
 * well fill): a GAME.* tone as text there would not clear 4.5:1 (success ~4.5:1, material ~3.4:1).
 */
function makeGlyph(parent: Instance, x: number, y: number, name: string, tone: Color3, muted: boolean): Frame {
	const f = makeSurface(parent, "Glyph", x, y, GLYPH, GLYPH, "well", {
		fill: SURFACE.well,
		border: muted ? SURFACE.line : tone,
		zIndex: 2,
	});
	const letter = muted ? THEME.mutedForeground : THEME.foreground;
	makeLabel(f, "Letter", name.sub(1, 1).upper(), 0, 0, GLYPH, GLYPH, TEXT.lg, letter, {
		weight: Enum.FontWeight.Bold,
		zIndex: 3,
		outline: true,
	});
	return f;
}

/** stat tile: small caption over a monospaced value */
function makeChip(parent: Instance, name: string, x: number, y: number, caption: string, value: string): Frame {
	const f = Card(parent, name, { x, y, w: CHIP_W, h: CHIP_H, variant: "muted" });
	const inner = CHIP_W - space(7);
	makeLabel(f, "Caption", caption.upper(), space(3.5), space(2.5), inner, 16, TEXT.xs, THEME.mutedForeground, {
		weight: Enum.FontWeight.Medium,
		align: "left",
	});
	makeLabel(f, "Value", value, space(3.5), 30, inner, 24, TEXT.xl, THEME.foreground, {
		font: "numeric",
		align: "left",
	});
	return f;
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
	private content: Frame | undefined;
	private spBadge: Frame | undefined;
	private backBtn: TextButton | undefined;
	private nav: SidebarHandle | undefined;
	private list: ScrollList | undefined;
	private listKey = "";
	private scrollMemory = new Map<string, Vector2>();
	private level = LEVEL_LIST;
	private cat = CAT_WEAPONS;
	private selItem = 0;
	private selKind = 0;
	private selRecipe = 0;

	constructor(ctx: GameContext) {
		this.ctx = ctx;
	}

	isOpen(): boolean {
		return this.root !== undefined;
	}

	open(): void {
		if (this.root !== undefined) return;
		// reopen on the last tab (Weapons the first time), always at its list
		this.level = this.cat === CAT_SKILLS ? LEVEL_SKILLS : LEVEL_LIST;
		this.scrollMemory.clear();

		const screen = makeScreen(this.ctx.uiLayer, "Backpack", {
			color: THEME.background,
			transparency: TRANSPARENCY.overlay,
			zIndex: 200,
		});
		this.root = screen.root;
		const panel = Card(screen.body, "Panel", { x: 60, y: 30, w: PANEL_W, h: PANEL_H });

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
		if (UserInputService.KeyboardEnabled) {
			// a raised key cap (Badge "default"), not a caption: muted text would not clear 4.5:1 on the strip
			Badge(panel, "KeyHint", KEY_HINT, {
				x: navX - space(2) - KEY_W,
				y: HEADER_Y + (HEADER_H - BADGE_H) / 2,
				w: KEY_W,
				h: BADGE_H,
				textSize: TEXT.sm,
				zIndex: HEADER_Z,
			});
		}
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

		// entrance: fade the scrim in, slide the panel up a little
		screen.root.BackgroundTransparency = 1;
		tween(screen.root, 0.15, { BackgroundTransparency: TRANSPARENCY.overlay });
		const target = panel.Position;
		panel.Position = target.add(UDim2.fromScale(0, 0.025));
		tween(panel, 0.18, { Position: target });

		this.rebuild();
	}

	close(): void {
		if (this.root === undefined) return;
		this.root.Destroy();
		this.root = undefined;
		this.content = undefined;
		this.spBadge = undefined;
		this.backBtn = undefined;
		this.nav = undefined;
		this.list = undefined;
		this.listKey = "";
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
		if (this.backBtn !== undefined) {
			setButtonEnabled(this.backBtn, this.level === LEVEL_DETAIL || this.level === LEVEL_RECIPE);
		}
	}

	private rebuild(): void {
		const content = this.content;
		if (content === undefined) return;
		if (this.list !== undefined && this.listKey !== "") {
			this.scrollMemory.set(this.listKey, this.list.frame.CanvasPosition);
		}
		this.list = undefined;
		this.listKey = "";
		clearChildren(content);
		this.refreshHeader();
		if (this.level === LEVEL_DETAIL) {
			this.buildDetail(content);
		} else if (this.level === LEVEL_RECIPE) {
			this.buildRecipe(content);
		} else if (this.cat === CAT_SKILLS) {
			this.buildSkills(content);
		} else if (this.cat === CAT_CRAFT) {
			this.buildCraftList(content);
		} else {
			this.buildItemList(content);
		}
	}

	/** scroll list for the current tab; restores where the player left it (e.g. after a detail page) */
	private newList(content: Frame, y: number, h: number): ScrollList {
		const list = makeScrollList(content, "List", 0, y, CONTENT_W, h);
		// keep the row outlines clear of the ScrollingFrame clipping
		const pad = list.frame.FindFirstChildOfClass("UIPadding");
		if (pad !== undefined) {
			pad.PaddingLeft = new UDim(0, 2);
			pad.PaddingTop = new UDim(0, 2);
			pad.PaddingBottom = new UDim(0, 2);
		}
		const key = `${this.level}:${this.cat}`;
		this.list = list;
		this.listKey = key;
		const pos = this.scrollMemory.get(key);
		if (pos !== undefined) {
			const frame = list.frame;
			const apply = (): void => {
				if (frame.Parent !== undefined) frame.CanvasPosition = pos;
			};
			// the automatic canvas size is only known after layout; re-apply once it is.
			// (declared first so the Luau local is in scope inside the callback)
			let conn: RBXScriptConnection | undefined;
			conn = frame.GetPropertyChangedSignal("AbsoluteCanvasSize").Connect((): void => {
				conn?.Disconnect();
				apply();
			});
			task.defer(apply);
		}
		return list;
	}

	/** thin status line above the craft / skills lists: a well with a coloured pixel chip + one line of text */
	private makeNotice(content: Frame, text: string, dot: Color3): void {
		const notice = Card(content, "Notice", { x: 0, y: 0, w: CONTENT_W, h: NOTICE_H, variant: "muted" });
		const d = space(2);
		makeSurface(notice, "Dot", space(3.5), (NOTICE_H - d) / 2, d, d, "well", {
			fill: dot,
			border: dot,
			zIndex: 2,
		});
		const textX = space(3.5) + d + space(2.5);
		// muted-foreground (#8c8c7d) on the well fill (#10100e) is ~5.6:1
		makeLabel(
			notice,
			"Text",
			text,
			textX,
			0,
			CONTENT_W - textX - space(3),
			NOTICE_H,
			TEXT.sm,
			THEME.mutedForeground,
			{ align: "left", zIndex: 2 },
		);
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

	private buildItemList(content: Frame): void {
		const entries = this.itemEntries(this.cat);
		if (entries.size() === 0) {
			this.buildEmpty(content);
			return;
		}
		const list = this.newList(content, 0, CONTENT_H);
		for (let i = 0; i < entries.size(); i++) {
			this.itemRow(list, i, entries[i]);
		}
	}

	private itemRow(list: ScrollList, index: number, e: ItemEntry): void {
		const row = ListRowButton(list, `Row${index}`, index, ROW_H, (): void => this.openDetail(e.kind, e.id));
		if (e.equipped) makeFrame(row, "Mark", 0, space(2), 3, ROW_H - space(4), GAME.success, { zIndex: 2 });
		makeGlyph(row, ROW_PAD, (ROW_H - GLYPH) / 2, e.name, kindTone(e.kind), false);
		const countX = CONTENT_W - ROW_PAD - COUNT_W;
		const badgeW = badgeWidth("EQUIPPED", TEXT.sm, BADGE_H);
		const badgeX = countX - space(3) - badgeW;
		const textW = badgeX - space(3) - ROW_TEXT_X;
		rowTitle(row, ROW_TEXT_X, e.name, textW, THEME.foreground);
		rowSubtitle(row, ROW_TEXT_X, e.info, textW);
		if (e.equipped) {
			Badge(row, "Equipped", "EQUIPPED", {
				x: badgeX,
				y: (ROW_H - BADGE_H) / 2,
				w: badgeW,
				h: BADGE_H,
				textSize: TEXT.sm,
				color: GAME.success,
			});
		}
		makeLabel(row, "Count", e.count, countX, 0, COUNT_W, ROW_H, TEXT.base, THEME.mutedForeground, {
			font: e.numeric ? "numeric" : "label",
			align: "right",
			zIndex: 2,
		});
	}

	private buildEmpty(content: Frame): void {
		let title = "No materials yet";
		let body = "Gather wood, stone and scrap while you explore. Materials are used in the Craft tab.";
		let craftShortcut = false;
		if (this.cat === CAT_WEAPONS) {
			title = "No weapons yet";
			body = "Find them in buildings or craft them in the Craft tab.";
			craftShortcut = true;
		} else if (this.cat === CAT_EQUIP) {
			title = "No equipment yet";
			body = "Find it in buildings, craft it in the Craft tab, or unlock decos with costumes in the shop.";
			craftShortcut = true;
		} else if (this.cat === CAT_USABLES) {
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
		const card = Card(content, "Empty", { x: (CONTENT_W - w) / 2, y: space(16), w, h });
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
	}

	// ------------------------------------------------------------ item detail

	private buildDetail(content: Frame): void {
		const kind = this.selKind;
		const id = this.selItem;
		if (kind === ItemKind.Weapon && WEAPONS[id] !== undefined) {
			this.weaponDetail(content, WEAPONS[id]);
		} else if (kind === ItemKind.Equip && EQUIPS[id] !== undefined) {
			this.equipDetail(content, id);
		} else if (kind === ItemKind.Use && USABLES[id] !== undefined) {
			this.usableDetail(content, id);
		} else if (kind === ItemKind.Etc && ETC_ITEMS[id] !== undefined) {
			this.materialDetail(content, id);
		} else {
			this.level = LEVEL_LIST;
			this.rebuild();
		}
	}

	private detailHeader(content: Frame, caption: string, name: string, equipped: boolean): void {
		makeLabel(content, "Caption", caption, 0, 0, CONTENT_W - 120, 20, TEXT.sm, THEME.mutedForeground, {
			font: "label",
			align: "left",
		});
		makeLabel(content, "Name", name, 0, 24, CONTENT_W - 120, 44, TEXT.xl3, THEME.foreground, {
			font: "title",
			align: "left",
		});
		if (equipped) {
			const h = 26;
			const w = badgeWidth("EQUIPPED", TEXT.sm, h);
			Badge(content, "Equipped", "EQUIPPED", {
				x: CONTENT_W - w,
				y: 24 + (44 - h) / 2,
				w,
				h,
				textSize: TEXT.sm,
				color: GAME.success,
			});
		}
	}

	private detailStats(content: Frame, stats: Array<[string, string]>): void {
		for (let i = 0; i < stats.size(); i++) {
			makeChip(content, `Stat${i}`, i * (CHIP_W + CHIP_GAP), 88, stats[i][0], stats[i][1]);
		}
	}

	private detailBody(content: Frame, owned: string, ownedColor: Color3, help: string): void {
		Separator(content, "Divider", { x: 0, y: 170, length: CONTENT_W });
		makeLabel(content, "Owned", owned, 0, 184, 600, 26, TEXT.lg, ownedColor, { font: "heading", align: "left" });
		makeLabel(content, "Help", help, 0, 218, CONTENT_W, 100, TEXT.base, THEME.mutedForeground, {
			align: "left",
			valign: "top",
		});
	}

	/**
	 * The page's action button (centred at the bottom). Hierarchy: the real action of the page (Equip / Use /
	 * Craft) is "default", the raised `primary` (green) plate of the reference art; neutral actions (Unequip,
	 * Open Craft) are "secondary"; anything impossible is disabled, which the kit draws as a well with muted
	 * text (~5.6:1) and whose label says why.
	 */
	private detailAction(
		content: Frame,
		text: string,
		variant: ButtonVariant,
		enabled: boolean,
		onClick: () => void,
	): TextButton {
		return Button(content, "Action", text, {
			x: (CONTENT_W - ACTION_W) / 2,
			y: CONTENT_H - ACTION_H - space(3),
			w: ACTION_W,
			size: "lg",
			variant,
			disabled: !enabled,
			onClick,
		});
	}

	private weaponDetail(content: Frame, w: WeaponDef): void {
		const save = this.ctx.save;
		const id = w.id;
		const owned = ownsWeapon(save, id);
		const count = save.invenWeapon[id] ?? 0;
		const equipped = save.equipWeapon === id;
		this.detailHeader(content, `WEAPON · ${weaponKindName(w.kind).upper()}`, w.name, equipped);

		const stats: Array<[string, string]> = [
			["Damage", damageText(w)],
			["Fire rate", fmtSeconds(w.cooldown)],
		];
		if (!isMelee(w)) {
			stats.push(["Mag", fmtInt(w.mag)]);
			stats.push(["Reload", fmtSeconds(w.reload)]);
		}
		stats.push(["Range", fmtNum(w.range)]);
		this.detailStats(content, stats);

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
		this.detailBody(content, ownedText, owned ? THEME.foreground : THEME.mutedForeground, help.join(" "));

		if (!owned) {
			this.detailAction(content, "Not owned", "secondary", false, (): void => {});
		} else if (equipped) {
			this.detailAction(content, "Equipped", "secondary", false, (): void => {});
		} else {
			this.detailAction(content, "Equip", "default", true, (): void => this.equipWeapon(id));
		}
	}

	private equipDetail(content: Frame, id: number): void {
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
		this.detailHeader(content, `EQUIPMENT · ${slotName.upper()} SLOT`, e.name, equipped);

		const stats: Array<[string, string]> = [["Slot", slotName]];
		if (slot === 1 || e.def !== 0) stats.push(["Defense", fmtNum(e.def)]);
		if (slot === 1 || e.speed !== 0) stats.push(["Speed", signed(e.speed)]);
		this.detailStats(content, stats);

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
		this.detailBody(content, ownedText, owned ? THEME.foreground : THEME.mutedForeground, help.join(" "));

		if (!owned) {
			this.detailAction(content, "Not owned", "secondary", false, (): void => {});
		} else if (equipped) {
			this.detailAction(content, "Unequip", "secondary", this.onUnequipItem !== undefined, (): void =>
				this.unequipItem(id, slot),
			);
		} else {
			this.detailAction(content, "Equip", "default", true, (): void => this.equipItem(id, slot));
		}
	}

	private usableDetail(content: Frame, id: number): void {
		const save = this.ctx.save;
		const u = USABLES[id];
		const count = save.invenUse[id] ?? 0;
		this.detailHeader(content, "USABLE", u.name, false);

		const stats: Array<[string, string]> = [
			["HP", signed(u.hp)],
			["Hunger", signed(u.hunger)],
		];
		if (u.speed !== 0) stats.push(["Speed", `${fmtNum(u.speed)} min`]);
		if (u.calm !== 0) stats.push(["Calm", `${fmtNum(u.calm)} min`]);
		if (u.pain !== 0) stats.push(["Pain", `${fmtNum(u.pain)} min`]);
		this.detailStats(content, stats);

		const help: Array<string> = ["Consumed when used."];
		if (u.cook >= 0 && USABLES[u.cook] !== undefined) help.push(`Can be cooked into ${USABLES[u.cook].name}.`);
		this.detailBody(
			content,
			`Owned x ${fmtInt(count)}`,
			count > 0 ? THEME.foreground : THEME.mutedForeground,
			help.join(" "),
		);

		this.detailAction(content, count > 0 ? "Use" : "None left", "default", count > 0, (): void => this.useItem(id));
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

	private materialDetail(content: Frame, id: number): void {
		const save = this.ctx.save;
		const count = save.invenEtc[id] ?? 0;
		const uses = this.recipesUsing(id);
		this.detailHeader(content, "MATERIAL", ETC_ITEMS[id].name, false);
		this.detailStats(content, [
			["Owned", fmtInt(count)],
			["Recipes", fmtInt(uses.size())],
		]);

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
		this.detailBody(
			content,
			`Owned x ${fmtInt(count)}`,
			count > 0 ? THEME.foreground : THEME.mutedForeground,
			help,
		);
		this.detailAction(content, "Open Craft", "secondary", true, (): void => this.selectCat(CAT_CRAFT));
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

	private buildCraftList(content: Frame): void {
		const fire = this.nearbyFire ? " A lit fire is nearby: smelting works." : " Smelting needs a lit fire.";
		if (this.nearbyPro) {
			this.makeNotice(content, `Pro craft desk nearby: every desk recipe works here.${fire}`, GAME.success);
		} else if (this.nearbyDesk) {
			this.makeNotice(content, `Craft desk nearby. Pro recipes need a pro desk.${fire}`, GAME.warning);
		} else {
			this.makeNotice(
				content,
				`No craft desk nearby: hand recipes only.${fire}`,
				this.nearbyFire ? GAME.warning : THEME.mutedForeground,
			);
		}
		const list = this.newList(content, NOTICE_H + LIST_GAP, CONTENT_H - NOTICE_H - LIST_GAP);
		// craftable now first, then what this station allows, then recipes that need another desk
		const ready: Array<CraftRecipe> = [];
		const missing: Array<CraftRecipe> = [];
		const locked: Array<CraftRecipe> = [];
		for (const r of CRAFT_RECIPES) {
			if (!this.recipeAvailable(r)) locked.push(r);
			else if (this.hasIngredients(r)) ready.push(r);
			else missing.push(r);
		}
		let index = 0;
		for (const group of [ready, missing, locked]) {
			for (const r of group) {
				this.recipeRow(list, index, r);
				index++;
			}
		}
	}

	private recipeRow(list: ScrollList, index: number, r: CraftRecipe): void {
		const avail = this.recipeAvailable(r);
		const enough = this.hasIngredients(r);
		const recipeId = r.id;
		const row = ListRowButton(list, `Recipe${index}`, index, ROW_H, (): void => this.openRecipe(recipeId));
		const name = this.resultName(r);
		makeGlyph(row, ROW_PAD, (ROW_H - GLYPH) / 2, name, kindTone(r.resultKind), !avail);
		const statusX = CONTENT_W - ROW_PAD - STATUS_W;
		const stationX = statusX - space(3) - STATION_W;
		const textW = stationX - space(3) - ROW_TEXT_X;
		rowTitle(row, ROW_TEXT_X, name, textW, avail ? THEME.foreground : THEME.mutedForeground);

		// ingredients: have / need in success or destructive
		const coloured: Array<string> = [];
		const plain: Array<string> = [];
		for (const ing of r.ingredients) {
			const have = this.ingredientCount(ing.kind, ing.index);
			const text = `${nameOf(ing.kind, ing.index)} ${fmtInt(have)}/${fmtInt(ing.count)}`;
			coloured.push(colorTag(have >= ing.count ? GAME.success : THEME.destructive, text));
			plain.push(escapeRich(text));
		}
		const richText = coloured.join(colorTag(THEME.mutedForeground, "  ·  "));
		const plainText = plain.join("  ·  ");
		const info = rowSubtitle(row, ROW_TEXT_X, richText, textW, true);
		// the kit turns the row's labels accent-foreground on the accent hover / selection; <font> tags would keep
		// their tones (unreadable on accent), so the line goes plain meanwhile
		info.GetPropertyChangedSignal("TextColor3").Connect((): void => {
			info.Text = info.TextColor3 === THEME.accentForeground ? plainText : richText;
		});

		Badge(row, "Station", stationTag(r).upper(), {
			x: stationX,
			y: (ROW_H - BADGE_H) / 2,
			w: STATION_W,
			h: BADGE_H,
			textSize: TEXT.sm,
			variant: avail ? "secondary" : "destructive",
		});
		let status = "Missing";
		let statusColor = THEME.destructive;
		if (!avail) {
			status = "Locked";
			statusColor = THEME.mutedForeground;
		} else if (enough) {
			status = "Ready";
			statusColor = GAME.success;
		}
		makeLabel(row, "Status", status, statusX, 0, STATUS_W, ROW_H, TEXT.sm, statusColor, {
			font: "heading",
			align: "right",
			zIndex: 2,
		});
	}

	private buildRecipe(content: Frame): void {
		let recipe: CraftRecipe | undefined;
		for (const r of CRAFT_RECIPES) {
			if (r.id === this.selRecipe) recipe = r;
		}
		if (recipe === undefined) {
			this.level = LEVEL_LIST;
			this.rebuild();
			return;
		}
		const r = recipe;
		const avail = this.recipeAvailable(r);
		const enough = this.hasIngredients(r);
		this.detailHeader(content, `RECIPE · ${stationName(r).upper()}`, nameOf(r.resultKind, r.resultIndex), false);
		this.detailStats(content, [
			["Makes", `x ${fmtInt(r.resultCount)}`],
			["Station", stationTag(r)],
			["You have", fmtInt(this.ingredientCount(r.resultKind, r.resultIndex))],
		]);

		makeLabel(content, "IngTitle", "INGREDIENTS", 0, 170, 400, 20, TEXT.xs, THEME.mutedForeground, {
			weight: Enum.FontWeight.Medium,
			align: "left",
		});
		for (let i = 0; i < r.ingredients.size(); i++) {
			const ing = r.ingredients[i];
			const have = this.ingredientCount(ing.kind, ing.index);
			const tone = have >= ing.count ? GAME.success : THEME.destructive;
			const line = Card(content, `Ing${i}`, {
				x: 0,
				y: 196 + i * (ING_H + space(2)),
				w: ING_W,
				h: ING_H,
				variant: "muted",
				border: tone,
			});
			const nameW = ING_W - space(8) - ING_COUNT_W;
			makeLabel(
				line,
				"Name",
				nameOf(ing.kind, ing.index),
				space(4),
				0,
				nameW,
				ING_H,
				TEXT.base,
				THEME.foreground,
				{
					align: "left",
				},
			);
			const count = `${fmtInt(have)} / ${fmtInt(ing.count)}`;
			makeLabel(line, "Count", count, ING_W - space(4) - ING_COUNT_W, 0, ING_COUNT_W, ING_H, TEXT.base, tone, {
				font: "numeric",
				align: "right",
			});
		}

		// station card
		let stationText = "No desk needed";
		if (r.needsPro) stationText = this.nearbyPro ? "Pro craft desk nearby" : "Need a pro craft desk";
		else if (r.needsDesk) stationText = this.nearbyDesk ? "Craft desk nearby" : "Need a craft desk";
		if (r.needsFire === true && !this.nearbyFire) stationText = "Need a lit fire";
		else if (r.needsFire === true && stationText === "No desk needed") stationText = "Lit fire nearby";
		// the game's own check also covers things the list can't see (e.g. a build in progress)
		const blocker = avail && enough ? this.craftCheck?.(r.id) : undefined;
		const cardX = ING_W + space(5);
		const cardW = CONTENT_W - cardX;
		const inner = cardW - space(8);
		const card = Card(content, "Station", {
			x: cardX,
			y: 196,
			w: cardW,
			h: 136,
			variant: "muted",
			// the plain well outline while the station is fine, `destructive` when it is what blocks the craft
			border: avail ? SURFACE.line : THEME.destructive,
		});
		makeLabel(card, "Caption", "STATION", space(4), space(3.5), inner, 16, TEXT.xs, THEME.mutedForeground, {
			weight: Enum.FontWeight.Medium,
			align: "left",
		});
		const stationColor = avail ? GAME.success : THEME.destructive;
		makeLabel(card, "Value", stationText, space(4), 36, inner, 26, TEXT.lg, stationColor, {
			font: "heading",
			align: "left",
		});
		makeLabel(
			card,
			"Hint",
			blocker !== undefined
				? blocker
				: avail
					? "You can craft this here."
					: r.needsFire === true && !this.nearbyFire
						? "Light a campfire or brazier and stand next to it, then open the backpack again."
						: "Stand next to the right desk, then open the backpack again.",
			space(4),
			70,
			inner,
			52,
			TEXT.sm,
			THEME.mutedForeground,
			{ align: "left", valign: "top" },
		);

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
		this.detailAction(content, label, "default", avail && enough && blocker === undefined, (): void => {
			if (!this.recipeAvailable(r) || !this.hasIngredients(r)) return;
			if (this.craftCheck?.(r.id) !== undefined) return;
			this.onCraft?.(r.id);
			this.rebuild();
		});
	}

	// ------------------------------------------------------------ skills

	private buildSkills(content: Frame): void {
		const save = this.ctx.save;
		const sp = save.skillPoint;
		if (sp > 0) {
			const text = `${sp} skill point${sp === 1 ? "" : "s"} to spend. Press + to learn a level.`;
			this.makeNotice(content, text, GAME.xp);
		} else {
			this.makeNotice(content, "No skill points to spend. Level up to earn more.", THEME.mutedForeground);
		}
		const list = this.newList(content, NOTICE_H + LIST_GAP, CONTENT_H - NOTICE_H - LIST_GAP);
		for (let i = 0; i < SKILLS.size(); i++) {
			this.skillRow(list, i, SKILLS[i]);
		}
	}

	private skillRow(list: ScrollList, index: number, sk: SkillDef): void {
		const save = this.ctx.save;
		const lvl = save.skillLevels[sk.id] ?? 0;
		const maxed = lvl >= sk.maxLevel;
		const canBuy = save.skillPoint > 0 && !maxed;
		const row = makeListRow(list, `Skill${index}`, index, ROW_H);
		const plusX = CONTENT_W - ROW_PAD - PLUS_W;
		const levelX = plusX - space(3) - LEVEL_W;
		const pipsX = levelX - space(3) - (MAX_PIPS * PIP_W + (MAX_PIPS - 1) * PIP_GAP);
		const textW = pipsX - space(3) - ROW_PAD;
		rowTitle(row, ROW_PAD, sk.name, textW, lvl > 0 ? THEME.foreground : THEME.mutedForeground);
		rowSubtitle(row, ROW_PAD, sk.detail, textW);
		// one recessed slot per level: learned ones are filled with the xp accent, the rest stay empty wells
		for (let p = 0; p < sk.maxLevel; p++) {
			const learned = p < lvl;
			makeSurface(row, `Pip${p}`, pipsX + p * (PIP_W + PIP_GAP), (ROW_H - PIP_H) / 2, PIP_W, PIP_H, "well", {
				fill: learned ? GAME.xp : SURFACE.well,
				border: learned ? GAME.xp : SURFACE.line,
				zIndex: 2,
			});
		}
		makeLabel(
			row,
			"Level",
			`Lv ${lvl} / ${sk.maxLevel}`,
			levelX,
			0,
			LEVEL_W,
			ROW_H,
			TEXT.sm,
			// GAME.success as text on the real background is only ~4.49:1 (< 4.5 AA); the "MAX" badge right next
			// to this already carries the success accent on its border, so this falls back to `foreground`
			maxed ? THEME.foreground : THEME.mutedForeground,
			{ font: "numeric", align: "right", zIndex: 2 },
		);
		if (maxed) {
			const w = badgeWidth("MAX", TEXT.sm, BADGE_H);
			Badge(row, "Max", "MAX", {
				x: plusX + PLUS_W - w,
				y: (ROW_H - BADGE_H) / 2,
				w,
				h: BADGE_H,
				textSize: TEXT.sm,
				color: GAME.success,
			});
			return;
		}
		// a raised plate on the row's well: what you press stands out; without points the kit sinks it and mutes it
		Button(row, "Plus", "+", {
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
