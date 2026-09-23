/*
 * The nameplate: who a survivor is, written on the ground under them (docs/DESIGN_RULES.md MP-08, MON-05, UI-04).
 *
 *            (survivor)
 *        LV 12  Editor3D   @editor3d_official      <- the name line: level, name, handle
 *              [Horde Breaker]                     <- the title, only when one is shown
 *
 * NO BACKGROUND (the owner, 2026-09-23: "sem colocar algo de fundo atrás"). The popover pill it used to sit on is gone,
 * and text never carries a contour (UI-04), so every line lands on the ground with the kit's pixel drop shadow
 * (skin.ts `textShadow`: a near-black copy one skin pixel down and to the right). Each voice is measured WITH that
 * shadow against the town's real grounds, day and night (`npm run test:world-art`, section 9).
 *
 * What each line is, and why it is where it is:
 *  - the NAME (the display name, THEME.foreground, the biggest and boldest) is the anchor: it is what an ally reads;
 *  - the LEVEL leads it, small, in the XP blue (OVER_WORLD.level) and in the console's own word ("LV", the XP bar's
 *    "LV 3 · 30 / 120"): a number next to a name, no badge plate;
 *  - the HANDLE ("@username") follows, smaller and greyer (OVER_WORLD.handle), and only when it adds information:
 *    it differs from the display name and the two fit (MAX_BOTH_CHARS);
 *  - the TITLE (MON-05) has its own line under the name, in its colour (client/ui/titleStyle.ts), only when shown.
 *
 * Your own plate shows LESS: no handle. You know who you are; the handle on your plate would only ever be read by you.
 * The level and the title stay: the level pops when you level up, and the title is what everyone else sees under you
 * (MON-05: "para todos" -- you included). Allies always get the full plate.
 *
 * Plates that overlap give way instead of piling up (MP-02: survivors do not collide, so two can stand on one spot and
 * two unplated names on top of each other are one unreadable smear). The plate that tells you something wins: your
 * own gives way to any ally's, and between two allies the one nearer the middle of the screen (nearer you) wins. The
 * loser fades to YIELD_FADE, shadow and all, and comes back once the two are apart by a hair more (no flicker at the
 * edge). Only plates in the world take part (`world`); the wardrobe's preview never does.
 *
 * The plate hangs by its TOP, radius + 14 u under the survivor's centre (gameLoop / allyPlate), so the title line grows
 * it DOWNWARD and it can never cover the body. It is laid out by the engine (UIListLayout + AutomaticSize), each voice in
 * a holder with its shadow, so a hidden title takes no room.
 *
 * The owner (gameLoop, allyPlate, the wardrobe) positions it every frame with update(); nothing is created there, and
 * Text / Position / Visible / TextTransparency are written only when they change (the shadows follow their labels by
 * themselves). Sizes follow the UI scale; no text goes under the kit's 9 px floor.
 *
 * The plate is built for the survivor it is given (docs/MULTIPLAYER.md §5.3): in co-op there is one per survivor in the
 * world, so it never reads LocalPlayer itself. It takes a NameplateProfile rather than a Player, because an ally only
 * reaches the client as a snapshot slot plus the name of its PlayerJoined delta -- there may be no Player object for it
 * at all (a spectated ally out of the roster, a replay, the offline harness).
 */
import { langGet } from "shared/data/lang";
import { titleFromWire } from "shared/data/titles";
import { OVER_WORLD, TEXT, THEME, fontOf, space } from "./theme";
import { screenSize } from "./device";
import { fixedTextPx, motionTween, onLayoutChange, reducedMotion, textShadow, uiScale } from "./skin";
import { titleColor, titleText } from "./titleStyle";

/** design sizes (scaled by the UI scale, never under the kit's 9 px floor) */
export const NAME_TEXT = TEXT.sm;
export const LEVEL_TEXT = TEXT.xs;
export const HANDLE_TEXT = TEXT.xs - 1;
/** MON-05: the title under the name, the size of the level */
export const TITLE_TEXT = TEXT.xs;
/** between the level, the name and the handle (design units) */
const VOICE_GAP = space(1);
/** between the name line and the title line (design units) */
export const LINE_GAP = space(0.25);
/** "@Name" only when it adds information and stays short */
const MAX_BOTH_CHARS = 26;

