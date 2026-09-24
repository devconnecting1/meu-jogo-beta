/*
 * The Bag's details panel (docs/DESIGN_RULES.md UI-11): the item card (UI-08) grown into the right half of the Bag,
 * in the vocabulary of the wardrobe's details column (UI-07):
 *
 *   ┌ Pistol ─────────────────────────────── [ x1 ] ┐   section title = the name; key = how many / EQUIPPED / LV 1 / 3
 *   │ ┌──────────┐ ┌ Weapon · Pistol ──────────────┐ │
 *   │ │          │ │ Damage                     25 │ │   the big icon on its dark bed; beside it, on another bed,
 *   │ │   icon   │ │ Cooldown                0.3 s │ │   the type and the stats in the card's voices (yellow
 *   │ │  (128)   │ │ Range                     400 │ │   numbers, green bonuses, orange effects, red penalties)
 *   │ └──────────┘ └───────────────────────────────┘ │
 *   │ ┌ One shot per press. ───────────────────────┐ │   notes, the survivor's side ("in your hands"), and the
 *   │ │ [Left click] Attack / shoot   [R] Reload    │ │   usage hint in the player's own device's keys
 *   │ └────────────────────────────────────────────┘ │   (a recipe: its ingredients as icon cells with have/need
 *   │ [                  Equip                   ]   │   in red when short, the station, what is near you)
 *   └────────────────────────────────────────────────┘   the one action: the steel-blue plate, or an iron one
 *
 * Every small text sits on a dark bed (a groove), where the card's voices and the muted grey are measured
 * (npm run test:contrast); on the section plate itself only the light title and the key.
 *
 * Built once; set() rewrites it in place and only when what it shows changed, so going through a grid with the mouse
 * or the pad creates nothing: the big icon holds as many Frames as the costliest icon from the start, and the recipe
 * block and the hint lines are made the first time they are needed and kept.
 */
import { CardHint, CardStat, toneColor } from "./itemCard";
import { IconView, clearIcon, drawIcon, maxItemFrames } from "./itemIcon";
import { paintPlate } from "./plate";
import { GAME, STAT, SURFACE, TEXT, THEME, fontOf, space } from "./theme";
import { Groove, SECTION_CONTENT_Y, SECTION_TITLE_MID, Section, setValueKey } from "./window";
import {
	Button,
	ButtonVariant,
	Keycap,
	makeFrame,
	makeLabel,
	setButtonEnabled,
	setButtonVariant,
	setVisible,
	uiScale,
} from "./widgets";

const BOLD = fontOf("sans", Enum.FontWeight.Bold);
const NUMERIC = fontOf("mono", Enum.FontWeight.Bold);

// ---------------------------------------------------------------- the model

export interface PanelAction {
	text: string;
	/** "default" = the steel-blue main action; "secondary" = an iron plate (navigation, Unequip...) */
	variant: ButtonVariant;
	enabled: boolean;
}

export interface PanelIngredient {
	name: string;
	icon: string;
	/** "3 / 5" */
	count: string;
	/** fewer than the recipe takes: the count in red */
	short: boolean;
}

export interface PanelStation {
	/** ICON_GLYPHS key of the station (hand, desk, pro, fire) */
	glyph: string;
	/** "Craft desk nearby" / "Need a craft desk" */
	text: string;
	/** the station is there: green, else red */
	ok: boolean;
	/** why it can or cannot be crafted, or what to do */
	hint: string;
	/** the stations near the survivor ("Near you: craft desk, lit fire") */
	nearby: string;
}

/** everything the panel shows; every string already through lang.ts */
export interface PanelModel {
	title: string;
	/** the key at the title's right ("" = none) */
	state: string;
	/** ITEM_ICONS key of the big icon ("" = none) */
	icon: string;
	dim: boolean;
	/** beside the icon: the type over the stats, or (an empty tab) the body text instead */
	type: string;
	stats: Array<CardStat>;
	body: string;
	/** the lower bed: notes (muted), an extra line (light, or the XP blue), the usage hint */
	notes: string;
	extra: string;
	extraXp: boolean;
	hints: Array<CardHint>;
	/** a recipe: its ingredients and station (the lower bed shows these instead of notes / hints) */
	ingredients: Array<PanelIngredient>;
	station: PanelStation | undefined;
	/** the button (undefined = none) */
	action: PanelAction | undefined;
}

