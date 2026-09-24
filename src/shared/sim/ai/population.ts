import { DESIGN } from "shared/engine/constants";
import { chance, choose, rndInt } from "shared/engine/rng";
import { randomRingPoint, removeGroundItemAt, spawnGroundItem, WorldData } from "shared/game/world";
import { circleBlocked } from "shared/game/physics";
import { createBoss, createZombie, ZombieState, ZombieType } from "shared/game/entities";
import { BUILDING_SPAWNS, getDayPopulation } from "shared/data/spawns";
import { MAX_BOSSES, MAX_ZOMBIES } from "shared/net/mpConfig";
import * as Ctx from "shared/sim/ai/context";
import * as Dir from "shared/sim/ai/director";
import { seedHunt, spawnAlpha, takeKills } from "shared/sim/ai/zombieBrain";

/*
 * Population: ambient walkers, specials, night waves, ground items and the bosses (docs/MULTIPLAYER.md §3.5).
 *
 * On top of the original's day table (sys_spawn_time_light: a fixed quota per day and nothing else) sits the
 * pacing director (shared/sim/ai/director.ts). It only scales the AMBIENT quota and the spawn intervals inside
 * its own limits; the 19h/22h/1h wave queues are the original's, untouched — a relief paces a wave, it never
 * shortens it.
 *
 * F2 makes it multiplayer without punishing the group. Survivors standing within CLUSTER_RADIUS of each other
 * form a CLUSTER, and a cluster of k gets S(k) = 1 + 0.5·(k − 1) times the horde: six together face 3.5× the
 * solo night, never 6×, because k players together are worth more than k players alone (crowd control, focus
 * and revives). A survivor alone on a full server faces exactly the solo game, S(1) = 1.
 *
 * MP-09 is enforced here and only here: MAX_ZOMBIES (150) alive on the whole server, and nothing ever appears
 * within MP09_SAFE_RADIUS of ANY survivor — not just the one whose ring it was drawn around.
 */

const SPECIAL_TYPES: Array<number> = [2, 3, 4, 5];
/** free radius required around a spawn point (original: 40×40 box free of solids) */
const SPAWN_CLEARANCE = 24;
/** ambient walkers added per spawn tick (the original filled the whole quota in one alarm) */
const AMBIENT_BATCH = 3;
/** MP-09: nothing spawns within this of ANY survivor */
export const MP09_SAFE_RADIUS = 720;
/** MP-09: hard ceiling of what one server simulates (§3.5) */
export const MP09_ZOMBIE_CAP = MAX_ZOMBIES;
/** the director is sampled at 4 Hz: counting the horde around the survivors every frame is pointless */
const DIRECTOR_TICK = 0.25;
/** however hot the director runs, the ambient quota never drops under this (the town is never empty) */
const AMBIENT_FLOOR = 3;
/** §3.5: survivors closer than this to each other are one cluster */
export const CLUSTER_RADIUS = 1500;
/** §3.5: a zombie counts against the cluster of the survivor it is nearest to, within this */
export const CLUSTER_CLAIM = 1600;
/** §3.5: the clusters are recomputed this often (a second is far below how fast a group can split) */
const CLUSTER_TICK = 1;
/** §3.5: a boss's HP scales with the survivors within this of the anchor when it wakes */
const BOSS_SCALE_RANGE = 1500;

/** §3.5: S(k) = 1 + 0,5·(k − 1) — sublinear on purpose, see the header */
export function clusterScale(k: number): number {
	return k > 0 ? 1 + 0.5 * (k - 1) : 1;
}

