/*
 * Item card: what an item IS, in one card (docs/DESIGN_RULES.md UI-08, in the style of the owner's reference
 * windows). The Bag shows it as the tooltip of the tile under the mouse (an item other than the selected one, whose
 * card is the details panel, client/ui/bagPanel.ts); any screen that shows an item can drop it in.
 *
 *   +--------------------------------+
 *   | [#]  Axe                   x 2 |  header: the item's pixel icon (UI-11: the same drawing as the Bag's tile and
 *   |      Weapon · Melee            |  the HUD hotbar) on a small dark-iron tile, the name, the type; a tag at right
 *   | ------------------------------ |  the fio: a thin rule in `line` between two sections
 *   | Damage                      50 |  stats: the label muted, the value in its voice (theme.ts STAT) --
 *   | Cooldown                 0.4 s |  numbers yellow, bonuses green, status effects orange, penalties red
 *   | ------------------------------ |
 *   | Automatic: hold to keep ...    |  notes: muted sentences, derived from the data
 *   | ------------------------------ |
 *   | [Left click]  Attack / shoot   |  usage hint: the keys of the player's own device
 *   +--------------------------------+
 *
 * No trade / gift buttons: the reference had them, the owner cut them. A card shows, it offers no action.
 *
 * The card only DRAWS a model (ItemCardModel); what goes in it -- read from the shared data, only the fields an
 * item really has -- is client/ui/itemInfo.ts. Built once, then rewritten in place: set() with another item
 * writes the new texts onto the same lines and resizes the card to what it shows now, so moving the mouse over a
 * grid creates no Instance (npm run test:backpack): the icon holds as many Frames as the costliest icon from the start,
 * and the lines a model needs beyond those built with the card are made once and kept.
 *
 * Text: light or muted, never with a contour (UI-04); every colour is a theme role (UI-01), every string comes in
 * the model already through lang.ts (UI-03).
 */
import { IconView, drawItemIcon, maxItemFrames } from "./itemIcon";
import { paintPlate } from "./plate";
import { STAT, SURFACE, TEXT, THEME, fontOf, hex, space } from "./theme";
import { setValueKey } from "./window";
import { Card, Keycap, Separator, designOf, makeFrame, makeLabel, setDesign, uiScale } from "./widgets";

// ---------------------------------------------------------------- the model

/** the voice of a stat's value (theme.ts STAT); "text" is a word, not a number (a slot, what it cooks into) */
export type StatTone = "value" | "bonus" | "effect" | "penalty" | "text";

export interface CardStat {
	label: string;
	value: string;
	tone: StatTone;
}

/** one line of the usage hint: a key of the player's device and what it does */
export interface CardHint {
	key: string;
	text: string;
}

/** everything a card shows; every string already through lang.ts */
export interface ItemCardModel {
	/** ItemKind and id: the icon of the header (shared/data/itemIcons.ts iconOf) */
	kind: number;
	id: number;
	name: string;
	/** "Weapon · Melee", "Food", "Clothing"... */
	type: string;
	/** a short tag at the header's right (the count, "EQUIPPED"); "" = none */
	tag: string;
	tagColor: Color3;
	/** the stats section; empty = no section */
	stats: Array<CardStat>;
	/** the notes section, muted sentences; "" = no section */
	notes: string;
	/** the usage hint section; empty = no section */
	hints: Array<CardHint>;
}

/** the colour of a stat's voice (theme.ts STAT): the card and the Bag's details panel speak the same way */
export function toneColor(tone: StatTone): Color3 {
	if (tone === "value") return STAT.value;
	if (tone === "bonus") return STAT.bonus;
	if (tone === "effect") return STAT.effect;
	if (tone === "penalty") return STAT.penalty;
	return THEME.foreground;
}

/** what a model draws: two models with the same signature draw the same card */
function modelSig(m: ItemCardModel): string {
	let s = `${m.kind}:${m.id}|${m.name}|${m.type}|${m.tag}|${hex(m.tagColor)}|${m.notes}`;
	for (const st of m.stats) s += `|${st.label}=${st.value}:${st.tone}`;
	for (const h of m.hints) s += `|${h.key}>${h.text}`;
	return s;
}

// ---------------------------------------------------------------- layout (card design units)

const BOLD = fontOf("sans", Enum.FontWeight.Bold);
/** the "numeric" role (theme.ts TYPE): tabular digits */
const NUMERIC = fontOf("mono", Enum.FontWeight.Bold);
const PAD = space(4);
/** the header: the icon, and the name over the type beside it */
const ICON = 44;
const NAME_H = 24;
const TYPE_H = 18;
const TAG_W = 96;
/** space above and under the fio between two sections */
const RULE_GAP = space(3);
const STAT_H = 24;
const STAT_GAP = space(0.5);
/** one line of notes at TEXT.sm */
const NOTE_LINE = 20;
const HINT_H = 28;
const HINT_GAP = space(1);
const KEY_H = 22;
const KEY_GAP = space(2);
/** lines built with the card, the most any item shows today (a gun: 6 stats; a weapon to equip: 3 hints) */
const BUILT_STATS = 6;
const BUILT_HINTS = 3;
/** three sections, so three rules at most */
const RULES = 3;