function panelSig(m: PanelModel): string {
	let s = `${m.title}|${m.state}|${m.icon}|${m.dim}|${m.type}|${m.body}|${m.notes}|${m.extra}|${m.extraXp}`;
	for (const st of m.stats) s += `|${st.label}=${st.value}:${st.tone}`;
	for (const h of m.hints) s += `|${h.key}>${h.text}`;
	for (const i of m.ingredients) s += `|${i.icon}:${i.name}:${i.count}:${i.short}`;
	const st = m.station;
	if (st !== undefined) s += `|${st.glyph}:${st.text}:${st.ok}:${st.hint}:${st.nearby}`;
	const a = m.action;
	if (a !== undefined) s += `|${a.text}:${a.variant}:${a.enabled}`;
	return s;
}

// ---------------------------------------------------------------- layout (panel design units)

const INSET = space(4);
/** the icon's bed and the icon in it (128 = 8 screen px per icon pixel at a UI scale of 1) */
const BED = 148;
const BIG = 128;
const GAP = space(2);
/** the stats bed: the type line, then up to six stats (a gun) */
const TYPE_Y = 8;
const TYPE_H = 18;
const STATS_Y = 30;
const STAT_H = 19;
const TEXT_X = 10;
/** the lower bed */
const LINE = 20;
const HINT_H = 26;
const KEY_H = 22;
const KEY_GAP = space(2);
/** hint lines built with the panel (more are made if an item ever needs them) */
const BUILT_HINTS = 3;
const ACTION_H = 44;
/** a recipe's ingredient: a small tile with the icon, the name and have / need beside it */
const ING_TILE = 44;
const ING_ICON = 32;
const ING_W = 148;
const MOST_INGREDIENTS = 3;

/** lines `text` wraps to at TEXT.sm in `w` design units (half an em a character, like the item card's estimate) */
function lines(text: string, w: number): number {
	if (text === "") return 0;
	const perLine = math.max(1, math.floor(w / (TEXT.sm * 0.56)));
	let n = 0;
	for (const paragraph of text.split("\n")) n += math.max(1, math.ceil(paragraph.size() / perLine));
	return n;
}

interface StatLine {
	frame: Frame;
	label: TextLabel;
	value: TextLabel;
}

interface HintLine {
	frame: Frame;
	key: Frame;
	text: TextLabel;
}

interface IngredientCell {
	frame: Frame;
	icon: IconView;
	name: TextLabel;
	count: TextLabel;
}

interface RecipeBlock {
	frame: Frame;
	cells: Array<IngredientCell>;
	glyph: IconView;
	station: TextLabel;
	hint: TextLabel;
	nearby: TextLabel;
}

const noop = (): void => {};

export class BagPanel {
	readonly frame: Frame;
	/** what the button does now (the Bag sets it on every sync: the handler is not drawn) */
	onAction: () => void = noop;
	private readonly lowerW: number;
	private readonly lowerH: number;
	private readonly title: TextLabel;
	private readonly state: Frame;
	private readonly bed: Frame;
	private readonly icon: IconView;
	private readonly statsBed: Frame;
	private readonly typeLabel: TextLabel;
	private readonly body: TextLabel;
	private readonly stats: Array<StatLine> = [];
	private readonly lower: Frame;
	private readonly notes: TextLabel;
	private readonly extra: TextLabel;
	private readonly hints: Array<HintLine> = [];
	private recipe: RecipeBlock | undefined;
	private readonly action: TextButton;
	private hintOffset = -1;
	private shown = "";
	/** lang.ts, for the one string the panel writes itself (the ingredients caption) */
	private readonly tr: (key: string) => string;