/**
 * A world with survivors in it and nobody standing among them (docs/DESIGN_RULES.md MP-21).
 *
 * The clusters are built from the LIVING on purpose (`rebuildClusters`: a horde spawned around a body is a
 * horde nobody can fight), so when every survivor present is dead there is no cluster, and with no cluster
 * nothing spawns — no ambient walker, no special, and not the night's waves, whose queues sit full on the
 * clock until somebody is back on their feet. With survivors still standing elsewhere, a Rebirth or the daybreak
 * revive (server/sim/life.ts) ends it within one night; with nobody left alive at all it lasts the 30 s decision
 * window at most, because then the world itself ends and a new town begins (MP-22, server/sim/worldReset.ts).
 *
 * What was missing was a way to SEE it: "the waves never came" in a playtest was exactly this, and nothing
 * said so (tools/test-waves.mjs). These numbers are for the server log and the admin panel only — they
 * change nothing about the game, and on a client that still runs its own population (MP_PHASE < 2) nobody
 * reads them.
 */
export interface PopulationStall {
	/** survivors present and none of them standing, as of the last `update` */
	active: boolean;
	/** how many times the world went from spawning to stalled since boot */
	episodes: number;
	/** seconds spent stalled since boot */
	seconds: number;
	/** seconds the current stall has lasted (0 while the world is spawning) */
	current: number;
}

/** one group of survivors that the population is computed for */
interface Cluster {
	/** lowest player index in the group: a stable name while the group holds together */
	key: number;
	members: Array<number>;
	scale: number;
	walkers: number;
	specials: number;
}

/** what a cluster carries between rebuilds (timers must not restart every second) */
interface ClusterState {
	director: Dir.PaceDirector;
	ambientTimer: number;
	specialTimer: number;
	waveTimer: number;
	specialWaveTimer: number;
	itemTimer: number;
	directorTimer: number;
	/** kills seen since this cluster's director last sampled (they must not be thrown away between samples) */
	pendingKills: number;
	lastHp: number;
	/** round-robin cursor over the members: consecutive spawns ring different survivors */
	rr: number;
}

function newState(): ClusterState {
	return {
		director: new Dir.PaceDirector(),
		ambientTimer: 0,
		specialTimer: 0,
		waveTimer: 0,
		specialWaveTimer: 0,
		itemTimer: 0,
		directorTimer: 0,
		pendingKills: 0,
		lastHp: -1,
		rr: 0,
	};
}

/** original Alarm 2: while there are fewer than 4 specials, prefer a type that is not on the map */
function pickSpecialType(zombies: Array<ZombieState>): ZombieType {
	let specialCount = 0;
	const present: Array<number> = [];
	for (const z of zombies) {
		if (z.special) {
			specialCount++;
			present.push(z.type);
		}
	}
	if (specialCount < DESIGN.ZOMBIE_SPECIAL_NUMBER_MAX) {
		const missing: Array<number> = [];
		for (const t of SPECIAL_TYPES) {
			if (!present.includes(t)) missing.push(t);
		}
		if (missing.size() > 0) {
			return choose(missing) as ZombieType;
		}
	}
	return choose(SPECIAL_TYPES) as ZombieType;
}

function rollGroundLoot(): { kind: number; index: number; count: number } {
	const lootTable = BUILDING_SPAWNS[0];
	const e = choose(lootTable);
	if (e.max < 1) {
		if (chance(e.max * 100)) {
			return { kind: e.kind, index: e.index, count: 1 };
		}
		return { kind: 4, index: 23, count: rndInt(1, 3) };
	}
	return { kind: e.kind, index: e.index, count: rndInt(e.min, e.max) };
}

/**
 * Zombie population (sys_spawn_time_light). Walkers and specials are separate channels like the original:
 * ambient walkers fill up to the day's quota, wave walkers stream in from the night queues, and specials have
 * their own quota and queues. Every quota and ceiling is now per CLUSTER and scaled by S(k) (§3.5).
 */
export class Population {
	private clusterTimer = CLUSTER_TICK;
	/**
	 * How many survivors the current clusters were built for. A cluster stores INDICES into `refs.players`,
	 * so somebody joining or leaving renumbers every survivor after them: waiting out the 1 s CLUSTER_TICK
	 * with a stale partition means spawning around, and reading the hp of, a survivor who is not there any
	 * more — which, on a server that owns the horde, is a crash a player can cause by walking out.
	 */
	private clusterRoster = -1;
	private clusters: Array<Cluster> = [];
	private readonly states = new Map<number, ClusterState>();

