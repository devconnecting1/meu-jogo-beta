/*
 * Backpack (in-run inventory): Weapons / Equipment / Usables / Materials / Craft / Skills.
 *
 * The item tabs only list what the player owns. Every game rule (equip, unequip, use, craft) is
 * delegated to main.client through the callbacks; the backpack only reads the save to draw its state
 * and rebuilds after each action. The one write it does itself is spending skill points.
 *
 * Levels: 2 = list of the current tab, 3 = item detail, 4 = recipe detail, 5 = skills.
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
import {
	ButtonStyle,
	FONTS,
	PALETTE,
	ScrollList,
	clearChildren,
	darken,
	fmtInt,
	fmtNum,
	fmtSeconds,
	lighten,
	makeButton,
	makeFrame,
	makeLabel,
	makeListRow,
	makePanel,
	makeScreen,
	makeScrollList,
	setButtonEnabled,
	setButtonStyle,
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
const PAD = 20;
const INNER_W = PANEL_W - PAD * 2;
const TABS_Y = 64;
const TABS_H = 50;
const CONTENT_Y = TABS_Y + TABS_H + 12;
const CONTENT_H = PANEL_H - PAD - CONTENT_Y;
const ROW_H = 50;
const STRIP_H = 30;
const LIST_GAP = 8;
const ACTION_W = 220;
const ACTION_H = 54;

const SLOT_NAMES = ["-", "Cloth", "Hand", "Gun", "Deco"];

interface ItemEntry {
	kind: number;
	id: number;
	name: string;
	info: string;
	count: string;
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

function kindColor(kind: number): Color3 {
	if (kind === ItemKind.Weapon) return PALETTE.danger;
	if (kind === ItemKind.Equip) return PALETTE.info;
	if (kind === ItemKind.Use) return PALETTE.success;
	return PALETTE.accent;
}

function rowColor(index: number): Color3 {
	return index % 2 === 0 ? PALETTE.surfaceAlt : lighten(PALETTE.surfaceAlt, 0.03);
}

function escapeRich(s: string): string {
	return s.gsub("&", "&amp;")[0].gsub("<", "&lt;")[0].gsub(">", "&gt;")[0];
}

function colorTag(c: Color3, text: string): string {
	const r = math.round(c.R * 255);
	const g = math.round(c.G * 255);
	const b = math.round(c.B * 255);
	return `<font color="rgb(${r},${g},${b})">${escapeRich(text)}</font>`;
}

// ---------------------------------------------------------------- small local widgets

/** coloured pill with a short caption (e.g. "EQUIPPED") */
function makeTag(
	parent: Instance,
	name: string,
	text: string,
	x: number,
	y: number,
	w: number,
	h: number,
	color: Color3,
) {
	const f = makeFrame(parent, name, x, y, w, h, darken(color, 0.7), {
		radius: h / 2,
		stroke: color,
		strokeTransparency: 0.35,
		zIndex: 2,
	});
	makeLabel(f, "Text", text, 0, 0, w, h, h * 0.46, lighten(color, 0.15), { font: FONTS.bold, zIndex: 3 });
	return f;
}

/** rounded square with the item's initial, tinted by item kind */
function makeGlyph(parent: Instance, x: number, y: number, size: number, name: string, color: Color3, muted: boolean) {
	const f = makeFrame(parent, "Glyph", x, y, size, size, muted ? PALETTE.surfaceHi : darken(color, 0.6), {
		radius: size * 0.25,
		stroke: muted ? PALETTE.strokeSoft : color,
		strokeTransparency: 0.45,
		zIndex: 2,
	});
	makeLabel(
		f,
		"Letter",
		name.sub(1, 1).upper(),
		0,
		0,
		size,
		size,
		size * 0.5,
		muted ? PALETTE.textMuted : lighten(color, 0.25),
		{
			font: FONTS.display,
			zIndex: 3,
		},
	);
	return f;
}

/** stat card: small caption over a big value */
function makeChip(
	parent: Instance,
	name: string,
	x: number,
	y: number,
	w: number,
	h: number,
	caption: string,
	value: string,
) {
	const f = makeFrame(parent, name, x, y, w, h, PALETTE.surfaceAlt, { radius: 10, stroke: PALETTE.strokeSoft });
	makeLabel(f, "Caption", caption.upper(), 14, 8, w - 28, 18, 12, PALETTE.textDim, {
		font: FONTS.bold,
		align: "left",
	});
	makeLabel(f, "Value", value, 14, 28, w - 28, 30, 22, PALETTE.text, { font: FONTS.bold, align: "left" });
	return f;
}

