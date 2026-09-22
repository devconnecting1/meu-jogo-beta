import { getCtx, syncKeyboardMove } from "./bootstrap";
import { COLORS, Z } from "shared/engine/colors";
import { Camera, ViewRect } from "shared/engine/camera";
import { DESIGN, TOWN } from "shared/engine/constants";
import { LightMap, LightSource, Renderer, SpriteOpts } from "shared/engine/renderer";
import { clamp, lerp } from "shared/engine/vec2";
import { WeaponKind } from "shared/data/kinds";
import { expMaxInit, PlayerSaveData } from "shared/game/save";
import { createPlayer, currentWeapon, PlayerState, recalcMoveSpeed } from "shared/game/player";
import { moveActor, PLAYER_RADIUS } from "shared/game/physics";
import {
	buildingAt,
	createWorld,
	generateTown,
	isOnRoad,
	querySolids,
	randomOpenPoint,
	rectHitsSolid,
	updateGroundItems,
	WorldData,
	Solid,
} from "shared/game/world";
import {
	BOSS1_SEGMENT_RADIUS,
	bossHitRadius,
	resetEntityIds,
	BossState,
	ZombieState,
	zombieRadius,
} from "shared/game/entities";
import { resetBullets, Bullet } from "shared/game/bullets";
import { DayNight } from "./systems/daynight";
import { ParticleSystem } from "./systems/particles";
import { Spawner } from "./systems/spawner";
import { updateZombies } from "./systems/zombieAI";
import { updateBosses } from "./systems/bossAI";
import { Combat } from "./systems/combat";
import { Interaction } from "./systems/interaction";
import { BuildSystem } from "./systems/build";
import { Explosion, GameRefs, SPEED_SCALE, Tracer } from "./systems/types";

/** roof easing per 60 fps frame (the original lerp), applied frame-rate independently */
const ROOF_LERP = 0.15;
/** tree canopy opacity while someone stands under it (original obj_tree1 fades near the player) */
const CANOPY_SEE_THROUGH = 0.35;
/** night light radii (world units): the player's own light and built light sources */
const PLAYER_LIGHT_R = 250;
const LIGHT_R: Record<string, number> = { lamp: 400, lamp_drone: 320, campfire: 300, brazier: 330 };
/** humanoid sprites are 36 × scale wide at the shoulders: scale = hit radius / 18 matches the hitbox */
const HUMANOID_HALF_WIDTH = 18;
/** spitter puddle size (zombieAI) — the landing marker of an acid blob uses it */
const SPIT_MARK_R = 40;
const WHITE = COLORS.white;
const BLACK = COLORS.shadow;

/**
 * Target roof opacity for a building (0 = invisible, 1 = opaque), eased by the caller.
 * Pure inside/outside like the original (par_building:47-57): from the street you never see
 * what waits inside, so every doorway is a gamble.
 * @param playerInside true when the player's position is inside the building's footprint
 */
function roofTargetAlpha(playerInside: boolean): number {
	return playerInside ? 0 : 1;
}

/** frame-rate independent version of `lerp(a, b, perFrame)` tuned at 60 fps */
function ease(perFrame: number, dt: number): number {
	return 1 - math.pow(1 - perFrame, dt * 60);
}

function overlaps(x: number, y: number, w: number, h: number, v: ViewRect): boolean {
	return x < v.maxX && x + w > v.minX && y < v.maxY && y + h > v.minY;
}

function circleInView(x: number, y: number, r: number, v: ViewRect): boolean {
	return x + r > v.minX && x - r < v.maxX && y + r > v.minY && y - r < v.maxY;
}

function zombieColor(t: number): Color3 {
	if (t === 2) return COLORS.zombie2;
	if (t === 3) return COLORS.zombie3;
	if (t === 4) return COLORS.zombie4;
	if (t === 5) return COLORS.zombie5;
	return COLORS.zombie1;
}

function itemColor(kind: number): Color3 {
	if (kind === 1) return COLORS.itemWeapon;
	if (kind === 2) return COLORS.itemEquip;
	if (kind === 3) return COLORS.itemUse;
	return COLORS.item;
}

/** 1 while a blast grows, then fades over its remaining life (0.4 s in zombieAI) */
function explosionFade(e: Explosion): number {
	return e.r < e.rMax ? 1 : clamp(e.life / 0.4, 0, 1);
}

/** outward unit normal of a building wall */
function sideNormal(side: string | undefined): { x: number; y: number } {
	if (side === "top") return { x: 0, y: -1 };
	if (side === "left") return { x: -1, y: 0 };
	if (side === "right") return { x: 1, y: 0 };
	return { x: 0, y: 1 };
}

export class GameLoop {
	/** empty placeholder; the town is generated once, in init() */
	private world: WorldData = createWorld(DESIGN.WORLD_W, DESIGN.WORLD_H);
	private player: PlayerState;
	private save: PlayerSaveData;
	private zombies: Array<ZombieState> = [];
	private bosses: Array<BossState> = [];
	private bullets: Array<Bullet> = [];
	private tracers: Array<Tracer> = [];
	private particles = new ParticleSystem();
	private daynight: DayNight;
	private combat = new Combat();
	private spawner = new Spawner();
	private interaction = new Interaction();
	private build = new BuildSystem();
	private refs: GameRefs;
	private announceQueue: Array<string> = [];

	/** buildings whose roof is (or may be) not fully opaque; eased even off-screen */
	private fadingRoofs = new Set<Solid>();
	private queryBuf: Array<Solid> = [];
	/** player walk cycle (feet) */
	private walkPhase = 0;
	private walkAmp = 0;
	/** shadow direction: sun by day, away from the player's light at night */
	private sunX = 0.7;
	private sunY = 0.7;
	private nightLight = false;
	private clock = 0;
	private lightMap?: LightMap;
	private lights: Array<LightSource> = [];
	/** stuck arrows: the victim's heading when the arrow went in, so it turns with the body */
	private stuckRef = new Map<number, { a: number; seen: number }>();
	private zombieById = new Map<number, ZombieState>();
	private frameNo = 0;

	constructor() {
		const save = getCtx().save;
		this.save = save;
		this.player = createPlayer(save, 0, 0);
		this.daynight = new DayNight(save);
		this.refs = {
			world: this.world,
			player: this.player,
			save: this.save,
			input: undefined as never,
			zombies: this.zombies,
			bosses: this.bosses,
			bullets: this.bullets,
			particles: this.particles,
			daynight: this.daynight,
			tracers: this.tracers,
			pendingPlace: -1,
			announceQueue: this.announceQueue,
			onMessage: () => {},
			onExp: () => {},
		};
	}

	init(save: PlayerSaveData): void {
		this.save = save;
		this.world = generateTown(DESIGN.TOWN_SEED);
		this.fadingRoofs.clear();
		resetEntityIds();
		resetBullets();
		this.zombies.clear();
		this.bosses.clear();
		this.bullets.clear();
		this.tracers.clear();
		this.particles.clear();
		this.announceQueue.clear();
		const spawn = this.findSpawnPoint();
		this.player = createPlayer(save, spawn.x, spawn.y);
		this.daynight = new DayNight(save);
		this.daynight.onAnnounce = msg => {
			this.announceQueue.push(msg);
		};
		const refs = this.refs;
		refs.world = this.world;
		refs.player = this.player;
		refs.save = save;
		refs.input = getCtx().input;
		refs.zombies = this.zombies;
		refs.bosses = this.bosses;
		refs.bullets = this.bullets;
		refs.particles = this.particles;
		refs.daynight = this.daynight;
		refs.tracers = this.tracers;
		refs.pendingPlace = -1;
		refs.announceQueue = this.announceQueue;
		refs.onMessage = msg => {
			print(msg);
		};
		refs.onExp = amount => {
			save.exp += amount;
			while (save.exp >= expMaxInit(save.level)) {
				save.exp -= expMaxInit(save.level);
				save.level++;
				save.skillPoint++;
			}
		};
		const ctx = getCtx();
		ctx.cam.x = this.player.x;
		ctx.cam.y = this.player.y;
	}