	constructor(
		parent: Instance,
		name: string,
		x: number,
		y: number,
		w: number,
		h: number,
		tr: (key: string) => string,
	) {
		this.tr = tr;
		const sec = Section(parent, name, { x, y, w, h, title: "" });
		const frame = sec.frame;
		this.frame = frame;
		const z = frame.ZIndex + 1;
		// the title leaves room for the key at its right
		const title = sec.title as TextLabel;
		title.Size = UDim2.fromScale((w - space(10) - 150) / w, title.Size.Y.Scale);
		this.title = title;
		this.state = Keycap(frame, "State", "", {
			x: w - space(5),
			cy: SECTION_TITLE_MID,
			anchorX: 1,
			h: 28,
			minW: 64,
			textSize: TEXT.base,
			font: BOLD,
			zIndex: z,
		});

		// the icon on its bed, and beside it the type and the stats on theirs
		const top = SECTION_CONTENT_Y;
		this.bed = Groove(frame, "IconBed", INSET, top, BED, BED);
		this.bed.ZIndex = z;
		const at = (BED - BIG) / 2;
		this.icon = IconView(this.bed, "ItemIcon", at, at, BIG, z + 1, maxItemFrames(), "drawn");
		const statsX = INSET + BED + GAP;
		const statsW = w - statsX - INSET;
		this.statsBed = Groove(frame, "Stats", statsX, top, statsW, BED);
		this.statsBed.ZIndex = z;
		const sz = z + 1;
		this.typeLabel = makeLabel(
			this.statsBed,
			"Type",
			"",
			TEXT_X,
			TYPE_Y,
			statsW - TEXT_X * 2,
			TYPE_H,
			TEXT.sm,
			THEME.mutedForeground,
			{
				weight: Enum.FontWeight.Medium,
				align: "left",
				zIndex: sz,
			},
		);
		this.body = makeLabel(
			this.statsBed,
			"Body",
			"",
			TEXT_X,
			TYPE_Y,
			statsW - TEXT_X * 2,
			BED - TYPE_Y * 2,
			TEXT.base,
			THEME.mutedForeground,
			{
				align: "left",
				valign: "top",
				zIndex: sz,
			},
		);
		this.body.Visible = false;
		for (let i = 0; i < 6; i++) this.stats.push(this.makeStat(i, statsW, sz));

		// the lower bed, between the top row and the button
		const actionY = h - INSET - ACTION_H;
		const lowerY = top + BED + GAP;
		this.lowerW = w - INSET * 2;
		this.lowerH = actionY - GAP - lowerY;
		this.lower = Groove(frame, "Lower", INSET, lowerY, this.lowerW, this.lowerH);
		this.lower.ZIndex = z;
		const lw = this.lowerW - TEXT_X * 2;
		this.notes = makeLabel(this.lower, "Notes", "", TEXT_X, 8, lw, LINE, TEXT.sm, THEME.mutedForeground, {
			align: "left",
			valign: "top",
			zIndex: sz,
		});
		this.extra = makeLabel(this.lower, "Extra", "", TEXT_X, 8, lw, LINE, TEXT.sm, THEME.foreground, {
			align: "left",
			valign: "top",
			zIndex: sz,
		});
		// the most hint lines an item shows today (a gun: attack and reload; a weapon on touch: aim), built up front
		for (let i = 0; i < BUILT_HINTS; i++) this.hints.push(this.makeHint(i));

		this.action = Button(frame, "Action", "", {
			x: INSET,
			y: actionY,
			w: w - INSET * 2,
			h: ACTION_H,
			textSize: TEXT.lg,
			zIndex: z,
			onClick: (): void => this.onAction(),
		});
	}

	/** the button (the Bag focuses it for the pad) */
	button(): TextButton {
		return this.action;
	}

	private makeStat(i: number, w: number, z: number): StatLine {
		const inner = w - TEXT_X * 2;
		const frame = makeFrame(this.statsBed, `Stat${i}`, TEXT_X, STATS_Y + i * STAT_H, inner, STAT_H, THEME.card, {
			transparency: 1,
			zIndex: z,
		});
		const half = inner / 2;
		const label = makeLabel(frame, "Label", "", 0, 0, half + 20, STAT_H, TEXT.sm, THEME.mutedForeground, {
			weight: Enum.FontWeight.Medium,
			align: "left",
			zIndex: z + 1,
		});
		const value = makeLabel(frame, "Value", "", half + 20, 0, half - 20, STAT_H, TEXT.base, THEME.foreground, {
			font: NUMERIC,
			align: "right",
			zIndex: z + 1,
		});
		frame.Visible = false;
		return { frame, label, value };
	}

	private makeHint(i: number): HintLine {
		const lw = this.lowerW - TEXT_X * 2;
		const z = this.lower.ZIndex + 1;
		const frame = makeFrame(this.lower, `Hint${i}`, TEXT_X, 0, lw, HINT_H, THEME.card, {
			transparency: 1,
			zIndex: z,
		});
		const key = Keycap(frame, "Key", "", { x: 0, cy: HINT_H / 2, h: KEY_H, textSize: TEXT.xs, zIndex: z + 1 });
		const text = makeLabel(
			frame,
			"Does",
			"",
			KEY_H + KEY_GAP,
			0,
			lw - KEY_H - KEY_GAP,
			HINT_H,
			TEXT.sm,
			THEME.mutedForeground,
			{
				align: "left",
				zIndex: z + 1,
			},
		);
		key.GetPropertyChangedSignal("AbsoluteSize").Connect(() => this.alignHints());
		this.hintOffset = -1;
		frame.Visible = false;
		return { frame, key, text };
	}

