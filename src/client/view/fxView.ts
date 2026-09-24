/*
 * Cosmetic effects on screen (docs/MULTIPLAYER.md §4.1 "Fx", §4.2, §11.3 F2-2D).
 *
 * Everything that is felt rather than decided: camera shake, blood, debris, shot lines, blasts, the sprite a
 * struck tree flinches with and the projectiles that have no simulation behind them any more. It is fed from
 * TWO channels and the whole point of the file is that they meet:
 *
 *   refs.fx     the simulation's own channel, pushed by the systems that still run on this client
 *               (client/predict/weaponFx.ts, crafting, the admin tools). Below MP_PHASE 2 it is everything.
 *   the wire    §4.2's `Fx` events, received unreliably from the server. `shared/net/fxWire.ts` turns the
 *               three that have a simulation shape (Blood, Debris, Tracer) back into simulation events, and
 *               they go down the SAME path as the local ones — which is what makes a bite look identical
 *               whether this client simulated it (< 2) or merely received it (≥ 2).
 *
 * The events with no simulation shape are played here from the wire event itself: a shot fired by somebody
 * else, an explosion, a solid being struck, a projectile appearing and disappearing.
 *
 * OWNERSHIP, and why `advance` exists. At MP_PHASE ≥ 2 the client's own systems stop running: nothing grows
 * a blast or flies a projectile any more. Whatever this file puts into the world it therefore also has to
 * carry — which is exactly the set `advance` walks, and nothing else. A solid's flinch is the exception: the
 * client starts those from two places (this wire and E on a tree), so they share one clock in solidFlinch.ts.
 */
import { Bullet } from "shared/game/bullets";
import { Camera, ViewRect } from "shared/engine/camera";
import { circleInView } from "./drawKit";
import { clearFlinches, flinch } from "./solidFlinch";
import { clamp } from "shared/engine/vec2";
import { COLORS, Z } from "shared/engine/colors";
import { DebrisMaterial, FxEvent as SimFx, TracerKind } from "shared/sim/types";
import { Explosion, fxBlood, fxDebris, fxTracer, GameRefs, Tracer } from "../systems/types";
import { fromWireFx } from "shared/net/fxWire";
import * as Net from "shared/net/protocol";
import { ParticleSystem } from "../systems/particles";
import { audio, playFxEvent, remoteProjectileSound, remoteShotSound } from "../audio";
import { Renderer } from "shared/engine/renderer";
import { BLAST_GROW, PUDDLE_LIFE, PUDDLE_RADIUS, SPIT_RANGE } from "shared/sim/ai/zombieTuning";
import { SLOT_NONE } from "shared/net/mpConfig";
import { Solid, WorldData } from "shared/game/world";

/** the local survivor's slot in refs.players: an FxEvent aimed at another survivor is not ours to play */
const LOCAL_SLOT = 0;
const WHITE = COLORS.white;

/** what a debris burst is made of (FxEvent "debris") */
const DEBRIS_COLOR: Record<DebrisMaterial, Color3> = {
	impact: COLORS.shadow,
	tree: COLORS.treeTrunk,
	car: COLORS.car,
	structure: COLORS.barricade,
	exploder: COLORS.zombie3,
	boss: COLORS.boss,
};
/** shot lines (FxEvent "tracer") */
const TRACER_COLOR: Record<TracerKind, Color3> = {
	bullet: COLORS.bullet,
	electric: COLORS.uiBlue,
	boss: COLORS.boss,
};

/** the arc weapon (weapons.ts id 26): its shot line is a short electric arc, not a bullet streak */
const ARC_WEAPON = 26;
/** the same two lifetimes client/predict/weaponFx.ts predicts our own shots with, so both look alike */
const TRACER_LIFE = 0.2;
const ARC_LIFE = 0.15;

