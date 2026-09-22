import { COLORS } from "shared/engine/colors";
import { DESIGN } from "shared/engine/constants";
import { Renderer } from "shared/engine/renderer";
import { bossHitRadius, BOSS1_SEGMENT_RADIUS, zombieRadius } from "shared/game/entities";
import { PLAYER_RADIUS } from "shared/game/physics";
import { isBlocking, querySolids, Solid } from "shared/game/world";
import type { GameContext } from "shared/game/context";
import type { GameRefs } from "../systems/types";
import { debugFlowField } from "../systems/zombieAI";

/*
 * Debug overlays of the admin panel, drawn with their own pooled Renderer in a layer above the game world (and above
 * the night light map, so they stay readable at night). World debug graphics use the engine palette (COLORS), not
 * the UI theme: they are part of the world view, like the build ghost.
 */

export interface OverlayFlags {
	solids: boolean;
	actors: boolean;
	flow: boolean;
	lights: boolean;
	/** the stats card is drawn by the panel (adminClient); kept here so every debug switch lives in one place */
	stats: boolean;
}

/** placement ghost under the cursor (spawn / item / structure / teleport modes) */
export interface PlacementPreview {
	shape: "circle" | "rect";
	/** where it will be placed (the nearest free point) */
	x: number;
	y: number;
	/** where the cursor is */
	cursorX: number;
	cursorY: number;
	/** circle radius / rect size (world units) */
	r: number;
	w: number;
	h: number;
	/** how many bodies a spawn places (sunflower spread, like LocalAdminWorld.spawnZombies) */
	count: number;
	valid: boolean;
}

/** light radii used by the game (gameLoop PLAYER_LIGHT_R / LIGHT_R, zombieAI STRUCTURE_LIGHT_R) */
const PLAYER_LIGHT_R = 250;
const LIGHT_R: Record<string, number> = { lamp: 400, lamp_drone: 320, campfire: 300, brazier: 330 };

const FLOW_STEP = 2;
const FLOW_REFRESH = 0.3;
const MAX_FLOW_MARKS = 450;
const MAX_SOLIDS = 700;
const UNREACHABLE = 1e6;
const Z_OVERLAY = 5;

interface FlowMark {
	x: number;
	y: number;
	/** heading (radians), undefined = target cell */
	a: number | undefined;
	blocked: boolean;
}

export class AdminOverlay {
	private renderer: Renderer;
	private flowMarks: Array<FlowMark> = [];
	private flowAt = -math.huge;
	private solidsBuf: Array<Solid> = [];

	constructor(parent: GuiObject) {
		this.renderer = new Renderer(parent, "AdminOverlay");
	}

	hide(): void {
		this.renderer.releaseAll();
	}