/** the text transparency of a plate giving way to another it overlaps */
export const YIELD_FADE = 0.6;
/** px two overlapping plates must be apart before the one that gave way comes back (no flicker at the edge) */
const YIELD_SLACK = 3;

/** level-up: the level flashes light and the plate pops, ~0.35 s (the pop is skipped with Reduce Motion) */
const PULSE_TIME = 0.35;
const FLASH_TIME = 0.14;

/**
 * Who a plate names. A Player is NOT structurally one of these (its fields are `DisplayName` / `Name`), which is
 * the point: a remote survivor is a slot in a snapshot, not a Player object, and `profileOf` is the one place that
 * converts.
 */
export interface NameplateProfile {
	/** the name on the plate */
	displayName: string;
	/** the "@handle"; pass the display name when there is no separate one to show */
	name: string;
}

/** the local player (or any ally still in Players) as a profile */
export function profileOf(player: Player): NameplateProfile {
	return { displayName: player.DisplayName, name: player.Name };
}

export interface NameplateOpts {
	/** the survivor you steer: no handle on the plate, and it gives way to any ally's plate it overlaps */
	self?: boolean;
	/** a plate in the world (yours or an ally's): overlapping plates give way to each other. The wardrobe's preview is not */
	world?: boolean;
}

/** the plates in the world, for the overlap rule (the wardrobe's preview never joins) */
const worldPlates = new Set<Nameplate>();
let plateSerial = 0;

/** a transparent frame that grows to what it holds */
function holder(name: string, order: number, zIndex: number): Frame {
	const f = new Instance("Frame");
	f.Name = name;
	f.LayoutOrder = order;
	f.AutomaticSize = Enum.AutomaticSize.XY;
	f.Size = UDim2.fromOffset(0, 0);
	f.BackgroundColor3 = THEME.background;
	f.BackgroundTransparency = 1;
	f.BorderSizePixel = 0;
	f.Active = false;
	f.ZIndex = zIndex;
	return f;
}

/** one voice of the plate: a label in its holder, landed on the ground by its pixel shadow (UI-04) */
function voice(parent: Instance, name: string, order: number, color: Color3, font: Font, zIndex: number): TextLabel {
	const box = holder(`${name}Box`, order, zIndex);
	const l = new Instance("TextLabel");
	l.Name = name;
	l.AutomaticSize = Enum.AutomaticSize.XY;
	l.Size = UDim2.fromOffset(0, 0);
	l.BackgroundColor3 = THEME.background;
	l.BackgroundTransparency = 1;
	l.BorderSizePixel = 0;
	l.TextColor3 = color;
	l.TextStrokeTransparency = 1;
	l.FontFace = font;
	l.AutoLocalize = false;
	l.Active = false;
	l.ZIndex = zIndex + 1;
	l.Parent = box;
	textShadow(l);
	box.Parent = parent;
	return l;
}

export class Nameplate {
	private readonly plate: Frame;
	private readonly levelLabel: TextLabel;
	/** every label of the plate (they fade together when it gives way; their shadows follow) */
	private readonly labels: Array<TextLabel>;
	/** MON-05: the title's holder (hidden, it takes no room) and its label */
	private readonly titleBox: Frame;
	private readonly titleLabel: TextLabel;
	private readonly plateScale: UIScale;
	private readonly self: boolean;
	private readonly world: boolean;
	private readonly serial: number;
	private lastX = math.huge;
	private lastY = math.huge;
	private lastLevel = -1;
	private levelWord = "";
	/** the title byte last drawn (`titleToWire`: 0 = none) */
	private lastTitle = 0;
	private shown = false;
	/** giving way to another plate it overlaps */
	private yielded = false;
	/** how near the middle of the screen it hangs (px, squared): the nearer ally wins an overlap */
	private rank = 0;
	private pulses: Array<Tween> = [];
	private pulseGen = 0;