/** a blast stays drawable this long once it is full size (`zombieBrain.explode`) */
const BLAST_LIFE = 0.4;
/** seconds a struck tree / car / bin flinches for (`interaction.hitMapItem`) */
const SOLID_SHAKE_S = 0.25;
/**
 * A projectile whose `ProjEnd` never arrived. The Fx channel is unreliable by design (§4.1), so the end of a
 * flight can simply be lost — and an arrow that keeps flying for ever because of one dropped packet is a far
 * worse artefact than one that vanishes a second late.
 */
const PROJ_MAX_LIFE_S = 6;

/** particles of the burst `zombieBrain.killZombie` leaves; §4.4 promises one wherever a body fell */
const DEATH_BLOOD = 10;
/** a burst that big, this close, in the same frame IS the kill's own blood: playing it twice is twice the pool */
const DEATH_BLOOD_NEAR = 48;

/** 1 while a blast grows, then fades over its remaining life (0.4 s in zombieAI) */
export function explosionFade(e: Explosion): number {
	return e.r < e.rMax ? 1 : clamp(e.life / 0.4, 0, 1);
}

/**
 * Where a survivor's shot starts, by slot.
 *
 * §4.2's `Shot` names the shooter by SLOT, and the view has bodies: `remotePlayers()` hands out survivors
 * keyed by userId, with no slot on them (client/net/netTypes.ts). Until that seam carries one, the loop
 * answers `undefined` here and a shot from somebody else draws its impacts and no line — a line drawn from
 * the wrong survivor tells you the wrong person is shooting at you, which is worse than no line at all.
 */
export type ShooterAt = (slot: number) => { x: number; y: number } | undefined;

export interface WireFxOpts {
	/** this client's own slot (§4.4's roster), so its own shot is not drawn twice — §2.5 predicted it */
	localSlot: number;
	shooterAt: ShooterAt;
}

/** one projectile the server told us about, flying on nothing but what `ProjSpawn` carried (§4.2) */
interface WireProj {
	bullet: Bullet;
	/** seconds left before the ghost is swept, in case `ProjEnd` was lost */
	life: number;
	/** the spitter's blob drags its acid ring along with it; see `playProjSpawn` */
	spit: boolean;
}

export class FxView {
	private readonly tracers = new Array<Tracer>();
	/** blasts this view put into `refs.explosions`, and therefore has to grow and age itself */
	private readonly blasts = new Array<Explosion>();
	/** projectiles announced by the wire, by `projId` */
	private readonly projs = new Map<number, WireProj>();
	/** `world.solids` by id, rebuilt when the town changes (there is no index on WorldData) */
	private readonly solidIndex = new Map<number, Solid>();
	private indexedWorld?: WorldData;
	private indexedCount = -1;
	/** big blood bursts played from the wire this frame, so a death does not pour a second pool on them */
	private readonly bloodX = new Array<number>();
	private readonly bloodY = new Array<number>();
	/** deaths noted this frame, waiting for `playSim` to decide whether they still owe a pool */
	private readonly deaths = new Array<{ x: number; y: number; cause: number }>();

	// ---------------------------------------------------------------- the two channels

	/**
	 * Plays and clears what the simulation asked for (`refs.fx`): camera shake, blood, debris, tracers and
	 * HUD messages. Call it LAST in the frame's effect work — after `playWire` and after the deaths of §4.4
	 * have been noted — because both of those feed this list.
	 */
	playSim(refs: GameRefs, cam: Camera, particles: ParticleSystem): void {
		this.flushDeaths(refs);
		const list = refs.fx;
		if (list.size() > 0) {
			for (const e of list) this.applySim(refs, e, cam, particles);
			list.clear();
		}
		// the frame's effect work is over: what the wire poured stops counting against the next frame's deaths
		this.bloodX.clear();
		this.bloodY.clear();
	}