/**
 * Height of the notes at TEXT.sm in `w` design units. BuilderSans averages about half an em a character; 0.56
 * leaves room for the word that wraps early. An estimate: if it comes up short, the label's TextScaled shrinks the
 * text a step instead of cutting it.
 */
function notesHeight(text: string, w: number): number {
	if (text === "") return 0;
	const perLine = math.max(1, math.floor(w / (TEXT.sm * 0.56)));
	let lines = 0;
	for (const paragraph of text.split("\n")) lines += math.max(1, math.ceil(paragraph.size() / perLine));
	return lines * NOTE_LINE;
}

/** height of a run of `n` lines of `h` with `gap` between them */
function runHeight(n: number, h: number, gap: number): number {
	return n <= 0 ? 0 : n * h + (n - 1) * gap;
}

/** design height of the card that shows `m` in `innerW` */
function cardHeight(m: ItemCardModel, innerW: number): number {
	let h = PAD + ICON;
	if (m.stats.size() > 0) h += RULE_GAP * 2 + runHeight(m.stats.size(), STAT_H, STAT_GAP);
	const notes = notesHeight(m.notes, innerW);
	if (notes > 0) h += RULE_GAP * 2 + notes;
	if (m.hints.size() > 0) h += RULE_GAP * 2 + runHeight(m.hints.size(), HINT_H, HINT_GAP);
	return h + PAD;
}

// ---------------------------------------------------------------- the card

export interface ItemCardProps {
	x: number;
	y: number;
	w: number;
	zIndex?: number;
}

