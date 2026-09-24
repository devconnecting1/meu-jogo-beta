import { getDayPopulation } from "shared/data/spawns";
import { zombieDef } from "shared/data/zombies";
import { BossState, ZombieType, bossHitRadius, createBoss, createZombie } from "shared/game/entities";
import type { PlayerState } from "shared/game/player";
import { PLAYER_RADIUS, circleBlocked } from "shared/game/physics";
import { GroundItem, removeSolid, spawnGroundItem } from "shared/game/world";
import { MAX_BUILDS_PER_PLAYER, MAX_BUILDS_PER_SERVER, SLOT_NONE } from "shared/net/mpConfig";
import * as Mind from "shared/sim/ai/memory";
import { spawnAlpha } from "shared/sim/ai/zombieBrain";
import { Weather, weatherAssists, weatherName } from "shared/sim/weather";
import type { AdminEvent, AdminResponse } from "shared/admin/protocol";
import * as W from "shared/admin/worldOps";
import type { MpHost } from "../net/mpHost";
import { stripAdminMods } from "../sim/life";
import { ServerPlayer, findSpawnPoint } from "../sim/players";
import type { ServerSimulation } from "../sim/simulation";

/*
 * The admin's world tools, run by the SERVER on the world it owns (docs/MULTIPLAYER.md §10, F6-6B).
 *
 * Until this file the panel's world tools edited the admin's own copy of a world the server owned from MP_PHASE 2:
 * the spawns were wiped by the next snapshot, the clock snapped back, a teleport rubber-banded, and god mode drew a
 * full HP bar while the server killed the body -- each of them toasting success and writing an audit line. Now every
 * tool is an AdminRequest `{ kind: "world", op }` (shared/admin/worldOps.ts) that server/admin/adminServer.ts has
 * already authorized by UserId and rate limited; this module validates it against the world as it is, runs it, and
 * answers what really happened, with the audit line to write.
 *
 * Who a tool helps, and so whose run stops paying (§9.3 "assisted run"; server/main.server.ts `markAssisted`):
 *   - the admin's own body (god, noclip, infinite ammo, a heal of themselves, a teleport, the free camera's scouting)
 *     and what they build or take down for themselves (items, structures, a construction removed): the ADMIN's run;
 *   - a heal of another survivor: THAT survivor's run;
 *   - whatever moves the world's clock (the hour, night, dawn, a wave) or clears its horde (kill all): EVERY run on the
 *     server, the lobby's kept runs included -- a clock moved backwards across midnight lets it cross it again and pay
 *     that day twice (server/sim/waves.ts `onClockSet`), and a horde cleared at night is a night nobody had to survive;
 *   - a weather (or the rain) that eases the night against the one the day rolled -- fog, rain or a storm over a
 *     clearer day: the horde sees or hears less (shared/sim/weather.ts `weatherAssists`): EVERY run, likewise;
 *   - what only adds danger or is cosmetic (a spawned zombie or boss, a clearer sky than the roll, clearing the blood):
 *     nobody. A spawn pays nobody either (`unpaid`: no XP, no kill, no loot), so it is never a way to farm.
 *
 * The switches (god, noclip, infinite ammo) belong to the PERSON, not to a body: they are kept here by UserId and put
 * on whatever body the survivor has, every tick (`ServerSimulation.adminMods`), so a stand-up, a reset or a trip to
 * the lobby does not silently drop them while the panel still shows them on. They end when the admin leaves the server.
 * A body that leaves the world sheds them (server/sim/life.ts `stripAdminMods`), so a switch turned off from the
 * lobby, or a session that ended, never stays on a kept body. And while any switch or the free camera is on, the run
 * of whatever body the admin stands in is marked, every tick: a new run (a reset, a New game) does not pay either.
 *
 * What an admin drops pays nobody but the item itself (`GroundItem.unpaid`): whoever picks it up gets no collector
 * credit, the pickup is logged (`world:taken`), and the run of whoever took it is assisted from then (review of
 * 97cd734, M1). Cosmetics (outfits, pets) are never dropped: the shop sells them.
 */

const Players = game.GetService("Players");

/** a free camera the panel stopped refreshing falls back to the body after this long (it refreshes every second) */
const FREECAM_TTL_S = 4;
/** the tools a panel repeats in bursts (Shift+click placing): the SAME line again counts on the last one ("×N") */
const MERGED = new Set<string>(["clock", "spawn", "spawnItem", "spawnStructure"]);

interface Mods {
	god: boolean;
	noclip: boolean;
	ammo: boolean;
}

