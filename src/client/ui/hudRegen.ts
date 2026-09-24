/*
 * The HUD console's cue for DESIGN_RULES VIT-01 (the wait before healing, and the food it needs): what the body is
 * doing about its HP, read off the vitals bars (UI-09) without a word of text.
 *
 *   healing     a soft glow round the HP bar in the theme's heal colour (GAME.success: "heal, success"), fading in
 *               with the ramp and breathing slowly (0,5 Hz, far under the 3 a second of WCAG 2.3.1)
 *   low food    a pixel fork at the right end of the FOOD bar, on the empty groove (below 25 the fill never reaches
 *               it), in the label's light: eat to heal. It pops once when it appears, never again until it has gone
 *   the wait    nothing: the fight already says it (the hit flash, the vignette)
 *
 * Reduce Motion (skin.ts `reducedMotion`, UI-07): the glow holds one value, with no fade, and the fork just appears.
 * The glow sits OUTSIDE the HP groove, so the bar's label keeps the 4,5:1 its fill was darkened for (UI-05).
 *
 * Built once with the console; `update` runs every frame, writes only what changed and creates nothing (test:hud).
 * Its own file for Luau's 200-locals-per-chunk budget (npm run check:registers), like hudSky.ts.
 */
import { RegenPhase, regenPhase, regenRamp } from "shared/sim/vitals";
import { Px, pixelIcon } from "./hudSky";
import { GAME, THEME } from "./theme";
import * as W from "./widgets";

/** a fork, on the 7 x 7 grid of hudSky.ts `pixelIcon`: three tines, the bridge, the neck and the handle */
const FORK: Array<Px> = [
	[1, 0, 1, 3],
	[3, 0, 1, 3],
	[5, 0, 1, 3],
	[1, 3, 5, 1],
	[2, 4, 3, 1],
	[3, 5, 1, 2],
];

/** the glow's reach past the HP groove on each side, design units (never more than half the gap to the next bar) */
const GLOW_PAD = 2;
/** the glow's opacity at the two ends of its breath, at the full rate (the ramp scales it in) */
const GLOW_MIN = 0.25;
const GLOW_MAX = 0.55;
/** breaths a second */
const BREATH_HZ = 0.5;
/** the glow's transparency is written in steps of this, so a steady frame writes nothing */
const GLOW_STEP = 0.02;
/** the fork: its side as a share of the bar's height, and its distance from the groove's right end (design units) */
const FORK_SIDE = 0.64;
const FORK_INSET = 4;
/** the pop: seconds, and how big it starts */
const POP_S = 0.3;
const POP_SCALE = 1.6;

/** what the console knows of its vitals bars (hudConsole.ts Layout), in the vitals section's design units */
export interface RegenBars {
	/** the HP groove's place in the section */
	x: number;
	y: number;
	barW: number;
	barH: number;
	barGap: number;
}

export class RegenCue {
	private readonly glow: Frame;
	/** the two frames of the ring (written together) */
	private readonly glowParts: Array<Frame> = [];
	private readonly fork: Frame;
	/** the fork's resting size, in scale of the FOOD groove, and the scale it is drawn at now */
	private readonly forkW: number;
	private readonly forkH: number;
	private forkScale = 1;
	private glowT = 1;
	/** seconds of the pop left (0 = resting) */
	private popLeft = 0;
	private lastNow: number | undefined;

