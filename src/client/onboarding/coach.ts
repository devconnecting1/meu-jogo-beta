import { GameContext } from "shared/game/context";
import { langGet } from "shared/data/lang";
import { MIN_TOUCH_PX } from "shared/engine/input";
import type { GameRefs } from "../systems/types";
import { GAME, RADIUS, TEXT, THEME, TRANSPARENCY, space } from "../ui/theme";
import { toast } from "../ui/popup";
import { Bar, Button, Card, Progress, makeAnchored, makeFrame, makeLabel, setDesign, uiScale } from "../ui/widgets";
import {
	FIRE_DEADLINE_HOUR,
	Memory,
	OBJECTIVES,
	ObjectiveTarget,
	ObjectiveView,
	newMemory,
	objectiveView,
	trackWorld,
} from "./objectives";

const UserInputService = game.GetService("UserInputService");

/*
 * The coach: one objective on screen at a time, a pointer in the world, and nothing that ever blocks the game.
 *
 * Placement: the card sits on the LEFT EDGE at mid height. That is the one strip of screen that is free on
 * every device and every layout — the vitals card owns the top-left, the banner and the day card the top
 * centre, the weapon card and the interaction prompt the bottom, and both thumbs the bottom corners (either
 * way round, since the player may be left-handed).
 */

const CARD_W = 380;
const CARD_H = 160;
const PAD = space(3);
/** Skip is a real touch target: 110 x 56 design units, scaled below so it clears MIN_TOUCH_PX on a phone */
const SKIP_W = 110;
const SKIP_H = 56;

/** seconds a lesson waits before it steps aside (no zombie around, nothing to pick up...) */
const OBJECTIVE_TIMEOUT = 45;
/** seconds the whole thing may take, frozen menus not counted: a hard stop so it can never nag */
const TOTAL_BUDGET = 420;
/** how long the finished card is shown before the next lesson */
const CELEBRATE = 1.1;
/** seconds between two sweeps for "where is the nearest house / tree" (the arrow still moves every frame) */
const VIEW_PERIOD = 0.2;

type Phase = "running" | "celebrating" | "late" | "done";

export class Coach {
	private ctx: GameContext;
	private root: Frame | undefined;
	private pointer: Frame | undefined;
	private arrow: Frame | undefined;
	/** the arrow and its two head bars, recoloured together */
	private arrowParts: Array<Frame> = [];
	private distLabel: TextLabel | undefined;
	private stepLabel: TextLabel | undefined;
	private titleLabel: TextLabel | undefined;
	private hintLabel: TextLabel | undefined;
	private progressLabel: TextLabel | undefined;
	private bar: Bar | undefined;
	private index = 0;
	private mem: Memory = newMemory();
	/** the last computed objective view, refreshed at VIEW_PERIOD instead of every frame */
	private view: ObjectiveView | undefined;
	private viewTimer = 0;
	private phase: Phase = "done";
	private timer = 0;
	private elapsed = 0;
	private budget = TOTAL_BUDGET;
	private lastClock = -1;
	private onFinished: (() => void) | undefined;

	constructor(ctx: GameContext) {
		this.ctx = ctx;
	}

	private tr(key: string): string {
		return langGet(key, this.ctx.save.settings.langType);
	}

	isRunning(): boolean {
		return this.phase !== "done";
	}

	/** which lesson is on screen: kept across a suspend (pause → shop → back) so it never starts over */
	progressIndex(): number {
		return this.index;
	}

	start(refs: GameRefs, onFinished: () => void, fromIndex = 0): void {
		if (this.phase !== "done") return;
		this.onFinished = onFinished;
		this.index = math.clamp(fromIndex, 0, OBJECTIVES.size() - 1);
		this.mem = newMemory();
		this.phase = "running";
		this.timer = 0;
		this.elapsed = 0;
		this.budget = TOTAL_BUDGET;
		this.lastClock = -1;
		this.view = undefined;
		this.viewTimer = 0;
		this.build();
		OBJECTIVES[this.index].begin(refs, this.mem);
		this.refresh(refs);
	}