	/**
	 * parent: frame that covers the viewport (same space as cam.worldToScreen); zIndex: above world, below HUD;
	 * who: the survivor this plate names — `profileOf(Players.LocalPlayer)` for yourself, the ally's roster entry
	 * in co-op; opts: `{ self: true, world: true }` for yours, `{ world: true }` for an ally's.
	 */
	constructor(parent: GuiObject, zIndex: number, who: NameplateProfile, opts?: NameplateOpts) {
		this.self = opts?.self === true;
		this.world = opts?.world === true;
		this.serial = ++plateSerial;
		const displayName = who.displayName;
		const userName = who.name;
		const showHandle =
			!this.self && userName !== displayName && displayName.size() + userName.size() + 1 <= MAX_BOTH_CHARS;

		const plate = holder("Nameplate", 0, zIndex);
		plate.AnchorPoint = new Vector2(0.5, 0);
		plate.Visible = false;
		// the name line, and under it the title (MON-05), centred on each other
		const lines = new Instance("UIListLayout");
		lines.FillDirection = Enum.FillDirection.Vertical;
		lines.HorizontalAlignment = Enum.HorizontalAlignment.Center;
		lines.SortOrder = Enum.SortOrder.LayoutOrder;
		lines.Parent = plate;
		// the pop scales around the anchor (top-centre), so the line never jitters sideways
		const scale = new Instance("UIScale");
		scale.Parent = plate;

		const row = holder("NameRow", 1, zIndex);
		const voices = new Instance("UIListLayout");
		voices.FillDirection = Enum.FillDirection.Horizontal;
		voices.VerticalAlignment = Enum.VerticalAlignment.Center;
		voices.SortOrder = Enum.SortOrder.LayoutOrder;
		voices.Parent = row;
		row.Parent = plate;

		const bold = fontOf("sans", Enum.FontWeight.Bold);
		const level = voice(row, "LevelLabel", 1, OVER_WORLD.level, bold, zIndex);
		const nameLabel = voice(row, "NameLabel", 2, OVER_WORLD.name, bold, zIndex);
		nameLabel.Text = displayName;
		let handle: TextLabel | undefined;
		if (showHandle) {
			handle = voice(row, "HandleLabel", 3, OVER_WORLD.handle, fontOf("sans", Enum.FontWeight.Medium), zIndex);
			handle.Text = `@${userName}`;
		}

		// MON-05: the title, under the name; built once and only re-texted / shown / hidden afterwards (its holder is
		// what hides: the list skips it, so a plate with no title is one line tall)
		const title = voice(plate, "TitleLabel", 2, OVER_WORLD.name, bold, zIndex);
		title.Text = "";
		const titleBox = title.Parent as Frame;
		titleBox.Visible = false;

		// AutomaticSize needs real TextSize / offsets (TextScaled does not auto-size): recompute on screen changes. Every
		// line of the plate keeps the kit's text floor (MON-02: a phone must still read it)
		onLayoutChange(plate, () => {
			const s = uiScale();
			const px = (v: number): number => math.max(1, math.round(v * s));
			voices.Padding = new UDim(0, px(VOICE_GAP));
			lines.Padding = new UDim(0, px(LINE_GAP));
			level.TextSize = fixedTextPx(LEVEL_TEXT);
			nameLabel.TextSize = fixedTextPx(NAME_TEXT);
			if (handle !== undefined) handle.TextSize = fixedTextPx(HANDLE_TEXT);
			title.TextSize = fixedTextPx(TITLE_TEXT);
		});

		plate.Parent = parent;
		this.plate = plate;
		this.levelLabel = level;
		this.labels = [level, nameLabel, title];
		if (handle !== undefined) this.labels.push(handle);
		this.titleBox = titleBox;
		this.titleLabel = title;
		this.plateScale = scale;
		if (this.world) worldPlates.add(this);
	}