	/**
	 * One frame's worth of §4.2 `Fx` events. Blood, Debris and Tracer become simulation events and land in
	 * `refs.fx`; the rest is played here, because there is nothing in the simulation shaped like them.
	 */
	playWire(
		refs: GameRefs,
		events: ReadonlyArray<Net.FxEvent>,
		cam: Camera,
		particles: ParticleSystem,
		opts: WireFxOpts,
	): void {
		for (const e of events) {
			const sim = fromWireFx(e);
			if (sim !== undefined) {
				if (sim.kind === "blood" && sim.count >= DEATH_BLOOD) {
					this.bloodX.push(sim.x);
					this.bloodY.push(sim.y);
				}
				this.applySim(refs, sim, cam, particles);
				continue;
			}
			if (e.t === Net.FxType.Shake) {
				// a shake belongs to ONE survivor and the server only sends it to them (§4.2, `queueFor`).
				// Checking the slot anyway costs one comparison and means a routing bug on the other side
				// cannot rattle the screen of everyone standing near the blast.
				if (e.slot === opts.localSlot) cam.shake(e.magnitude, e.duration);
			} else if (e.t === Net.FxType.Shot) {
				this.playShot(refs, e, opts);
			} else if (e.t === Net.FxType.Explosion) {
				this.playExplosion(refs, e);
			} else if (e.t === Net.FxType.SolidShake) {
				this.playSolidShake(refs, e);
			} else if (e.t === Net.FxType.ProjSpawn) {
				this.playProjSpawn(refs, e);
				// somebody else's arrow or flame is heard from where it left (P0-4; ours is heard by the weapon watcher)
				if (e.owner !== SLOT_NONE && e.owner !== opts.localSlot) remoteProjectileSound(e.kind, e.owner, e.x, e.y);
			} else if (e.t === Net.FxType.ProjEnd) {
				this.playProjEnd(refs, e);
			}
			// FxType.Sound never gets here: shared/net/fxWire.ts turns it into the simulation's "sound" event (its
			// WIRE_SOUNDS table is the id table), and it goes down the path above like a bite's blood (P0-4)
		}
	}

	/**
	 * One reliable `ZombieDied` (§4.4). It is only NOTED here, never played: the death arrives on the
	 * reliable channel and its blood on the unreliable one, and the two are read at different points of the
	 * frame (the mirror drains the deaths, `playWire` the effects). Holding the death until both have been
	 * read is what lets the one cancel the other in `flushDeaths`.
	 */
	noteDeath(d: { x: number; y: number; cause: number }): void {
		this.deaths.push(d);
	}

	/**
	 * What a death still owes: the sound, always, and the pool when nobody else poured it.
	 *
	 * The kill's own blood travels on the Fx channel too, so most of the time there is already a pool on that
	 * spot and this adds none. But that channel is unreliable by design (§4.1): on a lost packet a zombie
	 * would simply wink out of existence, and §4.4 promises it does not. This is the floor under that.
	 *
	 * The death SOUND has no such competition. It is not an Fx event at all, so `playFxEvent` never sees one,
	 * and client/audio/gameAudio.ts used to derive it from a zombie's hp reaching zero — which the mirror
	 * never shows, because a dead body leaves the snapshot instead of lying in it (client/view/actorsView.ts).
	 */
	private flushDeaths(refs: GameRefs): void {
		if (this.deaths.size() === 0) return;
		for (const d of this.deaths) {
			audio.play("zombieDeath", { x: d.x, y: d.y });
			let poured = false;
			for (let i = 0; i < this.bloodX.size(); i++) {
				const dx = this.bloodX[i] - d.x;
				const dy = this.bloodY[i] - d.y;
				if (dx * dx + dy * dy < DEATH_BLOOD_NEAR * DEATH_BLOOD_NEAR) {
					poured = true;
					break;
				}
			}
			// §4.4's `cause` is meant to pick the blood and the debris; the server fills it with `Shot` for
			// every death today (2C decides the weapon), so there is one kind of pool until it carries more
			if (!poured) fxBlood(refs, d.x, d.y, DEATH_BLOOD, "zombie");
		}
		this.deaths.clear();
	}