	/**
	 * The pacing director of the FIRST cluster — the one a single-survivor world, the HUD and the tests mean
	 * by "the" director. It lives here rather than in that cluster's state so the object survives the group
	 * splitting and re-forming: with one survivor it is the only director there has ever been.
	 */
	readonly director = new Dir.PaceDirector();

	/** survivors present, none standing, nothing spawning: observed here, never acted on (see PopulationStall) */
	readonly stall: PopulationStall = { active: false, episodes: 0, seconds: 0, current: 0 };

	private directorFor(ci: number, st: ClusterState): Dir.PaceDirector {
		return ci === 0 ? this.director : st.director;
	}

	/** every cluster's scale, for diagnostics and the admin panel (one entry per group of survivors) */
	scales(): Array<number> {
		const out = new Array<number>();
		for (const c of this.clusters) out.push(c.scale);
		return out;
	}

	private stateFor(key: number): ClusterState {
		let s = this.states.get(key);
		if (s === undefined) {
			s = newState();
			this.states.set(key, s);
		}
		return s;
	}

	// ------------------------------------------------------------ clusters (§3.5)

	/** MP-09: no zombie ever appears in anyone's face */
	private farFromEveryone(refs: Ctx.AiRefs, x: number, y: number): boolean {
		for (const p of refs.players) {
			if (p.dead) continue;
			const dx = p.x - x;
			const dy = p.y - y;
			if (dx * dx + dy * dy < MP09_SAFE_RADIUS * MP09_SAFE_RADIUS) return false;
		}
		return true;
	}

	/**
	 * A point on the spawn ring of `cx, cy` that is free of solids and — MP-09 — at least MP09_SAFE_RADIUS
	 * from EVERY survivor, not just the one the ring is drawn around.
	 */
	private ringOpen(
		refs: Ctx.AiRefs,
		cx: number,
		cy: number,
		minR: number,
		maxR: number,
		safe = false,
	): { x: number; y: number } | undefined {
		const world: WorldData = refs.world;
		for (let i = 0; i < 12; i++) {
			const p = randomRingPoint(cx, cy, minR, maxR);
			if (p.x < 0 || p.y < 0 || p.x > world.width || p.y > world.height) continue;
			if (circleBlocked(world, p.x, p.y, SPAWN_CLEARANCE) !== undefined) continue;
			if (safe && !this.farFromEveryone(refs, p.x, p.y)) continue;
			return p;
		}
		return undefined;
	}

