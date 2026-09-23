import { GameContext } from "shared/game/context";
import { langGet } from "shared/data/lang";
import { MIN_TOUCH_PX, TouchButton, TouchLayout } from "shared/engine/input";
import { getTouchLayout, onTouchLayoutChanged, refreshTouchLayout } from "../bootstrap";
import { CONSOLE_MARGIN, HudConsole, HudDay, HudState } from "./hudConsole";
import { GAME, RADIUS, SURFACE, TEXT, THEME, TRANSPARENCY, space } from "./theme";
import {
	Badge,
	Button,
	Card,
	DESIGN_H,
	DESIGN_W,
	addAspect,
	addStroke,
	badgeWidth,
	fadeSurface,
	fadeText,
	gamepadActive,
	makeAnchored,
	makeFrame,
	makeLabel,
	setBadge,
	setButtonEnabled,
	setDesign,
	setSurfaceTransparency,
	tween,
	uiScale,
} from "./widgets";

/*
 * The in-run HUD (docs/DESIGN_RULES.md UI-09). The vitals, the weapons and the Bag / Menu buttons live in ONE
 * framed console at the bottom centre and the day in a plate at the top centre -- both in client/ui/hudConsole.ts,
 * in the vocabulary of the owner's Settings window (UI-07). This file keeps what floats over the world: the damage
 * vignette, the interaction prompt, the banners and the message feed, and the touch layer.
 */
export type { HudState } from "./hudConsole";

type MessageKind = "wave" | "morning" | "night" | "boss" | "level" | "warn" | "normal";

function classify(msg: string): MessageKind {
	if (msg.match("^Wave %d")[0] !== undefined) return "wave";
	if (msg === "Good morning") return "morning";
	if (msg === "Night is coming") return "night";
	if (msg === "You killed it") return "boss";
	if (msg === "Level UP") return "level";
	if (msg === "No ammo") return "warn";
	return "normal";
}

const UserInputService = game.GetService("UserInputService");

const FEED_MAX = 4;
const FEED_TIME = 3.5;
const FEED_W = 560;
const FEED_H = 176;
const FEED_LINE_H = 34;
const FEED_LINE_MIN_W = 200;

const CENTER = UDim2.fromScale(0.5, 0.5);

const BANNER_W = 720;
const BANNER_H = 110;
const BANNER_MIN_W = 280;

/** between the interaction prompt and the top of the console (design units of the console) */
const HINT_GAP = 8;

/*
 * ---------------------------------------------------------------- touch layer (pixel space)
 *
 * Everything the thumbs touch is drawn in SCREEN PIXELS, not in the 1120x630 design space the rest of the HUD
 * uses: a touch target is a physical size (a thumb is ~9 mm wide), so it must not shrink with the letterbox.
 * The geometry itself comes from shared/engine/input.ts — the exact same numbers bootstrap.ts hit-tests with,
 * so what is drawn and what responds can never disagree.
 */

/** the touch layer's own design space is the viewport, so widget helpers place things at exact pixels */
function pixelSpace(f: Frame, layout: TouchLayout): void {
	setDesign(f, math.max(layout.viewW, 1), math.max(layout.viewH, 1));
}

/** a design size that renders at `px` screen pixels (scaleText multiplies by the current UI scale) */
function asPixels(px: number): number {
	return px / math.max(uiScale(), 0.05);
}

/** a rectangle centred on (cx, cy) pixels, optionally rotated — the building block of the icons */
function pxRect(
	parent: Frame,
	name: string,
	cx: number,
	cy: number,
	w: number,
	h: number,
	color: Color3,
	zIndex: number,
	rotation = 0,
	radius = 0,
): Frame {
	// place() puts the frame's top-left at (cx, cy); the centre anchor turns that into "centred on (cx, cy)"
	const f = makeFrame(parent, name, cx, cy, w, h, color, { zIndex, radius });
	f.AnchorPoint = new Vector2(0.5, 0.5);
	if (rotation !== 0) f.Rotation = rotation;
	return f;
}

/** a circle of radius `r` centred on (cx, cy) pixels */
function pxCircle(
	parent: Frame,
	name: string,
	cx: number,
	cy: number,
	r: number,
	color: Color3,
	zIndex: number,
	transparency: number,
): Frame {
	const f = makeFrame(parent, name, cx, cy, r * 2, r * 2, color, {
		zIndex,
		transparency,
		radius: RADIUS.full,
	});
	f.AnchorPoint = new Vector2(0.5, 0.5);
	return f;
}

type TouchIcon = "use" | "reload" | "bag" | "menu";

/**
 * Icons drawn from plain Frames (no image assets): every colour is an exact theme token, so UI-01 holds and
 * they stay crisp at any scale. `s` is the icon's box in the host's own units (pixels on the touch layer).
 */