	/** one simulation effect: the only place in the client that turns them into pixels (and into sound) */
	private applySim(refs: GameRefs, e: SimFx, cam: Camera, particles: ParticleSystem): void {
		// audio reads the same channel the view does: one call, and client/audio/fxAudio.ts has every event
		// (shots, hits, deaths, debris) instead of deriving half of them from the state (setFxAudioMode)
		playFxEvent(e);
		if (e.kind === "shake") {
			if (e.player === LOCAL_SLOT) cam.shake(e.magnitude, e.duration);
		} else if (e.kind === "blood") {
			particles.bloodBurst(e.x, e.y, e.count, e.source, e.dir);
		} else if (e.kind === "debris") {
			particles.debrisBurst(e.x, e.y, e.count, DEBRIS_COLOR[e.material]);
		} else if (e.kind === "tracer") {
			this.tracers.push({
				x1: e.x1,
				y1: e.y1,
				x2: e.x2,
				y2: e.y2,
				color: TRACER_COLOR[e.tracer],
				life: e.life,
			});
		} else if (e.kind === "message") {
			if (e.player === undefined || e.player === LOCAL_SLOT) refs.onMessage(e.text);
		}
		// "sound" has nothing to draw: playFxEvent above already played it
	}

	// ---------------------------------------------------------------- the wire-only effects

	/**
	 * Somebody's `ShotResult` (§4.2, §2.3 step 3). Our own shot already drew its line when the trigger was
	 * pulled (§2.5), so only the impacts are played for it; somebody else's gets the line too, from their
	 * body. Everything goes through `refs.fx` rather than straight to the particles, so a received shot and
	 * a predicted one are the same events in the same order — including for the audio.
	 */
	private playShot(refs: GameRefs, e: Net.FxShot, opts: WireFxOpts): void {
		const mine = e.slot !== SLOT_NONE && e.slot === opts.localSlot;
		const from = mine ? { x: refs.player.x, y: refs.player.y } : opts.shooterAt(e.slot);
		const arc = e.weapon === ARC_WEAPON;
		// an ally's shot is heard from their body (P0-4: it was silent); ours was heard when the trigger was pulled
		if (!mine && from !== undefined) remoteShotSound(e.weapon, from.x, from.y);
		for (const h of e.hits) {
			if (from === undefined) {
				// no body to hang the line on: the impacts still land, and they are the honest half
				this.playImpact(refs, h, 0);
				continue;
			}
			if (!mine) {
				fxTracer(refs, from.x, from.y, h.x, h.y, arc ? "electric" : "bullet", arc ? ARC_LIFE : TRACER_LIFE);
			}
			this.playImpact(refs, h, math.atan2(h.y - from.y, h.x - from.x));
		}
	}

	/** what one pellet left behind, by what it ended on (the same bursts weaponFx.applyShotResult plays) */
	private playImpact(refs: GameRefs, h: Net.ShotHit, away: number): void {
		if (h.hit === Net.HitKind.Zombie || h.hit === Net.HitKind.Boss) {
			fxBlood(refs, h.x, h.y, 3, "zombie", away);
		} else if (h.hit === Net.HitKind.MapItem) {
			fxDebris(refs, h.x, h.y, 3, "car");
		} else if (h.hit === Net.HitKind.Solid) {
			fxDebris(refs, h.x, h.y, 2, "impact");
		}
	}

	/**
	 * A blast at the radius the server rolled. It goes into `refs.explosions` — the same list the local
	 * exploders used — so the ring, the particles, the night light and the audio watcher all keep reading
	 * one place; `advance` then grows and ages it, because at MP_PHASE ≥ 2 nothing else does.
	 */
	private playExplosion(refs: GameRefs, e: Net.FxExplosion): void {
		refs.explosions ??= [];
		const blast: Explosion = { x: e.x, y: e.y, r: 0, rMax: math.max(1, e.radius), life: BLAST_LIFE };
		refs.explosions.push(blast);
		this.blasts.push(blast);
	}

	/** `MapItemHit` (§4.5): the tree, car or bin somebody struck flinches, exactly as `hitMapItem` makes it */
	private playSolidShake(refs: GameRefs, e: Net.FxSolidShake): void {
		const s = this.solidById(refs.world, e.solidId);
		if (s === undefined) return;
		flinch(s, SOLID_SHAKE_S * clamp(e.strength, 0, 1));
	}

