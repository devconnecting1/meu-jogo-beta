import { GameContext } from "shared/game/context";
import { COLORS } from "shared/engine/colors";
import { WEAPONS } from "shared/data/weapons";
import { EQUIPS } from "shared/data/equips";
import { USABLES } from "shared/data/usables";
import { ETC_ITEMS } from "shared/data/etcItems";
import { CRAFT_RECIPES, CraftRecipe } from "shared/data/crafts";
import { SKILLS } from "shared/data/skills";
import { toast } from "./popup";
import { makeFrame, makeLabel, makeButton, makeScrollList, clearChildren, ScrollList } from "./widgets";

const CAT_NAMES = ["Weapons", "Equipment", "Usables", "Materials", "Craft", "Skills"];
const ROW_H = 116;
const MAT_START = 23;

function nameOf(kind: number, index: number): string {
	if (kind === 1) return index >= 0 && index < WEAPONS.size() ? WEAPONS[index].name : "?";
	if (kind === 2) return index >= 0 && index < EQUIPS.size() ? EQUIPS[index].name : "?";
	if (kind === 3) return index >= 0 && index < USABLES.size() ? USABLES[index].name : "?";
	return index >= 0 && index < ETC_ITEMS.size() ? ETC_ITEMS[index].name : "?";
}

export class Backpack {
	onUse: ((itemId: number) => void) | undefined;
	onCraft: ((recipeId: number) => void) | undefined;
	onEquipWeapon: ((weaponId: number) => void) | undefined;
	onEquipItem: ((equipId: number) => void) | undefined;
	nearbyDesk = false;
	nearbyPro = false;

	private ctx: GameContext;
	private root: Frame | undefined;
	private content: Frame | undefined;
	private spLabel: TextLabel | undefined;
	private level = 1;
	private cat = 0;
	private selItem = 0;
	private selKind = 0;
	private selRecipe = 0;
	private scale = 1;

	constructor(ctx: GameContext) {
		this.ctx = ctx;
	}

	isOpen(): boolean {
		return this.root !== undefined;
	}

	open(): void {
		if (this.root !== undefined) return;
		this.level = 1;
		this.cat = 0;
		this.scale = math.max(this.ctx.viewH / 630, 0.5);
		const root = makeFrame(this.ctx.uiLayer, "Backpack", 0, 0, 1120, 630, Color3.fromRGB(0, 0, 0), {
			transparency: 0.4,
			zIndex: 200,
		});
		this.root = root;
		const panel = makeFrame(root, "Panel", 60, 36, 1000, 560, COLORS.uiPanel, { zIndex: 201 });
		makeLabel(panel, "Title", "Backpack", 20, 10, 220, 36, 24, COLORS.uiAccent);
		this.spLabel = makeLabel(panel, "Sp", `SP ${this.ctx.save.skillPoint}`, 250, 10, 160, 36, 18, COLORS.uiYellow);
		makeButton(panel, "Nav", "<", 860, 10, 56, 36, COLORS.uiPanelLight, (): void => {
			this.goBack();
		});
		makeButton(panel, "Close", "X", 930, 10, 56, 36, COLORS.uiPanelLight, (): void => {
			this.close();
		});
		for (let i = 0; i < CAT_NAMES.size(); i++) {
			const index = i;
			makeButton(panel, `Tab${i}`, CAT_NAMES[i], 20 + i * 160, 64, 150, 44, COLORS.uiPanelLight, (): void => {
				this.cat = index;
				this.level = index === 5 ? 5 : 2;
				this.rebuild();
			});
		}
		const content = makeFrame(panel, "Content", 20, 120, 960, 430, COLORS.bg, {
			transparency: 1,
			clips: true,
			zIndex: 5,
		});
		this.content = content;
		this.rebuild();
	}

	close(): void {
		if (this.root === undefined) return;
		this.root.Destroy();
		this.root = undefined;
		this.content = undefined;
		this.spLabel = undefined;
	}

	private goBack(): void {
		if (this.level === 1) {
			this.close();
			return;
		}
		if (this.level === 3 || this.level === 4) this.level = 2;
		else if (this.level === 5) this.level = 1;
		else this.level = 1;
		this.rebuild();
	}

	private refreshSp(): void {
		if (this.spLabel !== undefined) this.spLabel.Text = `SP ${this.ctx.save.skillPoint}`;
	}

