/*
 * Player nameplate: one compact popover pill under the character, "[Lv 12]  DisplayName  @Name".
 *
 * Roles: popover surface (background at TRANSPARENCY.nameplate over the world) + border; level = Badge in the XP
 * colour (chart-2); name in foreground (BuilderSans SemiBold); "@Name" in muted-foreground. Every colour is an
 * exact theme token.
 *
 * The owner (gameLoop) positions it every frame with update(); nothing is created there, and Text / Position /
 * Visible are only written when they change. Sizes follow the UI scale (text, padding, corner, border).
 *
 * The plate is built for the survivor it is given (docs/MULTIPLAYER.md §5.3): in co-op there is one per survivor in
 * the world, so it never reads LocalPlayer itself. It takes a NameplateProfile rather than a Player, because an ally
 * only reaches the client as a snapshot slot plus the name of its PlayerJoined delta — there may be no Player object
 * for it at all (a spectated ally out of the roster, a replay, the offline harness).
 */
import { GAME, RADIUS, TEXT, THEME, TRANSPARENCY, fontOf, space } from "./theme";
import { addStroke, boxStroke, onLayoutChange, uiScale } from "./widgets";

const TweenService = game.GetService("TweenService");

/** design sizes (scaled by the UI scale) */
const LEVEL_TEXT = TEXT.xs;
const NAME_TEXT = TEXT.sm - 1;
const HANDLE_TEXT = TEXT.xs - 1;
/** "@Name" only when it adds information and stays short */
const MAX_BOTH_CHARS = 26;

/** level-up pulse: flash + ring burst + pop, ~0.35 s */
const PULSE_TIME = 0.35;
const FLASH_TIME = 0.14;

/**
 * Who a plate names. A Player is NOT structurally one of these (its fields are `DisplayName` / `Name`), which is
 * the point: a remote survivor is a slot in a snapshot, not a Player object, and `profileOf` is the one place that
 * converts.
 */
export interface NameplateProfile {
	/** the name on the pill */
	displayName: string;
	/** the "@handle"; pass the display name when there is no separate one to show */
	name: string;
}

/** the local player (or any ally still in Players) as a profile */
export function profileOf(player: Player): NameplateProfile {
	return { displayName: player.DisplayName, name: player.Name };
}

function textLabel(name: string, order: number, color: Color3, font: Font, zIndex: number): TextLabel {
	const l = new Instance("TextLabel");
	l.Name = name;
	l.LayoutOrder = order;
	l.AutomaticSize = Enum.AutomaticSize.XY;
	l.Size = UDim2.fromOffset(0, 0);
	l.BackgroundColor3 = THEME.background;
	l.BackgroundTransparency = 1;
	l.BorderSizePixel = 0;
	l.TextColor3 = color;
	l.TextStrokeColor3 = THEME.background;
	l.FontFace = font;
	l.AutoLocalize = false;
	l.ZIndex = zIndex;
	return l;
}

export class Nameplate {
	private plate: Frame;
	private badge: TextLabel;
	private badgeRing: UIStroke;
	private plateScale: UIScale;
	private lastX = math.huge;
	private lastY = math.huge;
	private lastLevel = -1;
	private shown = false;
	private pulses: Array<Tween> = [];
	private pulseGen = 0;

