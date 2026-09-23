/*
 * Everything drawn OVER an ally instead of in the world: the `Nameplate` pill (name + level), a thin HP
 * bar while they are hurt and, while they are down, the revive ring and the bleed-out countdown.
 *
 * Why it is not drawn with the world Renderer: the night light map (`darkLayer`, ZIndex 80) covers every
 * world sprite, and MP-08 asks for a downed ally to stay readable IN THE DARK. So this lives just above
 * that layer and just below the HUD, like the local survivor's own plate.
 *
 * One of these per ally in the world (docs/MULTIPLAYER.md §5.3); `playersView` pools them by userId and
 * never builds one inside a frame.
 */
import { Camera } from "shared/engine/camera";
import { clamp } from "shared/engine/vec2";
import { GAME, RADIUS, TEXT, THEME, TRANSPARENCY, fontOf, space } from "../ui/theme";
import { addStroke, onLayoutChange, uiScale } from "../ui/widgets";
import { Nameplate, profileOf } from "../ui/nameplate";
import { RemotePlayerView } from "../net/netTypes";
import { SURVIVOR_R } from "./survivorView";

const Players = game.GetService("Players");

/** world units from the survivor's centre to the top of the plate: clears the body and its shadow */
const PLATE_GAP = 14;
/** MP-03: a standing ally at most this far away (centre to centre) can revive you */
export const REVIVE_RANGE = 70;
/** MP-03: a downed survivor bleeds out in 30 s */
const BLEED_SECONDS = 30;

/** design sizes (screen px before the UI scale) */
const BAR_W = 48;
const BAR_H = 5;
/** the bleed bar is taller because it also carries the countdown */
const BAR_H_DOWNED = 13;
const COUNT_TEXT = TEXT.xs - 2;

/** ring pulse: one breath every ~1.6 s */
const RING_PULSE = 4;
/** transparency step below which a write is not worth it */
const ALPHA_STEP = 1 / 24;

/**
 * Seconds of bleed-out left for a downed ally.
 *
 * F1 sends a survivor's life and nothing else (`netTypes.RemotePlayerView`), and MP-03 makes the downed
 * bleed out over 30 s, so their remaining life IS the countdown. When the snapshot starts carrying the
 * real byte (`bleed` / `revive`, shared/net/protocol.ts §4.2) in F2/F4, only this function changes.
 */
function bleedLeft(life: number): number {
	return math.ceil(life * BLEED_SECONDS);
}

function quantise(a: number): number {
	return math.round(a / ALPHA_STEP) * ALPHA_STEP;
}

export class AllyPlate {
	readonly userId: number;
	/** clock of the last frame this ally was in the snapshot; `playersView` retires stale plates */
	seen = 0;
	private host: Frame;
	private nameplate: Nameplate;
	private track: Frame;
	private fill: Frame;
	private count: TextLabel;
	/** built the first time this ally goes down (most allies never do) */
	private ring?: Frame;
	private ringStroke?: UIStroke;
	private scale = 1;
	private shown = false;
	private lastX = math.huge;
	private lastY = math.huge;
	private lastRingX = math.huge;
	private lastRingY = math.huge;
	private lastRatio = -1;
	private lastDowned = false;
	private lastText = "";
	private lastRingD = -1;
	private lastRingA = -1;
	private lastBarOn = true;
	/** the bar has to be sized again: the UI scale changed, or the survivor went down / got up */
	private barDirty = true;

	constructor(parent: GuiObject, zIndex: number, rp: RemotePlayerView) {
		const host = new Instance("Frame");
		host.Name = `Ally_${rp.userId}`;
		host.Size = UDim2.fromScale(1, 1);
		host.BackgroundTransparency = 1;
		host.BorderSizePixel = 0;
		host.ZIndex = zIndex;
		host.Active = false;
		host.Visible = false;
		host.Parent = parent;

		const track = new Instance("Frame");
		track.Name = "Health";
		track.AnchorPoint = new Vector2(0.5, 1);
		track.BackgroundColor3 = THEME.popover;
		track.BackgroundTransparency = TRANSPARENCY.nameplate;
		track.BorderSizePixel = 0;
		track.ClipsDescendants = true;
		track.ZIndex = 3;
		const trackCorner = new Instance("UICorner");
		trackCorner.Parent = track;
		addStroke(track, THEME.border);

		const fill = new Instance("Frame");
		fill.Name = "Fill";
		fill.AnchorPoint = new Vector2(0, 0.5);
		fill.Position = UDim2.fromScale(0, 0.5);
		fill.BackgroundColor3 = GAME.hp;
		fill.BorderSizePixel = 0;
		fill.ZIndex = 4;
		const fillCorner = new Instance("UICorner");
		fillCorner.Parent = fill;
		fill.Parent = track;

		const count = new Instance("TextLabel");
		count.Name = "Count";
		count.Size = UDim2.fromScale(1, 1);
		count.BackgroundTransparency = 1;
		count.BackgroundColor3 = THEME.background;
		count.BorderSizePixel = 0;
		count.TextColor3 = THEME.foreground;
		count.TextStrokeColor3 = THEME.background;
		count.FontFace = fontOf("mono", Enum.FontWeight.Bold);
		count.AutoLocalize = false;
		count.Text = "";
		count.Visible = false;
		count.ZIndex = 5;
		count.Parent = track;
		track.Parent = host;

		// the pill is the same component the local survivor uses, so allies read exactly like you do. The roster
		// (PlayerJoined) is the source of the name; the Player object only adds the "@handle", and an ally who
		// already left Players (or a snapshot replayed offline) still gets a plate.
		const player = Players.GetPlayerByUserId(rp.userId);
		const who = player !== undefined ? profileOf(player) : { displayName: rp.displayName, name: rp.displayName };
		this.nameplate = new Nameplate(host, 2, who);

		onLayoutChange(host, () => {
			const s = uiScale();
			this.scale = s;
			const px = (v: number): number => math.max(1, math.round(v * s));
			trackCorner.CornerRadius = new UDim(0, px(RADIUS.sm));
			fillCorner.CornerRadius = new UDim(0, px(RADIUS.sm));
			count.TextSize = px(COUNT_TEXT);
			this.barDirty = true;
		});

		this.userId = rp.userId;
		this.host = host;
		this.track = track;
		this.fill = fill;
		this.count = count;
	}