	/**
	 * Groups the standing survivors (union-find over at most MAX_PLAYERS nodes) and counts the horde each
	 * group is carrying. A zombie belongs to the cluster of the survivor it is nearest to, while it is within
	 * CLUSTER_CLAIM of them; farther out it belongs to nobody and holds nobody's quota down.
	 */
	private rebuildClusters(refs: Ctx.AiRefs): void {
		const players = refs.players;
		const n = players.size();
		this.clusterRoster = n;
		const parent = new Array<number>();
		for (let i = 0; i < n; i++) parent.push(i);
		const find = (i: number): number => {
			let r = i;
			while (parent[r] !== r) r = parent[r];
			while (parent[i] !== r) {
				const up = parent[i];
				parent[i] = r;
				i = up;
			}
			return r;
		};
		const r2 = CLUSTER_RADIUS * CLUSTER_RADIUS;
		for (let i = 0; i < n; i++) {
			if (players[i].dead) continue;
			for (let j = i + 1; j < n; j++) {
				if (players[j].dead) continue;
				const dx = players[i].x - players[j].x;
				const dy = players[i].y - players[j].y;
				if (dx * dx + dy * dy > r2) continue;
				const a = find(i);
				const b = find(j);
				if (a !== b) parent[a] = b;
			}
		}
		this.clusters.clear();
		const byRoot = new Map<number, number>();
		for (let i = 0; i < n; i++) {
			if (players[i].dead) continue;
			const root = find(i);
			let idx = byRoot.get(root);
			if (idx === undefined) {
				idx = this.clusters.size();
				byRoot.set(root, idx);
				this.clusters.push({ key: i, members: [], scale: 1, walkers: 0, specials: 0 });
			}
			this.clusters[idx].members.push(i);
		}
		for (const c of this.clusters) c.scale = clusterScale(c.members.size());
		// attribute the horde: nearest living survivor, inside the claim radius
		if (this.clusters.size() === 0) return;
		const clusterOfPlayer = new Array<number>();
		for (let i = 0; i < n; i++) clusterOfPlayer.push(-1);
		for (let ci = 0; ci < this.clusters.size(); ci++) {
			for (const m of this.clusters[ci].members) clusterOfPlayer[m] = ci;
		}
		const claim2 = CLUSTER_CLAIM * CLUSTER_CLAIM;
		for (const z of refs.zombies) {
			const pi = Ctx.nearestPlayerIndex(refs, z.x, z.y);
			if (pi < 0) continue;
			const p = players[pi];
			const dx = p.x - z.x;
			const dy = p.y - z.y;
			if (dx * dx + dy * dy > claim2) continue;
			const ci = clusterOfPlayer[pi];
			if (ci < 0) continue;
			if (z.special) this.clusters[ci].specials += 1;
			else this.clusters[ci].walkers += 1;
		}
	}

	// ------------------------------------------------------------ spawning

	/** the survivor of this cluster whose ring the next spawn is drawn around (round-robin, §3.5) */
	private ringPlayer(refs: Ctx.AiRefs, c: Cluster, st: ClusterState): { x: number; y: number } {
		const i = c.members[st.rr % c.members.size()];
		st.rr = (st.rr + 1) % c.members.size();
		// the same one-tick staleness as `updateDirector`: ring the first survivor rather than a hole
		return refs.players[i] ?? refs.players[0];
	}

	private spawnZombie(refs: Ctx.AiRefs, c: Cluster, st: ClusterState, zType: ZombieType, wave: boolean): boolean {
		// MP-09: hard ceiling on what one server simulates
		if (refs.zombies.size() >= MP09_ZOMBIE_CAP) return false;
		const p = this.ringPlayer(refs, c, st);
		const pos = this.ringOpen(refs, p.x, p.y, DESIGN.ZOMBIE_SPAWN_MIN, DESIGN.ZOMBIE_SPAWN_MAX, true);
		if (pos === undefined) return false;
		const z = createZombie(zType, pos.x, pos.y, refs.clock.day, wave);
		// anti-ESP (§4.3, §9.1): born at the alpha the light at (pos.x, pos.y) already gives it, not always
		// alpha 1 -- see zombieBrain.ts `spawnAlpha` for why a hardcoded 1 leaked every dark spawn's position.
		z.alpha = spawnAlpha(refs, pos.x, pos.y);
		if (wave) {
			// a wave zombie is the original's tide: it comes and it does not stop coming
			z.detect = true;
		} else if (z.detect) {
			// obj_zombie's 10% that spawn already hunting: they arrive knowing where the survivor WAS,
			// so they can lose the trail like anything else instead of homing for ever
			seedHunt(z, p.x, p.y);
		}
		refs.zombies.push(z);
		if (z.special) c.specials += 1;
		else c.walkers += 1;
		return true;
	}

	/** the day's ambient quota for this cluster, after the director's adjustment and S(k) */
	private ambientQuota(base: number, c: Cluster, dir: Dir.PaceDirector): number {
		if (base <= 0) return 0;
		const scaled = math.floor(base * c.scale * dir.ambientScale + 0.5);
		return math.clamp(scaled, math.min(AMBIENT_FLOOR, base), MP09_ZOMBIE_CAP);
	}