	stop(): void {
		this.phase = "done";
		this.root?.Destroy();
		this.root = undefined;
		this.pointer?.Destroy();
		this.pointer = undefined;
		this.arrow = undefined;
		this.arrowParts = [];
		this.distLabel = undefined;
		this.stepLabel = undefined;
		this.titleLabel = undefined;
		this.hintLabel = undefined;
		this.progressLabel = undefined;
		this.bar = undefined;
		this.view = undefined;
		this.onFinished = undefined;
	}

	/** the player pressed Skip, or the lessons ran out: never a failure, just the end of the hand-holding */
	finish(): void {
		const done = this.onFinished;
		this.stop();
		done?.();
	}

	// ---------------------------------------------------------------- frame

	update(refs: GameRefs, dt: number): void {
		if (this.phase === "done" || this.root === undefined) return;
		// the world clock is the honest "is the game actually running" signal: a menu freezes it
		const clock = refs.daynight.dayTime;
		const frozen = this.lastClock >= 0 && math.abs(clock - this.lastClock) < 1e-9;
		this.lastClock = clock;
		if (frozen) return;
		this.budget -= dt;
		if (this.budget <= 0) {
			this.finish();
			return;
		}
		const objective = OBJECTIVES[this.index];

		if (this.phase === "celebrating") {
			this.timer -= dt;
			if (this.timer > 0) return;
			this.advance(refs);
			return;
		}
		if (this.phase === "late") {
			this.timer -= dt;
			if (this.timer <= 0) this.finish();
			return;
		}

		this.elapsed += dt;
		this.viewTimer -= dt;
		trackWorld(refs, this.mem, dt, objective);
		if (objective.done(refs, this.mem)) {
			this.complete(objective.title);
			return;
		}
		// the fire lesson has a deadline; the others simply step aside if the town never offered the chance
		if (objective.id === "fire" && this.mem.late) {
			this.phase = "late";
			this.timer = 4.5;
			this.setCard(
				this.tr("Night came first"),
				this.tr("Fire lights the night and cooks what you find. Build one when you can."),
				"",
				-1,
				GAME.warning,
			);
			this.setPointer(undefined);
			return;
		}
		if (this.elapsed >= OBJECTIVE_TIMEOUT) {
			this.advance(refs);
			return;
		}
		this.refresh(refs);
	}

	private complete(title: string): void {
		this.phase = "celebrating";
		this.timer = CELEBRATE;
		this.setCard(`${this.tr(title)}  ✓`, this.tr("Nice."), "", 1, GAME.success);
		this.setPointer(undefined);
		// the toast carries the interface's own success cue (client/audio/uiAudio.ts reads its glyph)
		toast(this.ctx, this.tr(title), "success");
	}

	private advance(refs: GameRefs): void {
		this.index += 1;
		this.elapsed = 0;
		if (this.index >= OBJECTIVES.size()) {
			this.finish();
			return;
		}
		this.phase = "running";
		this.view = undefined;
		OBJECTIVES[this.index].begin(refs, this.mem);
		this.refresh(refs);
	}

	private refresh(refs: GameRefs): void {
		const objective = OBJECTIVES[this.index];
		// Looking for the nearest house / tree sweeps the spatial grid; five times a second is plenty for a
		// line of text and an arrow, and the arrow itself still follows the camera every frame (setPointer).
		let view = this.view;
		if (view === undefined || this.viewTimer <= 0) {
			view = objectiveView(refs, this.mem, objective);
			this.view = view;
			this.viewTimer = VIEW_PERIOD;
		}
		let progress = view.progress;
		if (objective.id === "fire" && progress !== "" && view.ratio >= 1) {
			const left = math.max(FIRE_DEADLINE_HOUR - refs.daynight.dayTime, 0);
			progress = `${progress}   ·   ${string.format("%.1f", left)}h left`;
		}
		this.setCard(this.tr(objective.title), this.tr(objective.hint), progress, view.ratio, THEME.foreground);
		const step = `${this.tr("Getting started")}  ·  ${this.index + 1} / ${OBJECTIVES.size()}`;
		if (this.stepLabel !== undefined && this.stepLabel.Text !== step) this.stepLabel.Text = step;
		this.setPointer(view.target);
	}