function drawIcon(host: Frame, kind: TouchIcon, s: number, color: Color3, zIndex: number): void {
	const c = s / 2;
	const bar = s * 0.13;
	if (kind === "menu") {
		// three bars, the menu everybody knows -- NOT the two upright bars of "pause": no menu pauses the
		// world (DESIGN_RULES UI-06), so the button that opens one must not promise it
		const w = s * 0.56;
		const h = s * 0.1;
		pxRect(host, "Bar1", c, c - s * 0.18, w, h, color, zIndex, 0, RADIUS.sm);
		pxRect(host, "Bar2", c, c, w, h, color, zIndex, 0, RADIUS.sm);
		pxRect(host, "Bar3", c, c + s * 0.18, w, h, color, zIndex, 0, RADIUS.sm);
		return;
	}
	if (kind === "bag") {
		// a satchel: body + the two straps of its handle
		pxRect(host, "Body", c, c + s * 0.1, s * 0.62, s * 0.46, color, zIndex, 0, RADIUS.sm);
		pxRect(host, "HandleL", c - s * 0.16, c - s * 0.2, bar * 0.8, s * 0.22, color, zIndex, 20, RADIUS.sm);
		pxRect(host, "HandleR", c + s * 0.16, c - s * 0.2, bar * 0.8, s * 0.22, color, zIndex, -20, RADIUS.sm);
		return;
	}
	if (kind === "reload") {
		// a magazine sliding up into the chevron above it
		pxRect(host, "Mag", c, c + s * 0.2, s * 0.3, s * 0.34, color, zIndex, 0, RADIUS.sm);
		pxRect(host, "ChevL", c - s * 0.12, c - s * 0.16, bar * 0.9, s * 0.34, color, zIndex, 42, RADIUS.sm);
		pxRect(host, "ChevR", c + s * 0.12, c - s * 0.16, bar * 0.9, s * 0.34, color, zIndex, -42, RADIUS.sm);
		return;
	}
	// "use": a hand tapping — a ring with a filled dot in it
	const ring = pxCircle(host, "Ring", c, c, s * 0.34, color, zIndex, 1);
	addStroke(ring, color, 0, 2);
	pxCircle(host, "Dot", c, c, s * 0.14, color, zIndex + 1, 0);
}

export class Hud {
	onPause: (() => void) | undefined;
	onBackpack: (() => void) | undefined;
	/** tapping the on-screen action button (mobile) */
	onAction: (() => void) | undefined;

	private ctx: GameContext;
	private root: Frame | undefined;
	/** bottom centre: vitals, the weapon hotbar, Bag / Menu, the weapon in hand (hudConsole.ts) */
	private console: HudConsole | undefined;
	/** top centre: the world's day, the phase, the watch's clock and this life's day (MP-13) */
	private day: HudDay | undefined;
	/** the "UI size" setting at mount (80%..120%) */
	private uiK = 1;
	private vignette: Array<Frame> = [];
	private vignetteT = 1;
	private flash = 0;
	private feed: Frame | undefined;
	private bannerCard: Frame | undefined;
	private banner: TextLabel | undefined;
	private bannerSub: TextLabel | undefined;
	private bannerScale: UIScale | undefined;
	private bannerGen = 0;
	private feedOrder = 0;
	private joyBase: Frame | undefined;
	private joyKnob: Frame | undefined;
	private joyActive: boolean | undefined;
	private fireBtn: Frame | undefined;
	private fireHeld: boolean | undefined;
	private actionBtn: TextButton | undefined;
	private hintBox: Frame | undefined;
	private hintKey: Frame | undefined;
	private hintLabel: TextLabel | undefined;
	private mounted = false;
	private last = new Map<string, string>();
	// ---- touch layer (pixel space; see the helpers above)
	private touchLayer: Frame | undefined;
	private touchOff: (() => void) | undefined;
	private touch = false;
	private aimPad: Frame | undefined;
	private aimKnob: Frame | undefined;
	private aimArrow: Frame | undefined;
	private aimCursor: Frame | undefined;
	private joyDead: Frame | undefined;
	private useLabel: TextLabel | undefined;
	private reloadBtn: TextButton | undefined;
	private hintGamepad: boolean | undefined;

	constructor(ctx: GameContext) {
		this.ctx = ctx;
	}

	private tr(key: string): string {
		return langGet(key, this.ctx.save.settings.langType);
	}

	/** sets a label's text only when it changed (the HUD updates every frame) */
	private setText(label: TextLabel | undefined, key: string, text: string): void {
		if (label === undefined || this.last.get(key) === text) return;
		this.last.set(key, text);
		label.Text = text;
	}

