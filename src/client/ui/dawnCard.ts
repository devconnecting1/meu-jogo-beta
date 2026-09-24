/*
 * The dawn card: the night that was, in numbers, the truth about what is saved -- and, after a long session, one
 * gentle line about a break (docs/DESIGN_RULES.md BEM-04; research docs/research/MOTIVATION_AND_ETHICS.md §4.1 and §4.7).
 *
 *   ┌─────────────────────────────────────────────────────┐
 *   │ ☀ Night survived                                  ╳ │   the state, and the ╳ -- the card's one button
 *   │ 12 zombies     85 damage taken     7 items found    │   the night's numbers, in the numbers' yellow (UI-08)
 *   │ ▣ Progress saved                                    │   ONLY after the server said a write landed (SAV-01)
 *   │ You've played for over 90 minutes. Dawn is a good…  │   only when the SERVER gave the line (protocol note 23)
 *   └─────────────────────────────────────────────────────┘
 *
 * The rules it keeps:
 *  - NEVER BLOCKING (UI-06): nothing pauses and nothing waits for it. It sits in the banner's own box at the top centre
 *    (hud.ts, the messages' place: never over the survivor, the console or a thumb), and never gets bigger than that
 *    box (DAWN_H: the feed under it stays clear, on a phone too). It takes no input but the ╳'s: the card and its texts
 *    are not Active, so a click or a touch that starts on them is the game's (a shot, the floating stick, the aim) --
 *    only the ╳ (a MIN_TOUCH_PX hit, not Selectable) sends it away sooner. It takes the pad from nobody (UI-09).
 *  - "Progress saved" is said only when the SERVER pushed "saved" on SaveAck after the card opened (client/ui/saveIndicator.ts
 *    reads the same push): a write that landed, or the DataStore already holding the live save -- never a promise. The
 *    server asks for a write at 06:00 and answers it even when nothing changed (server/main.server.ts `sim.onDawn`), so
 *    the card waits for that word, up to DAWN_MAX_S. "Saving..." while a write flies; the red "Progress not saved —
 *    retrying" if it fails. Nothing at all when the server never said: silence is not a claim.
 *  - No reward to stay, no count to the next night, no "one more night" (BEM-02 / BEM-04): it reports and it goes.
 *  - Nothing moves: it appears and it goes, so Reduce Motion has nothing to take away (like the pickup chips).
 *  - Theme tokens only (UI-01), no text contour (UI-04), every text through lang.ts. Its Instances are made on the first
 *    dawn of each HUD mount (a HUD that never sees one pays nothing for them); every later dawn, notice and frame of that
 *    mount only rewrites them (test:hud).
 */
import { MIN_TOUCH_PX } from "shared/engine/input";
import type { StoreState } from "shared/net/net";
import type { NightReport } from "../systems/nightReport";
import { PixelIcon } from "./pixelIcon";
import { GAME, STAT, TEXT, THEME, TRANSPARENCY, fontOf } from "./theme";
import { Card, fixedTextPx, fmtInt, makeLabel, setDesign, setVisible } from "./widgets";

/** the card's box, design units: the banner's box (hud.ts BANNER_H), which the card never outgrows */
export const DAWN_W = 560;
export const DAWN_H = 110;
/** how long the card stays once the server's word on the dawn's save is in (s) */
export const DAWN_SHOW_S = 12;
/** it waits for that word at most until this (s): the dawn's write goes within ~20 s (SAV-01's delay and gap) */
export const DAWN_MAX_S = 24;
/** "Progress saved" stays at least this long once it arrived (s) */
export const DAWN_SAVED_HOLD_S = 3;
/** the one sentence of the break line (lang.ts; test:analytics checks it says BREAK_NUDGE_MIN) */
const BREAK_KEY = "You've played for over 90 minutes. Dawn is a good time for a break.";

const PAD = 14;
const SUN = 18;
const DISK = 14;
const CROSS = 14;
/** the ╳'s hit, design units (and never under MIN_TOUCH_PX screen px) */
const CROSS_HIT = 30;
const TITLE_Y = 6;
const TITLE_H = 24;
const STATS_Y = 31;
const STATS_H = 22;
const STORE_Y = 55;
const ROW_H = 16;
const BREAK_Y = 73;
const BOTTOM = 5;
/** the card without the break line */
const DAWN_H_SHORT = STORE_Y + ROW_H + BOTTOM;
/** an average glyph's advance in a sans text, as a share of its size: whether the break line needs a second row */
const GLYPH_W = 0.55;