	private spawnAmbient(refs: Ctx.AiRefs, c: Cluster, st: ClusterState, dir: Dir.PaceDirector): void {
		const pop = getDayPopulation(refs.clock.day);
		const quota = this.ambientQuota(pop.ambient, c, dir);
		for (let i = 0; i < AMBIENT_BATCH && c.walkers < quota; i++) {
			if (!this.spawnZombie(refs, c, st, 1, false)) break;
		}
	}

	private spawnAmbientSpecial(refs: Ctx.AiRefs, c: Cluster, st: ClusterState, dir: Dir.PaceDirector): void {
		const pop = getDayPopulation(refs.clock.day);
		const quota = this.ambientQuota(pop.ambientSpecial, c, dir);
		// §3.5: the cluster's ceiling of specials is 4 + k − 1
		const cap = DESIGN.ZOMBIE_SPECIAL_NUMBER_MAX + c.members.size() - 1;
		if (c.specials >= quota || c.specials >= cap) return;
		this.spawnZombie(refs, c, st, pickSpecialType(refs.zombies), false);
	}

	/** index of the first active wave (0..2) whose queue still has entries, or -1 */
	private activeWave(refs: Ctx.AiRefs, queues: Array<number>): number {
		const clock = refs.clock;
		if (clock.wave1Active && queues[0] > 0) return 0;
		if (clock.wave2Active && queues[1] > 0) return 1;
		if (clock.wave3Active && queues[2] > 0) return 2;
		return -1;
	}

	private spawnWave(refs: Ctx.AiRefs, c: Cluster, st: ClusterState): void {
		// §3.5: the cluster's ceiling of walkers on the tide is 40·S(k)
		if (c.walkers >= DESIGN.ZOMBIE_NUMBER_MAX * c.scale) return;
		const queues = refs.clock.waveQueues;
		const i = this.activeWave(refs, queues);
		if (i < 0) return;
		if (this.spawnZombie(refs, c, st, 1, true)) {
			queues[i] = queues[i] - 1;
		}
	}

	private spawnSpecialWave(refs: Ctx.AiRefs, c: Cluster, st: ClusterState): void {
		if (c.specials >= DESIGN.ZOMBIE_SPECIAL_NUMBER_MAX + c.members.size() - 1) return;
		const queues = refs.clock.specialWaveQueues;
		const i = this.activeWave(refs, queues);
		if (i < 0) return;
		if (this.spawnZombie(refs, c, st, choose(SPECIAL_TYPES) as ZombieType, true)) {
			queues[i] = queues[i] - 1;
		}
	}

	private spawnGroundItem(refs: Ctx.AiRefs, c: Cluster, st: ClusterState): void {
		const p = this.ringPlayer(refs, c, st);
		const pos = this.ringOpen(refs, p.x, p.y, DESIGN.ITEM_SPAWN_MIN, DESIGN.ITEM_SPAWN_MAX);
		if (pos === undefined) return;
		const loot = rollGroundLoot();
		spawnGroundItem(refs.world, loot.kind, loot.index, loot.count, pos.x, pos.y);
	}