	mount(): void {
		if (this.mounted) return;
		this.mounted = true;
		this.last.clear();
		const ctx = this.ctx;
		const mobile = UserInputService.TouchEnabled;
		this.touch = mobile;
		// "UI size" setting (0..1, default 0.5): 80% .. 120% of the HUD controls
		const k = 0.8 + 0.4 * math.clamp(ctx.save.settings.uiSize, 0, 1);
		this.uiK = k;
		const root = new Instance("Frame");
		root.Name = "HudRoot";
		root.Size = UDim2.fromScale(1, 1);
		root.BackgroundTransparency = 1;
		root.BorderSizePixel = 0;
		root.Parent = ctx.hudLayer;
		this.root = root;

		this.buildVignette(root);
		const tr = (key: string): string => this.tr(key);
		this.day = new HudDay(root, tr, k);
		// one console at the bottom centre; on touch the compact one (bars + hotbar: the touch layer has the Bag
		// and Menu buttons), sized and placed between the thumbs by placeConsole()
		this.console = new HudConsole(root, tr, mobile, k, {
			// the field key 1-5 writes (client/bootstrap.ts): combat has ONE way to switch weapons
			onSlot: (slot: number): void => {
				this.ctx.input.weaponSlotPressed = slot;
			},
			onBag: (): void => this.onBackpack?.(),
			onMenu: (): void => this.onPause?.(),
		});
		this.buildHint(root, k);
		this.buildMessages(root, k);
		// the save (and with it the player's control preferences) arrives long after bootstrap ran: recompute
		// the geometry now, so the first run of a session already uses their own sizes and their own side
		refreshTouchLayout();
		this.buildTouch(root);
		this.placeConsole();
		// the controls follow the settings sliders and the viewport (rotation, split screen, top bar), and the
		// console and the prompt follow the controls
		this.touchOff = onTouchLayoutChanged(() => {
			if (!this.mounted || this.root === undefined) return;
			this.buildTouch(this.root);
			this.placeConsole();
		});
	}

	/**
	 * Places what sits at the bottom centre. Desktop: the console is anchored (hudConsole.ts) and the prompt rides
	 * above it in the same design space. Touch: the console goes into the band between the thumbs, measured on the
	 * touch layout (placeTouchConsole), and the prompt rides above THAT. Never per frame: on mount and on a change
	 * of the touch geometry.
	 */
	private placeConsole(): void {
		const deck = this.console;
		const hint = this.hintBox;
		if (deck === undefined) return;
		if (!this.touch) {
			const bottom = CONSOLE_MARGIN + deck.layout.h * this.uiK + HINT_GAP;
			if (hint !== undefined) hint.Position = new UDim2(0.5, 0, 1 - bottom / DESIGN_H, 0);
			return;
		}
		const p = deck.placeTouch(getTouchLayout(), this.uiK);
		if (hint !== undefined) {
			hint.Position = UDim2.fromOffset(math.round(p.x + p.w / 2), math.round(p.y - HINT_GAP * p.scale));
		}
	}