	/** Start on a street near the centre of town: never inside a building, a car or a tree. */
	private findSpawnPoint(): { x: number; y: number } {
		const w = this.world;
		const cx = w.width / 2;
		const cy = w.height / 2;
		for (let i = 0; i < 200; i++) {
			const p = randomOpenPoint(w, cx - 1400, cy - 1400, cx + 1400, cy + 1400);
			if (
				isOnRoad(w, p.x, p.y) &&
				buildingAt(w, p.x, p.y) === undefined &&
				rectHitsSolid(w, p.x, p.y, 80, 80) === undefined
			) {
				return p;
			}
		}
		return randomOpenPoint(w, cx - 800, cy - 800, cx + 800, cy + 800);
	}

	private updatePlayer(dt: number): void {
		const ctx = getCtx();
		const p = this.player;
		const save = this.save;
		const input = ctx.input;
		syncKeyboardMove();
		p.angle = input.aimAngle;

		// input is screen-space; in top-down it maps 1:1 to world (camera rotation undone)
		let wdx = 0;
		let wdy = 0;
		if (input.moveMagnitude > 0) {
			const d = ctx.cam.screenDirToWorld(input.moveX, input.moveY);
			const l = math.sqrt(d.x * d.x + d.y * d.y);
			if (l > 0.0001) {
				wdx = d.x / l;
				wdy = d.y / l;
			}
		}
		const speed = recalcMoveSpeed(p, save) * SPEED_SCALE;
		const rx = math.cos(p.reactionDir) * p.reactionSpeed * SPEED_SCALE;
		const ry = math.sin(p.reactionDir) * p.reactionSpeed * SPEED_SCALE;
		if (p.reactionSpeed > 0) {
			p.reactionSpeed = math.max(0, p.reactionSpeed - DESIGN.REACTION_FRICTION * dt);
		}
		const mvx = wdx * speed + rx;
		const mvy = wdy * speed + ry;
		const res = moveActor(this.world, p.x, p.y, PLAYER_RADIUS, mvx * dt, mvy * dt);
		const moved = math.sqrt((res.x - p.x) * (res.x - p.x) + (res.y - p.y) * (res.y - p.y));
		p.x = clamp(res.x, 40, this.world.width - 40);
		p.y = clamp(res.y, 40, this.world.height - 40);
		const walking = moved > 0.05 && (wdx !== 0 || wdy !== 0);
		this.walkPhase += moved * 0.09;
		this.walkAmp = lerp(this.walkAmp, walking ? 1 : 0, ease(0.25, dt));

		const hungerRate = 1 - save.skillLevels[8] / 3;
		p.hungry = math.max(0, p.hungry - 0.01 * 30 * hungerRate * dt);
		if (p.hungry <= 0) {
			p.hp -= 0.02 * 30 * dt;
		} else if (p.hp < p.hpMax) {
			p.hp = math.min(p.hpMax, p.hp + 0.04 * 30 * (1 + save.skillLevels[1]) * dt);
		}
		if (p.buffs.poison > 0) {
			p.buffs.poison -= dt;
			p.hp -= 0.06 * 30 * (save.skillLevels[20] > 0 ? 0.5 : 1) * dt;
		}
		if (p.buffs.speed > 0) p.buffs.speed -= dt;
		if (p.buffs.calm > 0) p.buffs.calm -= dt;
		if (p.buffs.pain > 0) p.buffs.pain -= dt;
		if (p.attacked) {
			p.iframe -= dt;
			if (p.iframe <= 0) {
				p.attacked = false;
				p.iframe = 0;
			}
		}
		if (p.hp <= 0 && !p.dead) {
			p.hp = 0;
			p.dead = true;
			getCtx().phase = "dead";
		}
	}

	update(dt: number): void {
		const ctx = getCtx();
		const refs = this.refs;
		if (this.player.dead) return;
		this.clock += dt;
		const handled = this.build.handleInput(refs, ctx.input);
		if (!handled && ctx.input.actionPressed) {
			this.interaction.tryInteract(refs);
		}
		this.build.update(refs);
		this.updatePlayer(dt);
		this.combat.update(refs, dt);
		updateZombies(refs, dt);
		updateBosses(refs, dt);
		this.spawner.update(refs, dt);
		this.daynight.update(dt);
		while (this.announceQueue.size() > 0) {
			refs.onMessage(this.announceQueue.remove(0)!);
		}
		this.particles.update(dt);
		updateGroundItems(this.world, dt);
		this.interaction.update(refs, dt);
		ctx.cam.follow(this.player.x, this.player.y, math.min(1, dt * 8));
		ctx.cam.update(dt);
		this.updateWorldFx(ctx.cam, dt);
		ctx.input.beginFrame();
	}

	// ------------------------------------------------------------------ roofs, canopies, shake

	/**
	 * Roofs and tree canopies around the view (grid query, no full scan).
	 * hitShake is only READ here (drawing); its countdown belongs to the AI/combat systems.
	 */
	private updateWorldFx(cam: Camera, dt: number): void {
		const v = cam.viewRect(400);
		const list = this.queryBuf;
		list.clear();
		querySolids(this.world, v.minX, v.minY, v.maxX, v.maxY, list);
		for (const s of list) {
			if (s.kind === "building") {
				this.fadingRoofs.add(s);
			} else if (s.kind === "tree") {
				this.updateCanopy(s, dt);
			}
		}
		const p = this.player;
		for (const s of this.fadingRoofs) {
			const inside = p.x >= s.x && p.x <= s.x + s.w && p.y >= s.y && p.y <= s.y + s.h;
			const target = clamp(roofTargetAlpha(inside), 0, 1);
			const a = lerp(s.roofAlpha ?? 1, target, ease(ROOF_LERP, dt));
			if (target >= 1 && a > 0.995) {
				s.roofAlpha = 1;
				this.fadingRoofs.delete(s);
			} else {
				s.roofAlpha = a;
			}
		}
	}

	private updateCanopy(s: Solid, dt: number): void {
		const cx = s.x + s.w / 2;
		const cy = s.y + s.h / 2;
		// any part of a body (≈18 px radius) under the canopy counts: nobody hides half-covered
		const r = (s.canopyR ?? 80) + 18;
		const r2 = r * r;
		let under = false;
		const p = this.player;
		if ((p.x - cx) * (p.x - cx) + (p.y - cy) * (p.y - cy) < r2) {
			under = true;
		} else {
			for (const z of this.zombies) {
				if (z.hp > 0 && (z.x - cx) * (z.x - cx) + (z.y - cy) * (z.y - cy) < r2) {
					under = true;
					break;
				}
			}
			if (!under) {
				for (const b of this.bosses) {
					if ((b.x - cx) * (b.x - cx) + (b.y - cy) * (b.y - cy) < r2) {
						under = true;
						break;
					}
				}
			}
		}
		const target = under ? CANOPY_SEE_THROUGH : 1;
		s.canopyAlpha = lerp(s.canopyAlpha ?? 1, target, ease(0.2, dt));
	}

	// ------------------------------------------------------------------ drawing helpers

	private updateShadowDir(): void {
		const t = this.daynight.dayTime;
		if (t > 6 && t < 18) {
			// original: lengthdir(len, day_time/24*360 - 180 - 45) (GameMaker y is flipped)
			const rad = math.rad((t / 24) * 360 - 225);
			this.sunX = math.cos(rad);
			this.sunY = -math.sin(rad);
			this.nightLight = false;
		} else {
			this.nightLight = true;
		}
	}

	/** where a shadow of length `len` falls for something at (x, y) */
	private shadowOffset(x: number, y: number, len: number): { x: number; y: number } {
		if (this.nightLight) {
			const dx = x - this.player.x;
			const dy = y - this.player.y;
			const d = math.sqrt(dx * dx + dy * dy);
			if (d < 1) return { x: 0, y: len * 0.5 };
			return { x: (dx / d) * len, y: (dy / d) * len };
		}
		return { x: this.sunX * len, y: this.sunY * len };
	}