const BOLD = fontOf("sans", Enum.FontWeight.Bold);

/** the words and colours of a save state on the card: the indicator's, with the one sentence a report needs */
const STORE_LOOK: Record<StoreState, { key: string; icon: Color3; text: Color3 }> = {
	saving: { key: "Saving...", icon: THEME.mutedForeground, text: THEME.mutedForeground },
	saved: { key: "Progress saved", icon: GAME.success, text: THEME.foreground },
	failing: { key: "Progress not saved — retrying", icon: STAT.penalty, text: STAT.penalty },
	stopped: { key: "Progress not saved", icon: STAT.penalty, text: STAT.penalty },
};

/** the three numbers, in the order the card shows them, with the words after each (singular, plural) */
const STATS: ReadonlyArray<[keyof NightReport, string, string]> = [
	["zombies", "zombie", "zombies"],
	["damage", "damage taken", "damage taken"],
	["items", "item found", "items found"],
];

interface StatCell {
	value: TextLabel;
	key: TextLabel;
}

/** the card's Instances, made on its first show and only rewritten afterwards */
interface Parts {
	card: Frame;
	sun: PixelIcon;
	title: TextLabel;
	cross: PixelIcon;
	cells: Array<StatCell>;
	disk: PixelIcon;
	store: TextLabel;
	breakLine: TextLabel;
	/** the ╳'s hit: the card's ONLY input (M1 of the review of ca9494a) */
	dismiss: TextButton;
}

export class DawnCard {
	readonly box: Frame;
	private readonly tr: (key: string) => string;
	/** built on the first dawn (like the save indicator on its first notice): a HUD mount costs nothing for it */
	private parts: Parts | undefined;
	/** os.clock() the card opened (undefined: not up) */
	private shownAt: number | undefined;
	/** os.clock() "saved" arrived while it was up */
	private savedAt: number | undefined;
	private storeState: StoreState | undefined;
	private dismissed = false;
	private w = DAWN_W;
	private h = DAWN_H;
	/** screen px per design unit of the box (hud.ts: the HUD's scale), for the break line's rows */
	private px = 1;
	/** rows the break line takes (0: none) */
	private breakRows = 0;

	/** `box`: the HUD's anchored DAWN_W x DAWN_H box at the top centre (hud.ts buildMessages) */
	constructor(box: Frame, tr: (key: string) => string) {
		this.box = box;
		this.tr = tr;
	}

	/** is the card up (hud.ts: a Good morning banner is not drawn over it) */
	isShown(): boolean {
		return this.shownAt !== undefined;
	}

	/**
	 * Opens the card with the night's numbers, without the break line (that is the server's: `addBreakLine`). `maxW`:
	 * the widest the top centre allows now (hud.ts fitMessages narrows it off the touch corner); `px`: screen px per
	 * design unit of the box.
	 */
	show(report: NightReport, maxW: number, px: number, now: number): void {
		const p = this.parts ?? this.build();
		this.shownAt = now;
		this.savedAt = undefined;
		this.storeState = undefined;
		this.dismissed = false;
		this.px = math.max(px, 0.01);
		this.breakRows = 0;
		p.title.Text = this.tr("Night survived");
		for (let i = 0; i < STATS.size(); i++) {
			const [field, one, many] = STATS[i];
			const n = report[field];
			p.cells[i].value.Text = fmtInt(n);
			p.cells[i].key.Text = this.tr(n === 1 ? one : many);
		}
		p.breakLine.Text = "";
		setVisible(p.breakLine, false);
		this.writeStore();
		this.layout(p, math.clamp(maxW, 280, DAWN_W), DAWN_H_SHORT);
		setVisible(p.card, true);
	}

	/**
	 * BEM-04: the server gave this survivor the break line (protocol note 23): it goes on the card if the card is up.
	 * False when it is not (client/main.client.ts then puts the line on the feed). The card grows for it, never past
	 * DAWN_H: one row, or two where one would not fit (a card narrowed off the touch corner, a phone's text floor).
	 */
	addBreakLine(): boolean {
		const p = this.parts;
		if (p === undefined || this.shownAt === undefined) return false;
		const text = this.breakText();
		const [chars] = utf8.len(text);
		const needed = (typeIs(chars, "number") ? chars : text.size()) * fixedTextPx(TEXT.sm) * GLYPH_W;
		const room = (this.w - PAD * 2) * this.px;
		this.breakRows = needed > room ? 2 : 1;
		p.breakLine.Text = text;
		setVisible(p.breakLine, true);
		this.layout(p, this.w, math.min(DAWN_H, BREAK_Y + this.breakRows * ROW_H + BOTTOM));
		return true;
	}

