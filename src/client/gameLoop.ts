import { getCtx, syncKeyboardMove } from "./bootstrap";
import { COLORS, Z } from "shared/engine/colors";
import { Camera } from "shared/engine/camera";
import { DESIGN } from "shared/engine/constants";
import { Renderer } from "shared/engine/renderer";
import { clamp, lerp } from "shared/engine/vec2";
import { expMaxInit, PlayerSaveData } from "shared/game/save";
import { createPlayer, PlayerState, recalcMoveSpeed } from "shared/game/player";
import { generateTown, rectHitsSolid, randomOpenPoint, updateGroundItems, WorldData, Solid } from "shared/game/world";
import { resetEntityIds, BossState, ZombieState } from "shared/game/entities";
import { resetBullets, Bullet } from "shared/game/bullets";
import { DayNight } from "./systems/daynight";
import { ParticleSystem } from "./systems/particles";
import { Spawner } from "./systems/spawner";
import { updateZombies } from "./systems/zombieAI";
import { updateBosses } from "./systems/bossAI";
import { Combat } from "./systems/combat";
import { Interaction } from "./systems/interaction";
import { BuildSystem } from "./systems/build";
import { GameRefs, SPEED_SCALE, Tracer } from "./systems/types";

export class GameLoop {
	private world: WorldData = generateTown(0);
	private player: PlayerState = createPlayer({} as PlayerSaveData, 0, 0);
	private save: PlayerSaveData = {} as PlayerSaveData;
	private zombies: Array<ZombieState> = [];
	private bosses: Array<BossState> = [];
	private bullets: Array<Bullet> = [];
	private tracers: Array<Tracer> = [];
	private particles = new ParticleSystem();
	private daynight: DayNight = new DayNight({} as PlayerSaveData);
	private combat = new Combat();
	private spawner = new Spawner();
	private interaction = new Interaction();
	private build = new BuildSystem();
	private refs: GameRefs;
	private announceQueue: Array<string> = [];