	draw(ctx: GameContext, refs: GameRefs, flags: OverlayFlags, preview: PlacementPreview | undefined): void {
		const r = this.renderer;
		const cam = ctx.cam;
		r.setView(ctx.viewW, ctx.viewH);
		r.beginFrame();
		const v = cam.viewRect(32);
		if (flags.solids) {
			const list = this.solidsBuf;
			list.clear();
			querySolids(refs.world, v.minX, v.minY, v.maxX, v.maxY, list);
			let n = 0;
			for (const s of list) {
				if (n++ >= MAX_SOLIDS) break;
				const blocking = isBlocking(s);
				r.drawRect(cam, s.x + s.w / 2, s.y + s.h / 2, {
					w: s.w,
					h: s.h,
					color: COLORS.uiYellow,
					alpha: blocking ? 0.12 : 0,
					stroke: blocking ? COLORS.uiYellow : COLORS.uiTextDim,
					strokeThickness: blocking ? 2 : 1,
					strokeAlpha: blocking ? 0.9 : 0.5,
					zIndex: Z_OVERLAY,
				});
			}
		}
		if (flags.flow) this.drawFlow(ctx, v);
		if (flags.lights) {
			const p = refs.player;
			this.lightRing(ctx, p.x, p.y, PLAYER_LIGHT_R);
			const list = this.solidsBuf;
			list.clear();
			querySolids(refs.world, v.minX - 400, v.minY - 400, v.maxX + 400, v.maxY + 400, list);
			for (const s of list) {
				const lr = LIGHT_R[s.tags];
				if (lr === undefined) continue;
				const on = s.powered === true;
				r.drawCircle(cam, s.x + s.w / 2, s.y + s.h / 2, lr * 2, {
					color: COLORS.lamp,
					alpha: on ? 0.08 : 0,
					stroke: on ? COLORS.lamp : COLORS.uiTextDim,
					strokeThickness: 2,
					strokeAlpha: on ? 0.9 : 0.4,
					zIndex: Z_OVERLAY,
				});
			}
		}
		if (flags.actors) {
			const p = refs.player;
			r.drawCircle(cam, p.x, p.y, PLAYER_RADIUS * 2, {
				color: COLORS.uiGreen,
				alpha: 0.15,
				stroke: COLORS.uiGreen,
				strokeThickness: 2,
				zIndex: Z_OVERLAY + 2,
			});
			for (const z of refs.zombies) {
				const zr = zombieRadius(z);
				if (z.x + zr < v.minX || z.x - zr > v.maxX || z.y + zr < v.minY || z.y - zr > v.maxY) continue;
				r.drawCircle(cam, z.x, z.y, zr * 2, {
					color: z.detect ? COLORS.uiRed : COLORS.uiYellow,
					alpha: 0.15,
					stroke: z.detect ? COLORS.uiRed : COLORS.uiYellow,
					strokeThickness: 2,
					strokeAlpha: z.hp > 0 ? 1 : 0.4,
					zIndex: Z_OVERLAY + 2,
				});
			}
			for (const b of refs.bosses) {
				if (b.type === 1 && b.bodyX !== undefined && b.bodyY !== undefined) {
					for (let i = 0; i < b.bodyX.size(); i += 2) {
						r.drawCircle(cam, b.bodyX[i], b.bodyY[i], BOSS1_SEGMENT_RADIUS * 2, {
							color: COLORS.boss,
							alpha: 0,
							stroke: COLORS.boss,
							strokeThickness: 1,
							zIndex: Z_OVERLAY + 2,
						});
					}
				}
				r.drawCircle(cam, b.x, b.y, bossHitRadius(b) * 2, {
					color: COLORS.boss,
					alpha: 0.12,
					stroke: COLORS.boss,
					strokeThickness: 2,
					zIndex: Z_OVERLAY + 2,
				});
			}
			for (const it of refs.world.items) {
				if (it.x < v.minX || it.x > v.maxX || it.y < v.minY || it.y > v.maxY) continue;
				r.drawCircle(cam, it.x, it.y, DESIGN.ITEM_GET_DISTANCE * 2, {
					color: COLORS.item,
					alpha: 0,
					stroke: COLORS.item,
					strokeThickness: 1,
					strokeAlpha: 0.7,
					zIndex: Z_OVERLAY + 1,
				});
			}
		}
		if (preview !== undefined) this.drawPreview(ctx, preview);
		r.endFrame();
	}

	private lightRing(ctx: GameContext, x: number, y: number, radius: number): void {
		this.renderer.drawCircle(ctx.cam, x, y, radius * 2, {
			color: COLORS.lamp,
			alpha: 0.05,
			stroke: COLORS.lamp,
			strokeThickness: 2,
			strokeAlpha: 0.8,
			zIndex: Z_OVERLAY,
		});
	}

