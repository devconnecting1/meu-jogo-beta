/*
 * The dawn card: the night that was, in numbers, the truth about what is saved -- and, after a long session, one
 * gentle line about a break (docs/DESIGN_RULES.md BEM-04; research docs/research/MOTIVATION_AND_ETHICS.md §4.1 and §4.7).
 *
 *   ┌─────────────────────────────────────────────────────┐
 *   │ ☀ Night survived                                  ╳ │   the state, and the ╳ that says a tap / click sends it away
 *   │ 12 zombies     85 damage taken     7 items found    │   the night's numbers, in the numbers' yellow (UI-08)
 *   │ ▣ Progress saved                                    │   ONLY after the server said a write landed (SAV-01)
 *   │ You've played for over 90 minutes. Dawn is a good…  │   once per session, after BREAK_NUDGE_MIN minutes
 *   └─────────────────────────────────────────────────────┘
 *
 * The rules it keeps:
 *  - NEVER BLOCKING (UI-06): nothing pauses and nothing waits for it. It sits in the banner's own box at the top centre
 *    (hud.ts, the messages' place: never over the survivor, the console or a thumb), takes the pad from nobody (nothing in
 *    it is Selectable, UI-09) and goes by itself after DAWN_SHOW_S. A tap or a click on it sends it away sooner.
 *  - "Progress saved" is said only when the SERVER pushed "saved" on SaveAck after the card opened (client/ui/saveIndicator.ts
 *    reads the same push): a write that landed, never a promise. "Saving..." while one is in flight; the red
 *    "Progress not saved — retrying" if it fails. Nothing at all when no write happened: silence is not a claim.
 *  - No reward to stay, no count to the next night, no "one more night" (BEM-02 / BEM-04): it reports and it goes.
 *  - Nothing moves: it appears and it goes, so Reduce Motion has nothing to take away (like the pickup chips).
 *  - Theme tokens only (UI-01), no text contour (UI-04), every text through lang.ts; built once, on the first dawn of a
 *    mount (a HUD that never sees one pays nothing), and only rewritten afterwards (UI-09: no Instance per frame or per
 *    dawn -- test:hud).
 */
import type { StoreState } from "shared/net/net";
import type { NightReport } from "../systems/nightReport";
import { PixelIcon } from "./pixelIcon";
import { GAME, STAT, TEXT, THEME, TRANSPARENCY, fontOf } from "./theme";
import { Card, fixedTextPx, fmtInt, makeLabel, setDesign, setVisible, uiScale } from "./widgets";

/** the card's box, design units: as wide as it needs and as tall as the banner's box (hud.ts BANNER_H) */
export const DAWN_W = 560;
export const DAWN_H = 110;
/** the card without the break line */
const DAWN_H_SHORT = 90;
/** how long the card stays (s) */
export const DAWN_SHOW_S = 12;
/** it waits for a write in flight ("Saving...") at most until this (s) */
export const DAWN_MAX_S = 24;
/** "Progress saved" stays at least this long once it arrived (s) */
export const DAWN_SAVED_HOLD_S = 3;

const PAD = 14;
const SUN = 18;
const DISK = 14;
const CROSS = 14;
const TITLE_Y = 8;
const TITLE_H = 26;
const STATS_Y = 38;
const STATS_H = 26;
const STORE_Y = 68;
const ROW_H = 18;
const BREAK_Y = 88;

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
	 * Opens the card with the night's numbers. `breakLine`: the session is a long one (nightReport.ts `breakNudgeDue`).
	 * `maxW`: the widest the top centre allows now (hud.ts fitMessages narrows it off the touch corner).
	 */
	show(report: NightReport, breakLine: boolean, maxW: number, now: number): void {
		const p = this.parts ?? this.build();
		const w = math.clamp(maxW, 280, DAWN_W);
		const breakText = breakLine
			? this.tr("You've played for over 90 minutes. Dawn is a good time for a break.")
			: "";
		// the break line takes a second row where it would not fit one -- a card narrowed off the touch corner, a phone's
		// text floor (TEXT.sm drawn bigger than its design size): it wraps instead of shrinking under the floor
		const size = math.max(TEXT.sm, fixedTextPx(TEXT.sm) / uiScale());
		const [chars] = utf8.len(breakText);
		const needed = (typeIs(chars, "number") ? chars : breakText.size()) * size * 0.5;
		this.breakRows = breakLine ? (needed > w - PAD * 2 ? 2 : 1) : 0;
		const h = breakLine ? BREAK_Y + this.breakRows * ROW_H + 4 : DAWN_H_SHORT;
		this.shownAt = now;
		this.savedAt = undefined;
		this.storeState = undefined;
		this.dismissed = false;
		p.title.Text = this.tr("Night survived");
		for (let i = 0; i < STATS.size(); i++) {
			const [field, one, many] = STATS[i];
			const n = report[field];
			p.cells[i].value.Text = fmtInt(n);
			p.cells[i].key.Text = this.tr(n === 1 ? one : many);
		}
		p.breakLine.Text = breakText;
		setVisible(p.breakLine, breakLine);
		this.writeStore();
		this.layout(p, w, h);
		setVisible(p.card, true);
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

	/** every frame of a run: the card's time runs out; writes nothing while it stays */
	update(now: number): void {
		const at = this.shownAt;
		if (at === undefined) return;
		const up = now - at;
		let stay = DAWN_SHOW_S;
		// a write in flight is waited for, up to DAWN_MAX_S: the card was opened to say what is saved
		if (this.storeState === "saving") stay = DAWN_MAX_S;
		if (this.savedAt !== undefined) stay = math.max(stay, this.savedAt - at + DAWN_SAVED_HOLD_S);
		if (up >= math.min(stay, DAWN_MAX_S)) this.hide();
	}

	/** takes the card away (its time ran out, a tap, a banner with news, the HUD unmounting) */
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
		// the whole card is the target that sends it away (a thumb on a phone, a click on a desktop) -- and never a stop
		// of the pad's: Selectable off, so the controller stays the survivor's (UI-09), and nothing registers for B
		const dismiss = new Instance("TextButton");
		dismiss.Name = "Dismiss";
		dismiss.Text = "";
		dismiss.BackgroundTransparency = 1;
		dismiss.BorderSizePixel = 0;
		dismiss.AutoButtonColor = false;
		dismiss.Selectable = false;
		dismiss.Size = UDim2.fromScale(1, 1);
		dismiss.ZIndex = z + 1;
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

	/** places everything in a card `w` x `h` design units, centred in the box (only when the card opens) */
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
		centre(p.cross.frame, w - PAD - CROSS / 2, TITLE_Y + TITLE_H / 2);
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