	/**
	 * parent: frame that covers the viewport (same space as cam.worldToScreen); zIndex: above world, below HUD;
	 * who: the survivor this plate names — `profileOf(Players.LocalPlayer)` for yourself, the ally's roster entry
	 * in co-op.
	 */
	constructor(parent: GuiObject, zIndex: number, who: NameplateProfile) {
		const displayName = who.displayName;
		const userName = who.name;
		const showHandle = userName !== displayName && displayName.size() + userName.size() + 1 <= MAX_BOTH_CHARS;

		const plate = new Instance("Frame");
		plate.Name = "Nameplate";
		plate.AnchorPoint = new Vector2(0.5, 0);
		plate.AutomaticSize = Enum.AutomaticSize.XY;
		plate.Size = UDim2.fromOffset(0, 0);
		plate.BackgroundColor3 = THEME.popover;
		plate.BackgroundTransparency = TRANSPARENCY.nameplate;
		plate.BorderSizePixel = 0;
		plate.ZIndex = zIndex;
		plate.Active = false;
		plate.Visible = false;
		const corner = new Instance("UICorner");
		corner.Parent = plate;
		addStroke(plate, THEME.border);
		const pad = new Instance("UIPadding");
		pad.Parent = plate;
		const layout = new Instance("UIListLayout");
		layout.FillDirection = Enum.FillDirection.Horizontal;
		layout.VerticalAlignment = Enum.VerticalAlignment.Center;
		layout.SortOrder = Enum.SortOrder.LayoutOrder;
		layout.Parent = plate;
		// the pop scales around the anchor (top-centre), so the name never jitters inside the pill
		const scale = new Instance("UIScale");
		scale.Parent = plate;

		// level: Badge look (rounded-md, solid XP colour, text-xs)
		const badge = textLabel("LevelBadge", 1, THEME.foreground, fontOf("sans", Enum.FontWeight.Bold), zIndex);
		badge.BackgroundColor3 = GAME.xp;
		badge.BackgroundTransparency = 0;
		badge.Text = "Lv 1";
		const badgeCorner = new Instance("UICorner");
		badgeCorner.Parent = badge;
		const badgePad = new Instance("UIPadding");
		badgePad.Parent = badge;
		// level-up burst: an outer ring (ring token) that expands and fades -- boxStroke puts the UIStroke on a
		// StrokeHost frame under badge (UI-04: never a UIStroke directly on a TextLabel), so it borders the pill
		// instead of contouring "Lv N"'s glyphs. The host frame needs its own UICorner to match the pill's rounding.
		const ring = boxStroke(badge, "LevelRing");
		ring.Color = THEME.ring;
		ring.Transparency = 1;
		ring.Thickness = 0;
		const ringHost = badge.FindFirstChild("StrokeHost") as Frame;
		const ringHostCorner = new Instance("UICorner");
		ringHostCorner.Parent = ringHost;
		badge.Parent = plate;

		const nameLabel = textLabel(
			"NameLabel",
			2,
			THEME.popoverForeground,
			fontOf("sans", Enum.FontWeight.SemiBold),
			zIndex,
		);
		nameLabel.Text = displayName;
		nameLabel.Parent = plate;

		let handle: TextLabel | undefined;
		if (showHandle) {
			handle = textLabel(
				"HandleLabel",
				3,
				THEME.mutedForeground,
				fontOf("sans", Enum.FontWeight.Regular),
				zIndex,
			);
			handle.Text = `@${userName}`;
			handle.Parent = plate;
		}

		// AutomaticSize needs real TextSize/offsets (TextScaled does not auto-size): recompute on screen changes
		onLayoutChange(plate, () => {
			const s = uiScale();
			const px = (v: number): number => math.max(1, math.round(v * s));
			corner.CornerRadius = new UDim(0, px(RADIUS.lg));
			badgeCorner.CornerRadius = new UDim(0, px(RADIUS.md));
			ringHostCorner.CornerRadius = new UDim(0, px(RADIUS.md));
			pad.PaddingLeft = new UDim(0, px(space(1)));
			pad.PaddingRight = new UDim(0, px(space(2)));
			pad.PaddingTop = new UDim(0, px(space(1)));
			pad.PaddingBottom = new UDim(0, px(space(1)));
			layout.Padding = new UDim(0, px(space(1.5)));
			badgePad.PaddingLeft = new UDim(0, px(space(1.5)));
			badgePad.PaddingRight = new UDim(0, px(space(1.5)));
			badgePad.PaddingTop = new UDim(0, px(space(0.5)));
			badgePad.PaddingBottom = new UDim(0, px(space(0.5)));
			badge.TextSize = px(LEVEL_TEXT);
			nameLabel.TextSize = px(NAME_TEXT);
			if (handle !== undefined) handle.TextSize = px(HANDLE_TEXT);
		});

		plate.Parent = parent;
		this.plate = plate;
		this.badge = badge;
		this.badgeRing = ring;
		this.plateScale = scale;
	}

	/** (x, y) = screen px (relative to the parent) of the plate's top-centre */
	update(x: number, y: number, level: number, visible: boolean): void {
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
		}
		if (level !== this.lastLevel) {
			const levelUp = this.lastLevel >= 0 && level > this.lastLevel;
			this.lastLevel = level;
			this.badge.Text = `Lv ${level}`;
			if (levelUp) this.pulse();
		}
	}

	/** level-up: the badge flashes (xp -> primary -> xp, token swap), throws a ring and the pill pops. The text
	 * stays THEME.foreground throughout -- it is already the light foreground (UI-05), and flashing the PILL
	 * (never the label) is what keeps it readable: foreground-on-primary is checked in test-contrast.mjs. */
	private pulse(): void {
		for (const t of this.pulses) t.Cancel();
		const gen = ++this.pulseGen;
		const badge = this.badge;
		badge.BackgroundColor3 = THEME.primary;
		task.delay(FLASH_TIME, () => {
			if (gen !== this.pulseGen || badge.Parent === undefined) return;
			badge.BackgroundColor3 = GAME.xp;
		});
		this.plateScale.Scale = 1;
		this.badgeRing.Transparency = 0;
		this.badgeRing.Thickness = 1;
		const ringPx = math.max(2, math.round(space(1) * uiScale()));
		const pop = new TweenInfo(PULSE_TIME / 2, Enum.EasingStyle.Quad, Enum.EasingDirection.Out, 0, true);
		const burst = new TweenInfo(PULSE_TIME, Enum.EasingStyle.Quad, Enum.EasingDirection.Out);
		this.pulses = [
			TweenService.Create(this.plateScale, pop, { Scale: 1.12 }),
			TweenService.Create(this.badgeRing, burst, { Thickness: ringPx, Transparency: 1 }),
		];
		for (const t of this.pulses) t.Play();
	}

	destroy(): void {
		for (const t of this.pulses) t.Cancel();
		this.pulses = [];
		this.pulseGen++;
		this.plate.Destroy();
	}
}
