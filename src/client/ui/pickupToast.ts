/*
 * What was just picked up (docs/DESIGN_RULES.md ITM-07): "+12 Shotgun ammo" with the item's pixel icon, in a chip
 * over the "E: …" prompt -- where the eye already is when E is pressed, and where a walked-up supply is announced
 * without a prompt at all -- and a flash on the Bag button (client/ui/hudConsole.ts on desktop, the touch layer's
 * Bag in client/ui/hud.ts), the place it went.
 *
 * Fed by client/systems/pickups.ts, which only hears pickups the server made for THIS survivor (or, offline, the
 * client's own): never an item another survivor took, a craft's bonus or a prediction undone. The same item again
 * while its chip is up adds to it ("+3 Wood" becomes "+9 Wood"), so a pile walked up is one line, not twelve.
 *
 * Built once with the HUD, CHIP_ROWS chips and their icon views (the Bag's drawer, UI-11: the atlas's one
 * ImageLabel, or the Frames it reserves up front); `update` rewrites them in place and creates nothing (UI-09,
 * npm run test:hud). Theme tokens only: the console's graphite plate, the numbers' yellow and the light text (UI-01,
 * UI-05); no text contour (UI-04); nothing moves, so Reduce Motion has nothing to take away.
 */
import { langGet } from "shared/data/lang";
import { IconView, clearIcon, drawItemIcon, maxItemFrames } from "./itemIcon";
import { nameOf } from "./itemInfo";
import { STAT, SURFACE, TEXT, THEME, space } from "./theme";
import { Card, DESIGN_H, DESIGN_W, addAspect, badgeWidth, makeLabel, setDesign, setVisible } from "./widgets";

/** the column's design size: as wide as the prompt, the prompt's own height at the bottom kept free */
export const TOAST_W = 440;
export const CHIP_H = 32;
const CHIP_GAP = 6;
export const CHIP_ROWS = 3;
/** the prompt under the column (hud.ts buildHint: 46) and the gap over it */
const HINT_ROOM = 46 + 8;
export const TOAST_H = HINT_ROOM + CHIP_ROWS * CHIP_H + (CHIP_ROWS - 1) * CHIP_GAP;
/** how long a chip stays up after its last pickup (s) */
export const CHIP_TIME = 1.8;
/** the Bag's flash: how long it takes to fade (s) and how bright it starts (0..1 of the light over the plate) */
export const BAG_FLASH_TIME = 0.45;
const ICON = 22;
const PAD = space(2);

/**
 * The light over the Bag button for a flash of `glow` (0..1): at most 35 % of the light text over the plate, in
 * steps of 0.05 so a fading flash writes the property a handful of times, not every frame. 1 = none.
 */
export function pickupFlashTransparency(glow: number): number {
	if (glow <= 0) return 1;
	return 1 - math.floor(glow * 0.35 * 20 + 0.5) / 20;
}

/** one pickup to show: the item and how many came in */
export interface PickupLine {
	kind: number;
	itemId: number;
	count: number;
}

interface Chip {
	card: Frame;
	icon: IconView;
	amount: TextLabel;
	label: TextLabel;
	kind: number;
	itemId: number;
	count: number;
	/** seconds left on screen (0: hidden) */
	left: number;
	/** what the chip shows now (a rewrite only when one of them changes) */
	shownKind: number;
	shownId: number;
	shownCount: number;
	shownName: string;
}

export class PickupToast {
	readonly frame: Frame;
	private readonly chips = new Array<Chip>();
	private readonly tr: (key: string) => string;
	/** seconds of the Bag's flash left */
	private flash = 0;
	private last = -1;

	constructor(root: Frame, tr: (key: string) => string, k: number) {
		this.tr = tr;
		const f = new Instance("Frame");
		f.Name = "PickupToast";
		f.AnchorPoint = new Vector2(0.5, 1);
		f.BackgroundTransparency = 1;
		f.BorderSizePixel = 0;
		f.Active = false;
		// with the prompt: over the vignette, under the touch layer (8) and never over the console
		f.ZIndex = 3;
		f.Size = UDim2.fromScale((TOAST_W * k) / DESIGN_W, (TOAST_H * k) / DESIGN_H);
		f.SetAttribute("TextScale", k);
		setDesign(f, TOAST_W, TOAST_H);
		addAspect(f, TOAST_W / TOAST_H);
		f.Parent = root;
		this.frame = f;
		const reserve = maxItemFrames();
		for (let i = 0; i < CHIP_ROWS; i++) {
			// row 0 is the newest, the lowest, right over the prompt
			const y = TOAST_H - HINT_ROOM - CHIP_H - i * (CHIP_H + CHIP_GAP);
			const card = Card(f, `Chip${i}`, { x: 0, y, w: TOAST_W, h: CHIP_H, fill: SURFACE.window });
			const icon = IconView(card, "Icon", PAD, (CHIP_H - ICON) / 2, ICON, card.ZIndex + 1, reserve, "drawn");
			const amount = makeLabel(card, "Amount", "", 0, 0, 60, CHIP_H, TEXT.base, STAT.value, {
				font: "label",
				align: "left",
				zIndex: card.ZIndex + 1,
			});
			const label = makeLabel(card, "Name", "", 0, 0, 200, CHIP_H, TEXT.base, THEME.foreground, {
				font: "label",
				align: "left",
				zIndex: card.ZIndex + 1,
			});
			setVisible(card, false);
			this.chips.push({
				card,
				icon,
				amount,
				label,
				kind: -1,
				itemId: -1,
				count: 0,
				left: 0,
				shownKind: -1,
				shownId: -1,
				shownCount: -1,
				shownName: "",
			});
		}
	}