	constructor(section: Frame, foodGroove: Frame, bars: RegenBars, zIndex: number) {
		// ---- the glow: a notched ring behind the HP groove (two frames, a cross: the corners stay cut, like the plates)
		const pad = math.min(GLOW_PAD, bars.barGap / 2);
		const w = bars.barW + pad * 2;
		const h = bars.barH + pad * 2;
		const glow = W.makeFrame(section, "HpGlow", bars.x - pad, bars.y - pad, w, h, THEME.background, {
			transparency: 1,
			// behind the groove (which is at `zIndex`), over the section's own plate
			zIndex: zIndex - 1,
		});
		glow.Visible = false;
		for (const [name, px, py, pw, ph] of [
			["GlowV", pad / w, 0, 1 - (2 * pad) / w, 1],
			["GlowH", 0, pad / h, 1, 1 - (2 * pad) / h],
		] as Array<[string, number, number, number, number]>) {
			const f = new Instance("Frame");
			f.Name = name;
			f.BorderSizePixel = 0;
			f.BackgroundColor3 = GAME.success;
			f.BackgroundTransparency = 1;
			f.Position = UDim2.fromScale(px, py);
			f.Size = UDim2.fromScale(pw, ph);
			f.ZIndex = zIndex - 1;
			f.Parent = glow;
			this.glowParts.push(f);
		}
		this.glow = glow;

		// ---- the fork: at the FOOD groove's right end, above the fill and under nothing (the label is centred)
		const side = bars.barH * FORK_SIDE;
		this.forkW = side / bars.barW;
		this.forkH = side / bars.barH;
		const host = new Instance("Frame");
		host.Name = "EatHint";
		host.BackgroundTransparency = 1;
		host.BackgroundColor3 = THEME.background;
		host.BorderSizePixel = 0;
		host.AnchorPoint = new Vector2(0.5, 0.5);
		host.Position = UDim2.fromScale((bars.barW - FORK_INSET - side / 2) / bars.barW, 0.5);
		host.Size = UDim2.fromScale(this.forkW, this.forkH);
		host.ZIndex = zIndex + 2;
		host.Visible = false;
		host.Parent = foodGroove;
		pixelIcon(host, "Fork", FORK, THEME.foreground, zIndex + 2);
		this.fork = host;
	}

	/** every frame: the phase from the vitals (shared/sim/vitals.ts), then only what it changed */
	update(
		hp: number,
		hpMax: number,
		hungry: number,
		sinceHurt: number | undefined,
		now: number,
		still: boolean,
	): void {
		const dt = this.lastNow === undefined ? 0 : math.clamp(now - this.lastNow, 0, 1);
		this.lastNow = now;
		const phase = regenPhase(hp, hpMax, hungry, sinceHurt);

		// the glow: in with the ramp (or at once, still), breathing while it heals
		let t = 1;
		if (phase === RegenPhase.Healing) {
			const breath = 0.5 + 0.5 * math.sin(now * math.pi * 2 * BREATH_HZ);
			const alpha = still
				? (GLOW_MIN + GLOW_MAX) / 2
				: regenRamp(sinceHurt) * (GLOW_MIN + (GLOW_MAX - GLOW_MIN) * breath);
			t = 1 - math.round(alpha / GLOW_STEP) * GLOW_STEP;
		}
		const lit = t < 1;
		if (this.glow.Visible !== lit) this.glow.Visible = lit;
		if (lit && t !== this.glowT) {
			this.glowT = t;
			for (const f of this.glowParts) f.BackgroundTransparency = t;
		}

		// the fork: shown while low food is what stands between the body and its healing; one pop as it appears (at
		// full size on that very frame, then down to rest over POP_S)
		if (this.popLeft > 0) this.popLeft = math.max(0, this.popLeft - dt);
		const eat = phase === RegenPhase.Hungry;
		if (this.fork.Visible !== eat) {
			this.fork.Visible = eat;
			this.popLeft = eat && !still ? POP_S : 0;
		}
		const k = this.popLeft / POP_S;
		this.sizeFork(1 + (POP_SCALE - 1) * k * k);
	}

	/** the fork at `scale` times its resting size, about its centre (written only when it changes) */
	private sizeFork(scale: number): void {
		if (scale === this.forkScale) return;
		this.forkScale = scale;
		this.fork.Size = UDim2.fromScale(this.forkW * scale, this.forkH * scale);
	}
}