	// ---------------------------------------------------------------- drawing

	private setCard(title: string, hint: string, progress: string, ratio: number, color: Color3): void {
		// the card is refreshed every frame: only write what actually changed
		if (this.titleLabel !== undefined) {
			if (this.titleLabel.Text !== title) this.titleLabel.Text = title;
			if (this.titleLabel.TextColor3 !== color) this.titleLabel.TextColor3 = color;
		}
		if (this.hintLabel !== undefined && this.hintLabel.Text !== hint) this.hintLabel.Text = hint;
		if (this.progressLabel !== undefined && this.progressLabel.Text !== progress) {
			this.progressLabel.Text = progress;
		}
		if (this.bar !== undefined) {
			const show = ratio >= 0;
			if (this.bar.frame.Visible !== show) this.bar.frame.Visible = show;
			if (show) this.bar.setRatio(math.clamp(ratio, 0, 1));
		}
	}

	private setPointer(target: ObjectiveTarget | undefined): void {
		const pointer = this.pointer;
		const arrow = this.arrow;
		const dist = this.distLabel;
		if (pointer === undefined || arrow === undefined || dist === undefined) return;
		if (target === undefined) {
			if (pointer.Visible) pointer.Visible = false;
			return;
		}
		if (!pointer.Visible) pointer.Visible = true;
		const ctx = this.ctx;
		const w = math.max(ctx.viewW, 1);
		const h = math.max(ctx.viewH, 1);
		const p = ctx.cam.worldToScreen(target.x, target.y);
		// amber for something to hit, green for somewhere to go (LEG-02 keeps red for the player's own blood)
		const color = target.kind === "body" ? GAME.warning : THEME.primary;
		if (arrow.BackgroundColor3 !== color) {
			for (const part of this.arrowParts) part.BackgroundColor3 = color;
			dist.TextColor3 = color;
		}
		const bob = math.sin(os.clock() * 4) * 4;
		const margin = 64;
		const onScreen = p.x > margin && p.x < w - margin && p.y > margin && p.y < h - margin;
		if (onScreen) {
			// above the thing itself, nodding at it
			arrow.Position = new UDim2(p.x / w, 0, (p.y - 42 + bob) / h, 0);
			arrow.Rotation = 90;
			dist.Visible = false;
			return;
		}
		// off screen: on a ring around the survivor, with how far it is (1 m = 55 u, DESIGN_RULES §1)
		const cx = w / 2;
		const cy = h / 2;
		const dx = p.x - cx;
		const dy = p.y - cy;
		const len = math.max(math.sqrt(dx * dx + dy * dy), 1);
		const ring = math.min(w, h) * 0.34;
		const ax = cx + (dx / len) * ring;
		const ay = cy + (dy / len) * ring;
		arrow.Position = new UDim2(ax / w, 0, ay / h, 0);
		arrow.Rotation = math.deg(math.atan2(dy, dx));
		const mx = target.x - ctx.cam.x;
		const my = target.y - ctx.cam.y;
		const metres = math.sqrt(mx * mx + my * my);
		dist.Visible = true;
		dist.Text = `${math.floor(metres / 55 + 0.5)} m`;
		dist.Position = new UDim2(ax / w, 0, (ay + 30) / h, 0);
	}