	/** the revive-reach circle, built the first time it is needed */
	private ringFrame(): Frame {
		let ring = this.ring;
		if (ring === undefined) {
			ring = new Instance("Frame");
			ring.Name = "ReviveRing";
			ring.AnchorPoint = new Vector2(0.5, 0.5);
			ring.BackgroundColor3 = GAME.warning;
			ring.BackgroundTransparency = 0.93;
			ring.BorderSizePixel = 0;
			ring.ZIndex = 1;
			const corner = new Instance("UICorner");
			corner.CornerRadius = new UDim(0.5, 0);
			corner.Parent = ring;
			this.ringStroke = addStroke(ring, GAME.warning, 0.2, 2);
			ring.Parent = this.host;
			this.ring = ring;
		}
		return ring;
	}

	/** position and fill everything for this frame; only changed properties reach the engine */
	update(cam: Camera, rp: RemotePlayerView, clock: number): void {
		this.seen = clock;
		if (!this.shown) {
			this.shown = true;
			this.host.Visible = true;
		}
		const at = cam.worldToScreen(rp.x, rp.y + SURVIVOR_R + PLATE_GAP);
		const x = math.round(at.x);
		const y = math.round(at.y);
		this.nameplate.update(x, y, rp.level, true, rp.title);

		const life = rp.hpMax > 0 ? clamp(rp.hp / rp.hpMax, 0, 1) : 0;
		const downed = rp.downed;
		// a healthy ally carries no bar: the plate alone is already a lot of chrome on screen (LEG)
		const barOn = downed || life < 0.999;
		if (barOn !== this.lastBarOn) {
			this.lastBarOn = barOn;
			this.track.Visible = barOn;
		}
		if (barOn) {
			this.layoutBar(downed, x, y);
			const ratio = math.round(life * 64) / 64;
			if (ratio !== this.lastRatio) {
				this.lastRatio = ratio;
				this.fill.Size = new UDim2(ratio, 0, 1, 0);
				this.fill.Visible = ratio > 0.001;
			}
			if (downed) {
				const text = `${bleedLeft(life)}s`;
				if (text !== this.lastText) {
					this.lastText = text;
					this.count.Text = text;
				}
			}
		}
		this.updateRing(cam, rp, clock, downed);
	}

	/** bar size and place; the bleed bar is taller and amber, the health bar thin and red */
	private layoutBar(downed: boolean, x: number, y: number): void {
		if (downed !== this.lastDowned || this.barDirty) {
			this.lastDowned = downed;
			this.barDirty = false;
			const s = this.scale;
			const h = math.max(1, math.round((downed ? BAR_H_DOWNED : BAR_H) * s));
			this.track.Size = UDim2.fromOffset(math.max(1, math.round(BAR_W * s)), h);
			this.fill.BackgroundColor3 = downed ? GAME.warning : GAME.hp;
			this.count.Visible = downed;
			this.lastY = math.huge;
		}
		const by = y - math.max(1, math.round(space(0.5) * this.scale));
		if (x !== this.lastX || by !== this.lastY) {
			this.lastX = x;
			this.lastY = by;
			this.track.Position = UDim2.fromOffset(x, by);
		}
	}

	/** MP-03's 70 u reach, so an ally can see where they have to stand to pick you up */
	private updateRing(cam: Camera, rp: RemotePlayerView, clock: number, downed: boolean): void {
		if (!downed) {
			if (this.ring !== undefined && this.lastRingA !== -1) {
				this.lastRingA = -1;
				this.ring.Visible = false;
			}
			return;
		}
		const ring = this.ringFrame();
		if (this.lastRingA === -1) ring.Visible = true;
		const centre = cam.worldToScreen(rp.x, rp.y);
		const d = math.round(REVIVE_RANGE * 2 * cam.zoom);
		if (d !== this.lastRingD) {
			this.lastRingD = d;
			ring.Size = UDim2.fromOffset(d, d);
		}
		const rx = math.round(centre.x);
		const ry = math.round(centre.y);
		if (rx !== this.lastRingX || ry !== this.lastRingY) {
			this.lastRingX = rx;
			this.lastRingY = ry;
			ring.Position = UDim2.fromOffset(rx, ry);
		}
		const alpha = quantise(0.45 + 0.3 * math.sin(clock * RING_PULSE));
		if (alpha !== this.lastRingA) {
			this.lastRingA = alpha;
			const stroke = this.ringStroke;
			if (stroke !== undefined) stroke.Transparency = alpha;
		}
	}

	/** off screen or out of the snapshot: keep the instances, show nothing */
	hide(): void {
		if (!this.shown) return;
		this.shown = false;
		this.host.Visible = false;
		this.nameplate.update(0, 0, 1, false);
	}

	destroy(): void {
		this.nameplate.destroy();
		this.host.Destroy();
	}
}