/** the audit line of a world op (server/admin/adminServer.ts `record`) */
export interface WorldAudit {
	action: string;
	targetId: number;
	/** a place word of server/admin/auditLog.ts: "all" (the shared world) or "own run" (the admin's own body) */
	target: string;
	details: string;
	ok: boolean;
	/** the same line again inside a couple of seconds counts on the last one ("×N"): Shift+click on one spot */
	merge: boolean;
}

export interface WorldOutcome {
	res: AdminResponse;
	/** undefined: nothing to log (a read, a free camera that only moved) */
	audit?: WorldAudit;
}

export interface AdminWorldDeps {
	/** the running host, or undefined with MP_PHASE = 0 (every client simulates its own world then) */
	host: () => MpHost | undefined;
	/** §9.3: this player's run earns no coins, achievements or records from now on; true when newly marked */
	markAssisted: (player: Player) => boolean;
	/** an AdminEvent to every client of this server */
	broadcast: (ev: AdminEvent) => void;
	/** an audit line the SERVER writes, acting on `targetId` (a pickup of an admin's drop): no admin did it */
	note: (action: string, targetId: number, details: string) => void;
}

export interface AdminWorldTools {
	/** one authorized, rate-limited `{ kind: "world" }` request (its payload still untrusted) */
	handle(caller: Player, raw: Record<string, unknown>): WorldOutcome;
	/** the player left the server: their switches and their free camera end */
	left(userId: number): void;
	/** the switches of a user (tests, the panel's first look) */
	stateOf(userId: number): W.AdminWorldState;
}