	/**
	 * Touch controls, rebuilt from scratch whenever the geometry changes (settings slider, rotation, top bar).
	 *
	 * Left (or right, when the player is left-handed): the move stick — floating by default, so it opens under
	 * the thumb wherever it lands, with its dead zone drawn as a faint inner ring so the player can SEE why a
	 * tiny wobble does not walk. Right: the aim / fire pad — drag to aim (a chevron shows the heading both on
	 * the pad and out in the world), let go to shoot, keep holding to keep firing with an automatic. Around it,
	 * USE and RELOAD; in the top corner, BAG and MENU. Every one of them is at least MIN_TOUCH_PX wide.
	 */
	private buildTouch(root: Frame): void {
		this.touchLayer?.Destroy();
		this.aimPad = undefined;
		this.aimKnob = undefined;
		this.aimArrow = undefined;
		this.aimCursor = undefined;
		this.joyBase = undefined;
		this.joyKnob = undefined;
		this.joyDead = undefined;
		this.joyActive = undefined;
		this.fireBtn = undefined;
		this.fireHeld = undefined;
		this.actionBtn = undefined;
		this.useLabel = undefined;
		this.reloadBtn = undefined;
		if (!this.touch) return;

		const L = getTouchLayout();
		const layer = new Instance("Frame");
		layer.Name = "Touch";
		layer.Size = UDim2.fromScale(1, 1);
		layer.BackgroundTransparency = 1;
		layer.BackgroundColor3 = THEME.background;
		layer.BorderSizePixel = 0;
		layer.ZIndex = 8;
		pixelSpace(layer, L);
		layer.Parent = root;
		this.touchLayer = layer;

		// ---- move stick
		const joyBase = pxCircle(
			layer,
			"JoyBase",
			L.move.homeX,
			L.move.homeY,
			L.move.baseR,
			THEME.foreground,
			10,
			TRANSPARENCY.touchIdle,
		);
		addStroke(joyBase, THEME.foreground, TRANSPARENCY.touchStroke, 2);
		this.joyBase = joyBase;
		// the dead zone, visible: inside this ring the stick deliberately does nothing
		const dead = pxCircle(joyBase, "Dead", L.move.baseR, L.move.baseR, L.move.dead, SURFACE.line, 11, 1);
		addStroke(dead, THEME.foreground, TRANSPARENCY.touchStroke, 1);
		this.joyDead = dead;
		this.joyKnob = pxCircle(
			joyBase,
			"JoyKnob",
			L.move.baseR,
			L.move.baseR,
			L.move.knobR,
			THEME.foreground,
			12,
			TRANSPARENCY.touchKnob,
		);

		// ---- aim / fire pad
		const pad = pxCircle(layer, "AimPad", L.aim.homeX, L.aim.homeY, L.aim.baseR, THEME.destructive, 10, 1);
		addStroke(pad, THEME.destructive, TRANSPARENCY.touchStroke, 2);
		this.aimPad = pad;
		this.fireBtn = pxCircle(
			pad,
			"Fire",
			L.aim.baseR,
			L.aim.baseR,
			L.aim.baseR * 0.74,
			THEME.destructive,
			11,
			TRANSPARENCY.fireIdle,
		);
		makeLabel(
			this.fireBtn,
			"FireTag",
			"FIRE",
			0,
			0,
			L.aim.baseR * 1.48,
			L.aim.baseR * 1.48,
			asPixels(L.aim.baseR * 0.42),
			THEME.destructiveForeground,
			{ weight: Enum.FontWeight.Bold, zIndex: 12 },
		);
		this.aimKnob = pxCircle(
			pad,
			"AimKnob",
			L.aim.baseR,
			L.aim.baseR,
			L.aim.knobR,
			THEME.foreground,
			13,
			TRANSPARENCY.touchKnob,
		);
		this.aimKnob.Visible = false;
		// heading chevron on the rim of the pad: the drag direction, spelled out
		this.aimArrow = pxRect(pad, "AimArrow", L.aim.baseR, L.aim.baseR, L.aim.baseR * 0.5, 4, THEME.foreground, 14);
		this.aimArrow.Visible = false;

		// the same heading, out in the world next to the survivor (the camera centre)
		const cursor = pxRect(
			layer,
			"AimCursor",
			L.viewW / 2,
			L.viewH / 2,
			math.max(18 * L.scale, 14),
			math.max(4 * L.scale, 3),
			THEME.foreground,
			9,
			0,
			RADIUS.sm,
		);
		cursor.BackgroundTransparency = 0.25;
		this.aimCursor = cursor;

		// ---- contextual buttons
		this.actionBtn = this.touchButton(layer, "UseBtn", L.use, "use", "default", () => this.onAction?.());
		this.actionBtn.Visible = false;
		this.useLabel = this.touchCaption(layer, "UseCap", L.use, this.tr("Use"));
		this.useLabel.Visible = false;
		this.reloadBtn = this.touchButton(layer, "ReloadBtn", L.reload, "reload", "secondary", () => {
			this.ctx.input.reloadPressed = true;
		});
		this.touchCaption(layer, "ReloadCap", L.reload, this.tr("Reload"));
		this.touchButton(layer, "BagBtn", L.bag, "bag", "secondary", () => this.onBackpack?.());
		this.touchButton(layer, "MenuBtn", L.pause, "menu", "secondary", () => this.onPause?.());
	}

	/** one round touch button of the pixel layer: kit relief, a frame-drawn icon and a >= 44 px hit box */
	private touchButton(
		layer: Frame,
		name: string,
		at: TouchButton,
		icon: TouchIcon,
		variant: "default" | "secondary",
		onClick: () => void,
	): TextButton {
		const size = math.max(at.r * 2, MIN_TOUCH_PX);
		const b = Button(layer, name, "", {
			x: at.x - size / 2,
			y: at.y - size / 2,
			w: size,
			h: size,
			size: "icon",
			variant,
			radius: RADIUS.full,
			zIndex: 20,
			onClick,
		});
		const host = makeFrame(b, `${name}Icon`, 0, 0, size, size, THEME.background, {
			transparency: 1,
			zIndex: b.ZIndex + 6,
		});
		drawIcon(host, icon, size, variant === "default" ? THEME.primaryForeground : THEME.secondaryForeground, 1);
		return b;
	}