	/** flow field arrows every FLOW_STEP cells (sampled every FLOW_REFRESH s, redrawn every frame) */
	private drawFlow(ctx: GameContext, v: { minX: number; minY: number; maxX: number; maxY: number }): void {
		const flow = debugFlowField();
		const cam = ctx.cam;
		const now = os.clock();
		if (now - this.flowAt >= FLOW_REFRESH) {
			this.flowAt = now;
			const marks = this.flowMarks;
			marks.clear();
			if (flow.valid) {
				const cell = flow.cell;
				const step = cell * FLOW_STEP;
				const x0 = math.max(v.minX, flow.ox);
				const y0 = math.max(v.minY, flow.oy);
				const x1 = math.min(v.maxX, flow.ox + cell * flow.size);
				const y1 = math.min(v.maxY, flow.oy + cell * flow.size);
				const gx0 = math.floor((x0 - flow.ox) / step) * step + flow.ox + cell / 2;
				const gy0 = math.floor((y0 - flow.oy) / step) * step + flow.oy + cell / 2;
				for (let y = gy0; y < y1 && marks.size() < MAX_FLOW_MARKS; y += step) {
					for (let x = gx0; x < x1 && marks.size() < MAX_FLOW_MARKS; x += step) {
						if (!flow.contains(x, y)) continue;
						const blocked = flow.pathCells(x, y) >= UNREACHABLE;
						marks.push({ x, y, a: blocked ? undefined : flow.heading(x, y), blocked });
					}
				}
			}
		}
		for (const m of this.flowMarks) {
			if (m.blocked) {
				this.renderer.drawRect(cam, m.x, m.y, {
					w: 8,
					h: 8,
					color: COLORS.uiRed,
					alpha: 0.6,
					zIndex: Z_OVERLAY + 1,
				});
			} else if (m.a === undefined) {
				this.renderer.drawCircle(cam, m.x, m.y, 14, { color: COLORS.uiGreen, zIndex: Z_OVERLAY + 1 });
			} else {
				const dx = math.cos(m.a) * 14;
				const dy = math.sin(m.a) * 14;
				this.renderer.drawSegment(cam, m.x - dx, m.y - dy, m.x + dx, m.y + dy, {
					h: 3,
					color: COLORS.uiBlue,
					alpha: 0.85,
					zIndex: Z_OVERLAY + 1,
				});
				this.renderer.drawCircle(cam, m.x + dx, m.y + dy, 7, { color: COLORS.uiBlue, zIndex: Z_OVERLAY + 1 });
			}
		}
		if (flow.valid) {
			this.renderer.drawCircle(cam, flow.targetX, flow.targetY, 24, {
				color: COLORS.uiGreen,
				alpha: 0,
				stroke: COLORS.uiGreen,
				strokeThickness: 3,
				zIndex: Z_OVERLAY + 1,
			});
		}
	}

	private drawPreview(ctx: GameContext, p: PlacementPreview): void {
		const cam = ctx.cam;
		const r = this.renderer;
		const color = p.valid ? COLORS.uiGreen : COLORS.uiRed;
		const z = Z_OVERLAY + 10;
		if (math.abs(p.cursorX - p.x) > 1 || math.abs(p.cursorY - p.y) > 1) {
			// the cursor is over something solid: show where it will really go
			r.drawSegment(cam, p.cursorX, p.cursorY, p.x, p.y, { h: 2, color, alpha: 0.6, zIndex: z });
			r.drawCircle(cam, p.cursorX, p.cursorY, 10, { color, alpha: 0.6, zIndex: z });
		}
		if (p.shape === "rect") {
			r.drawRect(cam, p.x, p.y, {
				w: p.w,
				h: p.h,
				color,
				alpha: 0.35,
				stroke: color,
				strokeThickness: 2,
				zIndex: z,
			});
			return;
		}
		const n = math.max(1, p.count);
		for (let i = 0; i < n; i++) {
			const a = i * 2.39996;
			const d = i === 0 ? 0 : p.r * 2.4 * math.sqrt(i);
			r.drawCircle(cam, p.x + math.cos(a) * d, p.y + math.sin(a) * d, p.r * 2, {
				color,
				alpha: i === 0 ? 0.35 : 0.15,
				stroke: color,
				strokeThickness: 2,
				strokeAlpha: i === 0 ? 1 : 0.5,
				zIndex: z,
			});
		}
	}
}