	/** the hint texts start after the widest key shown, so the hint reads as a table (the item card's rule) */
	private alignHints(): void {
		let widest = 0;
		for (const line of this.hints) if (line.frame.Visible) widest = math.max(widest, line.key.AbsoluteSize.X);
		const scale = uiScale();
		const offset = math.round(math.max(widest, KEY_H * scale) + KEY_GAP * scale);
		if (offset === this.hintOffset) return;
		this.hintOffset = offset;
		for (const line of this.hints) {
			line.text.Position = new UDim2(0, offset, 0, 0);
			line.text.Size = new UDim2(1, -offset, 1, 0);
		}
	}

	/** the recipe's lower bed: the ingredients in a row, then the station, the hint and what is near */
	private makeRecipe(): RecipeBlock {
		const lw = this.lowerW;
		const z = this.lower.ZIndex + 1;
		const frame = makeFrame(this.lower, "Recipe", 0, 0, lw, this.lowerH, THEME.card, {
			transparency: 1,
			zIndex: z,
		});
		makeLabel(
			frame,
			"Caption",
			this.tr("Ingredients"),
			TEXT_X,
			6,
			lw - TEXT_X * 2,
			16,
			TEXT.xs,
			THEME.mutedForeground,
			{
				font: BOLD,
				align: "left",
				zIndex: z + 1,
			},
		);
		const cells: Array<IngredientCell> = [];
		for (let i = 0; i < MOST_INGREDIENTS; i++) cells.push(this.makeCell(frame, i, z + 1));
		const rowY = 26 + ING_TILE + 10;
		const glyph = IconView(frame, "Glyph", TEXT_X, rowY + 3, 14, z + 1);
		const station = makeLabel(
			frame,
			"Station",
			"",
			TEXT_X + 20,
			rowY,
			lw - TEXT_X * 2 - 20,
			LINE,
			TEXT.sm,
			GAME.success,
			{
				font: BOLD,
				align: "left",
				zIndex: z + 1,
			},
		);
		const hint = makeLabel(
			frame,
			"Hint",
			"",
			TEXT_X,
			rowY + LINE + 2,
			lw - TEXT_X * 2,
			LINE,
			TEXT.sm,
			THEME.mutedForeground,
			{
				align: "left",
				zIndex: z + 1,
			},
		);
		const nearby = makeLabel(
			frame,
			"Nearby",
			"",
			TEXT_X,
			rowY + (LINE + 2) * 2,
			lw - TEXT_X * 2,
			LINE,
			TEXT.sm,
			THEME.mutedForeground,
			{
				align: "left",
				zIndex: z + 1,
			},
		);
		return { frame, cells, glyph, station, hint, nearby };
	}

	private makeCell(parent: Frame, i: number, z: number): IngredientCell {
		const frame = makeFrame(parent, `Ing${i}`, TEXT_X + i * ING_W, 26, ING_W - GAP, ING_TILE, THEME.card, {
			transparency: 1,
			zIndex: z,
		});
		// the small tile: the dark iron of an item the survivor has, the icon on it
		const tile = makeFrame(frame, "Tile", 0, 0, ING_TILE, ING_TILE, THEME.card, { transparency: 1, zIndex: z });
		paintPlate(tile, SURFACE.section, "flat", 3);
		const at = (ING_TILE - ING_ICON) / 2;
		const icon = IconView(tile, "ItemIcon", at, at, ING_ICON, z + 1, 0, "drawn");
		const textX = ING_TILE + 8;
		const textW = ING_W - GAP - textX;
		const name = makeLabel(frame, "Name", "", textX, 2, textW, 20, TEXT.sm, THEME.foreground, {
			weight: Enum.FontWeight.Medium,
			align: "left",
			zIndex: z + 1,
		});
		const count = makeLabel(frame, "Count", "", textX, 22, textW, 20, TEXT.base, THEME.foreground, {
			font: NUMERIC,
			align: "left",
			zIndex: z + 1,
		});
		frame.Visible = false;
		return { frame, icon, name, count };
	}