	/**
	 * A projectile the server is flying (§4.2 `ProjSpawn`). The bullet built here is PURELY visual: no
	 * damage, no pickup, no collision. At MP_PHASE ≥ 2 this client flies nothing of its own — every arrow,
	 * flame and needle on screen exists because the server said it does, and ends when the server says so.
	 */
	private playProjSpawn(refs: GameRefs, e: Net.FxProjSpawn): void {
		if (this.projs.has(e.projId)) return;
		const arrow = e.kind === Net.ProjKind.Arrow;
		const spit = e.kind === Net.ProjKind.Spit;
		const speed = math.max(0, e.speed);
		const bullet: Bullet = {
			id: e.projId,
			x: e.x,
			y: e.y,
			angle: e.angle,
			// `range` is read by one thing only: the height of the spitter's lob. No range travels on the
			// wire, so the blob arcs over the spitter's own reach — the longest lob it could have thrown —
			// and every other projectile flies straight and does not care
			range: spit ? SPIT_RANGE : math.max(1, speed * PROJ_MAX_LIFE_S),
			travel: 0,
			damage: 0,
			speed,
			kind: arrow
				? "arrow"
				: e.kind === Net.ProjKind.Fire
					? "fire"
					: e.kind === Net.ProjKind.Electric
						? "electric"
						: "hitscan",
			alive: true,
			fromPlayer: e.owner !== SLOT_NONE,
			alpha: 1,
			life: PROJ_MAX_LIFE_S,
		};
		if (spit) {
			/*
			 * §4.2's ProjSpawn carries a heading and a speed but not where the blob LANDS, and the acid
			 * puddle's marker is a gameplay tell: painting it at a guessed spot would teach the player to
			 * dodge the wrong tile. So the ring rides with the blob instead of ahead of it — the threat
			 * still reads as acid, and nothing on screen claims to know something the wire never said.
			 */
			bullet.targetX = e.x;
			bullet.targetY = e.y;
		}
		refs.bullets.push(bullet);
		this.projs.set(e.projId, { bullet, life: PROJ_MAX_LIFE_S, spit });
	}

	/** `ProjEnd` (§4.2): it hit something, fell short or left the world — either way it stops being drawn */
	private playProjEnd(refs: GameRefs, e: Net.FxProjEnd): void {
		const rec = this.projs.get(e.projId);
		if (rec === undefined) return;
		this.projs.delete(e.projId);
		// end it where the server says it ended, not where this client's dead reckoning had drifted to
		rec.bullet.x = e.x;
		rec.bullet.y = e.y;
		/*
		 * A spitter's blob becomes an acid puddle where it lands (`zombieBrain.addPuddle`), and the puddle
		 * is the part that matters: it is what slows a survivor who walks through it. The server owns that
		 * slowing — the self block's Acid flag is how you learn you are in one — but §4.5 has no delta for
		 * the puddle itself, so without this the ground a client must avoid would be invisible to them.
		 * Where it lands is not guesswork: `ProjEnd` says exactly where, and it is the same point the server
		 * put its own puddle on.
		 */
		if (rec.spit) {
			refs.puddles ??= [];
			refs.puddles.push({ x: e.x, y: e.y, r: PUDDLE_RADIUS, life: PUDDLE_LIFE, lifeMax: PUDDLE_LIFE });
		}
		this.dropBullet(refs, rec.bullet);
	}

	private dropBullet(refs: GameRefs, b: Bullet): void {
		b.alive = false;
		const list = refs.bullets;
		for (let i = list.size() - 1; i >= 0; i--) {
			if (list[i] === b) {
				list.remove(i);
				return;
			}
		}
	}

	// ---------------------------------------------------------------- what this view has to carry