	/** axis-aligned square rect clipped to the view (huge roads / lots never become huge Frames) */
	private drawClipped(
		r: Renderer,
		cam: Camera,
		x: number,
		y: number,
		w: number,
		h: number,
		v: ViewRect,
		opts: SpriteOpts,
	): void {
		const x0 = math.max(x, v.minX);
		const y0 = math.max(y, v.minY);
		const x1 = math.min(x + w, v.maxX);
		const y1 = math.min(y + h, v.maxY);
		if (x1 <= x0 || y1 <= y0) return;
		opts.w = x1 - x0;
		opts.h = y1 - y0;
		r.drawRect(cam, (x0 + x1) / 2, (y0 + y1) / 2, opts);
	}

	/** rect in an object's local frame (fwd along `a`, lat to its right) */
	private part(
		r: Renderer,
		cam: Camera,
		cx: number,
		cy: number,
		a: number,
		fwd: number,
		lat: number,
		opts: SpriteOpts,
	): void {
		const fx = math.cos(a);
		const fy = math.sin(a);
		opts.rotation = a;
		r.drawRect(cam, cx + fx * fwd - fy * lat, cy + fy * fwd + fx * lat, opts);
	}

	// ------------------------------------------------------------------ ground

	private drawGround(r: Renderer, cam: Camera, v: ViewRect): void {
		const w = this.world;
		for (const lot of w.lots) {
			if (!overlaps(lot.x, lot.y, lot.w, lot.h, v)) continue;
			const y = lot.yard;
			if (y.x !== lot.x || y.y !== lot.y || y.w !== lot.w || y.h !== lot.h) {
				this.drawClipped(r, cam, lot.x, lot.y, lot.w, lot.h, v, {
					color: COLORS.sidewalk,
					zIndex: Z.ground,
				});
			}
			this.drawClipped(r, cam, y.x, y.y, y.w, y.h, v, {
				color: lot.kind === "park" ? COLORS.parkGrass : COLORS.grass,
				zIndex: Z.ground + 1,
			});
			for (const p of lot.patches) {
				if (!overlaps(p.x, p.y, p.w, p.h, v)) continue;
				// lighter, low-contrast tufts: a dark rounded blob here reads as the shadow of nothing
				r.drawRect(cam, p.x + p.w / 2, p.y + p.h / 2, {
					w: p.w,
					h: p.h,
					color: COLORS.grassLight,
					alpha: 0.3,
					cornerRadius: math.min(p.w, p.h) / 2,
					zIndex: Z.ground + 2,
				});
			}
			for (const p of lot.paths) {
				this.drawClipped(r, cam, p.x, p.y, p.w, p.h, v, {
					color: COLORS.dirtPath,
					alpha: 0.85,
					zIndex: Z.ground + 2,
				});
			}
		}
		for (const road of w.roads) {
			if (!overlaps(road.x, road.y, road.w, road.h, v)) continue;
			this.drawClipped(r, cam, road.x, road.y, road.w, road.h, v, { color: COLORS.road, zIndex: Z.road });
			const vertical = road.h > road.w;
			const curb = 6;
			if (vertical) {
				this.drawClipped(r, cam, road.x, road.y, curb, road.h, v, { color: COLORS.curb, zIndex: Z.roadLine });
				this.drawClipped(r, cam, road.x + road.w - curb, road.y, curb, road.h, v, {
					color: COLORS.curb,
					zIndex: Z.roadLine,
				});
			} else {
				this.drawClipped(r, cam, road.x, road.y, road.w, curb, v, { color: COLORS.curb, zIndex: Z.roadLine });
				this.drawClipped(r, cam, road.x, road.y + road.h - curb, road.w, curb, v, {
					color: COLORS.curb,
					zIndex: Z.roadLine,
				});
			}
			// dashed centre line, skipped inside intersections
			const period = 160;
			const dash = 64;
			const a0 = vertical ? math.max(road.y, v.minY) : math.max(road.x, v.minX);
			const a1 = vertical ? math.min(road.y + road.h, v.maxY) : math.min(road.x + road.w, v.maxX);
			const mid = vertical ? road.x + road.w / 2 : road.y + road.h / 2;
			for (let t = math.floor(a0 / period) * period; t < a1; t += period) {
				let crossing = false;
				for (const o of w.roads) {
					if (o === road || o.h > o.w === vertical) continue;
					const o0 = vertical ? o.y : o.x;
					const o1 = o0 + (vertical ? o.h : o.w);
					if (t + dash > o0 - 40 && t < o1 + 40) {
						crossing = true;
						break;
					}
				}
				if (crossing) continue;
				r.drawRect(cam, vertical ? mid : t + dash / 2, vertical ? t + dash / 2 : mid, {
					w: vertical ? 5 : dash,
					h: vertical ? dash : 5,
					color: COLORS.roadLine,
					alpha: 0.7,
					zIndex: Z.roadLine,
				});
			}
		}
	}

	private drawDecals(r: Renderer, cam: Camera, v: ViewRect): void {
		this.particles.forDecals(d => {
			if (!circleInView(d.x, d.y, d.size, v)) return;
			r.drawCircle(cam, d.x, d.y, d.size, {
				color: d.color,
				alpha: 0.7 * math.min(1, d.life / 5),
				zIndex: Z.decal,
			});
		});
		const puddles = this.refs.puddles;
		if (puddles !== undefined) {
			for (const pd of puddles) {
				if (!circleInView(pd.x, pd.y, pd.r, v)) continue;
				const k = clamp(pd.life / math.max(0.001, pd.lifeMax), 0, 1);
				r.drawCircle(cam, pd.x, pd.y, pd.r * 2, {
					color: COLORS.acid,
					alpha: 0.45 * k,
					stroke: COLORS.bloodZombie,
					strokeAlpha: 0.6 * k,
					zIndex: Z.decal + 1,
				});
			}
		}
	}

	private drawItems(r: Renderer, cam: Camera, v: ViewRect): void {
		for (const it of this.world.items) {
			if (!circleInView(it.x, it.y, 20, v)) continue;
			const bob = math.sin(this.clock * 3 + it.id) * 2;
			r.drawCircle(cam, it.x, it.y + 7, 16, { color: BLACK, alpha: 0.25, zIndex: Z.actorShadow });
			r.drawRect(cam, it.x, it.y - 2 + bob, {
				w: 16,
				h: 16,
				color: itemColor(it.kind),
				cornerRadius: 4,
				stroke: WHITE,
				strokeThickness: 1,
				strokeAlpha: 0.7,
				zIndex: Z.item,
			});
		}
	}

	// ------------------------------------------------------------------ solids

	private drawSolids(r: Renderer, cam: Camera, v: ViewRect): void {
		const list = this.queryBuf;
		list.clear();
		// pad: canopies reach ~90 px past the trunk, shadows ~20 px past their caster
		querySolids(this.world, v.minX - 140, v.minY - 140, v.maxX + 140, v.maxY + 140, list);
		for (const s of list) {
			if (s.kind === "building") {
				if (overlaps(s.x - 30, s.y - 30, s.w + 60, s.h + 60, v)) this.drawBuilding(r, cam, s, v);
			} else if (s.tags === "border") {
				this.drawBorder(r, cam, s, v);
			} else if (s.kind === "tree") {
				this.drawTree(r, cam, s, v);
			} else if (overlaps(s.x - 16, s.y - 16, s.w + 32, s.h + 32, v)) {
				if (s.tags === "bwall") this.drawWall(r, cam, s);
				else if (s.kind === "car" && s.tags === "trash") this.drawTrash(r, cam, s);
				else if (s.kind === "car") this.drawCar(r, cam, s);
				else this.drawStructure(r, cam, s);
			}
		}
	}

	private shake(s: Solid): { x: number; y: number } {
		const t = s.hitShake ?? 0;
		if (t <= 0) return { x: 0, y: 0 };
		const amp = 4 * math.min(1, t / 0.25);
		return { x: math.sin(this.clock * 70) * amp, y: math.cos(this.clock * 55) * amp * 0.6 };
	}