	private rebuild(): void {
		if (this.content === undefined) return;
		clearChildren(this.content);
		this.refreshSp();
		if (this.level === 1) {
			makeLabel(this.content, "Hint", "Select a category", 0, 180, 960, 60, 24, COLORS.uiTextDim);
			return;
		}
		if (this.level === 3) {
			this.buildDetail();
			return;
		}
		if (this.level === 4) {
			this.buildCraftDetail();
			return;
		}
		if (this.cat === 5) {
			this.buildSkills();
			return;
		}
		if (this.cat === 4) {
			this.buildCraftList();
			return;
		}
		this.buildItemList();
	}

	private makeRow(list: ScrollList, order: number, name: string, right: string): Frame {
		const row = new Instance("Frame");
		row.Name = `Row${order}`;
		row.Size = new UDim2(1, 0, 0, math.round(ROW_H * this.scale));
		row.BackgroundColor3 = order % 2 === 0 ? Color3.fromRGB(38, 38, 46) : Color3.fromRGB(46, 46, 54);
		row.BorderSizePixel = 0;
		row.LayoutOrder = order;
		row.SetAttribute("DesignW", list.designW);
		row.SetAttribute("DesignH", ROW_H);
		row.Parent = list.frame;
		const nameLabel = makeLabel(row, "Name", name, 16, 38, 560, 40, 18, COLORS.uiText);
		nameLabel.TextXAlignment = Enum.TextXAlignment.Left;
		const countLabel = makeLabel(row, "Count", right, 700, 38, 240, 40, 17, COLORS.uiTextDim);
		countLabel.TextXAlignment = Enum.TextXAlignment.Right;
		return row;
	}

	private buildItemList(): void {
		const content = this.content;
		if (content === undefined) return;
		const list = makeScrollList(content, "Items", 0, 0, 960, 430);
		const save = this.ctx.save;
		if (this.cat === 0) {
			for (let i = 0; i < WEAPONS.size(); i++) {
				const w = WEAPONS[i];
				const row = this.makeRow(list, i, w.name, `x ${save.invenWeapon[w.id] ?? 0}`);
				const id = w.id;
				row.Active = true;
				row.InputBegan.Connect((input: InputObject): void => {
					if (
						input.UserInputType === Enum.UserInputType.MouseButton1 ||
						input.UserInputType === Enum.UserInputType.Touch
					) {
						this.selItem = id;
						this.selKind = 1;
						this.level = 3;
						this.rebuild();
					}
				});
			}
		} else if (this.cat === 1) {
			for (let i = 0; i < EQUIPS.size(); i++) {
				const e = EQUIPS[i];
				const row = this.makeRow(list, i, e.name, `x ${save.invenEquip[e.id] ?? 0}`);
				const id = e.id;
				row.Active = true;
				row.InputBegan.Connect((input: InputObject): void => {
					if (
						input.UserInputType === Enum.UserInputType.MouseButton1 ||
						input.UserInputType === Enum.UserInputType.Touch
					) {
						this.selItem = id;
						this.selKind = 2;
						this.level = 3;
						this.rebuild();
					}
				});
			}
		} else if (this.cat === 2) {
			for (let i = 0; i < USABLES.size(); i++) {
				const u = USABLES[i];
				const row = this.makeRow(list, i, u.name, `x ${save.invenUse[u.id] ?? 0}`);
				const id = u.id;
				row.Active = true;
				row.InputBegan.Connect((input: InputObject): void => {
					if (
						input.UserInputType === Enum.UserInputType.MouseButton1 ||
						input.UserInputType === Enum.UserInputType.Touch
					) {
						this.selItem = id;
						this.selKind = 3;
						this.level = 3;
						this.rebuild();
					}
				});
			}
		} else {
			let order = 0;
			for (let i = MAT_START; i < ETC_ITEMS.size(); i++) {
				const e = ETC_ITEMS[i];
				const row = this.makeRow(list, order, e.name, `x ${save.invenEtc[e.id] ?? 0}`);
				const id = e.id;
				row.Active = true;
				row.InputBegan.Connect((input: InputObject): void => {
					if (
						input.UserInputType === Enum.UserInputType.MouseButton1 ||
						input.UserInputType === Enum.UserInputType.Touch
					) {
						this.selItem = id;
						this.selKind = 4;
						this.level = 3;
						this.rebuild();
					}
				});
				order++;
			}
		}
	}