export function startAdminWorld(deps: AdminWorldDeps): AdminWorldTools {
	const mods = new Map<number, Mods>();
	/** the simulation tick of the last change of the sky (the weather or the rain), for its cooldown */
	let skyTick = -math.huge;
	/** the simulation tick the hands last moved (clock, night, dawn, a wave), for theirs */
	let handsTick = -math.huge;
	/** UserIds whose free camera is on (only the on/off edges are logged, never the moves) */
	const cams = new Set<number>();
	let hooked: ServerSimulation | undefined;

	// ------------------------------------------------------------ the switches

	/** the switches `m` on body `p`; an infinite magazine switched off is emptied, whichever switch was toggled */
	function putMods(p: PlayerState, m: Mods): void {
		if (p.infiniteAmmo === true && !m.ammo) {
			// the free magazine never becomes real ammo: emptied, and the weapon reloads from its pool
			p.weapon.ammoCount = 0;
			p.weapon.reloading = false;
			p.weapon.reloadCount = 0;
		}
		p.godMode = m.god;
		p.noclip = m.noclip;
		p.infiniteAmmo = m.ammo;
	}

	function applyMods(sp: ServerPlayer): void {
		// the admin's sky still eases the night against the day's own roll (LUZ-05, §9.3): whoever is in the world is
		// helped by it -- a run that came in after the tool was used as well (it was only the runs of that moment)
		const sim = hooked;
		if (sim !== undefined && weatherAssists(sim.clock.dayRoll, sim.clock.weather)) {
			const player = Players.GetPlayerByUserId(sp.userId);
			if (player !== undefined) deps.markAssisted(player);
		}
		const m = mods.get(sp.userId);
		const cam = cams.has(sp.userId);
		if (m === undefined && !cam) return;
		if (m !== undefined) {
			const p = sp.state;
			putMods(p, m);
			// no bite lands on a god (applyPlayerDamage), and neither starvation nor poison may kill one: topped up
			// before every step, so the step can never take a full body to 0
			if (m.god && !p.dead) {
				p.hp = p.hpMax;
				p.buffs.poison = 0;
			}
		}
		// a switch (an entry exists only while one is on) or the free camera helps whatever run this body is in -- a
		// new one included (a reset, a New game): marked every tick, a no-op once it is (the review of 8f50bc5, MEDIUM-2)
		const player = Players.GetPlayerByUserId(sp.userId);
		if (player !== undefined) deps.markAssisted(player);
	}

	/**
	 * who picked up an admin's drop (`GroundItem.unpaid`): one server-written audit line, with what they took (the
	 * save's ceiling can leave part of it on the ground, ITM-07) -- and THEIR run is assisted from here (§9.3; review of
	 * 97cd734, M1): a weapon an admin handed over is a night made easier, like the same weapon given by a save edit
	 */
	function taken(sim: ServerSimulation, slot: number, item: GroundItem, count: number): void {
		const sp = sim.get(slot);
		deps.note("world:taken", sp?.userId ?? 0, `kind ${item.kind} item ${item.itemId} ×${count} an admin dropped`);
		const player = sp !== undefined ? Players.GetPlayerByUserId(sp.userId) : undefined;
		if (player !== undefined) deps.markAssisted(player);
		// ...and told so, at once (review of b0174ed, L-1): it is never a surprise. Only an E press takes an admin's drop
		// (shared/sim/pickupRule.ts `walkPickupTarget` passes it over), so nobody walks into it
		if (sp !== undefined) deps.host()?.replicator.adminItem(slot);
	}

	/**
	 * The simulation calls `applyMods` for every survivor before its step (a new town keeps the same simulation); the
	 * items of the town (rebuilt with it) report the pickups of an admin's drops.
	 */
	function hook(sim: ServerSimulation): void {
		const items = sim.items;
		if (items !== undefined && items.onUnpaidTaken === undefined) {
			items.onUnpaidTaken = (slot, item, count) => taken(sim, slot, item, count);
		}
		if (hooked === sim && sim.adminMods !== undefined) return;
		hooked = sim;
		sim.adminMods = sp => applyMods(sp);
	}

	function stateOf(userId: number): W.AdminWorldState {
		const m = mods.get(userId);
		return {
			god: m?.god === true,
			noclip: m?.noclip === true,
			ammo: m?.ammo === true,
			freecam: cams.has(userId),
		};
	}

	function setMod(userId: number, key: keyof Mods, on: boolean): Mods {
		const m = mods.get(userId) ?? { god: false, noclip: false, ammo: false };
		m[key] = on;
		if (m.god || m.noclip || m.ammo) mods.set(userId, m);
		else mods.delete(userId);
		return m;
	}

	// ------------------------------------------------------------ answers

	function data(caller: Player, assisted: boolean, x?: number, y?: number): W.AdminWorldData {
		return { state: stateOf(caller.UserId), assisted, x, y };
	}

	function done(
		caller: Player,
		op: W.AdminWorldOp,
		message: string,
		assisted: boolean,
		target: string,
		extra = "",
		targetId = 0,
		x?: number,
		y?: number,
	): WorldOutcome {
		const text = W.describeWorldOp(op);
		const details = text !== "" && extra !== "" ? `${text} · ${extra}` : text !== "" ? text : extra;
		return {
			res: { ok: true, message, data: data(caller, assisted, x, y) },
			audit: { action: `world:${op.op}`, targetId, target, details, ok: true, merge: MERGED.has(op.op) },
		};
	}

	function refuse(name: string, reason: string, what = "", targetId = 0): WorldOutcome {
		return {
			res: { ok: false, error: reason },
			audit: {
				action: `world:${name}`,
				targetId,
				target: targetId !== 0 ? "" : "all",
				details: what !== "" ? `${what} · refused: ${reason}` : `refused: ${reason}`,
				ok: false,
				merge: true,
			},
		};
	}

	// ------------------------------------------------------------ helpers

	/** a zombie or an item is only kept near a survivor: farther than `range` on either axis from all, it is swept */
	function nearSurvivor(sim: ServerSimulation, x: number, y: number, range: number): boolean {
		for (const sp of sim.players()) {
			if (math.abs(sp.state.x - x) <= range && math.abs(sp.state.y - y) <= range) return true;
		}
		return false;
	}

	/** the nearest living body to (x, y), or undefined */
	function nearestBody(sim: ServerSimulation, x: number, y: number): ServerPlayer | undefined {
		let best: ServerPlayer | undefined;
		let bestD = math.huge;
		for (const sp of sim.players()) {
			if (sp.state.dead) continue;
			const d = (sp.state.x - x) * (sp.state.x - x) + (sp.state.y - y) * (sp.state.y - y);
			if (d < bestD) {
				bestD = d;
				best = sp;
			}
		}
		return best;
	}

	/**
	 * Every run of this server is helped by this op: each one is marked -- in the world, and in the lobby too (a kept
	 * run walks back into the clock that was moved: the review of 8f50bc5, L1). The caller's own included.
	 */
	function assistWorld(caller: Player): [number, boolean] {
		let n = 0;
		let mine = false;
		for (const p of Players.GetPlayers()) {
			if (!deps.markAssisted(p)) continue;
			n += 1;
			if (p === caller) mine = true;
		}
		return [n, mine];
	}

	function runsText(n: number): string {
		return n > 0 ? `${n} run${n === 1 ? "" : "s"} now assisted` : "";
	}

	/** the non-empty parts, joined for an audit line */
	function joined(...parts: Array<string>): string {
		const out = new Array<string>();
		for (const part of parts) if (part !== "") out.push(part);
		return out.join(" · ");
	}

	function hhmm(hour: number): string {
		const h = math.floor(hour) % 24;
		return string.format("%02d:%02d", h, math.floor((hour - math.floor(hour)) * 60));
	}

	// ------------------------------------------------------------ the tools

	function spawn(caller: Player, sim: ServerSimulation, op: W.AdminWorldOp & { op: "spawn" }): WorldOutcome {
		const horde = sim.horde;
		if (horde === undefined) return refuse(op.op, "the server does not run the horde here");
		const info = W.spawnKindInfo(op.spawn) as W.SpawnKindInfo;
		const what = W.describeWorldOp(op);
		const L = W.ADMIN_WORLD_LIMITS;
		// bosses are never recycled by the population; a zombie that far from everybody would be, at once
		if (!info.boss && !nearSurvivor(sim, op.x, op.y, W.ZOMBIE_KEEP_RANGE)) {
			return refuse(op.op, "too far from every survivor: the spawner would recycle it", what);
		}
		// an admin's bosses have their own cap, beside the town's (population.ts counts only the town's own)
		let adminBosses = 0;
		for (const b of horde.bossRoster.list) if (b.unpaid === true) adminBosses += 1;
		const room = info.boss ? L.BOSSES - adminBosses : L.ZOMBIES - horde.zombies.size();
		if (room <= 0) {
			return refuse(
				op.op,
				info.boss ? `at most ${L.BOSSES} admin bosses at once` : `at most ${L.ZOMBIES} zombies at once`,
				what,
			);
		}
		const r = info.boss
			? bossHitRadius({ type: info.type } as BossState)
			: zombieDef(info.type).radius * (op.spawn === "big" ? 1.4 : 1);
		const day = sim.clock.day;
		const n = math.min(op.count, room);
		let placed = 0;
		for (let i = 0; i < n; i++) {
			const [dx, dy] = W.sunflower(i, r);
			const at = W.freePointIn(sim.world, op.x + dx, op.y + dy, r + 2);
			if (at === undefined) continue;
			if (info.boss) {
				const b = createBoss(info.type, at.x, at.y);
				b.unpaid = true;
				horde.bossRoster.list.push(b);
			} else {
				const z = createZombie(info.type as ZombieType, at.x, at.y, day, false);
				if (z.type === 1) W.shapeWalker(z, op.spawn, day);
				z.unpaid = true;
				// anti-ESP (§4.3): born at the alpha its spot already has, like the population's own spawns
				z.alpha = spawnAlpha(horde.refs, at.x, at.y);
				const target = op.chase ? nearestBody(sim, at.x, at.y) : undefined;
				if (target !== undefined) {
					Mind.see(z, target.state.x, target.state.y);
					z.aware = Mind.Aware.Chasing;
					z.detectShow = 1;
				} else {
					// "wandering" means wandering: createZombie's 10 % born hunting do not apply to an admin's spawn
					Mind.forget(z);
				}
				horde.zombies.push(z);
			}
			placed += 1;
		}
		if (placed === 0) return refuse(op.op, "no free space there", what);
		const cut = placed < op.count ? ` (${op.count - placed} did not fit)` : "";
		return done(caller, op, `Spawned ${placed}${cut}`, false, "all", `placed ${placed}`);
	}

	function killAll(caller: Player, sim: ServerSimulation, op: W.AdminWorldOp & { op: "killAll" }): WorldOutcome {
		const horde = sim.horde;
		if (horde === undefined) return refuse(op.op, "the server does not run the horde here");
		const r2 = op.radius * op.radius;
		const hit = (x: number, y: number): boolean =>
			op.radius <= 0 || (x - op.x) * (x - op.x) + (y - op.y) * (y - op.y) <= r2;
		// removed outright: no XP, no loot, no exploder blast; the replication announces them as despawns
		let n = 0;
		const zombies = horde.zombies;
		for (let i = zombies.size() - 1; i >= 0; i--) {
			const z = zombies[i];
			if (!hit(z.x, z.y)) continue;
			horde.refs.onZombieGone?.(z, false);
			sim.progress?.forgetZombie(z.id);
			zombies.remove(i);
			n += 1;
		}
		const bosses = horde.bossRoster.list;
		for (let i = bosses.size() - 1; i >= 0; i--) {
			const b = bosses[i];
			if (!hit(b.x, b.y)) continue;
			sim.progress?.forgetBoss(b.id);
			bosses.remove(i);
			n += 1;
		}
		const [runs, mine] = assistWorld(caller);
		return done(caller, op, `Removed ${n} enemies`, mine, "all", joined(`removed ${n}`, runsText(runs)));
	}

	function clockTool(caller: Player, host: MpHost, op: W.AdminWorldOp): WorldOutcome {
		const sim = host.simulation;
		// below MP_PHASE 2 the server's clock stands still and every client runs its own
		if (sim.horde === undefined) return refuse(op.op, "the server does not run the clock here");
		const clock = sim.clock;
		const t = clock.dayTime;
		let message: string;
		let moved = true;
		const population = sim.horde.population;
		// a forced wave is as big as the natural one: the day table at the groups' ΣS(k) (`ServerPopulation.split`)
		const refill = (i: number, always: boolean): void => {
			const pop = getDayPopulation(clock.day);
			const walkers = [pop.wave1, pop.wave2, pop.wave3];
			const specials = [pop.specialWave1, pop.specialWave2, pop.specialWave3];
			if (always || clock.waveQueues[i] <= 0) clock.waveQueues[i] = population.scaled(walkers[i]);
			if (always || clock.specialWaveQueues[i] <= 0) {
				clock.specialWaveQueues[i] = population.scaled(specials[i]);
			}
		};
		if (op.op === "rain" || op.op === "weather") {
			// any of the five (LUZ-05; the rain is Rain or Clear), today's until midnight rolls the next day's
			const kind = op.op === "rain" ? (op.on ? Weather.Rain : Weather.Clear) : op.weather;
			const cooldown = W.ADMIN_WORLD_LIMITS.WEATHER_COOLDOWN_S;
			// the server's own seconds (a new town may start its ticks again: then there is no wait to serve)
			const since = sim.tick >= skyTick ? (sim.tick - skyTick) / sim.simHz : math.huge;
			if (since < cooldown) {
				return refuse(
					op.op,
					`the sky changes at most every ${cooldown} s: wait ${math.ceil(cooldown - since)} s`,
				);
			}
			skyTick = sim.tick;
			clock.setWeather(kind);
			const text = op.op === "rain" ? (op.on ? "Rain on" : "Rain off") : `Weather: ${weatherName(kind)}`;
			// a clearer sky than the day rolled only makes the night harder: it assists nobody
			if (!weatherAssists(clock.dayRoll, kind)) return done(caller, op, text, false, "all");
			// fog, rain or a storm over a clearer day is a weaker horde nobody earned (§9.3): every run is assisted
			const [runs, mine] = assistWorld(caller);
			return done(
				caller,
				op,
				text,
				mine,
				"all",
				joined(`the day rolled ${weatherName(clock.dayRoll)}`, runsText(runs)),
			);
		}
		// the hands: at most every HANDS_COOLDOWN_S (the slider's cadence passes; a burst of skips does not)
		const handsCool = W.ADMIN_WORLD_LIMITS.HANDS_COOLDOWN_S;
		const handsSince = sim.tick >= handsTick ? (sim.tick - handsTick) / sim.simHz : math.huge;
		if (handsSince < handsCool) return refuse(op.op, `the clock moves at most every ${handsCool} s: try again`);
		if (op.op === "clock") {
			// the hands move and nothing else: the hours skipped are nobody's (§3.6, `setClock` pays and announces none)
			clock.setClock(op.hour);
			message = `Clock set to ${hhmm(op.hour)}`;
		} else if (op.op === "night") {
			if (t >= 19 || t < 6) return refuse(op.op, "it is already night");
			// through the 18:00-18:30 window first, so the night being skipped into has its horde promised
			if (t < 18.5) clock.setClock(18.25);
			// just before 19:00: the next tick crosses it and announces wave 1 like a normal dusk
			clock.setClock(18.99);
			message = "Night falls";
		} else if (op.op === "dawn") {
			if (t >= 7 && t < 18) return refuse(op.op, "it is already day");
			// straight into the next day's morning: the midnight skipped pays nobody (it is never crossed)
			if (t >= 18) clock.setClock(6.99, clock.day + 1);
			else clock.setClock(6.99);
			message = `Dawn of day ${clock.day}`;
		} else {
			// wave
			if (t >= 6 && t < 19) {
				if (t < 18.5) clock.setClock(18.25);
				refill(0, false);
				clock.setClock(18.99);
				message = "Wave 1 incoming";
			} else if (t >= 19 && t < 22) {
				refill(1, false);
				clock.setClock(21.99);
				message = "Wave 2 incoming";
			} else if (t >= 22 || t < 1) {
				if (t >= 22) clock.setClock(0.99, clock.day + 1);
				else clock.setClock(0.99);
				refill(2, false);
				message = "Wave 3 incoming";
			} else {
				// wave 3 is already pouring (01:00-06:00): refill it, the hands stay where they are
				refill(2, true);
				moved = false;
				message = "Wave 3 refilled";
			}
		}
		// a move that happened (a refusal above waits for nothing)
		handsTick = sim.tick;
		if (!moved) return done(caller, op, message, false, "all");
		// the dead wait for the 06:00 the clock now shows, not the one it showed when they fell (Dawn: none at all)
		host.lives.clockMoved();
		const [runs, mine] = assistWorld(caller);
		return done(
			caller,
			op,
			message,
			mine,
			"all",
			joined(`now day ${clock.day} ${hhmm(clock.dayTime)}`, runsText(runs)),
		);
	}

	function heal(caller: Player, host: MpHost, op: W.AdminWorldOp & { op: "heal" }): WorldOutcome {
		const target = Players.GetPlayerByUserId(op.userId);
		const own = target === caller;
		const targetId = own ? 0 : op.userId;
		if (target === undefined) return refuse(op.op, "that player is not in this server", "", targetId);
		const sp = host.playerOf(target);
		if (sp === undefined) {
			return refuse(
				op.op,
				own ? "start a run first: you are not in the world" : "that player is not in the world",
				"",
				targetId,
			);
		}
		if (sp.state.dead) {
			return refuse(op.op, "that survivor is dead: a Rebirth or the daybreak stands them up", "", targetId);
		}
		const p = sp.state;
		p.hp = p.hpMax;
		p.hungry = p.hungryMax;
		p.buffs.poison = 0;
		p.puddleSlow = 0;
		// a heal helps the run of whoever is healed
		const marked = deps.markAssisted(target);
		const message = own ? "Healed and fed" : `${target.Name} healed and fed`;
		return done(
			caller,
			op,
			message,
			own && marked,
			own ? "own run" : "",
			marked ? "run now assisted" : "",
			targetId,
		);
	}

	/**
	 * Out of a solid (noclip ended inside a wall, a car or a tree): to the nearest free ground within UNSTICK_SEARCH,
	 * or, when there is none (deep inside a big building), to a spawn point -- never left stuck (the review of 8f50bc5,
	 * L4). True when the body stands free.
	 */
	function unstick(sim: ServerSimulation, sp: ServerPlayer): boolean {
		const p = sp.state;
		const world = sim.world;
		if (circleBlocked(world, p.x, p.y, PLAYER_RADIUS) === undefined) return true;
		let at: { x: number; y: number } | undefined = W.freePointIn(
			world,
			p.x,
			p.y,
			PLAYER_RADIUS + 2,
			W.ADMIN_WORLD_LIMITS.UNSTICK_SEARCH,
		);
		if (at === undefined) {
			at = findSpawnPoint(world, { allies: [{ x: p.x, y: p.y }], zombies: sim.horde?.zombies ?? [] });
		}
		p.x = at.x;
		p.y = at.y;
		p.reactionSpeed = 0;
		return circleBlocked(world, p.x, p.y, PLAYER_RADIUS) === undefined;
	}

	function toggle(
		caller: Player,
		host: MpHost,
		op: W.AdminWorldOp & { op: "god" | "noclip" | "ammo" },
	): WorldOutcome {
		const key: keyof Mods = op.op;
		const m = setMod(caller.UserId, key, op.on);
		const sp = host.playerOf(caller);
		let freed = "";
		if (sp !== undefined) {
			// on the body now, not at the next tick: the answer and the next snapshot agree (a magazine that was infinite
			// is emptied here whichever switch this was: `putMods`)
			const p = sp.state;
			const x0 = p.x;
			const y0 = p.y;
			putMods(p, m);
			if (key === "noclip" && !op.on && !p.dead) {
				// the answer says where the body really is (a spawn point always has room, so the last case is a guard)
				if (!unstick(host.simulation, sp)) freed = ", but still inside something: teleport out";
				else if (p.x !== x0 || p.y !== y0) freed = ", moved out to free ground";
			}
		}
		const name = key === "god" ? "God mode" : key === "noclip" ? "Noclip" : "Infinite ammo";
		const marked = op.on && deps.markAssisted(caller);
		const later = sp === undefined ? " (from your next run)" : "";
		return done(caller, op, `${name} ${op.on ? "on" : "off"}${later}${freed}`, marked, "own run");
	}

	function teleport(caller: Player, host: MpHost, op: W.AdminWorldOp & { op: "teleport" }): WorldOutcome {
		const s = host.simulation;
		const sp = host.playerOf(caller);
		const what = W.describeWorldOp(op);
		if (sp === undefined) return refuse(op.op, "start a run first: you are not in the world", what);
		if (sp.state.dead) return refuse(op.op, "you are dead", what);
		// the vehicle IS where its rider is: it would land in whatever the rider was moved into
		if (s.vehicles?.riding(sp.slot) === true) return refuse(op.op, "get off the vehicle first", what);
		const [x0, y0, x1, y1] = W.townBounds(s.world, PLAYER_RADIUS);
		let at: { x: number; y: number } | undefined = { x: math.clamp(op.x, x0, x1), y: math.clamp(op.y, y0, y1) };
		// with noclip a body may stand inside a wall (and walk out); without it, the nearest ground it fits on
		if (sp.state.noclip !== true) at = W.freePointIn(s.world, at.x, at.y, PLAYER_RADIUS + 2);
		if (at === undefined) return refuse(op.op, "no free space there", what);
		sp.state.x = at.x;
		sp.state.y = at.y;
		sp.state.reactionSpeed = 0;
		const marked = deps.markAssisted(caller);
		return done(caller, op, "Teleported", marked, "own run", "", 0, at.x, at.y);
	}

	function clearFx(caller: Player, s: ServerSimulation, op: W.AdminWorldOp): WorldOutcome {
		// the acid on the server (it slows whoever steps in it); the blood and the corpses live on each client
		const refs = s.horde?.refs;
		const acid = refs?.puddles?.size() ?? 0;
		refs?.puddles?.clear();
		refs?.explosions?.clear();
		deps.broadcast({ kind: "clearFx" });
		return done(caller, op, "Cleared blood, acid and bodies for everyone", false, "all", `${acid} acid puddles`);
	}

	function spawnItem(caller: Player, s: ServerSimulation, op: W.AdminWorldOp & { op: "spawnItem" }): WorldOutcome {
		const what = W.describeWorldOp(op);
		if (s.items === undefined) return refuse(op.op, "the server does not own the items here", what);
		if (!nearSurvivor(s, op.x, op.y, W.ITEM_KEEP_RANGE)) {
			return refuse(op.op, "too far from every survivor: the item would be swept away", what);
		}
		const at = W.freePointIn(s.world, op.x, op.y, 10);
		if (at === undefined) return refuse(op.op, "no free space there", what);
		// the world's own hook announces it to whoever is near (server/sim/items.ts), with a server id. An admin's gift:
		// its pickup credits no collector achievement, and is logged (`GroundItem.unpaid`, `taken`)
		const item = spawnGroundItem(
			s.world,
			W.ITEM_GROUP_KIND[op.group],
			W.groundItemId(op.group, op.index),
			op.count,
			at.x,
			at.y,
		);
		item.unpaid = true;
		const marked = deps.markAssisted(caller);
		return done(caller, op, "Item dropped", marked, "all", "", 0, at.x, at.y);
	}

	function spawnStructure(
		caller: Player,
		s: ServerSimulation,
		op: W.AdminWorldOp & { op: "spawnStructure" },
	): WorldOutcome {
		const what = W.describeWorldOp(op);
		const build = s.build;
		if (build === undefined) return refuse(op.op, "the server does not own the constructions here", what);
		const info = W.structureInfo(op.structure) as { kind: W.StructureKind; label: string; placeable: number };
		const [x0, y0, x1, y1] = W.townBounds(s.world, 0);
		if (op.x < x0 || op.y < y0 || op.x > x1 || op.y > y1) return refuse(op.op, "outside the town", what);
		const bodies = new Array<ServerPlayer["state"]>();
		let own = SLOT_NONE;
		for (const sp of s.players()) {
			bodies.push(sp.state);
			if (sp.userId === caller.UserId) own = sp.slot;
		}
		// MP-24: the admin's account builds it (its cap, its rot once the admin is gone, adoptable by a repairer)
		const placed = build.placeFree(info.placeable, op.x, op.y, bodies, s.horde?.zombies ?? [], {
			slot: own,
			userId: caller.UserId,
		});
		if (placed.kind !== "placed") {
			const why = placed.kind === "refused" ? placed.why : "unknown";
			let text = "blocked: something is in the way";
			if (why === "capServer") text = `the server already holds ${MAX_BUILDS_PER_SERVER} constructions`;
			else if (why === "capPlayer") text = `your account already holds ${MAX_BUILDS_PER_PLAYER} constructions`;
			else if (why === "sealed") text = "it would pen a survivor in (MP-24)";
			return refuse(op.op, text, what);
		}
		const marked = deps.markAssisted(caller);
		return done(caller, op, `${info.label} placed`, marked, "all");
	}

	/**
	 * The construction nearest to the click (`nearestConstruction`), whoever built it -- a survivor's, or an admin's
	 * (no survivor can take one down, MP-11; an abandoned one rots, MP-24, but a standing one only falls here or to the
	 * horde). `removeSolid` fires the world's hook: the SolidRemove to everybody, the flow field, the grid and both
	 * caps (server/sim/build.ts).
	 */
	function removeStructure(
		caller: Player,
		s: ServerSimulation,
		op: W.AdminWorldOp & { op: "removeStructure" },
	): WorldOutcome {
		const what = W.describeWorldOp(op);
		if (s.build === undefined) return refuse(op.op, "the server does not own the constructions here", what);
		const reach = W.ADMIN_WORLD_LIMITS.REMOVE_REACH;
		const best = W.nearestConstruction(s.world, op.x, op.y, reach);
		if (best === undefined) return refuse(op.op, `no construction within ${reach} u of that point`, what);
		const label = best.kind;
		removeSolid(s.world, best);
		const marked = deps.markAssisted(caller);
		return done(caller, op, `Removed ${label}`, marked, "all", label, 0, best.x + best.w / 2, best.y + best.h / 2);
	}

	function freecam(caller: Player, host: MpHost, op: W.AdminWorldOp & { op: "freecam" }): WorldOutcome {
		const s = host.simulation;
		const sp = host.playerOf(caller);
		const was = cams.has(caller.UserId);
		if (!op.on) {
			if (sp !== undefined) host.replicator.clearView(sp.slot);
			cams.delete(caller.UserId);
			const res: AdminResponse = { ok: true, message: "Free camera off", data: data(caller, false) };
			return was ? done(caller, op, "Free camera off", false, "own run") : { res };
		}
		if (sp === undefined) return refuse(op.op, "start a run first: you are not in the world");
		// inside the world, and never farther than FREECAM_MAX_RANGE from the body (§10): pulled back along the line
		let x = math.clamp(op.x, 0, s.world.width);
		let y = math.clamp(op.y, 0, s.world.height);
		const dx = x - sp.state.x;
		const dy = y - sp.state.y;
		const d = math.sqrt(dx * dx + dy * dy);
		const range = W.ADMIN_WORLD_LIMITS.FREECAM_RANGE;
		if (d > range) {
			x = sp.state.x + (dx / d) * range;
			y = sp.state.y + (dy / d) * range;
		}
		host.replicator.setView(sp.slot, x, y, s.tick + math.floor(FREECAM_TTL_S * s.simHz));
		cams.add(caller.UserId);
		if (was) return { res: { ok: true, data: data(caller, false, x, y) } };
		// scouting the town from above is a help to the admin's own run
		const marked = deps.markAssisted(caller);
		return done(caller, op, "Free camera on", marked, "own run", "", 0, x, y);
	}

	// ------------------------------------------------------------ the entry point

	function handle(caller: Player, raw: Record<string, unknown>): WorldOutcome {
		const name = W.worldOpName(raw);
		const op = W.readWorldOp(raw);
		if (typeIs(op, "string")) return refuse(name, op);
		const host = deps.host();
		if (host === undefined) {
			if (op.op === "state") return { res: { ok: true, data: data(caller, false) } };
			return refuse(op.op, "the server does not run the world (every client simulates its own)");
		}
		hook(host.simulation);
		const s = host.simulation;
		if (op.op === "state") return { res: { ok: true, data: data(caller, false) } };
		if (op.op === "spawn") return spawn(caller, s, op);
		if (op.op === "killAll") return killAll(caller, s, op);
		if (
			op.op === "clock" ||
			op.op === "night" ||
			op.op === "dawn" ||
			op.op === "wave" ||
			op.op === "rain" ||
			op.op === "weather"
		) {
			return clockTool(caller, host, op);
		}
		if (op.op === "heal") return heal(caller, host, op);
		if (op.op === "god" || op.op === "noclip" || op.op === "ammo") return toggle(caller, host, op);
		if (op.op === "teleport") return teleport(caller, host, op);
		if (op.op === "clearFx") return clearFx(caller, s, op);
		if (op.op === "spawnItem") return spawnItem(caller, s, op);
		if (op.op === "spawnStructure") return spawnStructure(caller, s, op);
		if (op.op === "removeStructure") return removeStructure(caller, s, op);
		return freecam(caller, host, op);
	}

	return {
		handle(caller: Player, raw: Record<string, unknown>): WorldOutcome {
			return handle(caller, raw);
		},
		left(userId: number): void {
			mods.delete(userId);
			cams.delete(userId);
			// a body still in the world sheds them now (server/sim/life.ts strips a leaving one too)
			const sim = deps.host()?.simulation;
			if (sim === undefined) return;
			for (const sp of sim.players()) if (sp.userId === userId) stripAdminMods(sp.state);
		},
		stateOf(userId: number): W.AdminWorldState {
			return stateOf(userId);
		},
	};
}
