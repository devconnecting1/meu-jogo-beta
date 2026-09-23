import { GameContext } from "shared/game/context";
import { HitAlarm } from "./hitAlarm";
import { GAME, TRANSPARENCY } from "./theme";
import { reducedMotion } from "./widgets";

/*
 * DESIGN_RULES UI-06: the red flash drawn ABOVE every menu when the survivor takes a hit with one open.
 *
 * No menu pauses the world, and the HUD's own damage vignette lives on the HUD layer, UNDER the menus -- so
 * with the Bag open a bite used to be felt only as a number that had dropped when the Bag closed. This is the
 * same vignette (the four screen edges in `GAME.blood`, each fading to nothing towards the centre), on the UI
 * layer above the Bag (200), the menu and the end-of-run screens (250) and the popups (300), and only while a
 * screen is open over a living survivor: with nothing open, the HUD vignette already does this job.
 *
 * It is a warning and nothing else: it does not close the menu, it takes no input (every frame is inactive
 * and not selectable, so a click or a gamepad focus goes through it), it carries no text (UI-04) and it adds
 * no sound. When a hit counts, and how often a flash may start (under 3 a second), is `HitAlarm`'s business
 * (client/ui/hitAlarm.ts). The bands are narrower than the HUD's, so a panel under them stays readable while
 * one fades; with Reduce Motion on, the flash holds and then goes instead of fading.
 */

/** above the Bag (200), the menu and end-of-run screens (250) and the popups (300); under the toasts (1000+) */
const FLASH_Z = 350;
/** how far in each band reaches, as a fraction of the screen (the HUD's vignette: 0,3 and 0,22) */
const DEPTH_Y = 0.16;
const DEPTH_X = 0.12;

export class DangerFlash {
	private readonly ctx: GameContext;
	private readonly alarm = new HitAlarm();
	private root: Frame | undefined;
	private readonly edges = new Array<Frame>();
	/** BackgroundTransparency the edges have now (1 = not drawn), so a quiet frame writes nothing */
	private shown = 1;

	constructor(ctx: GameContext) {
		this.ctx = ctx;
	}

	/**
	 * One frame. `watching`: a screen is open over the run and the survivor is alive. `hp` is read on every
	 * frame, watched or not (see HitAlarm.step).
	 */
	frame(dt: number, watching: boolean, hp: number): void {
		const strength = this.alarm.step(dt, watching, hp);
		const k = reducedMotion() ? (strength > 0 ? 1 : 0) : strength;
		const t = k > 0 ? 1 - (1 - TRANSPARENCY.alarm) * k : 1;
		if (t === this.shown) return;
		this.shown = t;
		const root = t < 1 ? this.build() : this.root;
		if (root === undefined) return;
		root.Visible = t < 1;
		for (const f of this.edges) f.BackgroundTransparency = t;
	}

	/** the run ended or was suspended: nothing on screen, and the next run starts with a fresh HP reading */
	reset(): void {
		this.alarm.reset();
		this.shown = 1;
		if (this.root !== undefined) this.root.Visible = false;
	}

	/** built on the first hit that needs it: most runs never open a menu under fire */
	private build(): Frame {
		const existing = this.root;
		if (existing !== undefined && existing.Parent !== undefined) return existing;
		const root = new Instance("Frame");
		root.Name = "DangerFlash";
		root.Size = UDim2.fromScale(1, 1);
		root.BackgroundTransparency = 1;
		root.BackgroundColor3 = GAME.blood;
		root.BorderSizePixel = 0;
		root.Active = false;
		root.Selectable = false;
		root.ZIndex = FLASH_Z;
		this.edges.clear();
		const bands: Array<[string, UDim2, UDim2, number]> = [
			["Top", UDim2.fromScale(0, 0), UDim2.fromScale(1, DEPTH_Y), 90],
			["Bottom", UDim2.fromScale(0, 1 - DEPTH_Y), UDim2.fromScale(1, DEPTH_Y), 270],
			["Left", UDim2.fromScale(0, 0), UDim2.fromScale(DEPTH_X, 1), 0],
			["Right", UDim2.fromScale(1 - DEPTH_X, 0), UDim2.fromScale(DEPTH_X, 1), 180],
		];
		for (const [name, pos, size, rotation] of bands) {
			const f = new Instance("Frame");
			f.Name = `Edge${name}`;
			f.Position = pos;
			f.Size = size;
			f.BackgroundColor3 = GAME.blood;
			f.BackgroundTransparency = 1;
			f.BorderSizePixel = 0;
			f.Active = false;
			f.Selectable = false;
			f.ZIndex = FLASH_Z;
			// the red is strongest at the screen edge and gone before it reaches the middle of the band
			const g = new Instance("UIGradient");
			g.Rotation = rotation;
			g.Transparency = new NumberSequence([new NumberSequenceKeypoint(0, 0), new NumberSequenceKeypoint(1, 1)]);
			g.Parent = f;
			f.Parent = root;
			this.edges.push(f);
		}
		root.Parent = this.ctx.uiLayer;
		this.root = root;
		return root;
	}
}