	/** the break line's sentence, in the player's language (hud.ts: the feed's copy of it when no card is up) */
	breakText(): string {
		return this.tr(BREAK_KEY);
	}

	/**
	 * What the server said about a write of this player's save (saveClient.ts `onStoreState`). Only what arrives while
	 * the card is up counts: a "saved" from before dawn is not this night's.
	 */
	storeNotice(state: StoreState, now: number): void {
		if (this.shownAt === undefined) return;
		this.storeState = state;
		if (state === "saved") this.savedAt = now;
		this.writeStore();
	}

	/**
	 * Every frame of a run: the card's time runs out; writes nothing while it stays. It waits for the server's word on
	 * the dawn's save (nothing yet, or "Saving..."), at most DAWN_MAX_S; once the word is in, DAWN_SHOW_S from the
	 * opening, and "Progress saved" DAWN_SAVED_HOLD_S at least.
	 */
	update(now: number): void {
		const at = this.shownAt;
		if (at === undefined) return;
		const s = this.storeState;
		let stay = s === undefined || s === "saving" ? DAWN_MAX_S : DAWN_SHOW_S;
		if (this.savedAt !== undefined) stay = math.max(DAWN_SHOW_S, this.savedAt - at + DAWN_SAVED_HOLD_S);
		if (now - at >= math.min(stay, DAWN_MAX_S)) this.hide();
	}

	/** takes the card away (its time ran out, the ╳, a banner with news, the HUD unmounting) */
	hide(): void {
		this.shownAt = undefined;
		this.savedAt = undefined;
		this.storeState = undefined;
		if (this.parts !== undefined) setVisible(this.parts.card, false);
	}

	/** did the player send the last card away themselves (tests) */
	wasDismissed(): boolean {
		return this.dismissed;
	}

	/** the card's Instances, once */
	private build(): Parts {
		const card = Card(this.box, "DawnCard", {
			x: 0,
			y: 0,
			w: DAWN_W,
			h: DAWN_H,
			variant: "popover",
			transparency: TRANSPARENCY.hud,
			zIndex: 3,
		});
		// click-through: a click or a touch that starts on the card is the game's (UI-06), only the ╳ takes one
		card.Active = false;
		const z = card.ZIndex + 1;
		const sun = PixelIcon(card, "Sun", "sun", PAD + SUN / 2, TITLE_Y + TITLE_H / 2, SUN, GAME.sun, z);
		const title = makeLabel(card, "Title", "", 0, 0, 10, 10, TEXT.lg, THEME.foreground, {
			font: BOLD,
			align: "left",
			zIndex: z,
		});
		// the ╳ is drawn, not written: a thin pixel cross, the affordance of "this goes away" without a word to translate
		const cross = PixelIcon(
			card,
			"Cross",
			"close",
			DAWN_W - PAD - CROSS / 2,
			TITLE_Y + TITLE_H / 2,
			CROSS,
			THEME.mutedForeground,
			z,
		);
		const cells = new Array<StatCell>();
		for (let i = 0; i < STATS.size(); i++) {
			const value = makeLabel(card, `Value${i + 1}`, "", 0, 0, 10, 10, TEXT.lg, STAT.value, {
				font: "numeric",
				align: "left",
				zIndex: z,
			});
			const key = makeLabel(card, `Key${i + 1}`, "", 0, 0, 10, 10, TEXT.sm, THEME.mutedForeground, {
				align: "left",
				zIndex: z,
			});
			cells.push({ value, key });
		}
		const disk = PixelIcon(card, "Disk", "save", PAD + DISK / 2, STORE_Y + ROW_H / 2, DISK, GAME.success, z);
		const store = makeLabel(card, "Store", "", 0, 0, 10, 10, TEXT.sm, THEME.foreground, {
			align: "left",
			zIndex: z,
		});
		const breakLine = makeLabel(card, "Break", "", 0, 0, 10, 10, TEXT.sm, THEME.mutedForeground, {
			align: "left",
			zIndex: z,
		});
		// the ╳'s hit, the card's one button: a thumb's size on a phone (MIN_TOUCH_PX, like the scoreboard's), a click's
		// on a desktop -- and never a stop of the pad's: Selectable off, so the controller stays the survivor's (UI-09)
		const dismiss = new Instance("TextButton");
		dismiss.Name = "Dismiss";
		dismiss.Text = "";
		dismiss.BackgroundTransparency = 1;
		dismiss.BackgroundColor3 = THEME.background;
		dismiss.TextColor3 = THEME.foreground;
		dismiss.BorderSizePixel = 0;
		dismiss.AutoButtonColor = false;
		dismiss.Selectable = false;
		dismiss.AnchorPoint = new Vector2(0.5, 0.5);
		dismiss.ZIndex = z + 1;
		const min = new Instance("UISizeConstraint");
		min.MinSize = new Vector2(MIN_TOUCH_PX, MIN_TOUCH_PX);
		min.Parent = dismiss;
		dismiss.Activated.Connect(() => {
			this.dismissed = true;
			this.hide();
		});
		dismiss.Parent = card;
		const parts: Parts = { card, sun, title, cross, cells, disk, store, breakLine, dismiss };
		this.parts = parts;
		setVisible(card, false);
		return parts;
	}