/** a full-row TextButton keeps the kit's hover/press feedback; its outline is toned down for lists */
function quietStroke(b: TextButton): void {
	const stroke = b.FindFirstChildOfClass("UIStroke");
	if (stroke !== undefined) stroke.Color = PALETTE.strokeSoft;
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
	private spPill: Frame | undefined;
	private spLabel: TextLabel | undefined;
	private skillBadge: Frame | undefined;
	private skillBadgeLabel: TextLabel | undefined;
	private backBtn: TextButton | undefined;
	private tabs: Array<TextButton> = [];
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
			color: PALETTE.overlay,
			transparency: 0.45,
			zIndex: 200,
		});
		this.root = screen.root;
		const panel = makePanel(screen.body, "Panel", 60, 30, PANEL_W, PANEL_H);

		// header
		makeLabel(panel, "Title", "Backpack", 24, 12, 170, 44, 26, PALETTE.text, {
			font: FONTS.display,
			align: "left",
		});
		const pill = makeFrame(panel, "SpPill", 200, 20, 88, 28, PALETTE.accent, { radius: 14 });
		this.spPill = pill;
		this.spLabel = makeLabel(pill, "Text", "", 0, 0, 88, 28, 15, PALETTE.textOnAccent, { font: FONTS.bold });
		if (UserInputService.KeyboardEnabled) {
			makeLabel(panel, "KeyHint", "Press B to close", 640, 20, 212, 28, 13, PALETTE.textMuted, {
				align: "right",
			});
		}
		this.backBtn = makeButton(panel, "Nav", "<", 868, 14, 52, 40, "ghost", (): void => this.goBack(), {
			textSize: 20,
		});
		makeButton(panel, "Close", "X", 928, 14, 52, 40, "ghost", (): void => this.close(), { textSize: 18 });

		// tabs: segmented control
		const bar = makeFrame(panel, "Tabs", PAD, TABS_Y, INNER_W, TABS_H, PALETTE.bgRaised, {
			radius: 12,
			stroke: PALETTE.strokeSoft,
		});
		const gap = 4;
		const tabW = (INNER_W - gap * 2 - gap * (CAT_NAMES.size() - 1)) / CAT_NAMES.size();
		this.tabs = [];
		for (let i = 0; i < CAT_NAMES.size(); i++) {
			const index = i;
			const tab = makeButton(
				bar,
				`Tab${i}`,
				CAT_NAMES[i],
				gap + i * (tabW + gap),
				gap,
				tabW,
				TABS_H - gap * 2,
				"secondary",
				(): void => this.selectCat(index),
				{ textSize: 16, radius: 10 },
			);
			this.tabs.push(tab);
		}
		// unspent skill points badge on the Skills tab
		const badgeX = gap + CAT_SKILLS * (tabW + gap) + tabW - 32;
		const badge = makeFrame(bar, "SkillBadge", badgeX, 14, 22, 22, PALETTE.accent, { radius: 11, zIndex: 3 });
		this.skillBadge = badge;
		this.skillBadgeLabel = makeLabel(badge, "Count", "", 0, 0, 22, 22, 12, PALETTE.textOnAccent, {
			font: FONTS.bold,
			zIndex: 4,
		});

		this.content = makeFrame(panel, "Content", PAD, CONTENT_Y, INNER_W, CONTENT_H, PALETTE.surface, {
			transparency: 1,
		});

		// entrance: fade the dim in, slide the panel up a little
		screen.root.BackgroundTransparency = 1;
		tween(screen.root, 0.15, { BackgroundTransparency: 0.45 });
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
		this.spPill = undefined;
		this.spLabel = undefined;
		this.skillBadge = undefined;
		this.skillBadgeLabel = undefined;
		this.backBtn = undefined;
		this.tabs = [];
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
		if (this.spPill !== undefined && this.spLabel !== undefined) {
			this.spLabel.Text = `SP ${sp}`;
			this.spPill.BackgroundColor3 = sp > 0 ? PALETTE.accent : PALETTE.surfaceHi;
			this.spLabel.TextColor3 = sp > 0 ? PALETTE.textOnAccent : PALETTE.textDim;
		}
		if (this.skillBadge !== undefined && this.skillBadgeLabel !== undefined) {
			this.skillBadge.Visible = sp > 0 && this.cat !== CAT_SKILLS;
			this.skillBadgeLabel.Text = sp > 9 ? "9+" : `${sp}`;
		}
		for (let i = 0; i < this.tabs.size(); i++) {
			setButtonStyle(this.tabs[i], i === this.cat ? "primary" : "secondary");
		}
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
		const list = makeScrollList(content, "List", 0, y, INNER_W, h);
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

	/** thin info bar above the craft / skills lists */
	private makeStrip(content: Frame, text: string, dot: Color3): void {
		const strip = makeFrame(content, "Strip", 0, 0, INNER_W, STRIP_H, PALETTE.bgRaised, {
			radius: 8,
			stroke: PALETTE.strokeSoft,
			strokeTransparency: 0.4,
		});
		makeFrame(strip, "Dot", 12, 10, 10, 10, dot, { radius: 5, zIndex: 2 });
		makeLabel(strip, "Text", text, 32, 0, INNER_W - 44, STRIP_H, 14, PALETTE.textDim, {
			align: "left",
			zIndex: 2,
		});
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
				out.push({
					kind: ItemKind.Weapon,
					id: w.id,
					name: w.name,
					info,
					count: w.id === 0 && count === 0 ? "Default" : `x ${fmtInt(count)}`,
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
		const color = rowColor(index);
		const row = makeListRow(list, `Row${index}`, index, ROW_H, color);
		row.BackgroundTransparency = 1;
		const hit = makeButton(row, "Hit", "", 0, 0, INNER_W, ROW_H, color, (): void => this.openDetail(e.kind, e.id), {
			radius: 10,
		});
		quietStroke(hit);
		if (e.equipped) makeFrame(row, "Mark", 0, 10, 4, ROW_H - 20, PALETTE.success, { radius: 2, zIndex: 2 });
		makeGlyph(row, 14, 9, 32, e.name, kindColor(e.kind), false);
		makeLabel(row, "Name", e.name, 58, 0, 320, ROW_H, 17, PALETTE.text, {
			font: FONTS.bold,
			align: "left",
			zIndex: 2,
		});
		makeLabel(row, "Info", e.info, 388, 0, 330, ROW_H, 13, PALETTE.textDim, { align: "left", zIndex: 2 });
		if (e.equipped) makeTag(row, "Equipped", "EQUIPPED", 728, 12, 100, 26, PALETTE.success);
		makeLabel(row, "Count", e.count, 840, 0, 100, ROW_H, 17, PALETTE.text, {
			font: FONTS.bold,
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
		const card = makePanel(content, "Empty", 200, 80, 560, 230, { color: PALETTE.bgRaised });
		makeLabel(card, "Title", title, 30, 34, 500, 36, 22, PALETTE.text, { font: FONTS.bold });
		makeLabel(card, "Body", body, 40, 78, 480, 60, 15, PALETTE.textDim);
		if (craftShortcut) {
			makeButton(card, "ToCraft", "Open Craft", 180, 156, 200, 46, "secondary", (): void =>
				this.selectCat(CAT_CRAFT),
			);
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
		makeLabel(content, "Caption", caption, 0, 0, 700, 22, 13, PALETTE.textDim, { font: FONTS.bold, align: "left" });
		makeLabel(content, "Name", name, 0, 24, 780, 50, 32, PALETTE.accent, { font: FONTS.display, align: "left" });
		if (equipped) makeTag(content, "Equipped", "EQUIPPED", INNER_W - 140, 34, 140, 32, PALETTE.success);
	}

	private detailStats(content: Frame, stats: Array<[string, string]>): void {
		const w = 172;
		const gap = 12;
		for (let i = 0; i < stats.size(); i++) {
			makeChip(content, `Stat${i}`, i * (w + gap), 88, w, 64, stats[i][0], stats[i][1]);
		}
	}

	private detailBody(content: Frame, owned: string, ownedColor: Color3, help: string): void {
		makeFrame(content, "Divider", 0, 170, INNER_W, 2, PALETTE.strokeSoft);
		makeLabel(content, "Owned", owned, 0, 184, 600, 26, 18, ownedColor, { font: FONTS.bold, align: "left" });
		makeLabel(content, "Help", help, 0, 218, INNER_W, 100, 16, PALETTE.textDim, { align: "left", valign: "top" });
	}

	private detailAction(content: Frame, text: string, style: ButtonStyle, enabled: boolean, onClick: () => void) {
		const b = makeButton(
			content,
			"Action",
			text,
			(INNER_W - ACTION_W) / 2,
			CONTENT_H - ACTION_H - 12,
			ACTION_W,
			ACTION_H,
			style,
			onClick,
			{ textSize: 20 },
		);
		if (!enabled) setButtonEnabled(b, false);
		return b;
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
		this.detailBody(content, ownedText, owned ? PALETTE.text : PALETTE.textMuted, help.join(" "));

		if (!owned) {
			this.detailAction(content, "Not owned", "secondary", false, (): void => {});
		} else if (equipped) {
			this.detailAction(content, "Equipped", "success", true, (): void => {});
		} else {
			this.detailAction(content, "Equip", "primary", true, (): void => this.equipWeapon(id));
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
		this.detailBody(content, ownedText, owned ? PALETTE.text : PALETTE.textMuted, help.join(" "));

		if (!owned) {
			this.detailAction(content, "Not owned", "secondary", false, (): void => {});
		} else if (equipped) {
			this.detailAction(content, "Unequip", "secondary", this.onUnequipItem !== undefined, (): void =>
				this.unequipItem(id, slot),
			);
		} else {
			this.detailAction(content, "Equip", "primary", true, (): void => this.equipItem(id, slot));
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
			count > 0 ? PALETTE.text : PALETTE.textMuted,
			help.join(" "),
		);

		this.detailAction(content, count > 0 ? "Use" : "None left", "primary", count > 0, (): void => this.useItem(id));
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
		this.detailBody(content, `Owned x ${fmtInt(count)}`, count > 0 ? PALETTE.text : PALETTE.textMuted, help);
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
			this.makeStrip(content, `Pro craft desk nearby: every desk recipe works here.${fire}`, PALETTE.success);
		} else if (this.nearbyDesk) {
			this.makeStrip(content, `Craft desk nearby. Pro recipes need a pro desk.${fire}`, PALETTE.accent);
		} else {
			this.makeStrip(
				content,
				`No craft desk nearby: hand recipes only.${fire}`,
				this.nearbyFire ? PALETTE.accent : PALETTE.textMuted,
			);
		}
		const list = this.newList(content, STRIP_H + LIST_GAP, CONTENT_H - STRIP_H - LIST_GAP);
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
		const color = rowColor(index);
		const row = makeListRow(list, `Recipe${index}`, index, ROW_H, color);
		row.BackgroundTransparency = 1;
		const recipeId = r.id;
		const hit = makeButton(row, "Hit", "", 0, 0, INNER_W, ROW_H, color, (): void => this.openRecipe(recipeId), {
			radius: 10,
		});
		quietStroke(hit);
		const name = this.resultName(r);
		makeGlyph(row, 14, 9, 32, name, kindColor(r.resultKind), !avail);
		makeLabel(row, "Name", name, 58, 0, 250, ROW_H, 16, avail ? PALETTE.text : PALETTE.textMuted, {
			font: FONTS.bold,
			align: "left",
			zIndex: 2,
		});
		const parts: Array<string> = [];
		for (const ing of r.ingredients) {
			const have = this.ingredientCount(ing.kind, ing.index);
			const c = have >= ing.count ? PALETTE.success : PALETTE.danger;
			parts.push(colorTag(c, `${nameOf(ing.kind, ing.index)} ${fmtInt(have)}/${fmtInt(ing.count)}`));
		}
		makeLabel(
			row,
			"Ingredients",
			parts.join(colorTag(PALETTE.textMuted, "  ·  ")),
			318,
			0,
			390,
			ROW_H,
			13,
			PALETTE.textDim,
			{
				align: "left",
				rich: true,
				zIndex: 2,
			},
		);
		const station = stationTag(r);
		makeTag(row, "Station", station.upper(), 716, 12, 104, 26, avail ? PALETTE.info : PALETTE.danger);
		let status = "Missing";
		let statusColor = PALETTE.danger;
		if (!avail) {
			status = "Locked";
			statusColor = PALETTE.textMuted;
		} else if (enough) {
			status = "Ready";
			statusColor = PALETTE.success;
		}
		makeLabel(row, "Status", status, 830, 0, 110, ROW_H, 15, statusColor, {
			font: FONTS.bold,
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

		makeLabel(content, "IngTitle", "INGREDIENTS", 0, 170, 400, 20, 13, PALETTE.textDim, {
			font: FONTS.bold,
			align: "left",
		});
		for (let i = 0; i < r.ingredients.size(); i++) {
			const ing = r.ingredients[i];
			const have = this.ingredientCount(ing.kind, ing.index);
			const ok = have >= ing.count;
			const c = ok ? PALETTE.success : PALETTE.danger;
			const line = makeFrame(content, `Ing${i}`, 0, 196 + i * 44, 600, 38, PALETTE.surfaceAlt, {
				radius: 8,
				stroke: c,
				strokeTransparency: 0.6,
			});
			makeLabel(line, "Name", nameOf(ing.kind, ing.index), 16, 0, 400, 38, 16, PALETTE.text, { align: "left" });
			makeLabel(line, "Count", `${fmtInt(have)} / ${fmtInt(ing.count)}`, 420, 0, 164, 38, 16, c, {
				font: FONTS.bold,
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
		const card = makeFrame(content, "Station", 630, 196, INNER_W - 630, 126, PALETTE.surfaceAlt, {
			radius: 10,
			stroke: avail ? PALETTE.strokeSoft : PALETTE.danger,
			strokeTransparency: avail ? 0 : 0.5,
		});
		makeLabel(card, "Caption", "STATION", 16, 12, 298, 18, 12, PALETTE.textDim, {
			font: FONTS.bold,
			align: "left",
		});
		makeLabel(card, "Value", stationText, 16, 34, 298, 30, 18, avail ? PALETTE.success : PALETTE.danger, {
			font: FONTS.bold,
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
			16,
			70,
			298,
			44,
			13,
			PALETTE.textDim,
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
		this.detailAction(content, label, "primary", avail && enough && blocker === undefined, (): void => {
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
			this.makeStrip(
				content,
				`${sp} skill point${sp === 1 ? "" : "s"} to spend. Press + to learn a level.`,
				PALETTE.accent,
			);
		} else {
			this.makeStrip(content, "No skill points to spend. Level up to earn more.", PALETTE.textMuted);
		}
		const list = this.newList(content, STRIP_H + LIST_GAP, CONTENT_H - STRIP_H - LIST_GAP);
		for (let i = 0; i < SKILLS.size(); i++) {
			this.skillRow(list, i, SKILLS[i]);
		}
	}

	private skillRow(list: ScrollList, index: number, sk: SkillDef): void {
		const save = this.ctx.save;
		const lvl = save.skillLevels[sk.id] ?? 0;
		const maxed = lvl >= sk.maxLevel;
		const canBuy = save.skillPoint > 0 && !maxed;
		const row = makeListRow(list, `Skill${index}`, index, ROW_H, rowColor(index));
		makeLabel(row, "Name", sk.name, 20, 0, 220, ROW_H, 16, lvl > 0 ? PALETTE.text : PALETTE.textDim, {
			font: FONTS.bold,
			align: "left",
		});
		makeLabel(row, "Detail", sk.detail, 250, 0, 330, ROW_H, 13, PALETTE.textDim, { align: "left" });
		for (let p = 0; p < sk.maxLevel; p++) {
			makeFrame(row, `Pip${p}`, 600 + p * 32, 20, 26, 10, p < lvl ? PALETTE.accent : PALETTE.surfaceHi, {
				radius: 5,
			});
		}
		makeLabel(
			row,
			"Level",
			`Lv ${lvl} / ${sk.maxLevel}`,
			706,
			0,
			126,
			ROW_H,
			15,
			maxed ? PALETTE.success : PALETTE.textDim,
			{
				font: FONTS.bold,
				align: "right",
			},
		);
		const plus = makeButton(
			row,
			"Plus",
			maxed ? "MAX" : "+",
			850,
			7,
			90,
			36,
			canBuy ? "primary" : "secondary",
			(): void => this.learnSkill(sk),
			{ textSize: maxed ? 14 : 20 },
		);
		plus.ZIndex = 3;
		if (!canBuy) setButtonEnabled(plus, false);
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