	/** where the column sits: the prompt's own place (hud.ts placeConsole), its bottom at the prompt's bottom */
	place(position: UDim2): void {
		if (this.frame.Position !== position) this.frame.Position = position;
	}

	/** a pickup: onto the chip of the same item if it is still up, else a new chip at the bottom */
	add(line: PickupLine): void {
		this.flash = BAG_FLASH_TIME;
		const chips = this.chips;
		for (const c of chips) {
			if (c.left > 0 && c.kind === line.kind && c.itemId === line.itemId) {
				c.count += line.count;
				c.left = CHIP_TIME;
				return;
			}
		}
		// the others move up one row: their contents do, the Instances stay where they are
		for (let i = chips.size() - 1; i > 0; i--) {
			const to = chips[i];
			const from = chips[i - 1];
			to.kind = from.kind;
			to.itemId = from.itemId;
			to.count = from.count;
			to.left = from.left;
		}
		const c = chips[0];
		c.kind = line.kind;
		c.itemId = line.itemId;
		c.count = line.count;
		c.left = CHIP_TIME;
	}

	/** how bright the Bag's flash is now, 0..1 (hud.ts hands it to the Bag button of the device) */
	bagFlash(): number {
		return this.flash <= 0 ? 0 : this.flash / BAG_FLASH_TIME;
	}

	/** every frame: the chips' time runs out, and what changed is written (nothing is created) */
	update(now: number): void {
		const dt = this.last < 0 ? 0 : math.clamp(now - this.last, 0, 0.25);
		this.last = now;
		this.flash = math.max(0, this.flash - dt);
		for (const c of this.chips) {
			c.left = math.max(0, c.left - dt);
			const up = c.left > 0 && c.kind >= 0;
			setVisible(c.card, up);
			if (!up) continue;
			const name = this.tr(nameOf(c.kind, c.itemId));
			if (c.shownKind === c.kind && c.shownId === c.itemId && c.shownCount === c.count && c.shownName === name) {
				continue;
			}
			c.shownKind = c.kind;
			c.shownId = c.itemId;
			c.shownCount = c.count;
			c.shownName = name;
			this.write(c, name);
		}
	}

	/** the chip's text, icon and width: "+N" in the numbers' yellow, the name in the light text, centred */
	private write(c: Chip, name: string): void {
		const amount = `+${c.count}`;
		drawItemIcon(c.icon, c.kind, c.itemId);
		const aw = badgeWidth(amount, TEXT.base, 0) - space(2) * 2 + space(1);
		const nw = badgeWidth(name, TEXT.base, 0) - space(2) * 2;
		const w = math.clamp(PAD + ICON + space(2) + aw + space(1) + nw + PAD * 2, 120, TOAST_W);
		const x0 = (TOAST_W - w) / 2;
		const card = c.card;
		const pos = card.Position;
		card.Position = UDim2.fromScale(x0 / TOAST_W, pos.Y.Scale);
		card.Size = UDim2.fromScale(w / TOAST_W, card.Size.Y.Scale);
		setDesign(card, w, CHIP_H);
		// the children are placed in the card's own design units: icon, amount, name from the left
		c.icon.frame.Position = UDim2.fromScale(PAD / w, (CHIP_H - ICON) / 2 / CHIP_H);
		c.icon.frame.Size = UDim2.fromScale(ICON / w, ICON / CHIP_H);
		const ax = PAD + ICON + space(2);
		c.amount.Text = amount;
		c.amount.Position = UDim2.fromScale(ax / w, 0);
		c.amount.Size = UDim2.fromScale(aw / w, 1);
		const nx = ax + aw + space(1);
		c.label.Text = name;
		c.label.Position = UDim2.fromScale(nx / w, 0);
		c.label.Size = UDim2.fromScale(math.max(10, w - nx - PAD) / w, 1);
	}

	/** the HUD is going away: nothing stays drawn (the Instances go with the HUD's root) */
	clear(): void {
		for (const c of this.chips) {
			c.left = 0;
			c.kind = -1;
			c.shownKind = -1;
			clearIcon(c.icon);
			setVisible(c.card, false);
		}
		this.flash = 0;
	}
}

/** "+12 Wood": the words of a line, for a reader that wants them without the chip (tests, the admin log) */
export function pickupText(line: PickupLine, langType: number): string {
	return `+${line.count} ${langGet(nameOf(line.kind, line.itemId), langType)}`;
}