	/** the save line: hidden until the server has said something about a write */
	private writeStore(): void {
		const p = this.parts;
		if (p === undefined) return;
		const s = this.storeState;
		const shown = s !== undefined;
		setVisible(p.store, shown);
		setVisible(p.disk.frame, shown);
		if (s === undefined) return;
		const look = STORE_LOOK[s];
		const text = this.tr(look.key);
		if (p.store.Text !== text) p.store.Text = text;
		if (p.store.TextColor3 !== look.text) p.store.TextColor3 = look.text;
		p.disk.setColor(look.icon);
	}

	/** places everything in a card `w` x `h` design units, centred in the box (when it opens, and for the break line) */
	private layout(p: Parts, w: number, h: number): void {
		this.w = w;
		this.h = h;
		const card = p.card;
		card.Position = UDim2.fromScale((DAWN_W - w) / 2 / DAWN_W, 0);
		card.Size = UDim2.fromScale(w / DAWN_W, h / DAWN_H);
		setDesign(card, w, h);
		const at = (g: GuiObject, x: number, y: number, gw: number, gh: number): void => {
			g.Position = UDim2.fromScale(x / w, y / h);
			g.Size = UDim2.fromScale(math.max(1, gw) / w, gh / h);
		};
		const centre = (g: GuiObject, cx: number, cy: number): void => {
			g.Position = UDim2.fromScale(cx / w, cy / h);
		};
		centre(p.sun.frame, PAD + SUN / 2, TITLE_Y + TITLE_H / 2);
		const tx = PAD + SUN + 8;
		at(p.title, tx, TITLE_Y, w - tx - PAD - CROSS - 8, TITLE_H);
		const crossX = w - PAD - CROSS / 2;
		const crossY = TITLE_Y + TITLE_H / 2;
		centre(p.cross.frame, crossX, crossY);
		centre(p.dismiss, crossX, crossY);
		p.dismiss.Size = UDim2.fromScale(CROSS_HIT / w, CROSS_HIT / h);
		// three cells across the card: each the number, then its words, as wide as the number needs
		const cellW = (w - PAD * 2) / STATS.size();
		for (let i = 0; i < p.cells.size(); i++) {
			const c = p.cells[i];
			const x0 = PAD + i * cellW;
			const vw = math.min(cellW * 0.45, math.max(12, c.value.Text.size() * TEXT.lg * 0.62 + 2));
			at(c.value, x0, STATS_Y, vw, STATS_H);
			at(c.key, x0 + vw + 6, STATS_Y, cellW - vw - 12, STATS_H);
		}
		centre(p.disk.frame, PAD + DISK / 2, STORE_Y + ROW_H / 2);
		at(p.store, PAD + DISK + 6, STORE_Y, w - PAD * 2 - DISK - 6, ROW_H);
		at(p.breakLine, PAD, BREAK_Y, w - PAD * 2, ROW_H * math.max(1, this.breakRows));
	}

	/** the card's size now, design units (tests) */
	size(): [number, number] {
		return [this.w, this.h];
	}

	/** the card's Instances, once it was first shown (tests) */
	instances(): Parts | undefined {
		return this.parts;
	}
}