	private buildDetail(): void {
		const content = this.content;
		if (content === undefined) return;
		const save = this.ctx.save;
		const kind = this.selKind;
		const id = this.selItem;
		makeLabel(content, "DetailName", nameOf(kind, id), 40, 30, 880, 46, 26, COLORS.uiAccent);
		if (kind === 1) {
			const w = WEAPONS[id];
			const info = makeLabel(
				content,
				"DetailInfo",
				`Damage ${w.dmg}   Cooldown ${w.cooldown}   Mag ${w.mag}   Range ${w.range}`,
				40,
				100,
				880,
				40,
				17,
				COLORS.uiTextDim,
			);
			info.TextYAlignment = Enum.TextYAlignment.Top;
			makeLabel(
				content,
				"DetailCount",
				`Owned x ${save.invenWeapon[id] ?? 0}`,
				40,
				160,
				880,
				34,
				17,
				COLORS.uiTextDim,
			);
			const equipped = save.equipWeapon === id;
			const btn = makeButton(
				content,
				"Equip",
				equipped ? "Equipped" : "Equip",
				390,
				320,
				180,
				52,
				COLORS.uiPanelLight,
				(): void => {
					save.equipWeapon = id;
					if (this.onEquipWeapon !== undefined) this.onEquipWeapon(id);
					toast(this.ctx, `Equipped ${w.name}`);
					this.rebuild();
				},
			);
			if (equipped) btn.BackgroundColor3 = COLORS.uiGreen;
		} else if (kind === 2) {
			const e = EQUIPS[id];
			const info = makeLabel(
				content,
				"DetailInfo",
				`Defense ${e.def}   Speed ${e.speed}`,
				40,
				100,
				880,
				40,
				17,
				COLORS.uiTextDim,
			);
			info.TextYAlignment = Enum.TextYAlignment.Top;
			makeLabel(
				content,
				"DetailCount",
				`Owned x ${save.invenEquip[id] ?? 0}`,
				40,
				160,
				880,
				34,
				17,
				COLORS.uiTextDim,
			);
			const slot = e.kind;
			const currently =
				slot === 1
					? save.equipCloth === id
					: slot === 2
						? save.equipHand === id
						: slot === 3
							? save.equipGun === id
							: save.equipDeco === id;
			const btn = makeButton(
				content,
				"Equip",
				currently ? "Equipped" : "Equip",
				390,
				320,
				180,
				52,
				COLORS.uiPanelLight,
				(): void => {
					if (slot === 1) save.equipCloth = id;
					else if (slot === 2) save.equipHand = id;
					else if (slot === 3) save.equipGun = id;
					else save.equipDeco = id;
					if (this.onEquipItem !== undefined) this.onEquipItem(id);
					toast(this.ctx, `Equipped ${e.name}`);
					this.rebuild();
				},
			);
			if (currently) btn.BackgroundColor3 = COLORS.uiGreen;
		} else if (kind === 3) {
			const u = USABLES[id];
			const info = makeLabel(
				content,
				"DetailInfo",
				`HP ${u.hp}   Hunger ${u.hunger}   Speed ${u.speed}   Calm ${u.calm}   Pain ${u.pain}`,
				40,
				100,
				880,
				40,
				17,
				COLORS.uiTextDim,
			);
			info.TextYAlignment = Enum.TextYAlignment.Top;
			makeLabel(
				content,
				"DetailCount",
				`Owned x ${save.invenUse[id] ?? 0}`,
				40,
				160,
				880,
				34,
				17,
				COLORS.uiTextDim,
			);
			makeButton(content, "Use", "Use", 390, 320, 180, 52, COLORS.uiPanelLight, (): void => {
				if (this.onUse !== undefined) this.onUse(id);
				this.rebuild();
			});
		} else {
			makeLabel(
				content,
				"DetailCount",
				`Owned x ${save.invenEtc[id] ?? 0}`,
				40,
				100,
				880,
				34,
				17,
				COLORS.uiTextDim,
			);
			makeLabel(content, "DetailHint", "Material", 40, 160, 880, 34, 17, COLORS.uiTextDim);
		}
	}

	private recipeAvailable(r: CraftRecipe): boolean {
		if (r.needsPro) return this.nearbyPro;
		if (r.needsDesk) return this.nearbyDesk;
		return true;
	}

	private ingredientCount(kind: number, index: number): number {
		const save = this.ctx.save;
		if (kind === 1) return save.invenWeapon[index] ?? 0;
		if (kind === 2) return save.invenEquip[index] ?? 0;
		if (kind === 3) return save.invenUse[index] ?? 0;
		return save.invenEtc[index] ?? 0;
	}