	private drawBuilding(r: Renderer, cam: Camera, s: Solid, v: ViewRect): void {
		const cx = s.x + s.w / 2;
		const cy = s.y + s.h / 2;
		const roofA = s.roofAlpha ?? 1;
		const bt = s.buildingType ?? 1;
		const isHouse = bt === 1 || bt === 2;
		// building shadow (the roof's, like the original: 0.3 * roof_alpha)
		const so = this.shadowOffset(cx, cy, 20);
		if (overlaps(s.x + so.x, s.y + so.y, s.w, s.h, v)) {
			r.drawRect(cam, cx + so.x, cy + so.y, {
				w: s.w,
				h: s.h,
				color: BLACK,
				alpha: 0.3 * math.max(roofA, 0.4),
				zIndex: Z.shadow,
			});
		}
		// floor (visible through the doorway / when the roof fades)
		r.drawRect(cam, cx, cy, {
			w: s.w,
			h: s.h,
			color: isHouse ? COLORS.floorWood : bt === 4 || bt === 6 ? COLORS.floorTile : COLORS.floorShop,
			stroke: BLACK,
			strokeAlpha: 0.25,
			strokeThickness: 2,
			zIndex: Z.floor,
		});
		// doormat just outside the door: shows the entrance even with the roof closed
		const n = sideNormal(s.doorSide);
		const dx = s.doorX ?? cx;
		const dy = s.doorY ?? s.y + s.h;
		const matOff = TOWN.WALL_T / 2 + 14;
		r.drawRect(cam, dx + n.x * matOff, dy + n.y * matOff, {
			w: n.x !== 0 ? 22 : TOWN.DOOR_W - 24,
			h: n.x !== 0 ? TOWN.DOOR_W - 24 : 22,
			color: COLORS.doormat,
			cornerRadius: 3,
			zIndex: Z.floorDetail,
		});
		if (roofA <= 0.01) return;
		const roof = s.roofColor ?? COLORS.roofGray;
		const roofDark = roof.Lerp(BLACK, 0.3);
		r.drawRect(cam, cx, cy, {
			w: s.w,
			h: s.h,
			color: roof,
			alpha: roofA,
			stroke: roofDark,
			strokeThickness: 3,
			strokeAlpha: roofA,
			zIndex: Z.roof,
		});
		if (isHouse) {
			// ridge along the long axis
			const alongX = s.w >= s.h;
			r.drawRect(cam, cx, cy, {
				w: alongX ? s.w - 80 : 12,
				h: alongX ? 12 : s.h - 80,
				color: roofDark,
				alpha: roofA * 0.8,
				zIndex: Z.roof + 1,
			});
		} else {
			// flat roof: a/c box
			r.drawRect(cam, cx + s.w * 0.22, cy - s.h * 0.2, {
				w: 90,
				h: 70,
				color: roof.Lerp(WHITE, 0.25),
				alpha: roofA,
				stroke: roofDark,
				strokeAlpha: roofA,
				zIndex: Z.roof + 1,
			});
		}
		// darker eave over the doorway: the entrance reads from above
		const ex = dx + n.x * (TOWN.WALL_T / 2 - 6);
		const ey = dy + n.y * (TOWN.WALL_T / 2 - 6);
		r.drawRect(cam, ex, ey, {
			w: n.x !== 0 ? 12 : TOWN.DOOR_W,
			h: n.x !== 0 ? TOWN.DOOR_W : 12,
			color: roofDark.Lerp(BLACK, 0.3),
			alpha: roofA,
			zIndex: Z.roof + 1,
		});
		this.drawEmblem(r, cam, bt, cx, cy, roofA);
	}

	/** rooftop sign so shops can be found from afar */
	private drawEmblem(r: Renderer, cam: Camera, bt: number, cx: number, cy: number, a: number): void {
		const z = Z.roof + 2;
		if (bt === 4 || bt === 6) {
			const plate = bt === 4 ? 150 : 110;
			const crossColor = bt === 4 ? COLORS.uiRed : COLORS.uiGreen;
			r.drawRect(cam, cx, cy, { w: plate, h: plate, color: WHITE, alpha: a, cornerRadius: 12, zIndex: z });
			r.drawRect(cam, cx, cy, { w: plate * 0.72, h: plate * 0.24, color: crossColor, alpha: a, zIndex: z + 1 });
			r.drawRect(cam, cx, cy, { w: plate * 0.24, h: plate * 0.72, color: crossColor, alpha: a, zIndex: z + 1 });
		} else if (bt === 9) {
			r.drawCircle(cam, cx, cy, 110, {
				color: COLORS.uiPanel,
				alpha: a,
				stroke: COLORS.uiRed,
				strokeThickness: 4,
				strokeAlpha: a,
				zIndex: z,
			});
			r.drawRect(cam, cx, cy, { w: 120, h: 8, color: COLORS.uiRed, alpha: a, zIndex: z + 1 });
			r.drawRect(cam, cx, cy, { w: 8, h: 120, color: COLORS.uiRed, alpha: a, zIndex: z + 1 });
		} else if (bt === 5) {
			r.drawCircle(cam, cx, cy, 90, { color: COLORS.uiRed, alpha: a, zIndex: z });
			r.drawRect(cam, cx, cy, { w: 30, h: 44, color: WHITE, alpha: a, cornerRadius: 6, zIndex: z + 1 });
		} else if (bt === 7 || bt === 8 || bt === 11 || bt === 10 || bt === 3) {
			const accent = bt === 3 ? COLORS.uiYellow : bt === 11 ? WHITE : bt === 10 ? COLORS.uiBlue : COLORS.uiGreen;
			r.drawRect(cam, cx, cy, {
				w: 160,
				h: 56,
				color: COLORS.uiPanel,
				alpha: a,
				cornerRadius: 8,
				stroke: accent,
				strokeThickness: 3,
				strokeAlpha: a,
				zIndex: z,
			});
			r.drawRect(cam, cx, cy, { w: 110, h: 10, color: accent, alpha: a, zIndex: z + 1 });
		}
	}

	private drawWall(r: Renderer, cam: Camera, s: Solid): void {
		r.drawRect(cam, s.x + s.w / 2, s.y + s.h / 2, {
			w: s.w,
			h: s.h,
			color: COLORS.wallHouse,
			stroke: COLORS.wallWood,
			strokeThickness: 1,
			strokeAlpha: 0.8,
			zIndex: Z.structure,
		});
	}

	private drawBorder(r: Renderer, cam: Camera, s: Solid, v: ViewRect): void {
		this.drawClipped(r, cam, s.x, s.y, s.w, s.h, v, { color: COLORS.borderForest, zIndex: Z.structure });
		// fence along the inner edge
		const f = 8;
		let fx = s.x;
		let fy = s.y;
		let fw = s.w;
		let fh = s.h;
		if (s.w > s.h) {
			fh = f;
			fy = s.y === 0 ? s.y + s.h - f : s.y;
		} else {
			fw = f;
			fx = s.x === 0 ? s.x + s.w - f : s.x;
		}
		this.drawClipped(r, cam, fx, fy, fw, fh, v, { color: COLORS.fence, zIndex: Z.structure + 1 });
	}

	private drawTree(r: Renderer, cam: Camera, s: Solid, v: ViewRect): void {
		const sh = this.shake(s);
		const cx = s.x + s.w / 2 + sh.x;
		const cy = s.y + s.h / 2 + sh.y;
		const rad = s.canopyR ?? 80;
		if (!circleInView(cx, cy, rad + 24, v)) return;
		const a = s.canopyAlpha ?? 1;
		const leaf = s.tint ?? COLORS.treeLeaf;
		const so = this.shadowOffset(cx, cy, 18);
		r.drawCircle(cam, cx + so.x, cy + so.y, rad * 1.8, { color: BLACK, alpha: 0.22, zIndex: Z.shadow });
		r.drawCircle(cam, cx, cy, s.w, {
			color: COLORS.treeTrunk,
			stroke: COLORS.treeTrunk.Lerp(BLACK, 0.4),
			strokeThickness: 2,
			zIndex: Z.structure,
		});
		r.drawCircle(cam, cx, cy, rad * 2, {
			color: leaf,
			alpha: a,
			stroke: COLORS.treeLeafDark,
			strokeThickness: 2,
			strokeAlpha: a * 0.7,
			zIndex: Z.canopy,
		});
		r.drawCircle(cam, cx - rad * 0.22, cy - rad * 0.22, rad * 1.1, {
			color: leaf.Lerp(COLORS.grassLight.Lerp(COLORS.treeLeafLight, 0.5), 0.6),
			alpha: a * a,
			zIndex: Z.canopy + 1,
		});
	}