	/** shows `m`, rewriting only when it differs from what is shown */
	set(m: PanelModel): void {
		const a = m.action;
		if (a !== undefined) {
			this.action.Text = a.text;
			setButtonVariant(this.action, a.variant);
			setButtonEnabled(this.action, a.enabled);
		}
		setVisible(this.action, a !== undefined);
		const sig = panelSig(m);
		if (sig === this.shown) return;
		this.shown = sig;
		this.title.Text = m.title;
		setValueKey(this.state, m.state);
		this.state.Visible = m.state !== "";
		if (m.icon !== "") drawIcon(this.icon, m.icon, { dim: m.dim });
		else clearIcon(this.icon);

		// beside the icon: the type and the stats, or the body text of an empty tab
		const empty = m.body !== "";
		this.body.Visible = empty;
		this.body.Text = m.body;
		this.typeLabel.Visible = !empty;
		this.typeLabel.Text = m.type;
		for (let i = 0; i < this.stats.size(); i++) {
			const line = this.stats[i];
			const st = empty ? undefined : m.stats[i];
			line.frame.Visible = st !== undefined;
			if (st === undefined) continue;
			line.label.Text = st.label;
			line.value.Text = st.value;
			line.value.TextColor3 = toneColor(st.tone);
			line.value.FontFace = st.tone === "text" ? BOLD : NUMERIC;
		}

		const isRecipe = m.station !== undefined;
		if (isRecipe && this.recipe === undefined) this.recipe = this.makeRecipe();
		if (this.recipe !== undefined) this.recipe.frame.Visible = isRecipe;
		this.lower.Visible = !empty || isRecipe;
		if (isRecipe) this.setRecipe(m);
		this.setText(isRecipe ? undefined : m);
	}

	/** the lower bed's text: notes, the extra line, the hints -- stacked from the top ("undefined" hides them) */
	private setText(m: PanelModel | undefined): void {
		const lw = this.lowerW - TEXT_X * 2;
		const H = this.lowerH;
		let y = 8;
		const put = (g: GuiObject, top: number, h: number): void => {
			g.Position = UDim2.fromScale(TEXT_X / this.lowerW, top / H);
			g.Size = UDim2.fromScale(lw / this.lowerW, h / H);
		};
		const notes = m !== undefined ? m.notes : "";
		const notesH = lines(notes, lw) * LINE;
		this.notes.Visible = notesH > 0;
		if (notesH > 0) {
			this.notes.Text = notes;
			put(this.notes, y, notesH);
			y += notesH + 4;
		}
		const extra = m !== undefined ? m.extra : "";
		const extraH = lines(extra, lw) * LINE;
		this.extra.Visible = extraH > 0;
		if (extraH > 0) {
			this.extra.Text = extra;
			this.extra.TextColor3 = m !== undefined && m.extraXp ? GAME.xp : THEME.foreground;
			put(this.extra, y, extraH);
			y += extraH + 4;
		}
		const hints = m !== undefined ? m.hints : [];
		while (this.hints.size() < hints.size()) this.hints.push(this.makeHint(this.hints.size()));
		for (let i = 0; i < this.hints.size(); i++) {
			const line = this.hints[i];
			const hint = hints[i];
			line.frame.Visible = hint !== undefined;
			if (hint === undefined) continue;
			line.frame.Position = UDim2.fromScale(TEXT_X / this.lowerW, y / H);
			y += HINT_H + 2;
			setValueKey(line.key, hint.key);
			line.text.Text = hint.text;
		}
		this.hintOffset = -1;
		this.alignHints();
	}

	private setRecipe(m: PanelModel): void {
		const r = this.recipe;
		const st = m.station;
		if (r === undefined || st === undefined) return;
		while (r.cells.size() < m.ingredients.size()) {
			r.cells.push(this.makeCell(r.frame, r.cells.size(), r.frame.ZIndex + 1));
		}
		for (let i = 0; i < r.cells.size(); i++) {
			const cell = r.cells[i];
			const ing = m.ingredients[i];
			cell.frame.Visible = ing !== undefined;
			if (ing === undefined) continue;
			drawIcon(cell.icon, ing.icon);
			cell.name.Text = ing.name;
			cell.count.Text = ing.count;
			cell.count.TextColor3 = ing.short ? STAT.penalty : THEME.foreground;
		}
		drawIcon(r.glyph, st.glyph, { ink: st.ok ? GAME.success : THEME.destructive });
		r.station.Text = st.text;
		r.station.TextColor3 = st.ok ? GAME.success : THEME.destructive;
		r.hint.Text = st.hint;
		r.nearby.Text = st.nearby;
	}
}