	/**
	 * Feed the director of one cluster: hp its survivors lost, zombies killed anywhere, how many are on top
	 * of them and how hurt they are. Sampled at DIRECTOR_TICK so counting the horde costs nothing per frame.
	 */
	private updateDirector(
		refs: Ctx.AiRefs,
		c: Cluster,
		st: ClusterState,
		dt: number,
		kills: number,
		dir: Dir.PaceDirector,
	): void {
		// every kill counts, whatever tick it happened on: the sample is 4 Hz, the fighting is not
		st.pendingKills += kills;
		st.directorTimer += dt;
		if (st.directorTimer < DIRECTOR_TICK) return;
		const step = st.directorTimer;
		st.directorTimer = 0;
		let hp = 0;
		let hpMax = 0;
		let alive = 0;
		for (const i of c.members) {
			const p = refs.players[i];
			// belt and braces over the rebuild above: a member index is only ever stale for one tick, and
			// one tick of a wrong hp reading is cheaper than a crash in the middle of a night
			if (p === undefined || p.dead) continue;
			alive++;
			hp += math.max(0, p.hp);
			hpMax += p.hpMax;
		}
		if (st.lastHp < 0) st.lastHp = hp;
		// only losses count: healing and respawning are not the survivors having a bad time
		const damage = math.max(0, st.lastHp - hp);
		st.lastHp = hp;
		let near = 0;
		for (const z of refs.zombies) {
			if (z.hp <= 0) continue;
			for (const i of c.members) {
				const p = refs.players[i];
				if (p === undefined) continue;
				const dx = p.x - z.x;
				const dy = p.y - z.y;
				if (dx * dx + dy * dy < Dir.DIRECTOR_NEAR * Dir.DIRECTOR_NEAR) {
					near++;
					break;
				}
			}
		}
		const counted = st.pendingKills;
		st.pendingKills = 0;
		dir.update({ damage, kills: counted, near, health: alive > 0 && hpMax > 0 ? hp / hpMax : 1 }, step);
	}

	/** inside the spawn square of at least one survivor */
	private nearAnyPlayer(refs: Ctx.AiRefs, x: number, y: number, range: number): boolean {
		for (const p of refs.players) {
			if (math.abs(x - p.x) <= range && math.abs(y - p.y) <= range) return true;
		}
		return false;
	}

	/**
	 * Zombies that fell out of every survivor's spawn square: plain walkers vanish; wave walkers and specials
	 * are moved back onto the ring of the nearest survivor (original deactive/respawn), so a night wave or a
	 * rare special is not lost just because somebody ran.
	 */
	/** a zombie nobody can see any more leaves in silence: the replication has to know it is gone (§4.4) */
	private recycle(refs: Ctx.AiRefs, i: number): void {
		if (refs.onZombieGone !== undefined) refs.onZombieGone(refs.zombies[i], false);
		refs.zombies.remove(i);
	}

	private cleanup(refs: Ctx.AiRefs): void {
		for (let i = refs.zombies.size() - 1; i >= 0; i--) {
			const z = refs.zombies[i];
			if (this.nearAnyPlayer(refs, z.x, z.y, DESIGN.ZOMBIE_SPAWN_MAX)) continue;
			if (z.hp <= 0) continue; // a lit exploder finishes its fuse
			if (z.wave || z.special) {
				const pi = Ctx.nearestPlayerIndex(refs, z.x, z.y);
				const p = refs.players[pi < 0 ? 0 : pi];
				const pos = this.ringOpen(refs, p.x, p.y, DESIGN.ZOMBIE_SPAWN_MIN, DESIGN.ZOMBIE_SPAWN_MAX, true);
				if (pos !== undefined) {
					z.x = pos.x;
					z.y = pos.y;
					z.spawnX = pos.x;
					z.spawnY = pos.y;
					z.jumping = false;
					z.jumpHeight = 0;
					z.rush = false;
					z.reactionSpeed = 0;
					z.stunned = 0;
				} else {
					this.recycle(refs, i);
				}
			} else {
				this.recycle(refs, i);
			}
		}
		for (let i = refs.world.items.size() - 1; i >= 0; i--) {
			const it = refs.world.items[i];
			// through the world's own removal: on the server that is the grid and the ItemRemove every client that was
			// shown the item is owed -- splicing the list left it on their screens for good (a ghost E could not take)
			if (!this.nearAnyPlayer(refs, it.x, it.y, DESIGN.ITEM_SPAWN_MAX)) removeGroundItemAt(refs.world, i);
		}
	}