	private drawCar(r: Renderer, cam: Camera, s: Solid): void {
		const sh = this.shake(s);
		const cx = s.x + s.w / 2 + sh.x;
		const cy = s.y + s.h / 2 + sh.y;
		const vertical = s.h > s.w;
		const L = vertical ? s.h : s.w;
		const W = vertical ? s.w : s.h;
		// heading picked from the position hash: parked either way along the lane
		const flip = math.floor(s.x + s.y) % 2 === 0;
		const a = (vertical ? math.pi / 2 : 0) + (flip ? math.pi : 0);
		const paint = s.tint ?? COLORS.car;
		const so = this.shadowOffset(cx, cy, 10);
		r.drawRect(cam, cx + so.x, cy + so.y, {
			w: s.w,
			h: s.h,
			color: BLACK,
			alpha: 0.35,
			cornerRadius: 18,
			zIndex: Z.shadow,
		});
		this.part(r, cam, cx, cy, a, 0, 0, {
			w: L,
			h: W,
			color: paint,
			cornerRadius: 18,
			stroke: paint.Lerp(BLACK, 0.45),
			strokeThickness: 2,
			zIndex: Z.structure,
		});
		this.part(r, cam, cx, cy, a, -L * 0.04, 0, {
			w: L * 0.44,
			h: W * 0.8,
			color: paint.Lerp(BLACK, 0.25),
			cornerRadius: 10,
			zIndex: Z.structure + 1,
		});
		this.part(r, cam, cx, cy, a, L * 0.2, 0, {
			w: L * 0.1,
			h: W * 0.72,
			color: COLORS.carGlass,
			cornerRadius: 4,
			zIndex: Z.structure + 2,
		});
		this.part(r, cam, cx, cy, a, -L * 0.28, 0, {
			w: L * 0.07,
			h: W * 0.66,
			color: COLORS.carGlass,
			cornerRadius: 4,
			zIndex: Z.structure + 2,
		});
		for (const side of [-1, 1]) {
			this.part(r, cam, cx, cy, a, L * 0.47, side * W * 0.3, {
				w: 8,
				h: 18,
				color: COLORS.carLight,
				cornerRadius: 3,
				zIndex: Z.structure + 2,
			});
			this.part(r, cam, cx, cy, a, -L * 0.48, side * W * 0.3, {
				w: 6,
				h: 16,
				color: COLORS.carTail,
				cornerRadius: 2,
				zIndex: Z.structure + 2,
			});
		}
	}

	private drawTrash(r: Renderer, cam: Camera, s: Solid): void {
		const sh = this.shake(s);
		const cx = s.x + s.w / 2 + sh.x;
		const cy = s.y + s.h / 2 + sh.y;
		const so = this.shadowOffset(cx, cy, 7);
		r.drawRect(cam, cx + so.x, cy + so.y, {
			w: s.w,
			h: s.h,
			color: BLACK,
			alpha: 0.3,
			cornerRadius: 6,
			zIndex: Z.shadow,
		});
		r.drawRect(cam, cx, cy, {
			w: s.w,
			h: s.h,
			color: COLORS.trashBin,
			cornerRadius: 6,
			stroke: COLORS.trashBin.Lerp(BLACK, 0.5),
			strokeThickness: 2,
			zIndex: Z.structure,
		});
		r.drawRect(cam, cx, cy, {
			w: s.w - 8,
			h: s.h - 8,
			color: COLORS.trashLid,
			cornerRadius: 5,
			zIndex: Z.structure + 1,
		});
		r.drawRect(cam, cx, cy, {
			w: 14,
			h: 4,
			color: COLORS.trashBin.Lerp(BLACK, 0.4),
			zIndex: Z.structure + 2,
		});
	}

	private structureColor(s: Solid): Color3 {
		if (s.kind === "wall_h" || s.kind === "wall_v") return COLORS.wallWood;
		if (s.kind === "door") return COLORS.door;
		if (s.kind === "iron_door") return COLORS.ironDoor;
		if (s.kind === "barricade") return COLORS.barricade;
		if (s.kind === "iron_barricade") return COLORS.ironBarricade;
		if (s.tags === "turret" || s.tags === "electric_turret") return COLORS.turret;
		if (s.tags === "trap" || s.tags === "trap_electric") return COLORS.trap;
		if (s.tags === "lamp") return COLORS.lamp;
		if (s.tags === "campfire" || s.tags === "brazier") return COLORS.campfire;
		if (s.tags === "generator" || s.tags === "battery") return COLORS.uiBlue;
		return COLORS.uiPanelLight;
	}

	/** player-built structures (doors, barricades, turrets, traps, desks...) */
	private drawStructure(r: Renderer, cam: Camera, s: Solid): void {
		const sh = this.shake(s);
		const cx = s.x + s.w / 2 + sh.x;
		const cy = s.y + s.h / 2 + sh.y;
		const isTrap = s.tags === "trap" || s.tags === "trap_electric";
		const isDoor = s.kind === "door" || s.kind === "iron_door";
		const color = this.structureColor(s);
		if (!isTrap) {
			const so = this.shadowOffset(cx, cy, 8);
			r.drawRect(cam, cx + so.x, cy + so.y, { w: s.w, h: s.h, color: BLACK, alpha: 0.3, zIndex: Z.shadow });
		}
		r.drawRect(cam, cx, cy, {
			w: s.w,
			h: s.h,
			color,
			alpha: isDoor && s.open === true ? 0.35 : 1,
			stroke: color.Lerp(BLACK, 0.45),
			strokeThickness: 2,
			cornerRadius: isTrap ? 8 : 0,
			// traps lie flat on the floor: zombies walk over them
			zIndex: isTrap ? Z.item : Z.structure,
		});
		if (s.powered === true && (s.tags === "lamp" || s.tags === "campfire" || s.tags === "brazier")) {
			r.drawCircle(cam, cx, cy, math.min(s.w, s.h) * 0.5, {
				color: COLORS.lamp,
				alpha: 0.6 + math.sin(this.clock * 9) * 0.2,
				zIndex: Z.structure + 1,
			});
		}
		if (s.destructible && s.hp < s.hpMax && s.hpMax < 99999) {
			const k = clamp(s.hp / s.hpMax, 0, 1);
			const bw = math.max(40, s.w * 0.8);
			const by = s.y - 10;
			r.drawRect(cam, cx, by, { w: bw, h: 6, color: BLACK, alpha: 0.6, zIndex: Z.actorFx });
			r.drawRect(cam, cx - (bw * (1 - k)) / 2, by, {
				w: math.max(1, bw * k),
				h: 4,
				color: COLORS.uiRed.Lerp(COLORS.uiGreen, k),
				zIndex: Z.actorFx + 1,
			});
		}
	}

	// ------------------------------------------------------------------ actors

	/**
	 * Top-down humanoid (zombies, boss 3): 2 animated feet, body, 2 arms reaching forward, head.
	 * All offsets are in world space: forward f = (cos a, sin a), lateral l = (-f.y, f.x).
	 */
	private drawHumanoid(
		r: Renderer,
		cam: Camera,
		x: number,
		y: number,
		a: number,
		sc: number,
		color: Color3,
		flash: number,
		alpha: number,
		phase: number,
		z: number,
		windup = 0,
		outline?: Color3,
	): void {
		const body = flash > 0 ? color.Lerp(WHITE, 0.75 * flash) : color;
		const dark = color.Lerp(BLACK, 0.3);
		const edge = outline ?? (flash > 0 ? WHITE : dark);
		const step = math.sin(phase) * 8 * sc;
		for (const side of [-1, 1]) {
			const along = step * side;
			this.part(r, cam, x, y, a, along, side * 9 * sc, {
				w: 12 * sc,
				h: 9 * sc,
				color: COLORS.zombieFeet,
				alpha,
				cornerRadius: 3 * sc,
				zIndex: z,
			});
			// arms reach straight ahead, swaying a little with the gait
			this.part(r, cam, x, y, a, 22 * sc - along * 0.25, side * 12 * sc, {
				w: 24 * sc,
				h: 7 * sc,
				color: flash > 0 ? body : dark,
				alpha,
				cornerRadius: 3 * sc,
				zIndex: z + 1,
			});
		}
		this.part(r, cam, x, y, a, 0, 0, {
			w: 26 * sc,
			h: 36 * sc,
			color: body,
			alpha,
			cornerRadius: 9 * sc,
			stroke: edge,
			strokeThickness: flash > 0 || outline !== undefined ? 3 : 1.5,
			strokeAlpha: alpha,
			zIndex: z + 2,
		});
		// head; a spitter winding up (windup 0..10) pulls it back and swells its acid sac
		const k = clamp(windup / 10, 0, 1);
		const headFwd = (3 - 9 * k) * sc;
		let headColor = flash > 0 ? body : color.Lerp(BLACK, 0.12);
		if (k > 0) headColor = headColor.Lerp(COLORS.acid, 0.7 * k);
		r.drawCircle(cam, x + math.cos(a) * headFwd, y + math.sin(a) * headFwd, 20 * sc * (1 + 0.4 * k), {
			color: headColor,
			alpha,
			stroke: k > 0 ? COLORS.bloodZombie : undefined,
			strokeThickness: 2,
			strokeAlpha: alpha * k,
			zIndex: z + 3,
		});
	}