	/**
	 * The word over a touch button (USE and RELOAD are new to the player; BAG and MENU are not). Above and
	 * not below: below would put the text on the aim pad's rim, which is exactly where the thumb is.
	 */
	private touchCaption(layer: Frame, name: string, at: TouchButton, text: string): TextLabel {
		const w = at.r * 3;
		const h = math.max(14 * getTouchLayout().scale, 12);
		return makeLabel(
			layer,
			name,
			text.upper(),
			at.x - w / 2,
			at.y - at.r - 2 - h,
			w,
			h,
			asPixels(h * 0.8),
			THEME.foreground,
			{
				font: "label",
				zIndex: 21,
			},
		);
	}

	/**
	 * Interaction prompt ("E  Open door"), bottom centre, just above the console: the console's graphite body and
	 * frame (UI-07), the key as the kit's dark-iron key, the text light. Anchored by its bottom edge and placed by
	 * placeConsole() -- not by makeAnchored, whose own layout handler would put it back under a touch console.
	 */
	private buildHint(root: Frame, k: number): void {
		const w = 440;
		const h = 46;
		const hintBox = new Instance("Frame");
		hintBox.Name = "HintBox";
		hintBox.AnchorPoint = new Vector2(0.5, 1);
		hintBox.BackgroundTransparency = 1;
		hintBox.BackgroundColor3 = THEME.background;
		hintBox.BorderSizePixel = 0;
		hintBox.ZIndex = 3;
		hintBox.Size = UDim2.fromScale((w * k) / DESIGN_W, (h * k) / DESIGN_H);
		hintBox.SetAttribute("TextScale", k);
		setDesign(hintBox, w, h);
		addAspect(hintBox, w / h);
		hintBox.Parent = root;
		const hintBg = Card(hintBox, "Bg", { x: 0, y: 0, w, h, fill: SURFACE.window });
		const keySize = 32;
		const keyPad = (h - keySize) / 2;
		this.hintKey = Badge(hintBg, "Key", "E", {
			x: keyPad,
			y: keyPad,
			w: keySize,
			h: keySize,
			variant: "default",
			textSize: TEXT.lg,
			zIndex: 2,
		});
		const textX = keyPad + keySize + space(3);
		this.hintLabel = makeLabel(hintBg, "Text", "", textX, 0, w - textX - space(4), h, TEXT.lg, THEME.foreground, {
			font: "label",
			align: "left",
			zIndex: 2,
		});
		hintBox.Visible = false;
		this.hintBox = hintBox;
	}

	/** banner (waves, morning, night, boss) as a bordered card + the feed of short messages below it */
	private buildMessages(root: Frame, k: number): void {
		// the HUD size setting scales the messages too, as its description promises ("Console, day plate, hints and
		// messages"): the banner under the day plate, the feed under the banner, all at `k`
		const bannerY = 20 + 64 * k;
		const bannerBox = makeAnchored(root, "BannerBox", 0.5, 0, BANNER_W, BANNER_H, 0, bannerY, true, k);
		// the card is resized to the message in showBanner; the texts stay centred over it
		const card = Card(bannerBox, "Card", {
			x: 0,
			y: 0,
			w: BANNER_W,
			h: BANNER_H,
			variant: "popover",
			transparency: TRANSPARENCY.hud,
		});
		setSurfaceTransparency(card, 1);
		this.bannerCard = card;
		const pad = space(6);
		const banner = makeLabel(
			bannerBox,
			"Banner",
			"",
			pad,
			space(3),
			BANNER_W - pad * 2,
			58,
			TEXT.xl5,
			THEME.foreground,
			{
				font: "display",
				zIndex: 2,
			},
		);
		banner.TextTransparency = 1;
		this.banner = banner;
		const sub = makeLabel(
			bannerBox,
			"BannerSub",
			"",
			pad,
			70,
			BANNER_W - pad * 2,
			28,
			TEXT.lg,
			THEME.mutedForeground,
			{
				font: "label",
				zIndex: 2,
			},
		);
		sub.TextTransparency = 1;
		this.bannerSub = sub;
		const scale = new Instance("UIScale");
		scale.Parent = bannerBox;
		this.bannerScale = scale;

		const feed = makeAnchored(root, "Feed", 0.5, 0, FEED_W, FEED_H, 0, bannerY + (BANNER_H + 6) * k, true, k);
		const layout = new Instance("UIListLayout");
		layout.SortOrder = Enum.SortOrder.LayoutOrder;
		layout.HorizontalAlignment = Enum.HorizontalAlignment.Center;
		layout.Padding = new UDim(space(1.5) / FEED_H, 0);
		layout.Parent = feed;
		this.feed = feed;
	}