	private build(): void {
		const ctx = this.ctx;
		this.root?.Destroy();
		// the Skip button has to stay thumb-sized on a phone, where a design unit is about half a pixel
		const touch = UserInputService.TouchEnabled;
		const k = 0.8 + 0.4 * math.clamp(ctx.save.settings.uiSize, 0, 1);
		const scale = touch ? math.clamp(MIN_TOUCH_PX / (SKIP_H * math.max(uiScale(), 0.05)), k, 1.6) : k;
		const box = makeAnchored(ctx.hudLayer, "Coach", 0, 0.5, CARD_W, CARD_H, 14, 0, false, scale);
		box.ZIndex = 30;
		this.root = box;
		const card = Card(box, "Bg", {
			x: 0,
			y: 0,
			w: CARD_W,
			h: CARD_H,
			variant: "popover",
			transparency: TRANSPARENCY.hud,
		});
		const innerW = CARD_W - PAD * 2;
		this.stepLabel = makeLabel(card, "Step", "", PAD, 8, innerW, 16, TEXT.xs, THEME.mutedForeground, {
			font: "caption",
			align: "left",
			zIndex: 2,
		});
		this.titleLabel = makeLabel(card, "Title", "", PAD, 26, innerW, 28, TEXT.xl, THEME.foreground, {
			font: "heading",
			align: "left",
			zIndex: 2,
		});
		this.hintLabel = makeLabel(card, "Hint", "", PAD, 56, innerW, 34, TEXT.sm, THEME.mutedForeground, {
			align: "left",
			valign: "top",
			zIndex: 2,
		});
		const barW = innerW - SKIP_W - space(3);
		const bar = Progress(card, "Bar", {
			x: PAD,
			y: 96,
			w: barW,
			h: 8,
			color: GAME.success,
			value: 0,
			zIndex: 2,
		});
		bar.frame.Visible = false;
		this.bar = bar;
		this.progressLabel = makeLabel(card, "Progress", "", PAD, 108, barW, 20, TEXT.xs, THEME.foreground, {
			font: "caption",
			align: "left",
			zIndex: 2,
		});
		Button(card, "Skip", this.tr("Skip"), {
			x: CARD_W - PAD - SKIP_W,
			y: CARD_H - PAD - SKIP_H,
			w: SKIP_W,
			h: SKIP_H,
			variant: "ghost",
			zIndex: 3,
			onClick: (): void => this.finish(),
		});

		// ---- world pointer (pixel space: it has to line up with the camera, not with the letterbox)
		this.pointer?.Destroy();
		const pointer = new Instance("Frame");
		pointer.Name = "CoachPointer";
		pointer.Size = UDim2.fromScale(1, 1);
		pointer.BackgroundTransparency = 1;
		pointer.BackgroundColor3 = THEME.background;
		pointer.BorderSizePixel = 0;
		pointer.ZIndex = 29;
		pointer.Visible = false;
		setDesign(pointer, math.max(ctx.viewW, 1), math.max(ctx.viewH, 1));
		pointer.Parent = ctx.hudLayer;
		this.pointer = pointer;

		const size = math.max(26 * math.max(uiScale(), 0.5), 22);
		// the arrow is one rotatable box: a shaft plus the two bars of its head, pointing at +x
		const arrow = makeFrame(pointer, "Arrow", 0, 0, size * 0.62, size * 0.16, THEME.primary, {
			zIndex: 30,
			radius: RADIUS.sm,
		});
		arrow.AnchorPoint = new Vector2(0.5, 0.5);
		this.arrow = arrow;
		const head = (name: string, rot: number): void => {
			const b = makeFrame(arrow, name, size * 0.62, (size * 0.16) / 2, size * 0.3, size * 0.16, THEME.primary, {
				zIndex: 31,
				radius: RADIUS.sm,
			});
			b.AnchorPoint = new Vector2(1, 0.5);
			b.Rotation = rot;
			b.BackgroundColor3 = arrow.BackgroundColor3;
		};
		head("HeadUp", -40);
		head("HeadDown", 40);
		this.arrowParts = [arrow];
		for (const child of arrow.GetChildren()) {
			if (child.IsA("Frame")) this.arrowParts.push(child);
		}
		this.distLabel = makeLabel(pointer, "Dist", "", 0, 0, 90, 20, 14, THEME.primary, {
			font: "numeric",
			zIndex: 31,
			outline: true,
		});
		this.distLabel.AnchorPoint = new Vector2(0.5, 0.5);
		this.distLabel.Visible = false;
	}
}