	private drawZombies(r: Renderer, cam: Camera, v: ViewRect): void {
		const up = cam.screenDirToWorld(0, -1);
		for (const zb of this.zombies) {
			const rad = zombieRadius(zb);
			if (!circleInView(zb.x, zb.y, rad * 3.5 + 40, v)) continue;
			const alpha = clamp(zb.alpha, 0, 1);
			if (alpha <= 0.01) continue;
			const sc = rad / HUMANOID_HALF_WIDTH;
			// jumper: the body rises (0..28) and grows a little; the shadow stays on the ground
			const lift = math.max(0, zb.jumpHeight ?? 0);
			const liftScale = 1 + lift / 100;
			const so = this.shadowOffset(zb.x, zb.y, 10);
			r.drawCircle(cam, zb.x + so.x, zb.y + so.y, (rad * 2.1) / liftScale, {
				color: BLACK,
				alpha: 0.3 * alpha * (1 - lift / 70),
				zIndex: Z.actorShadow,
			});
			let color = zombieColor(zb.type);
			let outline: Color3 | undefined;
			const fuse = zb.fuse ?? -1;
			if (zb.type === 3 && fuse > 0) {
				// lit fuse: red blink that accelerates as it burns (frequency ∝ 1 / time left)
				if (math.sin(math.pi * 2 * 3 * math.log(fuse + 0.1)) > 0) {
					color = color.Lerp(COLORS.uiRed, 0.8);
					outline = COLORS.uiYellow;
				}
			}
			const bx = zb.x + up.x * lift;
			const by = zb.y + up.y * lift;
			const standing = zb.hp > 0 || fuse > 0;
			this.drawHumanoid(
				r,
				cam,
				bx,
				by,
				zb.angleSlow,
				sc * liftScale,
				color,
				clamp(zb.hitFlash ?? 0, 0, 1),
				alpha,
				zb.feetCycle ?? 0,
				standing ? Z.zombie : Z.zombie - 5,
				zb.type === 2 ? (zb.headX ?? 0) : 0,
				outline,
			);
			if (zb.detectShow > 0 && zb.hp > 0) {
				// "!" made of two rects, always upright on screen
				const k = math.min(1, zb.detectShow * 4);
				const hx = zb.x + up.x * (rad * 2.6 + lift);
				const hy = zb.y + up.y * (rad * 2.6 + lift);
				r.drawRect(cam, hx + up.x * 6, hy + up.y * 6, {
					w: 6,
					h: 16,
					color: COLORS.detect,
					alpha: k,
					rotation: -cam.angle,
					stroke: BLACK,
					strokeThickness: 1,
					strokeAlpha: k * 0.6,
					zIndex: Z.actorFx,
				});
				r.drawRect(cam, hx - up.x * 8, hy - up.y * 8, {
					w: 6,
					h: 6,
					color: COLORS.detect,
					alpha: k,
					rotation: -cam.angle,
					stroke: BLACK,
					strokeThickness: 1,
					strokeAlpha: k * 0.6,
					zIndex: Z.actorFx,
				});
			}
		}
	}

	private drawPlayer(r: Renderer, cam: Camera): void {
		const p = this.player;
		const a = p.angle;
		const so = this.shadowOffset(p.x, p.y, 10);
		r.drawCircle(cam, p.x + so.x, p.y + so.y, 38, { color: BLACK, alpha: 0.3, zIndex: Z.actorShadow });
		const flash = clamp(p.hitFlash ?? 0, 0, 1);
		let body = p.buffs.poison > 0 ? COLORS.zombie5 : COLORS.player;
		if (flash > 0) body = body.Lerp(COLORS.uiRed, 0.85 * flash);
		const dark = COLORS.playerDark;
		// feet
		const step = math.sin(this.walkPhase) * 8 * this.walkAmp;
		for (const side of [-1, 1]) {
			this.part(r, cam, p.x, p.y, a, step * side, side * 9, {
				w: 12,
				h: 9,
				color: dark.Lerp(BLACK, 0.4),
				cornerRadius: 3,
				zIndex: Z.player,
			});
		}
		// weapon + hands
		const w = currentWeapon(p);
		const hands: Array<{ f: number; l: number }> = [];
		if (w.kind === WeaponKind.Melee) {
			const reach = p.swingReach ?? 46;
			if (p.swingerActive) {
				const sa = p.swingerAngle;
				// motion trail, then the blade itself
				for (const t of [
					{ o: -0.5, al: 0.15 },
					{ o: -0.25, al: 0.3 },
				]) {
					const ta = sa + t.o;
					r.drawSegment(
						cam,
						p.x + math.cos(ta) * 16,
						p.y + math.sin(ta) * 16,
						p.x + math.cos(ta) * reach,
						p.y + math.sin(ta) * reach,
						{ h: 8, color: WHITE, alpha: t.al, zIndex: Z.player + 1 },
					);
				}
				r.drawSegment(
					cam,
					p.x + math.cos(sa) * 14,
					p.y + math.sin(sa) * 14,
					p.x + math.cos(sa) * reach,
					p.y + math.sin(sa) * reach,
					{ h: 6, color: COLORS.blade, stroke: COLORS.weapon, strokeThickness: 1, zIndex: Z.player + 1 },
				);
				hands.push({ f: 16 * math.cos(sa - a), l: 16 * math.sin(sa - a) });
				hands.push({ f: 10, l: -14 });
			} else {
				// idle: blade held low in the right hand, pointing forward-out
				const ha = a + 0.5;
				const hx = p.x + math.cos(a) * 12 - math.sin(a) * 14;
				const hy = p.y + math.sin(a) * 12 + math.cos(a) * 14;
				const len = math.max(18, reach * 0.55);
				r.drawSegment(cam, hx, hy, hx + math.cos(ha) * len, hy + math.sin(ha) * len, {
					h: 5,
					color: COLORS.blade,
					stroke: COLORS.weapon,
					strokeThickness: 1,
					zIndex: Z.player + 1,
				});
				hands.push({ f: 12, l: 14 });
				hands.push({ f: 10, l: -14 });
			}
		} else if (w.kind === WeaponKind.Bow) {
			this.part(r, cam, p.x, p.y, a, 26, 0, {
				w: 6,
				h: 44,
				color: COLORS.arrow.Lerp(BLACK, 0.3),
				cornerRadius: 3,
				zIndex: Z.player + 1,
			});
			hands.push({ f: 24, l: 0 });
			hands.push({ f: 10, l: 8 });
		} else {
			let len = 42;
			if (w.kind === WeaponKind.Pistol) len = 22;
			else if (w.kind === WeaponKind.Shotgun) len = 40;
			else if (w.kind === WeaponKind.MG) len = 50;
			else if (w.kind === WeaponKind.Sniper) len = 56;
			this.part(r, cam, p.x, p.y, a, 12 + len / 2, 3, {
				w: len,
				h: w.kind === WeaponKind.Pistol ? 6 : 7,
				color: COLORS.weapon,
				zIndex: Z.player + 1,
			});
			if (w.kind === WeaponKind.Pistol) {
				hands.push({ f: 18, l: 6 });
				hands.push({ f: 18, l: -2 });
			} else {
				hands.push({ f: 16, l: 7 });
				hands.push({ f: 12 + len * 0.6, l: 3 });
			}
		}
		// body (shoulders across the heading)
		this.part(r, cam, p.x, p.y, a, 0, 0, {
			w: 24,
			h: 38,
			color: body,
			cornerRadius: 10,
			stroke: flash > 0 ? COLORS.uiRed : dark,
			strokeThickness: flash > 0 ? 3 : 2,
			zIndex: Z.player + 2,
		});
		for (const hnd of hands) {
			this.part(r, cam, p.x, p.y, a, hnd.f, hnd.l, {
				w: 10,
				h: 10,
				circle: true,
				color: COLORS.playerSkin,
				zIndex: Z.player + 3,
			});
		}
		r.drawCircle(cam, p.x + math.cos(a) * 1, p.y + math.sin(a) * 1, 22, {
			color: dark,
			stroke: dark.Lerp(BLACK, 0.4),
			strokeThickness: 1,
			zIndex: Z.player + 4,
		});
	}