	private buildVignette(root: Frame): void {
		const edges: Array<[string, UDim2, UDim2, number]> = [
			["Top", UDim2.fromScale(0, 0), UDim2.fromScale(1, 0.3), 90],
			["Bottom", UDim2.fromScale(0, 0.7), UDim2.fromScale(1, 0.3), 270],
			["Left", UDim2.fromScale(0, 0), UDim2.fromScale(0.22, 1), 0],
			["Right", UDim2.fromScale(0.78, 0), UDim2.fromScale(0.22, 1), 180],
		];
		this.vignette = [];
		this.vignetteT = 1;
		for (const [name, pos, size, rotation] of edges) {
			const f = new Instance("Frame");
			f.Name = `Vignette${name}`;
			f.Position = pos;
			f.Size = size;
			f.BackgroundColor3 = GAME.blood;
			f.BackgroundTransparency = 1;
			f.BorderSizePixel = 0;
			f.Active = false;
			// game effect (not decoration): the red fades from the screen edge towards the centre
			const g = new Instance("UIGradient");
			g.Rotation = rotation;
			g.Transparency = new NumberSequence([new NumberSequenceKeypoint(0, 0), new NumberSequenceKeypoint(1, 1)]);
			g.Parent = f;
			f.Parent = root;
			this.vignette.push(f);
		}
	}

	unmount(): void {
		if (!this.mounted) return;
		this.mounted = false;
		this.touchOff?.();
		this.touchOff = undefined;
		this.root?.Destroy();
		this.root = undefined;
		this.console = undefined;
		this.day = undefined;
		this.vignette = [];
		this.vignetteT = 1;
		this.feed = undefined;
		this.bannerCard = undefined;
		this.banner = undefined;
		this.bannerSub = undefined;
		this.bannerScale = undefined;
		this.joyBase = undefined;
		this.joyKnob = undefined;
		this.joyDead = undefined;
		this.joyActive = undefined;
		this.fireBtn = undefined;
		this.fireHeld = undefined;
		this.actionBtn = undefined;
		this.touchLayer = undefined;
		this.aimPad = undefined;
		this.aimKnob = undefined;
		this.aimArrow = undefined;
		this.aimCursor = undefined;
		this.useLabel = undefined;
		this.reloadBtn = undefined;
		this.hintBox = undefined;
		this.hintKey = undefined;
		this.hintLabel = undefined;
		this.hintGamepad = undefined;
		this.flash = 0;
	}

	isMounted(): boolean {
		return this.mounted;
	}

	update(state: HudState): void {
		if (!this.mounted || this.root === undefined) return;
		const now = os.clock();

		// the console (bars, hotbar, weapon) and the day plate: both write only what changed, and create nothing
		this.console?.update(state, this.ctx.save, now);
		this.day?.update(state);
		const hpRatio = state.hpMax > 0 ? state.hp / state.hpMax : 0;

		// a melee weapon has nothing to reload: the touch button says so instead of doing nothing when pressed
		if (this.reloadBtn !== undefined) {
			const canReload = state.magSize > 0;
			if ((this.reloadBtn.GetAttribute("Disabled") !== true) !== canReload) {
				setButtonEnabled(this.reloadBtn, canReload);
			}
		}

		// damage vignette: hit flash + a slow pulse when HP is low
		this.flash = math.max(0, this.flash - 1.6 / 60);
		let intensity = math.max(math.clamp(state.hitFlash, 0, 1) * 0.75, this.flash);
		if (hpRatio > 0 && hpRatio < 0.3) {
			const low = (0.3 - hpRatio) / 0.3;
			intensity = math.max(intensity, low * (0.3 + 0.15 * math.sin(now * 4)));
		}
		const transparency = 1 - math.clamp(intensity, 0, 0.9);
		if (transparency !== this.vignetteT) {
			this.vignetteT = transparency;
			for (const f of this.vignette) f.BackgroundTransparency = transparency;
		}

		if (this.touchLayer !== undefined) this.updateTouch();
	}