	/**
	 * (x, y) = screen px (relative to the parent) of the plate's top-centre. `title` is the title byte to show under the
	 * name (`titleToWire`, 0 = none): the SERVER's word for an ally (their roster entry), `titleWireOf(save)` for
	 * yourself -- never a title nobody checked.
	 */
	update(x: number, y: number, level: number, visible: boolean, title = 0): void {
		if (visible !== this.shown) {
			this.shown = visible;
			this.plate.Visible = visible;
		}
		if (!visible) return;
		const rx = math.round(x);
		const ry = math.round(y);
		if (rx !== this.lastX || ry !== this.lastY) {
			this.lastX = rx;
			this.lastY = ry;
			this.plate.Position = UDim2.fromOffset(rx, ry);
			// the plates hang in the world's ScreenGui: the whole screen
			const v = screenSize();
			const dx = rx - v.X / 2;
			const dy = ry - v.Y / 2;
			this.rank = dx * dx + dy * dy;
		}
		if (level !== this.lastLevel) {
			const levelUp = this.lastLevel >= 0 && level > this.lastLevel;
			this.lastLevel = level;
			if (this.levelWord === "") this.levelWord = langGet("LV", 0);
			this.levelLabel.Text = `${this.levelWord} ${level}`;
			if (levelUp) this.pulse();
		}
		const shownTitle = title > 0 ? title : 0;
		if (shownTitle !== this.lastTitle) {
			this.lastTitle = shownTitle;
			const id = titleFromWire(shownTitle);
			this.titleBox.Visible = id >= 0;
			if (id >= 0) {
				this.titleLabel.Text = titleText(id, 0);
				this.titleLabel.TextColor3 = titleColor(id);
			}
		}
		if (this.world) this.giveWay();
	}

	/** is `other` the plate that keeps its place when the two overlap? (see the header) */
	private outrankedBy(other: Nameplate): boolean {
		if (this.self !== other.self) return this.self;
		if (other.rank !== this.rank) return other.rank < this.rank;
		return other.serial < this.serial;
	}

	/**
	 * The overlap rule: fade while a plate that outranks this one covers it (read-only on the others; writes on change).
	 * The rectangles come from the top-centres the owners wrote (every world plate hangs in a full-screen frame at the
	 * origin: the local one in the world's GUI root, an ally's in its full-size host in that root) and the sizes the
	 * layout gave: a size is at most one frame old, and a hair of lag in a fade is invisible.
	 */
	private giveWay(): void {
		const s = this.plate.AbsoluteSize;
		// once faded, the plate waits until it is YIELD_SLACK px clear before it comes back
		const m = this.yielded ? YIELD_SLACK : 0;
		let give = false;
		if (s.X > 0 && s.Y > 0) {
			const ax = this.lastX - s.X / 2;
			const ay = this.lastY;
			for (const other of worldPlates) {
				if (other === this || !other.shown || !this.outrankedBy(other)) continue;
				const t = other.plate.AbsoluteSize;
				if (t.X <= 0 || t.Y <= 0) continue;
				const bx = other.lastX - t.X / 2;
				const by = other.lastY;
				if (ax - m < bx + t.X && bx < ax + s.X + m && ay - m < by + t.Y && by < ay + s.Y + m) {
					give = true;
					break;
				}
			}
		}
		if (give === this.yielded) return;
		this.yielded = give;
		const fade = give ? YIELD_FADE : 0;
		for (const l of this.labels) l.TextTransparency = fade;
	}

	/** is this plate giving way to another it overlaps? (for the tests and the renders) */
	isYielding(): boolean {
		return this.yielded;
	}

	/** level-up: "LV N" flashes the light foreground and the plate pops (no pop with Reduce Motion) */
	private pulse(): void {
		for (const t of this.pulses) t.Cancel();
		this.pulses = [];
		const gen = ++this.pulseGen;
		const label = this.levelLabel;
		label.TextColor3 = THEME.foreground;
		task.delay(FLASH_TIME, () => {
			if (gen !== this.pulseGen || label.Parent === undefined) return;
			label.TextColor3 = OVER_WORLD.level;
		});
		this.plateScale.Scale = 1;
		// the pop is motion: under Reduce Motion the flash of the level says it alone (the kit's tween would make it a
		// zero-length there-and-back, i.e. nothing, anyway)
		if (reducedMotion()) return;
		this.pulses = [motionTween(this.plateScale, PULSE_TIME / 2, { Scale: 1.12 }, true)];
	}

	destroy(): void {
		for (const t of this.pulses) t.Cancel();
		this.pulses = [];
		this.pulseGen++;
		worldPlates.delete(this);
		this.plate.Destroy();
	}
}