	private drawBosses(r: Renderer, cam: Camera, v: ViewRect): void {
		for (const b of this.bosses) {
			const flash = clamp(b.hitFlash ?? 0, 0, 1);
			const color = flash > 0 ? COLORS.boss.Lerp(WHITE, 0.7 * flash) : COLORS.boss;
			const dark = COLORS.boss.Lerp(BLACK, 0.4);
			if (b.type === 1) {
				const bodyX = b.bodyX;
				const bodyY = b.bodyY;
				if (bodyX === undefined || bodyY === undefined) continue;
				// centipede: every segment is drawn at its hit radius, the head at bossHitRadius
				const n = bodyX.size();
				const seg = BOSS1_SEGMENT_RADIUS * 2;
				const head = bossHitRadius(b) * 2;
				for (let i = n - 1; i >= 0; i--) {
					const size = i === 0 ? head : seg;
					if (!circleInView(bodyX[i], bodyY[i], size, v)) continue;
					if (i > 0 && i % 3 === 0) {
						// legs on every third segment, across the local body direction
						const j0 = math.max(0, i - 1);
						const j1 = math.min(n - 1, i + 1);
						const da = math.atan2(bodyY[j0] - bodyY[j1], bodyX[j0] - bodyX[j1]);
						const swing = math.sin(this.clock * 12 + i) * 0.35;
						for (const side of [-1, 1]) {
							this.part(r, cam, bodyX[i], bodyY[i], da + side * (math.pi / 2 + swing), seg * 0.55, 0, {
								w: seg * 0.5,
								h: 7,
								color: dark,
								cornerRadius: 3,
								zIndex: Z.boss - 1,
							});
						}
					}
					r.drawCircle(cam, bodyX[i], bodyY[i], size, {
						color: i === 0 || i % 2 === 0 ? color : color.Lerp(BLACK, 0.2),
						stroke: dark,
						strokeThickness: 2,
						zIndex: Z.boss + (i === 0 ? 2 : 0),
					});
				}
				if (n > 1) {
					const ha = math.atan2(bodyY[0] - bodyY[1], bodyX[0] - bodyX[1]);
					for (const side of [-1, 1]) {
						this.part(r, cam, bodyX[0], bodyY[0], ha, head * 0.22, side * head * 0.2, {
							w: head * 0.12,
							h: head * 0.12,
							circle: true,
							color: COLORS.detect,
							zIndex: Z.boss + 3,
						});
						// mandibles
						this.part(r, cam, bodyX[0], bodyY[0], ha + side * 0.35, head * 0.55, 0, {
							w: head * 0.3,
							h: 8,
							color: dark,
							cornerRadius: 3,
							zIndex: Z.boss + 1,
						});
					}
				}
				continue;
			}
			// types 2-4: drawn at their hit radius so what you see is what you hit
			const size = bossHitRadius(b) * 2;
			if (!circleInView(b.x, b.y, size + 60, v)) continue;
			const so = this.shadowOffset(b.x, b.y, 14);
			r.drawCircle(cam, b.x + so.x, b.y + so.y, size * 1.05, {
				color: BLACK,
				alpha: 0.35,
				zIndex: Z.actorShadow,
			});
			if (b.type === 3) {
				this.drawHumanoid(
					r,
					cam,
					b.x,
					b.y,
					b.angle,
					size / 2 / HUMANOID_HALF_WIDTH,
					color,
					flash,
					1,
					math.rad(b.moveCycle ?? 0),
					Z.boss,
				);
				continue;
			}
			if (b.type === 2) {
				// tentacles slowly sweeping around the stationary body
				for (let i = 0; i < 6; i++) {
					const ta = this.clock * 0.6 + (i * math.pi) / 3;
					this.part(r, cam, b.x, b.y, ta, size * 0.62, 0, {
						w: 80,
						h: 16,
						color: dark,
						cornerRadius: 8,
						zIndex: Z.boss,
					});
				}
			} else {
				// needles
				for (let i = 0; i < 8; i++) {
					this.part(r, cam, b.x, b.y, b.angle + (i * math.pi) / 4, size * 0.55, 0, {
						w: 30,
						h: 8,
						color: dark,
						zIndex: Z.boss,
					});
				}
			}
			r.drawCircle(cam, b.x, b.y, size, {
				color,
				stroke: flash > 0 ? WHITE : dark,
				strokeThickness: flash > 0 ? 4 : 2,
				zIndex: Z.boss + 1,
			});
			for (const side of [-1, 1]) {
				this.part(r, cam, b.x, b.y, b.angle, size * 0.3, side * size * 0.16, {
					w: size * 0.12,
					h: size * 0.12,
					circle: true,
					color: COLORS.detect,
					zIndex: Z.boss + 2,
				});
			}
		}
	}

	/** arrow sprite (shaft, head, fletching) centred on (x, y) */
	private drawArrow(r: Renderer, cam: Camera, x: number, y: number, a: number, alpha: number, z: number): void {
		this.part(r, cam, x, y, a, 0, 0, { w: 26, h: 3, color: COLORS.arrow, alpha, zIndex: z });
		this.part(r, cam, x, y, a, 14, 0, {
			w: 6,
			h: 6,
			color: COLORS.ironDoor,
			alpha,
			cornerRadius: 1,
			zIndex: z + 1,
		});
		this.part(r, cam, x, y, a, -12, 0, {
			w: 7,
			h: 7,
			color: COLORS.uiRed,
			alpha,
			cornerRadius: 1,
			zIndex: z + 1,
		});
	}