	/** drives the pixel touch layer from the live InputState (positions are already in screen pixels) */
	private updateTouch(): void {
		const ctx = this.ctx;
		const input = ctx.input;
		const L = getTouchLayout();
		const sx = (px: number): number => px / math.max(L.viewW, 1);
		const sy = (px: number): number => px / math.max(L.viewH, 1);

		if (this.joyBase !== undefined && this.joyKnob !== undefined) {
			const active = input.joystickActive;
			// a floating stick follows the thumb; a fixed one never leaves its home
			const baseX = active && L.floating ? input.joystickBaseX : L.move.homeX;
			const baseY = active && L.floating ? input.joystickBaseY : L.move.homeY;
			this.joyBase.Position = new UDim2(sx(baseX), 0, sy(baseY), 0);
			if (active) {
				const dx = input.joystickX - baseX;
				const dy = input.joystickY - baseY;
				const dist = math.sqrt(dx * dx + dy * dy);
				const travel = math.min(dist, L.move.radius);
				const ux = dist > 0.001 ? dx / dist : 0;
				const uy = dist > 0.001 ? dy / dist : 0;
				// the knob sits where the thumb is, clamped to the stick's travel
				this.joyKnob.Position = new UDim2(
					0.5 + (ux * travel) / (L.move.baseR * 2),
					0,
					0.5 + (uy * travel) / (L.move.baseR * 2),
					0,
				);
			}
			if (active !== this.joyActive) {
				this.joyActive = active;
				this.joyBase.BackgroundTransparency = active ? TRANSPARENCY.touchActive : TRANSPARENCY.touchIdle;
				if (this.joyDead !== undefined) this.joyDead.Visible = active;
				if (!active) this.joyKnob.Position = CENTER;
			}
		}

		// aim pad: it opens under the thumb, the knob and the rim chevron spell out the heading
		if (this.aimPad !== undefined && this.aimKnob !== undefined && this.aimArrow !== undefined) {
			const aiming = input.aimStickActive;
			const padX = aiming ? input.aimStickBaseX : L.aim.homeX;
			const padY = aiming ? input.aimStickBaseY : L.aim.homeY;
			this.aimPad.Position = new UDim2(sx(padX), 0, sy(padY), 0);
			if (this.aimKnob.Visible !== aiming) this.aimKnob.Visible = aiming;
			if (this.aimArrow.Visible !== aiming) this.aimArrow.Visible = aiming;
			if (aiming) {
				const dx = input.aimStickX - padX;
				const dy = input.aimStickY - padY;
				const dist = math.sqrt(dx * dx + dy * dy);
				const ux = dist > 0.001 ? dx / dist : 0;
				const uy = dist > 0.001 ? dy / dist : 0;
				const travel = math.min(dist, L.aim.radius);
				const span = L.aim.baseR * 2;
				this.aimKnob.Position = new UDim2(0.5 + (ux * travel) / span, 0, 0.5 + (uy * travel) / span, 0);
				const rimR = L.aim.baseR * 0.78;
				this.aimArrow.Position = new UDim2(0.5 + (ux * rimR) / span, 0, 0.5 + (uy * rimR) / span, 0);
				this.aimArrow.Rotation = math.deg(math.atan2(uy, ux));
			}
		}
		// the same heading drawn beside the survivor, so the player never has to guess where the shot goes
		if (this.aimCursor !== undefined) {
			const show = input.aimMode === "touch";
			if (this.aimCursor.Visible !== show) this.aimCursor.Visible = show;
			if (show) {
				const deg = ctx.cam.spriteRotationDeg(input.aimAngle);
				const rad = math.rad(deg);
				const reach = math.max(64 * L.scale, 52);
				this.aimCursor.Position = new UDim2(
					sx(L.viewW / 2 + math.cos(rad) * reach),
					0,
					sy(L.viewH / 2 + math.sin(rad) * reach),
					0,
				);
				this.aimCursor.Rotation = deg;
			}
		}
		if (this.fireBtn !== undefined && input.attackHeld !== this.fireHeld) {
			this.fireHeld = input.attackHeld;
			this.fireBtn.BackgroundTransparency = input.attackHeld ? TRANSPARENCY.fireHeld : TRANSPARENCY.fireIdle;
		}
	}

	/** gameplay announcement: waves / morning / night / boss as a banner, the rest in the feed */
	showMessage(text: string): void {
		const kind = classify(text);
		const shown = this.tr(text);
		if (kind === "wave") {
			this.showBanner(shown, THEME.destructive, this.tr("Zombies are coming"));
		} else if (kind === "night") {
			this.showBanner(shown, GAME.moon, this.tr("Survive the night"));
		} else if (kind === "morning") {
			this.showBanner(shown, GAME.sun, "");
		} else if (kind === "boss") {
			this.showBanner(shown, GAME.rare, "");
		} else {
			this.pushFeed(
				shown,
				kind === "level" ? GAME.xp : kind === "warn" ? THEME.destructive : THEME.popoverForeground,
			);
		}
	}