	/**
	 * A boss wakes when a standing survivor comes within BOSS_LENGTH of an anchor that is due. §3.5: at most
	 * MAX_BOSSES at once, and its HP scales with how many survivors are close enough to take part.
	 */
	private spawnBoss(refs: Ctx.AiRefs): void {
		if (refs.bosses.size() >= MAX_BOSSES) return;
		const day = refs.clock.day;
		for (const anchor of refs.world.bossAnchors) {
			if (day < anchor.nextDay) continue;
			let near = false;
			let party = 0;
			for (const p of refs.players) {
				if (p.dead) continue;
				const d = Ctx.actorDist(anchor.x, anchor.y, p.x, p.y);
				if (d < DESIGN.BOSS_LENGTH) near = true;
				if (d <= BOSS_SCALE_RANGE) party += 1;
			}
			if (!near) continue;
			const b = createBoss(anchor.type, anchor.x, anchor.y);
			const scale = clusterScale(party);
			b.hp *= scale;
			b.hpMax *= scale;
			refs.bosses.push(b);
			anchor.nextDay = day + DESIGN.BOSS_RESPAWN_DAY;
			break;
		}
	}

	/**
	 * The symmetric case of the empty world below: survivors ARE here and there is still no cluster, because
	 * `rebuildClusters` only groups the living. Counted, not corrected — see PopulationStall.
	 */
	private noteStall(stalled: boolean, dt: number): void {
		const s = this.stall;
		if (!stalled) {
			s.active = false;
			s.current = 0;
			return;
		}
		if (!s.active) {
			s.active = true;
			s.episodes += 1;
			s.current = 0;
		}
		s.seconds += dt;
		s.current += dt;
	}

	update(refs: Ctx.AiRefs, dt: number): void {
		// nobody in the world: nothing to spawn around, and nothing to recycle against — empty, not stalled
		if (refs.players.size() === 0) {
			this.noteStall(false, dt);
			return;
		}
		this.clusterTimer += dt;
		if (this.clusterTimer >= CLUSTER_TICK || this.clusterRoster !== refs.players.size()) {
			this.clusterTimer = 0;
			this.rebuildClusters(refs);
		}
		// survivors here, and every one of them down: the loop below has nothing to spawn around
		this.noteStall(this.clusters.size() === 0, dt);
		// one drain for the whole world: every cluster's director hears about every kill, because a fight
		// anywhere is pressure the pacing has to answer for
		const kills = takeKills(refs.ai);
		// §3.5: ITEM_NUMBER × S(k) per cluster, topped up against one world-wide count
		let itemTarget = 0;
		for (const c of this.clusters) itemTarget += DESIGN.ITEM_NUMBER * c.scale;
		for (let ci = 0; ci < this.clusters.size(); ci++) {
			const c = this.clusters[ci];
			const st = this.stateFor(c.key);
			const dir = this.directorFor(ci, st);
			this.updateDirector(refs, c, st, dt, kills, dir);
			// the director stretches the intervals instead of touching the queues: a relief makes the town
			// fill up slowly, a build-up makes it fill up faster, and the night still delivers every zombie
			const ambientEvery = DESIGN.ZOMBIE_SPAWN_TIME / dir.ambientScale;
			const waveEvery = DESIGN.ZOMBIE_WAVE_SPAWN_TIME / dir.waveScale;
			st.ambientTimer += dt;
			if (st.ambientTimer >= ambientEvery) {
				st.ambientTimer = 0;
				this.spawnAmbient(refs, c, st, dir);
			}
			st.specialTimer += dt;
			if (st.specialTimer >= ambientEvery) {
				st.specialTimer = 0;
				this.spawnAmbientSpecial(refs, c, st, dir);
			}
			st.itemTimer += dt;
			if (st.itemTimer >= 1) {
				st.itemTimer = 0;
				if (refs.world.items.size() < itemTarget) {
					this.spawnGroundItem(refs, c, st);
				}
			}
			st.waveTimer += dt;
			if (st.waveTimer >= waveEvery) {
				st.waveTimer = 0;
				this.spawnWave(refs, c, st);
			}
			st.specialWaveTimer += dt;
			if (st.specialWaveTimer >= waveEvery) {
				st.specialWaveTimer = 0;
				this.spawnSpecialWave(refs, c, st);
			}
		}
		this.cleanup(refs);
		this.spawnBoss(refs);
	}
}