	private buildCraftList(): void {
		const content = this.content;
		if (content === undefined) return;
		const list = makeScrollList(content, "Recipes", 0, 0, 960, 430);
		let order = 0;
		for (const r of CRAFT_RECIPES) {
			const avail = this.recipeAvailable(r);
			const tag = r.needsPro ? "  [pro]" : r.needsDesk ? "  [desk]" : "";
			const row = this.makeRow(
				list,
				order,
				`${nameOf(r.resultKind, r.resultIndex)}${tag}`,
				avail ? "" : "locked",
			);
			if (!avail) {
				row.BackgroundColor3 = Color3.fromRGB(32, 32, 38);
			}
			const recipeId = r.id;
			row.Active = true;
			row.InputBegan.Connect((input: InputObject): void => {
				if (
					input.UserInputType === Enum.UserInputType.MouseButton1 ||
					input.UserInputType === Enum.UserInputType.Touch
				) {
					this.selRecipe = recipeId;
					this.level = 4;
					this.rebuild();
				}
			});
			order++;
		}
	}

	private buildCraftDetail(): void {
		const content = this.content;
		if (content === undefined) return;
		let recipe: CraftRecipe | undefined;
		for (const r of CRAFT_RECIPES) {
			if (r.id === this.selRecipe) recipe = r;
		}
		if (recipe === undefined) {
			this.level = 2;
			this.rebuild();
			return;
		}
		const r = recipe;
		makeLabel(
			content,
			"CraftResult",
			`Make: ${nameOf(r.resultKind, r.resultIndex)} x ${r.resultCount}`,
			40,
			24,
			880,
			44,
			24,
			COLORS.uiAccent,
		);
		for (let i = 0; i < r.ingredients.size(); i++) {
			const ing = r.ingredients[i];
			const have = this.ingredientCount(ing.kind, ing.index);
			const ok = have >= ing.count;
			const line = makeLabel(
				content,
				`Ing${i}`,
				`${nameOf(ing.kind, ing.index)}   ${have} / ${ing.count}`,
				60,
				90 + i * 40,
				600,
				34,
				17,
				ok ? COLORS.uiGreen : COLORS.uiRed,
			);
			line.TextXAlignment = Enum.TextXAlignment.Left;
		}
		const avail = this.recipeAvailable(r);
		const deskTag = r.needsPro
			? this.nearbyPro
				? "Pro desk"
				: "Need pro desk"
			: r.needsDesk
				? this.nearbyDesk
					? "Craft desk"
					: "Need craft desk"
				: "Hand craft";
		const deskLabel = makeLabel(
			content,
			"DeskTag",
			deskTag,
			60,
			240,
			400,
			34,
			16,
			avail ? COLORS.uiTextDim : COLORS.uiRed,
		);
		deskLabel.TextXAlignment = Enum.TextXAlignment.Left;
		let enough = true;
		for (const ing of r.ingredients) {
			if (this.ingredientCount(ing.kind, ing.index) < ing.count) enough = false;
		}
		const btn = makeButton(content, "CraftBtn", "Craft", 390, 330, 180, 52, COLORS.uiPanelLight, (): void => {
			if (this.onCraft !== undefined) this.onCraft(r.id);
			this.rebuild();
		});
		if (!avail || !enough) {
			btn.BackgroundColor3 = Color3.fromRGB(50, 50, 58);
			btn.TextColor3 = COLORS.uiTextDim;
		}
	}

	private buildSkills(): void {
		const content = this.content;
		if (content === undefined) return;
		const list = makeScrollList(content, "Skills", 0, 0, 960, 430);
		const save = this.ctx.save;
		for (let i = 0; i < SKILLS.size(); i++) {
			const sk = SKILLS[i];
			const lvl = save.skillLevels[sk.id] ?? 0;
			const row = this.makeRow(list, i, sk.name, `Lv ${lvl} / ${sk.maxLevel}`);
			const detail = makeLabel(row, "Detail", sk.detail, 16, 78, 560, 28, 13, COLORS.uiTextDim);
			detail.TextXAlignment = Enum.TextXAlignment.Left;
			const canBuy = save.skillPoint > 0 && lvl < sk.maxLevel;
			const plus = makeButton(
				row,
				"Plus",
				"+",
				870,
				33,
				70,
				50,
				canBuy ? COLORS.uiAccent : Color3.fromRGB(50, 50, 58),
				(): void => {
					const current = save.skillLevels[sk.id] ?? 0;
					if (save.skillPoint > 0 && current < sk.maxLevel) {
						save.skillLevels[sk.id] = current + 1;
						save.skillPoint -= 1;
						toast(this.ctx, `Learned ${sk.name}`);
						this.rebuild();
					}
				},
			);
			plus.ZIndex = 3;
		}
	}
}