export interface ItemCardHandle {
	frame: Frame;
	/** design height of what the card shows now: it grows and shrinks with the item */
	height: number;
	/** shows `model`, rewriting only what changed; the lines are reused, never rebuilt */
	set: (model: ItemCardModel) => void;
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

/**
 * The item card: a popover Card (the kit's framed panel, `SURFACE.panel` inside), `w` wide and as tall as the item
 * it shows. Place it like any Card; its height follows set(), read it back from `height`.
 */
export function ItemCard(parent: Instance, name: string, props: ItemCardProps): ItemCardHandle {
	const w = props.w;
	const innerW = w - PAD * 2;
	const [pdw, pdh] = designOf(parent);
	const frame = Card(parent, name, {
		x: props.x,
		y: props.y,
		w,
		h: PAD * 2 + ICON,
		variant: "popover",
		zIndex: props.zIndex,
	});
	const z = frame.ZIndex + 1;
	/** a transparent block of the card, innerW wide; set() places it in the card's height of the moment */
	const block = (blockName: string, h: number): Frame =>
		makeFrame(frame, blockName, PAD, 0, innerW, h, THEME.card, { transparency: 1, zIndex: z });

	// header: icon, name over type, tag at the right
	const header = block("Header", ICON);
	// the icon on a small tile of dark iron (the Bag's tile face), as many Frames as any icon needs from the start
	const iconTile = makeFrame(header, "IconTile", 0, 0, ICON, ICON, THEME.card, { transparency: 1, zIndex: z + 1 });
	paintPlate(iconTile, SURFACE.section, "flat", 3);
	const icon = IconView(iconTile, "ItemIcon", 4, 4, ICON - 8, z + 2, maxItemFrames());
	const textX = ICON + space(3);
	const title = makeLabel(header, "Name", "", textX, 0, innerW - textX, NAME_H, TEXT.lg, THEME.foreground, {
		font: BOLD,
		align: "left",
		zIndex: z + 1,
	});
	const typeLabel = makeLabel(
		header,
		"Type",
		"",
		textX,
		NAME_H + 2,
		innerW - textX,
		TYPE_H,
		TEXT.sm,
		THEME.mutedForeground,
		{
			weight: Enum.FontWeight.Medium,
			align: "left",
			zIndex: z + 1,
		},
	);
	const tag = makeLabel(header, "Tag", "", innerW - TAG_W, 0, TAG_W, NAME_H, TEXT.sm, THEME.mutedForeground, {
		font: BOLD,
		align: "right",
		zIndex: z + 1,
	});

	const rules: Array<Frame> = [];
	for (let i = 0; i < RULES; i++) {
		rules.push(Separator(frame, `Rule${i}`, { x: PAD, y: 0, length: innerW, color: SURFACE.line, zIndex: z }));
	}

	const stats: Array<StatLine> = [];
	const makeStat = (i: number): StatLine => {
		const line = block(`Stat${i}`, STAT_H);
		const half = innerW / 2;
		const label = makeLabel(line, "Label", "", 0, 0, half, STAT_H, TEXT.sm, THEME.mutedForeground, {
			weight: Enum.FontWeight.Medium,
			align: "left",
			zIndex: z + 1,
		});
		const value = makeLabel(line, "Value", "", half, 0, half, STAT_H, TEXT.base, THEME.foreground, {
			font: NUMERIC,
			align: "right",
			zIndex: z + 1,
		});
		return { frame: line, label, value };
	};

	const notes = makeLabel(frame, "Notes", "", PAD, 0, innerW, NOTE_LINE, TEXT.sm, THEME.mutedForeground, {
		align: "left",
		valign: "top",
		zIndex: z,
	});

	const hints: Array<HintLine> = [];
	let hintOffset = -1;
	/** the texts of the hint start after the WIDEST key shown, so the section reads as a table (like How to play) */
	const alignHints = (): void => {
		let widest = 0;
		for (const line of hints) if (line.frame.Visible) widest = math.max(widest, line.key.AbsoluteSize.X);
		const scale = uiScale();
		const offset = math.round(math.max(widest, KEY_H * scale) + KEY_GAP * scale);
		if (offset === hintOffset) return;
		hintOffset = offset;
		for (const line of hints) {
			line.text.Position = new UDim2(0, offset, 0, 0);
			line.text.Size = new UDim2(1, -offset, 1, 0);
		}
	};
	const makeHint = (i: number): HintLine => {
		const line = block(`Hint${i}`, HINT_H);
		const key = Keycap(line, "Key", "", { x: 0, cy: HINT_H / 2, h: KEY_H, textSize: TEXT.xs, zIndex: z + 1 });
		const text = makeLabel(
			line,
			"Does",
			"",
			KEY_H + KEY_GAP,
			0,
			innerW - KEY_H - KEY_GAP,
			HINT_H,
			TEXT.sm,
			THEME.mutedForeground,
			{
				align: "left",
				zIndex: z + 1,
			},
		);
		key.GetPropertyChangedSignal("AbsoluteSize").Connect(alignHints);
		hintOffset = -1;
		return { frame: line, key, text };
	};

	for (let i = 0; i < BUILT_STATS; i++) stats.push(makeStat(i));
	for (let i = 0; i < BUILT_HINTS; i++) hints.push(makeHint(i));

	let shown = "";
	const handle: ItemCardHandle = {
		frame,
		height: PAD * 2 + ICON,
		set: (m: ItemCardModel): void => {
			const sig = modelSig(m);
			if (sig === shown) return;
			shown = sig;
			while (stats.size() < m.stats.size()) stats.push(makeStat(stats.size()));
			while (hints.size() < m.hints.size()) hints.push(makeHint(hints.size()));

			// header
			drawItemIcon(icon, m.kind, m.id);
			title.Text = m.name;
			typeLabel.Text = m.type;
			tag.Text = m.tag;
			tag.TextColor3 = m.tagColor;
			tag.Visible = m.tag !== "";
			const titleW = innerW - textX - (m.tag !== "" ? TAG_W + space(2) : 0);
			title.Size = UDim2.fromScale(titleW / innerW, NAME_H / ICON);

			// the card takes the height of what it shows now; every block is placed in that height
			const h = cardHeight(m, innerW);
			handle.height = h;
			frame.Size = UDim2.fromScale(w / pdw, h / pdh);
			setDesign(frame, w, h);
			const put = (g: GuiObject, top: number, bh: number): void => {
				g.Position = UDim2.fromScale(PAD / w, top / h);
				g.Size = UDim2.fromScale(innerW / w, bh / h);
			};
			let y = PAD;
			put(header, y, ICON);
			y += ICON;
			let ruleIndex = 0;
			const section = (): void => {
				y += RULE_GAP;
				const rule = rules[ruleIndex];
				ruleIndex += 1;
				rule.Visible = true;
				rule.Position = UDim2.fromScale(PAD / w, y / h);
				y += RULE_GAP;
			};

			if (m.stats.size() > 0) section();
			for (let i = 0; i < stats.size(); i++) {
				const line = stats[i];
				const st = m.stats[i];
				line.frame.Visible = st !== undefined;
				if (st === undefined) continue;
				put(line.frame, y, STAT_H);
				y += STAT_H + (i < m.stats.size() - 1 ? STAT_GAP : 0);
				line.label.Text = st.label;
				line.value.Text = st.value;
				line.value.TextColor3 = toneColor(st.tone);
				// a word (a slot, a dish) in the body font; numbers in the tabular one
				line.value.FontFace = st.tone === "text" ? BOLD : NUMERIC;
			}

			const notesH = notesHeight(m.notes, innerW);
			notes.Visible = notesH > 0;
			if (notesH > 0) {
				section();
				put(notes, y, notesH);
				notes.Text = m.notes;
				y += notesH;
			}

			if (m.hints.size() > 0) section();
			for (let i = 0; i < hints.size(); i++) {
				const line = hints[i];
				const hint = m.hints[i];
				line.frame.Visible = hint !== undefined;
				if (hint === undefined) continue;
				put(line.frame, y, HINT_H);
				y += HINT_H + (i < m.hints.size() - 1 ? HINT_GAP : 0);
				setValueKey(line.key, hint.key);
				line.text.Text = hint.text;
			}
			for (let i = ruleIndex; i < rules.size(); i++) rules[i].Visible = false;
			hintOffset = -1;
			alignHints();
		},
	};
	return handle;
}