	constructor() {
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
		this.world = generateTown(0);
		resetEntityIds();
		resetBullets();
		this.zombies.clear();
		this.bosses.clear();
		this.bullets.clear();
		this.tracers.clear();
		this.particles.clear();
		this.announceQueue.clear();
		const center = randomOpenPoint(
			this.world,
			this.world.width / 2 - 800,
			this.world.height / 2 - 800,
			this.world.width / 2 + 800,
			this.world.height / 2 + 800,
		);
		this.player = createPlayer(save, center.x, center.y);
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

	private updatePlayer(dt: number): void {
		const ctx = getCtx();
		const p = this.player;
		const save = this.save;
		const input = ctx.input;
		syncKeyboardMove();
		p.angle = input.aimAngle;

		let wdx = 0;
		let wdy = 0;
		if (input.moveMagnitude > 0) {
			const a = input.moveX;
			const b = input.moveY / ctx.cam.isoSquash;
			wdx = (a + b) * 0.5;
			wdy = (b - a) * 0.5;
			const l = math.sqrt(wdx * wdx + wdy * wdy);
			if (l > 0.0001) {
				wdx /= l;
				wdy /= l;
			} else {
				wdx = 0;
				wdy = 0;
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
		const nx = p.x + mvx * dt;
		const ny = p.y + mvy * dt;
		if (!rectHitsSolid(this.world, nx, ny, 36, 40)) {
			p.x = nx;
			p.y = ny;
		} else if (!rectHitsSolid(this.world, nx, p.y, 36, 40)) {
			p.x = nx;
		} else if (!rectHitsSolid(this.world, p.x, ny, 36, 40)) {
			p.y = ny;
		}
		p.x = clamp(p.x, 40, this.world.width - 40);
		p.y = clamp(p.y, 40, this.world.height - 40);

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
			const msg = this.announceQueue.remove(0);
			print(msg);
		}
		this.particles.update(dt);
		updateGroundItems(this.world, dt);
		this.interaction.update(refs, dt);
		ctx.cam.follow(this.player.x, this.player.y, math.min(1, dt * 8));
		ctx.cam.update(dt);
		ctx.input.beginFrame();
	}

	private viewBounds(cam: Camera): { minX: number; minY: number; maxX: number; maxY: number } {
		const c0 = cam.screenToWorld(0, 0);
		const c1 = cam.screenToWorld(cam.viewW, 0);
		const c2 = cam.screenToWorld(0, cam.viewH);
		const c3 = cam.screenToWorld(cam.viewW, cam.viewH);
		return {
			minX: math.min(c0.x, c1.x, c2.x, c3.x) - 128,
			minY: math.min(c0.y, c1.y, c2.y, c3.y) - 128,
			maxX: math.max(c0.x, c1.x, c2.x, c3.x) + 128,
			maxY: math.max(c0.y, c1.y, c2.y, c3.y) + 128,
		};
	}

	private drawGround(
		renderer: Renderer,
		cam: Camera,
		view: { minX: number; minY: number; maxX: number; maxY: number },
	): void {
		const w = this.world;
		const tile = 512;
		const x0 = math.floor(math.max(0, view.minX) / tile) * tile;
		const y0 = math.floor(math.max(0, view.minY) / tile) * tile;
		const x1 = math.min(w.width, view.maxX);
		const y1 = math.min(w.height, view.maxY);
		for (let x = x0; x < x1; x += tile) {
			for (let y = y0; y < y1; y += tile) {
				const alt = (math.floor(x / tile) + math.floor(y / tile)) % 2 === 0;
				renderer.drawRect(cam, x + tile / 2, y + tile / 2, {
					w: tile,
					h: tile,
					color: alt ? COLORS.grass : COLORS.grassDark,
					zIndex: Z.ground,
				});
			}
		}
		for (const r of w.roads) {
			if (r.x > view.maxX || r.x + r.w < view.minX || r.y > view.maxY || r.y + r.h < view.minY) continue;
			renderer.drawRect(cam, r.x + r.w / 2, r.y + r.h / 2, {
				w: r.w,
				h: r.h,
				color: COLORS.road,
				zIndex: Z.ground + 1,
			});
			if (r.w < r.h) {
				renderer.drawRect(cam, r.x + r.w / 2, r.y + r.h / 2, {
					w: 4,
					h: r.h,
					color: COLORS.roadLine,
					alpha: 0.5,
					zIndex: Z.ground + 2,
				});
			}
		}
	}

	private solidBodyColor(s: Solid): Color3 {
		if (s.kind === "wall_h" || s.kind === "wall_v") return COLORS.wallWood;
		if (s.kind === "car") return s.tags === "trash" ? COLORS.uiPanelLight : COLORS.car;
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

	private drawSolids(
		renderer: Renderer,
		cam: Camera,
		view: { minX: number; minY: number; maxX: number; maxY: number },
	): void {
		const p = this.player;
		for (const s of this.world.solids) {
			const cx = s.x + s.w / 2;
			const cy = s.y + s.h / 2;
			if (cx < view.minX || cx > view.maxX || cy < view.minY || cy > view.maxY) continue;
			if (s.kind === "tree") {
				renderer.drawRect(cam, cx, cy + 8, {
					w: 40,
					h: 14,
					color: COLORS.shadow,
					alpha: 0.35,
					zIndex: Z.shadow,
				});
				renderer.drawRect(cam, cx, cy, { w: 14, h: 22, color: COLORS.treeTrunk, zIndex: Z.structure });
				renderer.drawRect(cam, cx, cy - 6, {
					w: 48,
					h: 48,
					color: COLORS.treeLeaf,
					cornerRadius: 24,
					zIndex: Z.structure + 1,
				});
				continue;
			}
			renderer.drawRect(cam, cx + 6, cy + 10, {
				w: s.w,
				h: s.h,
				color: COLORS.shadow,
				alpha: 0.35,
				zIndex: Z.shadow,
			});
			if (s.kind === "building") {
				const dx = math.max(math.abs(cx - p.x) - s.w / 2, math.abs(cy - p.y) - s.h / 2);
				const target = dx < 220 ? 0.12 : 1;
				s.roofAlpha = lerp(s.roofAlpha ?? 1, target, 0.15);
				renderer.drawRect(cam, cx, cy, { w: s.w, h: s.h, color: COLORS.floorWood, zIndex: Z.structure });
				renderer.drawRect(cam, cx, cy, {
					w: s.w,
					h: s.h,
					color: s.roofColor ?? COLORS.roofGray,
					alpha: s.roofAlpha ?? 1,
					zIndex: Z.structure + 1,
				});
				continue;
			}
			const alpha = s.kind === "door" && s.open ? 0.4 : 1;
			renderer.drawRect(cam, cx, cy, {
				w: s.w,
				h: s.h,
				color: this.solidBodyColor(s),
				alpha,
				zIndex: Z.structure,
			});
			if (s.kind === "door" && s.open) {
				renderer.drawRect(cam, cx, cy, {
					w: s.w,
					h: s.h,
					color: COLORS.door,
					alpha: 0.25,
					zIndex: Z.structure + 1,
				});
			}
		}
	}

	private drawItems(
		renderer: Renderer,
		cam: Camera,
		view: { minX: number; minY: number; maxX: number; maxY: number },
	): void {
		for (const it of this.world.items) {
			if (it.x < view.minX || it.x > view.maxX || it.y < view.minY || it.y > view.maxY) continue;
			renderer.drawRect(cam, it.x, it.y, { w: 16, h: 16, color: COLORS.item, cornerRadius: 4, zIndex: Z.item });
		}
	}

	private zombieColor(t: number): Color3 {
		if (t === 2) return COLORS.zombie2;
		if (t === 3) return COLORS.zombie3;
		if (t === 4) return COLORS.zombie4;
		if (t === 5) return COLORS.zombie5;
		return COLORS.zombie1;
	}

	private drawZombies(
		renderer: Renderer,
		cam: Camera,
		view: { minX: number; minY: number; maxX: number; maxY: number },
	): void {
		for (const z of this.zombies) {
			if (z.x < view.minX || z.x > view.maxX || z.y < view.minY || z.y > view.maxY) continue;
			const lift = z.jumpHeight ?? 0;
			renderer.drawRect(cam, z.x, z.y + 8, { w: 34, h: 14, color: COLORS.shadow, alpha: 0.3, zIndex: Z.shadow });
			renderer.drawRect(cam, z.x, z.y - lift, {
				w: 36,
				h: 36,
				color: this.zombieColor(z.type),
				cornerRadius: 18,
				zIndex: z.hp <= 0 ? Z.zombie - 1 : Z.zombie,
			});
		}
	}

	private drawPlayer(renderer: Renderer, cam: Camera): void {
		const p = this.player;
		renderer.drawRect(cam, p.x, p.y + 10, { w: 36, h: 14, color: COLORS.shadow, alpha: 0.3, zIndex: Z.shadow });
		if (p.swingerActive) {
			const reach = 46;
			renderer.drawRect(
				cam,
				p.x + math.cos(p.swingerAngle) * reach * 0.6,
				p.y + math.sin(p.swingerAngle) * reach * 0.6,
				{
					w: reach,
					h: 6,
					color: COLORS.item,
					alpha: 0.8,
					rotation: p.swingerAngle,
					zIndex: Z.player,
				},
			);
		}
		renderer.drawRect(cam, p.x, p.y, {
			w: 40,
			h: 40,
			color: p.buffs.poison > 0 ? COLORS.zombie5 : COLORS.player,
			cornerRadius: 20,
			zIndex: Z.player,
		});
		renderer.drawRect(cam, p.x, p.y, {
			w: 14,
			h: 14,
			color: COLORS.playerDark,
			cornerRadius: 7,
			zIndex: Z.player + 1,
		});
	}

	private drawBosses(
		renderer: Renderer,
		cam: Camera,
		view: { minX: number; minY: number; maxX: number; maxY: number },
	): void {
		for (const b of this.bosses) {
			if (b.type === 1) {
				const bodyX = b.bodyX;
				const bodyY = b.bodyY;
				if (bodyX === undefined || bodyY === undefined) continue;
				for (let i = bodyX.size() - 1; i >= 0; i--) {
					const size = i === 0 ? 28 : i % 3 === 0 ? 20 : 14;
					renderer.drawRect(cam, bodyX[i], bodyY[i], {
						w: size,
						h: size,
						color: COLORS.boss,
						cornerRadius: size / 2,
						zIndex: Z.boss,
					});
				}
				continue;
			}
			if (b.x < view.minX || b.x > view.maxX || b.y < view.minY || b.y > view.maxY) continue;
			const size = b.type === 2 ? 130 : b.type === 3 ? 90 : 70;
			renderer.drawRect(cam, b.x, b.y + 12, {
				w: size,
				h: size * 0.4,
				color: COLORS.shadow,
				alpha: 0.35,
				zIndex: Z.shadow,
			});
			renderer.drawRect(cam, b.x, b.y, {
				w: size,
				h: size,
				color: COLORS.boss,
				cornerRadius: size / 2,
				zIndex: Z.boss,
			});
		}
	}

	private drawBullets(renderer: Renderer, cam: Camera): void {
		for (const b of this.bullets) {
			let color = COLORS.arrow;
			let w = 16;
			let h = 4;
			if (!b.fromPlayer) {
				if (b.id < -100000) {
					color = COLORS.bullet;
					w = 14;
					h = 3;
				} else {
					color = COLORS.zombie2;
					w = 10;
					h = 10;
				}
			} else if (b.kind === "fire") {
				color = COLORS.campfire;
				w = 12;
				h = 12;
			} else if (b.kind === "electric") {
				color = COLORS.uiBlue;
				w = 12;
				h = 6;
			}
			renderer.drawRect(cam, b.x, b.y, {
				w,
				h,
				color,
				rotation: b.angle,
				cornerRadius: h / 2,
				zIndex: Z.projectile,
			});
		}
	}

	private drawTracers(renderer: Renderer, cam: Camera): void {
		for (const t of this.tracers) {
			const dx = t.x2 - t.x1;
			const dy = t.y2 - t.y1;
			const len = math.sqrt(dx * dx + dy * dy);
			if (len < 1) continue;
			renderer.drawRect(cam, (t.x1 + t.x2) / 2, (t.y1 + t.y2) / 2, {
				w: len,
				h: 3,
				color: t.color,
				alpha: clamp(t.life * 5, 0, 1),
				rotation: math.atan2(dy, dx),
				zIndex: Z.projectile,
			});
		}
	}

	private drawParticles(renderer: Renderer, cam: Camera): void {
		this.particles.forActive(p => {
			renderer.drawRect(cam, p.x, p.y, {
				w: p.size,
				h: p.size,
				color: p.color,
				alpha: clamp(p.life / p.maxLife, 0, 1),
				cornerRadius: p.size / 2,
				zIndex: Z.particle,
			});
		});
	}

	render(): void {
		const ctx = getCtx();
		const renderer = ctx.renderer;
		const cam = ctx.cam;
		renderer.releaseAll();
		const view = this.viewBounds(cam);
		this.drawGround(renderer, cam, view);
		this.drawItems(renderer, cam, view);
		this.drawSolids(renderer, cam, view);
		this.drawZombies(renderer, cam, view);
		this.drawPlayer(renderer, cam);
		this.drawBosses(renderer, cam, view);
		this.drawBullets(renderer, cam);
		this.drawTracers(renderer, cam);
		this.drawParticles(renderer, cam);
		this.build.draw(renderer, cam);
		ctx.darkLayer.BackgroundTransparency = 1 - this.daynight.darkAlpha;
	}

	getRefs(): GameRefs {
		return this.refs;
	}
}