	private drawBullets(r: Renderer, cam: Camera, v: ViewRect): void {
		this.frameNo++;
		const byId = this.zombieById;
		byId.clear();
		let anyStuck = false;
		for (const b of this.bullets) {
			if (b.stuckTo !== undefined) {
				anyStuck = true;
				break;
			}
		}
		if (anyStuck) {
			for (const zb of this.zombies) byId.set(zb.id, zb);
		}
		const up = cam.screenDirToWorld(0, -1);
		for (const b of this.bullets) {
			if (!circleInView(b.x, b.y, 90, v)) continue;
			if (b.fromPlayer && b.kind === "arrow") {
				const zb = b.stuckTo !== undefined ? byId.get(b.stuckTo) : undefined;
				if (zb !== undefined) {
					// stuck in a zombie: keeps its offset in the body's frame, turning (and jumping) with it
					let ref = this.stuckRef.get(b.id);
					if (ref === undefined) {
						ref = { a: zb.angleSlow, seen: this.frameNo };
						this.stuckRef.set(b.id, ref);
					}
					ref.seen = this.frameNo;
					const d = zb.angleSlow - ref.a;
					const ox = b.stuckDX ?? 0;
					const oy = b.stuckDY ?? 0;
					const lift = math.max(0, zb.jumpHeight ?? 0);
					const ax = zb.x + ox * math.cos(d) - oy * math.sin(d) + up.x * lift;
					const ay = zb.y + ox * math.sin(d) + oy * math.cos(d) + up.y * lift;
					const aa = b.angle + d;
					// only the back half sticks out of the body
					this.drawArrow(r, cam, ax - math.cos(aa) * 8, ay - math.sin(aa) * 8, aa, 1, Z.zombie + 4);
				} else if (b.grounded === true) {
					// lying on the ground, dimmed; the player walks over it to pick it up
					this.drawArrow(r, cam, b.x, b.y, b.angle, 0.6, Z.item);
				} else {
					this.drawArrow(r, cam, b.x, b.y, b.angle, 1, Z.projectile);
				}
				continue;
			}
			if (!b.fromPlayer) {
				if (b.targetX !== undefined && b.targetY !== undefined) {
					// spitter acid: a lobbed blob — shadow on the ground, blob arcing above it, and a
					// landing marker so the player can read where the puddle will appear
					const t = clamp(b.travel / math.max(1, b.range), 0, 1);
					const arc = math.sin(t * math.pi);
					const h = arc * math.min(70, 20 + b.range * 0.2);
					r.drawCircle(cam, b.targetX, b.targetY, SPIT_MARK_R * 2, {
						color: COLORS.acid,
						alpha: 0.08 + 0.12 * t,
						stroke: COLORS.acid,
						strokeThickness: 2,
						strokeAlpha: 0.3 + 0.5 * t,
						zIndex: Z.decal + 2,
					});
					r.drawCircle(cam, b.x, b.y, 12, { color: BLACK, alpha: 0.25, zIndex: Z.actorShadow });
					r.drawCircle(cam, b.x + up.x * h, b.y + up.y * h, 14 * (1 + 0.5 * arc), {
						color: COLORS.acid,
						stroke: COLORS.bloodZombie,
						strokeThickness: 2,
						zIndex: Z.projectile,
					});
				} else {
					// boss needle (any enemy shot without a landing point): a thin bone spike
					this.part(r, cam, b.x, b.y, b.angle, 0, 0, {
						w: 28,
						h: 3,
						color: COLORS.blade.Lerp(COLORS.parcel, 0.4),
						zIndex: Z.projectile,
					});
					this.part(r, cam, b.x, b.y, b.angle, 15, 0, {
						w: 6,
						h: 4,
						color: COLORS.boss,
						cornerRadius: 2,
						zIndex: Z.projectile + 1,
					});
				}
				continue;
			}
			if (b.kind === "fire") {
				r.drawCircle(cam, b.x, b.y, 12 + math.sin(this.clock * 30 + b.id) * 3, {
					color: COLORS.campfire,
					alpha: 0.85,
					zIndex: Z.projectile,
				});
			} else if (b.kind === "electric") {
				this.part(r, cam, b.x, b.y, b.angle, 0, 0, {
					w: 14,
					h: 6,
					color: COLORS.uiBlue,
					cornerRadius: 3,
					zIndex: Z.projectile,
				});
			} else {
				this.part(r, cam, b.x, b.y, b.angle, 0, 0, {
					w: 16,
					h: 4,
					color: COLORS.bullet,
					cornerRadius: 2,
					zIndex: Z.projectile,
				});
			}
		}
		for (const [id, ref] of this.stuckRef) {
			if (ref.seen !== this.frameNo) this.stuckRef.delete(id);
		}
	}

	/** exploder blasts: expanding shock ring + hot core, fading once full size */
	private drawExplosions(r: Renderer, cam: Camera, v: ViewRect): void {
		const list = this.refs.explosions;
		if (list === undefined) return;
		for (const e of list) {
			if (!circleInView(e.x, e.y, e.rMax, v)) continue;
			const fade = explosionFade(e);
			const grow = clamp(e.r / math.max(1, e.rMax), 0, 1);
			const d = math.max(4, e.r * 2);
			r.drawCircle(cam, e.x, e.y, d, {
				color: COLORS.campfire,
				alpha: 0.35 * fade,
				stroke: COLORS.uiYellow,
				strokeThickness: 5,
				strokeAlpha: 0.9 * fade,
				zIndex: Z.particle + 1,
			});
			r.drawCircle(cam, e.x, e.y, d * 0.45, {
				color: COLORS.lamp.Lerp(WHITE, 0.5),
				alpha: 0.7 * fade * (1 - grow * 0.6),
				zIndex: Z.particle + 2,
			});
		}
	}

	private drawTracers(r: Renderer, cam: Camera): void {
		for (const t of this.tracers) {
			r.drawSegment(cam, t.x1, t.y1, t.x2, t.y2, {
				h: 3,
				color: t.color,
				alpha: clamp(t.life * 5, 0, 1),
				zIndex: Z.projectile,
			});
		}
	}

	private drawParticles(r: Renderer, cam: Camera, v: ViewRect): void {
		this.particles.forActive(p => {
			if (!circleInView(p.x, p.y, p.size, v)) return;
			r.drawCircle(cam, p.x, p.y, p.size, {
				color: p.color,
				alpha: clamp((p.life / p.maxLife) * 1.5, 0, 1),
				zIndex: Z.particle,
			});
		});
	}

	render(): void {
		const ctx = getCtx();
		const renderer = ctx.renderer;
		const cam = ctx.cam;
		renderer.beginFrame();
		const view = cam.viewRect(32);
		this.updateShadowDir();
		this.drawGround(renderer, cam, view);
		this.drawDecals(renderer, cam, view);
		this.drawItems(renderer, cam, view);
		this.drawSolids(renderer, cam, view);
		this.drawZombies(renderer, cam, view);
		this.drawPlayer(renderer, cam);
		this.drawBosses(renderer, cam, view);
		this.drawBullets(renderer, cam, view);
		this.drawExplosions(renderer, cam, view);
		this.drawTracers(renderer, cam);
		this.drawParticles(renderer, cam, view);
		this.build.draw(renderer, cam);
		renderer.endFrame();
		this.drawLight(cam, view);
	}

	/**
	 * Night: a coarse light map instead of a flat overlay (Dead Town simply darkened everything).
	 * The player always sees ~250 px around them; powered lamps / fires light their surroundings,
	 * so building light sources becomes a real defensive choice. Muzzle flashes light up briefly.
	 */
	private drawLight(cam: Camera, v: ViewRect): void {
		const ctx = getCtx();
		ctx.darkLayer.BackgroundTransparency = 1;
		if (this.lightMap === undefined) {
			this.lightMap = new LightMap(ctx.darkLayer, COLORS.overlayNight);
		}
		const dark = this.daynight.darkAlpha;
		if (dark <= 0.004) {
			this.lightMap.hide();
			return;
		}
		const lights = this.lights;
		lights.clear();
		const p = this.player;
		if (!p.dead) {
			lights.push({ x: p.x, y: p.y, r: PLAYER_LIGHT_R, inner: 0.4 });
		}
		const list = this.queryBuf;
		list.clear();
		querySolids(this.world, v.minX - 400, v.minY - 400, v.maxX + 400, v.maxY + 400, list);
		for (const s of list) {
			const r = LIGHT_R[s.tags];
			if (r === undefined || s.powered !== true) continue;
			const fire = s.tags === "campfire" || s.tags === "brazier";
			const flicker = fire ? 0.92 + math.sin(this.clock * 11 + s.id) * 0.05 : 1;
			lights.push({ x: s.x + s.w / 2, y: s.y + s.h / 2, r: r * flicker, inner: 0.5 });
		}
		for (const t of this.tracers) {
			const k = clamp(t.life * 5, 0, 1);
			if (k > 0.05) lights.push({ x: t.x1, y: t.y1, r: 150, k: 0.85 * k, inner: 0.2 });
		}
		for (const b of this.bullets) {
			if (b.kind === "fire") lights.push({ x: b.x, y: b.y, r: 110, k: 0.7, inner: 0.2 });
		}
		const blasts = this.refs.explosions;
		if (blasts !== undefined) {
			for (const e of blasts) {
				lights.push({ x: e.x, y: e.y, r: e.rMax * 1.8, k: explosionFade(e), inner: 0.35 });
			}
		}
		this.lightMap.update(cam, dark, lights);
	}

	/** Hide every world sprite and the night overlay (call when leaving the game screen). */
	hideWorld(): void {
		const ctx = getCtx();
		ctx.renderer.releaseAll();
		this.lightMap?.hide();
		ctx.darkLayer.BackgroundTransparency = 1;
	}

	getRefs(): GameRefs {
		return this.refs;
	}
}