	/**
	 * Everything this file put into the world, moved one frame on. Call it ONLY where the client's own
	 * systems have stopped running (MP_PHASE ≥ 2): below that the simulation still grows its own blasts and
	 * flies its own arrows, and a second hand on them would run the world at double speed.
	 */
	advance(refs: GameRefs, dt: number): void {
		const step = math.max(0, dt);
		for (let i = this.blasts.size() - 1; i >= 0; i--) {
			const e = this.blasts[i];
			if (e.r < e.rMax) {
				e.r = math.min(e.rMax, e.r + BLAST_GROW * step);
				continue;
			}
			e.life -= step;
			if (e.life > 0) continue;
			this.blasts.remove(i);
			const list = refs.explosions;
			if (list === undefined) continue;
			for (let j = list.size() - 1; j >= 0; j--) {
				if (list[j] === e) {
					list.remove(j);
					break;
				}
			}
		}
		// the acid a spit left behind: `zombieBrain.updatePuddles` ages these below MP_PHASE 2, and the
		// SERVER ages its own copy above it — this one is the drawing, and it has to dry up on its own
		const puddles = refs.puddles;
		if (puddles !== undefined) {
			for (let i = puddles.size() - 1; i >= 0; i--) {
				puddles[i].life -= step;
				if (puddles[i].life <= 0) puddles.remove(i);
			}
		}
		for (const [projId, rec] of this.projs) {
			const b = rec.bullet;
			const moved = b.speed * step;
			b.x += math.cos(b.angle) * moved;
			b.y += math.sin(b.angle) * moved;
			b.travel += moved;
			if (rec.spit) {
				b.targetX = b.x;
				b.targetY = b.y;
			}
			rec.life -= step;
			if (rec.life > 0) continue;
			this.projs.delete(projId);
			this.dropBullet(refs, b);
		}
	}

	/** shot lines age here (Combat did it until F0) so new ones live a full life */
	decayTracers(dt: number): void {
		const list = this.tracers;
		for (let i = list.size() - 1; i >= 0; i--) {
			list[i].life -= dt;
			if (list[i].life <= 0) list.remove(i);
		}
	}

	/** the live shot lines: the night light map brightens around each one while it burns (LUZ-01) */
	shotLines(): ReadonlyArray<Tracer> {
		return this.tracers;
	}

	/**
	 * A new world (a new run, a rebirth). The lists this view pushed into are emptied too: at MP_PHASE ≥ 2
	 * nothing else ages a blast, so one left behind by the previous run would hang in the new town for ever.
	 */
	clear(refs: GameRefs): void {
		refs.explosions?.clear();
		this.tracers.clear();
		this.blasts.clear();
		clearFlinches();
		this.projs.clear();
		this.deaths.clear();
		this.bloodX.clear();
		this.bloodY.clear();
		this.solidIndex.clear();
		this.indexedWorld = undefined;
		this.indexedCount = -1;
	}

	// ---------------------------------------------------------------- drawing

	/** exploder blasts: expanding shock ring + hot core, fading once full size */
	drawExplosions(r: Renderer, cam: Camera, v: ViewRect, refs: GameRefs): void {
		const list = refs.explosions;
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

	drawTracers(r: Renderer, cam: Camera): void {
		for (const t of this.tracers) {
			r.drawSegment(cam, t.x1, t.y1, t.x2, t.y2, {
				h: 3,
				color: t.color,
				alpha: clamp(t.life * 5, 0, 1),
				zIndex: Z.projectile,
			});
		}
	}

	// ---------------------------------------------------------------- solids by id

	/**
	 * `SolidShake` names a solid by id and `WorldData` has no index by id — only the array and the spatial
	 * grid, neither of which answers "which one is 4711?". The index is built on the first hit of a town and
	 * rebuilt whenever the solid count moves (a construction went up, a fence came down), which is as often
	 * as it can change without the whole world being replaced.
	 */
	private solidById(world: WorldData, id: number): Solid | undefined {
		const count = world.solids.size();
		if (this.indexedWorld !== world || this.indexedCount !== count) {
			this.indexedWorld = world;
			this.indexedCount = count;
			this.solidIndex.clear();
			for (const s of world.solids) this.solidIndex.set(s.id, s);
		}
		return this.solidIndex.get(id);
	}
}