	private showBanner(text: string, color: Color3, subText: string): void {
		const card = this.bannerCard;
		const banner = this.banner;
		const sub = this.bannerSub;
		const scale = this.bannerScale;
		if (card === undefined || banner === undefined || sub === undefined || scale === undefined) return;
		const gen = ++this.bannerGen;
		banner.Text = text;
		banner.TextColor3 = color;
		sub.Text = subText;
		// fit the card to the message (estimated width; TextScaled shrinks anything longer)
		const textW = math.max(badgeWidth(text, TEXT.xl5, 0), subText === "" ? 0 : badgeWidth(subText, TEXT.lg, 0));
		const w = math.clamp(textW + space(12), BANNER_MIN_W, BANNER_W);
		const h = subText === "" ? 70 + space(3) : BANNER_H;
		card.Position = UDim2.fromScale((BANNER_W - w) / 2 / BANNER_W, 0);
		card.Size = UDim2.fromScale(w / BANNER_W, h / BANNER_H);
		setSurfaceTransparency(card, 1);
		banner.TextTransparency = 1;
		sub.TextTransparency = 1;
		scale.Scale = 1.2;
		fadeSurface(card, 0.2, 0);
		fadeText(banner, 0.25, 0);
		fadeText(sub, 0.35, 0);
		tween(scale, 0.3, { Scale: 1 });
		task.delay(2.6, () => {
			if (gen !== this.bannerGen || banner.Parent === undefined) return;
			fadeSurface(card, 0.5, 1);
			fadeText(banner, 0.5, 1);
			fadeText(sub, 0.5, 1);
		});
	}

	/** toast-like line (small HUD card) under the banner; repeated messages refresh instead of stacking */
	private pushFeed(text: string, color: Color3): void {
		const feed = this.feed;
		if (feed === undefined) return;
		const entries: Array<Frame> = [];
		for (const child of feed.GetChildren()) {
			if (!child.IsA("Frame")) continue;
			if (child.GetAttribute("Text") === text) {
				// repeated message: refresh the existing line instead of stacking copies
				child.SetAttribute("Born", os.clock());
				child.LayoutOrder = ++this.feedOrder;
				return;
			}
			entries.push(child);
		}
		entries.sort((a, b) => a.LayoutOrder < b.LayoutOrder);
		while (entries.size() >= FEED_MAX) entries.remove(0)?.Destroy();
		const w = math.clamp(badgeWidth(text, TEXT.base, FEED_LINE_H) + space(6), FEED_LINE_MIN_W, FEED_W);
		const line = Card(feed, "Line", {
			x: 0,
			y: 0,
			w,
			h: FEED_LINE_H,
			variant: "popover",
			transparency: TRANSPARENCY.hud,
		});
		line.LayoutOrder = ++this.feedOrder;
		line.SetAttribute("Text", text);
		line.SetAttribute("Born", os.clock());
		const label = makeLabel(line, "Text", text, space(4), 0, w - space(8), FEED_LINE_H, TEXT.base, color, {
			font: "label",
			zIndex: 2,
		});
		// enter: fade in
		setSurfaceTransparency(line, 1);
		label.TextTransparency = 1;
		fadeSurface(line, 0.2, 0);
		fadeText(label, 0.2, 0);
		task.spawn(() => {
			while (line.Parent !== undefined) {
				const born = line.GetAttribute("Born");
				if (typeIs(born, "number") && os.clock() - born >= FEED_TIME) break;
				task.wait(0.25);
			}
			if (line.Parent === undefined) return;
			// fading out: the same message arriving now gets a fresh line instead of refreshing this one
			line.SetAttribute("Text", undefined);
			fadeSurface(line, 0.4, 1);
			fadeText(label, 0.4, 1);
			task.wait(0.4);
			line.Destroy();
		});
	}

	/**
	 * Interaction prompt from the game ("E: Open door", "Repair: needs Wood"...). Hints starting with
	 * "E: " are actions: keyboard players see the E key badge, touch players get the USE button.
	 */
	setInteractHint(text: string | undefined): void {
		const box = this.hintBox;
		if (box === undefined) return;
		const btn = this.actionBtn;
		const cap = this.useLabel;
		if (text === undefined || text === "") {
			if (box.Visible) box.Visible = false;
			if (btn !== undefined && btn.Visible) btn.Visible = false;
			if (cap !== undefined && cap.Visible) cap.Visible = false;
			return;
		}
		const actionable = text.sub(1, 3) === "E: ";
		const touch = this.touch;
		if (!box.Visible) box.Visible = true;
		if (this.hintKey !== undefined) this.hintKey.Visible = actionable && !touch;
		// a pad player is told the pad's button, not a key they do not have
		const pad = gamepadActive();
		if (actionable && !touch && pad !== this.hintGamepad && this.hintKey !== undefined) {
			this.hintGamepad = pad;
			setBadge(this.hintKey, pad ? "X" : "E");
		}
		this.setText(this.hintLabel, "hint", actionable ? text.sub(4) : text);
		const showBtn = actionable && touch;
		if (btn !== undefined && btn.Visible !== showBtn) btn.Visible = showBtn;
		if (cap !== undefined && cap.Visible !== showBtn) cap.Visible = showBtn;
	}

	/** extra red flash (e.g. explosions); the regular hit flash comes from HudState.hitFlash */
	showDamage(alpha: number): void {
		this.flash = math.max(this.flash, math.clamp(alpha, 0, 0.85));
	}
}
