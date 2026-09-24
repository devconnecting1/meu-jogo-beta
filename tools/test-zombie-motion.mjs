#!/usr/bin/env node
/*
 * Do the zombies MOVE smoothly on screen? (docs/MULTIPLAYER.md §3.1, §5.1; docs/DESIGN_RULES.md LEG-05; the owner's
 * Studio playtest of 2026-09-23: "the zombies walk a bit laggy, with light micro-stutters")
 *
 *   npm run test:zombie-motion
 *   node tools/test-zombie-motion.mjs --verbose                          # one line per zombie as well
 *   PZ_SRC=path/to/other/src node tools/test-zombie-motion.mjs --report  # numbers only (the "before" column)
 *
 * tools/test-smoothness.mjs proves an ALLY is drawn smoothly, with a synthetic server walking a straight line. This
 * runs the whole REAL chain for the horde instead, with nothing but bytes in between:
 *
 *   server  ServerSimulation with the horde on, driven by a Heartbeat with realistic frame times (§3.1: at most
 *           MAX_CATCHUP_TICKS per heartbeat), its Replicator (interest rings, the mid ring's rotation) and encoder;
 *   link    latency, jitter and loss both ways -- the survivor's own commands go up the same way;
 *   client  decodeSnapshotPart → SnapshotBuffer + ClockSync + CommandStream + Prediction, in the order
 *           client/net/netClient.ts runs them; then the Camera easing onto the drawn survivor as client/gameLoop.ts
 *           does (lerp 8/s), and the renderer's rounding to whole pixels.
 *
 * Every drawn frame of every zombie is compared with two references:
 *
 *   ideal  the server's positions at the ticks it actually SENT for that zombie, interpolated at the same render
 *          time: what a perfect client would draw. Anything the drawing does beyond it is the CLIENT's fault
 *          (delivery, clock, delay): stale frames, frozen frames, steps backwards, jolts the ideal does not have.
 *   truth  the server's position every tick. Its jolts and reversals are the SERVER's fault (bodies ping-ponging,
 *          a threshold toggled every tick), and no client can draw them away.
 *
 * "Tranco" is client/net/hitchMeter.ts -- the very meter the [PZ-NET] line prints -- at ZOMBIE_MOVING_UPS.
 *
 * Scenarios: (a) one walker chasing a survivor who walks, then stops; (b) ten walkers crowding a standing survivor
 * (the owner's screenshot); (c) a walker crossing the 800 u near/mid boundary on a 1920x1080 screen; (d) a charger
 * keeping its distance and rushing, plus a walker knocked back twice. Each on four links:
 *
 *   clean   60 Hz heartbeat and 60 fps apart, 80 ms RTT;
 *   wan     the same with 140 ms RTT, 15 ms jitter and 2 % loss;
 *   studio  server and client in ONE process sharing irregular frames, as the owner's [PZ-NET] log showed them;
 *   server  the same irregular frames on the server's Heartbeat ALONE, the client at a steady 60 fps (a live server
 *           that hitches: nothing on the client stands still with it).
 *
 * And three that break the timeline on purpose, each judged on its own (the review of 2026-09-23, #4 and #5):
 * (e) a 10 s breakpoint on the server, apart and in one process; (f) a 0.6 s pause while the client goes on drawing;
 * (g) the client's GetServerTimeNow() stepping 0.6 s with the server perfectly fine. Every one of them failed on
 * 097f484: the fixed epoch left a 9.8 s delay after (e) for good and drew 81-95 frames past the server, (f) ended
 * on 463 ms, and in (g) the render time jumped with the clock (37x in one frame) and 26 frames ran past the data.
 * The clock now re-anchors on the TimePongs (client/net/clockSync.ts), the render time no longer moves with the
 * clock's corrections at all (snapshotBuffer.ts `clockCorrected`), and a resync re-locks the delay and re-bases the
 * render time instead of holding it.
 *
 * What was found, and what this suite now holds the code to (commit 7fb3e89 → this one, same seed; 31 failed
 * checks → 0):
 *   1. the server DROPPED ticks on every hitch longer than two ticks, and the clients' clock (`tick0Time +
 *      tick / 60`) never knew: the render time ran past everything the server had simulated. Studio profile:
 *      69 % of the zombie frames extrapolated or held, 2.4-6.8 frozen frames a second per zombie, 392 frames
 *      drawn past the server, 30 ticks lost in 14 s → 0.8 % / 0-0.01 / 0 / 0 (server/sim/simulation.ts carries
 *      the heartbeat's debt; client/net/snapshotBuffer.ts measures the lateness);
 *   2. the delay never counted the downstream latency: WAN 9.6-10.9 % of frames extrapolated → 0.1 %;
 *   3. the charger's "keep ~110 u" toggled every tick: 13 reversals a second on the server, a 10 Hz wobble on
 *      the wire → 0.25 (shared/sim/ai/zombieBrain.ts `thinkCharger`, KEEP_BAND);
 *   4. walkers pressed into the survivor they already touched, and the ring slid and kicked: 1.03-1.18 server-made
 *      jolts per zombie-second → 0.10-0.13 (shared/sim/ai/zombieBrain.ts `alongContacts`).
 * Ruled out by the same numbers: the ±5 % slew of the delay (the render clock stays inside 0.95x-1.05x, far from
 * the meter's 0.4x/1.8x), and the eased camera plus pixel rounding (a perfectly drawn body never steps back a
 * pixel through it, in any run).
 *
 * THE MAX DRAWN SPEED (h)-(k), the owner's report of 2026-09-24: "when I explore, the enemies left behind get teleported
 * to other places: I see enemies on screen going very fast from one region to another". Every drawn frame of every
 * zombie against the fastest that body ever moved on the server: at most 1.25x that times dt + 4 u (plus, on the frame
 * that ends an extrapolation, what the extrapolation could be off: 2 x that speed x 100 ms), unless the frame lands faded
 * (alpha <= 0.1, a snap that starts a fade-in) or both ends are off the screen.
 *   (h) 90 s exploring by day with the REAL population (spawns, recycling, relocations), 1920 x 1080, clean and WAN;
 *   (i) the same at night with the waves; (j) a re-entry in the near and the mid ring (the wire skips six samples);
 *   (k) the server moving a body 670 u under the same netId (the client's own guard);
 *   (l) the review of 577c729, M1: loss bursts of 350 and 400 ms on the Snap stream, strict (no allowance for the end of
 *       an extrapolation): no body blinks (alpha >= 0.8), none restarts, none jumps. Before: every track restarted at
 *       alpha 0 (the horde blinked to 0.05); dropping only the history jumped 43 u in one frame, keeping it snapped 29.5 u.
 *   (m) the review of 6e6dfa0: a 1.6 s silence of the whole stream with the same walkers -- more than one walk can
 *       catch up with. No bridge may owe more than BRIDGE_MAX_U (64 u): a body that would is started again where it
 *       is, faded in, instead of sliding ~100 u for most of a second; strict, no frame over the body's own speed.
 *   (h) also checks L4: a moved body's rewind history (combat.history) goes with its old identity.
 * Root cause: the population put a wave walker or a special left behind back on the survivor's ring under the SAME
 * netId (shared/sim/ai/population.ts `cleanup`), and every screen that still had it interpolated it across the town.
 * Before (PZ_SRC at c72aa6c): (h) clean 126 frames, the worst 726 u in one frame (43 591 u/s, 194x its own speed), 40
 * same-netId jumps, 17 of the 40 moved bodies landing on screen; WAN 71 frames, 753 u in one frame; (i) 80 jumps, 29
 * landing on screen (the dark hid most of the runs); (j) 41 u in one frame at alpha 0.38; (k) 228 u in one frame.
 * Now: 0 fast frames everywhere, 0 jumps (a relocation is a new netId), 0 of 43 moved bodies on screen by day and 0 of
 * 94 at night. New bodies still fade in wherever the ring puts them, as before (the waves' pacing depends on it). Ruled out by the same runs: the netId reuse after the tomb change (a
 * freed id comes back 2 s later, after the client retired the track; the lives are split per body here) and the
 * swap-remove draw order (the view writes each sprite's absolute position every frame, nothing eases per slot).
 *
 * Pure Node (>= 18) + the project's TypeScript, through tools/luau-shim.mjs.
 */
import { join } from "node:path";
import { installShims, mulberry32 } from "./luau-shim.mjs";

const { SRC, require, setSeed } = installShims({ seed: 1 });

const W = require(join(SRC, "shared/game/world.ts"));
const { defaultSave } = require(join(SRC, "shared/game/save.ts"));
const { createPlayer } = require(join(SRC, "shared/game/player.ts"));
const { createZombie, resetEntityIds } = require(join(SRC, "shared/game/entities.ts"));
const CFG = require(join(SRC, "shared/net/mpConfig.ts"));
const P = require(join(SRC, "shared/net/protocol.ts"));
const codec = require(join(SRC, "shared/net/codec.ts"));
const PL = require(join(SRC, "server/sim/players.ts"));
const Brain = require(join(SRC, "shared/sim/ai/zombieBrain.ts"));
const { ServerSimulation } = require(join(SRC, "server/sim/simulation.ts"));
const { Replicator, mapHashOf } = require(join(SRC, "server/net/replication.ts"));
const { ClockSync } = require(join(SRC, "client/net/clockSync.ts"));
const { CommandStream } = require(join(SRC, "client/net/commands.ts"));
const { Prediction } = require(join(SRC, "client/net/prediction.ts"));
const SB = require(join(SRC, "client/net/snapshotBuffer.ts"));
const { SnapshotBuffer } = SB;
/** a client frame this long is a hitch (an older src has no such notion: judge every frame then) */
const HITCH_FRAME_S = SB.HITCH_FRAME_S ?? Infinity;
const HM = require(join(SRC, "client/net/hitchMeter.ts"));
const { Camera } = require(join(SRC, "shared/engine/camera.ts"));

// ---------------------------------------------------------------- CLI and reporting

const args = process.argv.slice(2);
const VERBOSE = args.includes("--verbose");
/** numbers only, no verdict: for running this file against an older src (PZ_SRC) */
const REPORT_ONLY = args.includes("--report");
const numArg = (name, fallback) => {
	const i = args.indexOf(name);
	return i >= 0 && args[i + 1] !== undefined ? Number(args[i + 1]) : fallback;
};
const SEED = numArg("--seed", 7);
/** `--only hl`: run just these scenarios (a quicker loop while working on one; the full run is the verdict) */
const ONLY = args.includes("--only") ? (args[args.indexOf("--only") + 1] ?? "") : undefined;

let failures = 0;
function check(name, ok, detail) {
	const tail = detail === undefined ? "" : "  (" + detail + ")";
	if (REPORT_ONLY) console.log("  --    " + name + tail);
	else if (ok) console.log("  ok    " + name + tail);
	else {
		console.error("  FALHA " + name + tail);
		failures += 1;
	}
}

const SIM_HZ = CFG.SIM_HZ;
/** GetServerTimeNow() of tick 0 */
const T0 = 1000;
const ROUND = v => Math.floor(v + 0.5);
const TAU = Math.PI * 2;
const angleDiff = (a, b) => {
	let d = (b - a) % TAU;
	if (d > Math.PI) d -= TAU;
	else if (d < -Math.PI) d += TAU;
	return d;
};
/** one tick of this is faster than any zombie moves (mpConfig ZOMBIE_TELEPORT_UPS: 1500 u/s): a body moved, not walked */
const TELEPORT_TICK_U = (CFG.ZOMBIE_TELEPORT_UPS ?? 1500) / SIM_HZ;
/** zombies walk slower than a survivor (90 u/s against 210): their meter judges from this speed up */
const ZOMBIE_MOVING_UPS = HM.ZOMBIE_MOVING_UPS ?? 40;
/**
 * A frame this long is the machine hitching: in one process the server stood still for it too, and for a few
 * frames after it the server is paying back its debt (§3.1) while the client has nothing newer to draw. The jolt
 * comparison is not judged in that shadow -- for the drawing and the ideal alike -- and is reported apart.
 */
const HITCH_S = 0.1;
const HITCH_SHADOW_S = 0.15;
/** client/net/netClient.ts: a clock probe every this many seconds */
const TIME_SYNC_PERIOD = 1 / Math.max(1, CFG.TIME_SYNC_RATE / 2);

// ---------------------------------------------------------------- the link (as in tools/test-predict.mjs)

class Link {
	constructor(opts) {
		this.oneWay = opts.oneWay;
		this.jitter = opts.jitter ?? 0;
		this.loss = opts.loss ?? 0;
		this.random = opts.random;
		/** (l) windows [from, to) of absolute time in which everything sent is lost: a loss burst */
		this.bursts = opts.bursts ?? [];
		this.queue = [];
	}
	send(now, payload) {
		for (const [from, to] of this.bursts) if (now >= from && now < to) return;
		if (this.loss > 0 && this.random() < this.loss) return;
		this.queue.push({ at: now + this.oneWay + (this.random() - 0.5) * 2 * this.jitter, payload });
	}
	/** one client frame's Input packets leave in one instant and share one delay */
	sendBurst(now, payloads) {
		const at = now + this.oneWay + (this.random() - 0.5) * 2 * this.jitter;
		for (const payload of payloads) {
			if (this.loss > 0 && this.random() < this.loss) continue;
			this.queue.push({ at, payload });
		}
	}
	poll(now) {
		const out = [];
		let i = 0;
		while (i < this.queue.length) {
			if (this.queue[i].at <= now) out.push(this.queue.splice(i, 1)[0]);
			else i++;
		}
		out.sort((a, b) => a.at - b.at);
		return out.map(e => e.payload);
	}
}

/** the reliable World channel: same latency, never lost, in order */
class Reliable {
	constructor(oneWay) {
		this.oneWay = oneWay;
		this.queue = [];
	}
	send(now, payload) {
		this.queue.push({ at: now + this.oneWay, payload });
	}
	poll(now) {
		const out = [];
		while (this.queue.length > 0 && this.queue[0].at <= now) out.push(this.queue.shift().payload);
		return out;
	}
}

// ---------------------------------------------------------------- frame-time profiles

/**
 * The owner's Studio playtest ([PZ-NET], 2026-09-23): server and client in ONE process, so one frame time drives
 * both the server's Heartbeat and the client's render. The log: fps 38-57 per 5 s window, snapshot arrival
 * interval 48-115 ms with jitter spikes of 13-93 ms, and the server warning of input overflow. That is: mostly
 * 60 fps, stretches in the 25-45 fps range, and single hitches of 50-160 ms.
 */
function studioFrames(seconds, random) {
	const out = [];
	let t = 0;
	let slowLeft = 0;
	while (t < seconds) {
		let dt;
		if (random() < 0.012) {
			dt = 0.05 + random() * 0.11; // a hitch: the collector, Studio's own UI, a script
		} else {
			if (slowLeft <= 0 && random() < 0.006) slowLeft = 0.5 + random() * 1.5;
			if (slowLeft > 0) {
				dt = 0.022 + random() * 0.018;
				slowLeft -= dt;
			} else {
				dt = (1 / 60) * (0.95 + random() * 0.1);
			}
		}
		out.push(dt);
		t += dt;
	}
	return out;
}

const PROFILES = {
	clean: { oneWay: 0.04, jitter: 0.004, loss: 0.005, shared: false, clockNoise: 0.002 },
	wan: { oneWay: 0.07, jitter: 0.015, loss: 0.02, shared: false, clockNoise: 0.002 },
	studio: { oneWay: 0.004, jitter: 0.003, loss: 0, shared: true, clockNoise: 0 },
	/*
	 * A real server that hitches while the client does not: the Studio frame times drive the server's Heartbeat
	 * alone, the client draws at a steady 60 fps over the clean link. The server drops the time it cannot catch up
	 * (§3.1) and nothing on the client stood still with it, so this is where a lost tick would show.
	 */
	server: { oneWay: 0.04, jitter: 0.004, loss: 0.005, shared: false, clockNoise: 0.002, serverOnly: true },
};

// ---------------------------------------------------------------- one run of the whole chain

/**
 * One scenario on one link. `setup(ctx)` returns the zombies to put in the world, `input(t)` is the local
 * survivor's stick at client time t (seconds), and `event(t, ctx)` may poke the server world (a knockback).
 */
function run(scn, profileName) {
	const prof = PROFILES[profileName];
	setSeed(SEED);
	resetEntityIds();
	const random = mulberry32(SEED ^ 0x9e3779b9);
	const randomUp = mulberry32(SEED ^ 0x51ed270b);
	const randomFrames = mulberry32(SEED ^ 0x2545f491);

	const world = W.createWorld(scn.worldSize ?? 6000, scn.worldSize ?? 6000);
	const sim = new ServerSimulation({ world, zombies: true, interactive: false });
	const horde = sim.horde;
	horde.clock.setClock(scn.hour ?? 12, scn.day ?? 5);
	horde.clock.isRaining = false;
	if (scn.night === true) horde.clock.fillNight();
	// the ambient population would wander into the measurement: the scenario places every body itself -- unless the
	// population IS the scenario (h): the real spawner, recycling and relocations around a survivor who explores
	if (scn.population !== true) horde.population.update = () => {};
	/** (h) the population's relocations (shared/sim/ai/population.ts `cleanup`), through its own hook when there is one */
	let relocations = 0;
	/** (h) review of 577c729, L4: a moved body whose rewind history (by entity id) survived the move */
	let historyKept = 0;
	const moved = horde.refs.onZombieMoved;
	horde.refs.onZombieMoved = z => {
		relocations += 1;
		// the body had a past where it stood (combat records every living zombie every tick)...
		const had = sim.combat?.history?.has?.(z.id) === true;
		moved?.(z);
		// ...which a shot at the old drawing must not be rewound into
		if (had && sim.combat.history.has(z.id)) historyKept += 1;
	};
	/** (j) the part filter's own memory, fresh for every run */
	const filterState = {};
	/** (h) server-side: a netId whose body moved more than TELEPORT_TICK_U in one tick, and spawns seen on screen */
	const teleports = [];
	let spawns = 0;
	let spawnsInView = 0;
	/** (h) relocations, by where the moved body landed: a new identity of a body seen before, or (before the fix) a jump */
	const seenBodies = new WeakSet();
	let relocLanded = 0;
	let relocInView = 0;
	const inView = z => Math.abs(z.x - sp.state.x) <= viewW / 2 && Math.abs(z.y - sp.state.y) <= viewH / 2;

	const snaps = [];
	const worldPackets = [];
	const transport = {
		snap(slot, part) {
			if (slot === 0) snaps.push(part);
		},
		fx() {},
		world(slot, packet) {
			if (slot === 0) worldPackets.push(packet);
		},
		worldAll(packet) {
			worldPackets.push(packet);
		},
	};
	const replicator = new Replicator(sim, transport, { tick0Time: T0, mapHash: mapHashOf(world) });

	const sx = scn.start?.x ?? 3000;
	const sy = scn.start?.y ?? 3000;
	const sp = PL.createServerPlayer({ slot: 0, userId: 1, name: "me" }, defaultSave(), sx, sy, sim.tick, SIM_HZ);
	sp.state.hpMax = 1e6;
	sp.state.hp = 1e6;
	sim.add(sp);
	replicator.welcome(sp);
	for (const z of scn.setup({ sx, sy })) {
		z.alpha = 1;
		horde.zombies.push(z);
	}
	const watched = [...horde.zombies];

	// ---- the server's truth every tick, and the ticks it SENT for each zombie
	const truth = new Map(); // netId -> Map(tick -> {x, y, a})
	const lives = new Map(); // netId -> [{ body, from, vmax }]: (h)-(k) the bodies that went by that netId, in order
	const sent = new Map(); // netId -> ascending ticks carried by a snapshot
	const tickWall = []; // tick -> wall-clock time it was simulated
	let serverWall = T0;
	const viewW = scn.viewW ?? 1360;
	const viewH = scn.viewH ?? 600;
	sim.onTick = tick => {
		tickWall[tick] = serverWall;
		// (h) every body the population made, not only the scenario's own
		for (const z of scn.population === true ? horde.zombies : watched) {
			const id = horde.netIdOf(z);
			if (!(id > 0)) continue;
			let m = truth.get(id);
			if (m === undefined) {
				m = new Map();
				truth.set(id, m);
			}
			m.set(tick, { x: z.x, y: z.y, a: z.angleSlow });
			// one LIFE per (netId, body): the server hands a freed netId out again 2 s later, to another body
			let list = lives.get(id);
			if (list === undefined) {
				list = [];
				lives.set(id, list);
			}
			let life = list[list.length - 1];
			if (life === undefined || life.body !== z) {
				life = { body: z, from: tick, last: undefined, lastTick: -1, vmax: 0 };
				list.push(life);
				// a body the survivor's screen shows the tick it appears: a new one, or a moved one under its new identity
				if (seenBodies.has(z)) {
					relocLanded += 1;
					if (inView(z)) relocInView += 1;
				} else {
					seenBodies.add(z);
					spawns += 1;
					if (inView(z)) spawnsInView += 1;
				}
			}
			if (life.last !== undefined && life.lastTick === tick - 1) {
				const d = Math.hypot(z.x - life.last.x, z.y - life.last.y);
				// faster than any zombie walks: the body was MOVED under the same netId (what every client draws racing)
				if (d > TELEPORT_TICK_U) {
					teleports.push({ tick, netId: id, d });
					relocLanded += 1;
					if (inView(z)) relocInView += 1;
				} else life.vmax = Math.max(life.vmax, d * SIM_HZ);
			}
			life.last = { x: z.x, y: z.y };
			life.lastTick = tick;
		}
		const before = snaps.length;
		replicator.afterTick(tick);
		// only the parts THIS tick produced: a heartbeat that runs two ticks sends both ticks' parts together
		for (let i = before; i < snaps.length; i++) {
			const decoded = P.decodeSnapshotPart(snaps[i]);
			if (decoded === undefined) continue;
			const partTick = codec.unwrapTick(decoded.tick, tick);
			for (const zs of decoded.zombies) {
				let list = sent.get(zs.netId);
				if (list === undefined) {
					list = [];
					sent.set(zs.netId, list);
				}
				if (list[list.length - 1] !== partTick) list.push(partTick);
			}
		}
	};

	// ---- the client, in client/net/netClient.ts's frame order
	const lsave = defaultSave();
	const local = createPlayer(lsave, sx, sy);
	const cl = {
		clock: new ClockSync(),
		commands: new CommandStream(),
		prediction: new Prediction(),
		snapshots: new SnapshotBuffer(),
		queue: [],
		lastSelfTick: -Infinity,
		raw: { moveX: 0, moveY: 0, magnitude: 0, aim: 0, held: 0 },
		sampled: [],
		outbound: [],
	};
	cl.clock.setEpoch(T0, SIM_HZ);
	cl.snapshots.setRate(SIM_HZ);
	cl.prediction.attach(world, local, lsave);
	const cam = new Camera();
	cam.setView(viewW, viewH);
	cam.x = sx;
	cam.y = sy;
	/** the same view locked on the survivor, against which the eased camera is judged (hypothesis 4) */
	const locked = new Camera();
	locked.setView(cam.viewW, cam.viewH);

	const down = new Link({
		oneWay: prof.oneWay,
		jitter: prof.jitter,
		loss: prof.loss,
		random,
		bursts: (scn.lossBursts ?? []).map(([at, len]) => [T0 + at, T0 + at + len]),
	});
	const up = new Link({ oneWay: prof.oneWay, jitter: prof.jitter, loss: prof.loss, random: randomUp });
	const rel = new Reliable(prof.oneWay);
	// the TimeSync RemoteEvent both ways (reliable): a probe a second, answered with the server's clock and tick
	const pingUp = new Reliable(prof.oneWay);
	const pongDown = new Reliable(prof.oneWay);
	let pingAt = -Infinity;
	let pingSeq = 0;

	// ---- the timeline: server heartbeats and client frames in wall-clock order
	// a breakpoint (`scn.pause`): the server's Heartbeat stops for `seconds` at `at`, and its next delta says so. In
	// one process the client stops with it; apart, it goes on drawing through it
	const pause = scn.pause;
	const pauseS = pause?.seconds ?? 0;
	const steady = new Array(Math.ceil((scn.seconds + 1 + pauseS) * 60)).fill(1 / 60);
	const irregular = prof.shared || prof.serverOnly ? studioFrames(scn.seconds + 1, randomFrames) : steady;
	const dts = prof.shared ? irregular : steady;
	const events = [];
	/** wall time of the first heartbeat after the breakpoint */
	let resumeAt = Infinity;
	{
		const lay = (frames, start, kind, stops) => {
			let t = start;
			let stopped = false;
			for (const dt0 of frames) {
				let dt = dt0;
				if (stops && pause !== undefined && !stopped && t + dt > T0 + pause.at) {
					stopped = true;
					dt += pauseS;
					if (kind === "server") resumeAt = t + dt;
				}
				t += dt;
				events.push({ at: t, kind, dt });
			}
		};
		lay(irregular, T0, "server", true);
		// in one process the client's frame follows the server's step of the same frame; apart, the client is a
		// third of a frame out of phase so the two clocks are not in lock-step
		lay(dts, T0 + (prof.shared ? 1e-6 : 0.37 / 60), "client", prof.shared);
		events.sort((a, b) => a.at - b.at || (a.kind === "server" ? -1 : 1));
	}

	const rec = new Map(); // netId -> per-frame records
	/** client time of the last frame long enough to be the machine hitching (the whole screen stood still) */
	let hitchAt = -Infinity;
	const lag = [];
	/** the client time of each `lag` entry */
	const lagT = [];
	const delays = [];
	const rates = [];
	let lastRender;
	const endWall = T0 + scn.seconds + pauseS;

	for (const ev of events) {
		if (ev.at > endWall) break;
		if (ev.kind === "server") {
			serverWall = ev.at;
			// server/net/mpHost.ts: the queue keeps the commands for the ticks the server owes (an older src ignores it)
			const grace = sim.inputGrace?.(ev.dt) ?? 0;
			for (const payload of up.poll(ev.at)) PL.ingestInput(sp, payload, ev.at, grace);
			// server/net/mpHost.ts: the clock and the tick in the same instant -- before this frame's ticks, the late
			// side of where a RemoteEvent handler can run
			for (const payload of pingUp.poll(ev.at)) {
				const ping = P.decodeTimePing(payload);
				if (ping === undefined) continue;
				const pong = P.encodeTimePong({
					seq: ping.seq,
					clientTime: ping.clientTime,
					serverTime: ev.at,
					serverTick: sim.tick,
				});
				if (pong !== undefined) pongDown.send(ev.at, pong);
			}
			if (scn.event !== undefined) scn.event(ev.at - T0, { watched, sx, sy, horde });
			sim.advance(ev.dt);
			for (const part of snaps) down.send(ev.at, part);
			snaps.length = 0;
			for (const packet of worldPackets) rel.send(ev.at, packet);
			worldPackets.length = 0;
			continue;
		}
		// ---------------- one client frame
		const dt = ev.dt;
		const now = ev.at;
		const clientT = now - T0;
		if (dt > HITCH_S) hitchAt = clientT;
		for (const packet of rel.poll(now)) {
			const batch = P.decodeWorld(packet);
			if (batch === undefined) continue;
			// as client/net/netClient.ts: the batch's tick buries the netId against older parts still in flight (M1),
			// and the body goes when the drawing reaches that tick (M3); an older src (PZ_SRC) took it away at once
			for (const e of batch.events) {
				if (e.t !== P.WorldEv.ZombieDied) continue;
				if (cl.snapshots.zombieDied !== undefined) cl.snapshots.zombieDied(e.netId, batch.tick, now);
				else cl.snapshots.forgetZombie(e.netId, batch.tick);
			}
		}
		for (const payload of down.poll(now)) {
			const part = P.decodeSnapshotPart(payload);
			if (part === undefined) continue;
			// (i) what the wire stops carrying for a while (a body out of the interest, of the light, behind a roof)
			if (scn.filterPart !== undefined) {
				part.zombies = part.zombies.filter(zs =>
					scn.filterPart(zs, clientT, { watched, horde, state: filterState }),
				);
			}
			cl.queue.push(part);
		}
		// `scn.clockStep`: GetServerTimeNow() itself steps (the engine re-syncing it) -- the client's clock re-locks
		const step = scn.clockStep !== undefined && clientT >= scn.clockStep.at ? scn.clockStep.seconds : 0;
		const serverNow = now + step + (prof.clockNoise > 0 ? (random() - 0.5) * 2 * prof.clockNoise : 0);
		// netClient.onTimeSync, which runs off its RemoteEvent before the frame
		for (const payload of pongDown.poll(now)) {
			const pong = P.decodeTimePong(payload);
			if (pong === undefined) continue;
			cl.clock.noteRtt(P.pongRtt(pong, serverNow));
			// (an older src, run with PZ_SRC for the "before" column, has neither of these)
			cl.clock.noteServerTick?.(pong.serverTime, pong.serverTick);
		}
		const tick = cl.clock.update(dt, serverNow);
		cl.snapshots.clockCorrected?.(cl.clock.lastCorrection?.() ?? 0);
		const refTick = cl.clock.tickNow();
		for (const part of cl.queue) {
			const partTick = codec.unwrapTick(part.tick, Math.floor(refTick));
			cl.snapshots.receive(part, refTick, now);
			const block = part.self;
			if (block === undefined || partTick <= cl.lastSelfTick) continue;
			cl.lastSelfTick = partTick;
			cl.commands.ack(block.ackSeq);
			cl.commands.noteBufDepth(block.bufDepth);
			cl.prediction.reconcile(block, cl.commands.unacked(), now);
		}
		cl.queue.length = 0;
		const stick = scn.input(clientT);
		cl.raw.moveX = stick.x;
		cl.raw.moveY = stick.y;
		cl.raw.magnitude = stick.x !== 0 || stick.y !== 0 ? 1 : 0;
		cl.sampled.length = 0;
		cl.commands.sample(dt, cl.raw, cl.sampled);
		for (const cmd of cl.sampled) cl.prediction.step(cmd);
		cl.snapshots.advance(dt, tick, now, world);
		const render = cl.snapshots.renderNow();
		const viewTick = Math.floor(render);
		const viewFrac = Math.min(255, Math.max(0, Math.floor((render - viewTick) * 256)));
		cl.outbound.length = 0;
		cl.commands.flush(viewTick, viewFrac, now, cl.outbound);
		const burst = [];
		for (const packet of cl.outbound) {
			const payload = P.encodeInput(packet);
			if (payload !== undefined) burst.push(payload);
		}
		if (burst.length > 0) up.sendBurst(now, burst);
		// netClient.sendTimePing
		if (now - pingAt >= TIME_SYNC_PERIOD) {
			pingAt = now;
			pingSeq = (pingSeq + 1) % 65536;
			const ping = P.encodeTimePing({ seq: pingSeq, clientTime: serverNow });
			if (ping !== undefined) pingUp.send(now, ping);
		}
		cl.prediction.present(dt, cl.commands.phase(), cl.commands.newest());
		// client/gameLoop.ts: the camera eases onto the DRAWN survivor
		cam.follow(local.x, local.y, Math.min(1, dt * 8));
		cam.update(dt);
		locked.x = local.x;
		locked.y = local.y;

		if (clientT < scn.warmup) {
			lastRender = render;
			continue;
		}
		// hypothesis 1: how fast the render clock runs against real time (1 = exactly real time). Not on a hitch frame:
		// the screen stood still through it, and not running the render time through what the server never simulated
		// is the point there (snapshotBuffer.ts HITCH_FRAME_S)
		if (lastRender !== undefined && dt > 0 && dt < HITCH_FRAME_S) rates.push((render - lastRender) / (dt * SIM_HZ));
		lastRender = render;
		// how old the drawing is in wall-clock time: the "laggy" half of the complaint
		const rt = Math.floor(render);
		const w0 = tickWall[rt];
		const w1 = tickWall[rt + 1];
		if (w0 !== undefined && w1 !== undefined) lag.push(now - (w0 + (w1 - w0) * (render - rt)));
		else lag.push(NaN); // the render time is past anything the server has simulated
		lagT.push(clientT);
		delays.push(cl.snapshots.delay());

		for (const z of cl.snapshots.zombieStates()) {
			const hist = truth.get(z.netId);
			if (hist === undefined) continue;
			let list = rec.get(z.netId);
			if (list === undefined) {
				list = [];
				rec.set(z.netId, list);
			}
			// the tick this body was drawn at (the mid ring is drawn further back); an older buffer has one for all
			const at = z.tick ?? render;
			const tr = truthAt(hist, at);
			const ideal = idealAt(hist, sent.get(z.netId) ?? [], at);
			cam.project(z.x, z.y);
			const px = ROUND(cam.screenX);
			const py = ROUND(cam.screenY);
			cam.project(ideal.x, ideal.y);
			const ipx = cam.screenX;
			const ipy = cam.screenY;
			locked.project(ideal.x, ideal.y);
			list.push({
				t: clientT,
				dt,
				// the render tick it was drawn at: which of the netId's lives this frame shows (h-k)
				tick: at,
				x: z.x,
				y: z.y,
				a: z.angle,
				stale: z.stale,
				alpha: z.alpha,
				tx: tr.x,
				ty: tr.y,
				ta: tr.a,
				ix: ideal.x,
				iy: ideal.y,
				// where the server has it RIGHT NOW (its newest tick): moving, while the drawing stands, is a freeze
				live: hist.get(sim.tick),
				shadow: clientT - hitchAt <= HITCH_SHADOW_S,
				px,
				py,
				ipx,
				ipy,
				lpx: locked.screenX,
				lpy: locked.screenY,
			});
		}
	}

	return {
		rec,
		truth,
		lag,
		lagT,
		delays,
		rates,
		dropped: sim.stats.droppedTicks,
		fps: dts.length / dts.reduce((a, b) => a + b, 0),
		// what the clock re-anchored onto (the time the server dropped) and what hitch frames did not run through
		epochShift: cl.clock.stats().epochShift ?? 0,
		absorbed: cl.snapshots.stats().absorbedS ?? 0,
		relocks: cl.snapshots.stats().relocks ?? 0,
		// a breakpoint scenario: when the server came back (client time), and the delay the run ended on
		resumeT: scn.clockStep !== undefined ? scn.clockStep.at : resumeAt - T0,
		delayEnd: cl.snapshots.delay(),
		// (h), (i), (j): what the population did, and what the buffer did about breaks in a track
		teleports,
		lives,
		relocations,
		historyKept,
		spawns,
		spawnsInView,
		relocLanded,
		relocInView,
		restarts: cl.snapshots.stats().restarts ?? 0,
		bridged: cl.snapshots.stats().bridged ?? 0,
		bridgeCapped: cl.snapshots.stats().bridgeCapped ?? 0,
		bridgeMax: cl.snapshots.stats().bridgeMax ?? 0,
		viewW,
		viewH,
		zombiesEnd: horde.zombies.length,
	};
}

/** the server's own position at a fractional tick, from its every-tick record */
function truthAt(hist, r) {
	const k = Math.floor(r);
	const a = hist.get(k);
	const b = hist.get(k + 1);
	if (a !== undefined && b !== undefined) {
		const f = r - k;
		return { x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f, a: a.a + angleDiff(a.a, b.a) * f };
	}
	if (a !== undefined) return a;
	let best;
	let bestD = Infinity;
	for (const [t, s] of hist) {
		const d = Math.abs(t - r);
		if (d < bestD) {
			bestD = d;
			best = s;
		}
	}
	return best;
}

/** a position as the wire carries it (§4.2: u16 at 0.5 u) */
const wire = v => codec.dequantPos(codec.quantPos(v));

/**
 * What a perfect client draws at render tick r: the samples the server SENT around r, as the wire carries them
 * (0.5 u steps), interpolated. The real client can do no better than this, and should do no worse.
 */
function idealAt(hist, ticks, r) {
	if (ticks.length === 0) return truthAt(hist, r);
	let lo = 0;
	let hi = ticks.length - 1;
	const at = t => {
		const s = hist.get(t);
		return { x: wire(s.x), y: wire(s.y) };
	};
	if (r <= ticks[0]) return at(ticks[0]);
	if (r >= ticks[hi]) return at(ticks[hi]);
	while (hi - lo > 1) {
		const mid = (lo + hi) >> 1;
		if (ticks[mid] <= r) lo = mid;
		else hi = mid;
	}
	const a = at(ticks[lo]);
	const b = at(ticks[hi]);
	const f = (r - ticks[lo]) / (ticks[hi] - ticks[lo]);
	return { x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f };
}

// ---------------------------------------------------------------- the measures

/** heading reversals: the turn changes direction after at least FLIP_DEG each way (a sprite rocking) */
const FLIP_DEG = 3;
function headingFlips(angles) {
	let flips = 0;
	let dir = 0;
	let acc = 0;
	let pendingDir = 0;
	let pendingAcc = 0;
	for (let i = 1; i < angles.length; i++) {
		const d = (angleDiff(angles[i - 1], angles[i]) * 180) / Math.PI;
		if (Math.abs(d) < 1e-6) continue;
		const s = Math.sign(d);
		if (dir === 0 || s === dir) {
			pendingDir = 0;
			pendingAcc = 0;
			dir = s;
			acc += Math.abs(d);
			continue;
		}
		if (pendingDir !== s) {
			pendingDir = s;
			pendingAcc = 0;
		}
		pendingAcc += Math.abs(d);
		if (pendingAcc >= FLIP_DEG) {
			if (acc >= FLIP_DEG) flips += 1;
			dir = s;
			acc = pendingAcc;
			pendingDir = 0;
			pendingAcc = 0;
		}
	}
	return flips;
}

/**
 * On-screen trembling: a pixel step on one axis that undoes, within JIGGLE_FRAMES, a reversal on that axis. A turn
 * or a stop is one reversal and is not counted.
 */
const JIGGLE_FRAMES = 6;
function pixelTremors(xs, ys) {
	let n = 0;
	for (const v of [xs, ys]) {
		let lastDir = 0;
		let revAt = -Infinity;
		let revDir = 0;
		for (let i = 1; i < v.length; i++) {
			const d = Math.sign(v[i] - v[i - 1]);
			if (d === 0) continue;
			if (lastDir !== 0 && d !== lastDir) {
				if (i - revAt <= JIGGLE_FRAMES && d === -revDir) n += 1;
				revAt = i;
				revDir = d;
			}
			lastDir = d;
		}
	}
	return n;
}

/** the [PZ-NET] meter over one path of one zombie: all its jolts, and those in the shadow of a machine hitch */
function trancos(frames, xKey, yKey) {
	const m = new HM.HitchMeter(ZOMBIE_MOVING_UPS);
	let seen = 0;
	let shadowed = 0;
	for (const f of frames) {
		m.beginFrame(f.dt);
		m.observe(1, f[xKey], f[yKey], f.dt);
		// the meter keeps its count private in TypeScript; the transpiled object has it as a plain field
		const n = m.jolts;
		if (n > seen && f.shadow) shadowed += n - seen;
		seen = n;
	}
	return { all: m.take().jolts, shadowed };
}

function median(xs) {
	if (xs.length === 0) return 0;
	const s = [...xs].sort((a, b) => a - b);
	return s[Math.floor(s.length / 2)];
}

function percentile(xs, p) {
	const v = xs.filter(x => Number.isFinite(x)).sort((a, b) => a - b);
	if (v.length === 0) return NaN;
	return v[Math.min(v.length - 1, Math.floor(v.length * p))];
}

const ZERO = () => ({
	seconds: 0,
	frames: 0,
	stale: 0,
	frozen: 0,
	back: 0,
	jumps: 0,
	jumpsIdeal: 0,
	errMax: 0,
	pxBack: 0,
	idealPxBack: 0,
	tremor: 0,
	tremorIdeal: 0,
	flipsDrawn: 0,
	trDrawn: 0,
	trIdeal: 0,
	trDrawnHitch: 0,
	trIdealHitch: 0,
	trTruth: 0,
});

/** one zombie's drawn frames (only those where it was drawn opaque) against the ideal and the truth */
function measure(frames) {
	const f = frames.filter(r => r.alpha > 0.5);
	const out = ZERO();
	out.frames = f.length;
	if (f.length < 3) return out;
	for (const r of f) out.seconds += r.dt;
	const steps = [];
	for (let i = 1; i < f.length; i++) {
		const a = f[i - 1];
		const b = f[i];
		const dx = b.x - a.x;
		const dy = b.y - a.y;
		const d = Math.hypot(dx, dy);
		const idx = b.ix - a.ix;
		const idy = b.iy - a.iy;
		const id = Math.hypot(idx, idy);
		if (id > 0.3) steps.push(id);
		if (b.stale) out.stale += 1;
		out.errMax = Math.max(out.errMax, Math.hypot(b.x - b.ix, b.y - b.iy));
		// frozen: the ideal drawing moved this frame, the real one did not move at all
		if (id > 0.3 && d < 0.01) out.frozen += 1;
		// backwards: the real drawing stepped against the way the ideal one moved
		if (id > 0.3 && (dx * idx + dy * idy) / id < -0.25) out.back += 1;
		// on screen, through the same eased camera: the drawn pixel against the ideal one's motion
		if (Math.abs(b.ipx - a.ipx) >= 0.4 && (b.px - a.px) * (b.ipx - a.ipx) < 0) out.pxBack += 1;
		if (Math.abs(b.ipy - a.ipy) >= 0.4 && (b.py - a.py) * (b.ipy - a.ipy) < 0) out.pxBack += 1;
		// hypothesis 4: the IDEAL drawing, rounded, through the eased camera, against the same through a locked
		// one. A pixel stepping back here is the camera and the rounding, and no network could cause it
		const rx = ROUND(b.ipx) - ROUND(a.ipx);
		const ry = ROUND(b.ipy) - ROUND(a.ipy);
		if (Math.abs(b.ipx - a.ipx) >= 0.4 && rx * (b.ipx - a.ipx) < 0) out.idealPxBack += 1;
		if (Math.abs(b.ipy - a.ipy) >= 0.4 && ry * (b.ipy - a.ipy) < 0) out.idealPxBack += 1;
	}
	// a frame over 3x the median step: counted on the real drawing and on the ideal one (a charge or a knockback
	// is the zombie really lunging; only the difference is the drawing catching up)
	const med = median(steps);
	for (let i = 1; i < f.length; i++) {
		const d = Math.hypot(f[i].x - f[i - 1].x, f[i].y - f[i - 1].y);
		const id = Math.hypot(f[i].ix - f[i - 1].ix, f[i].iy - f[i - 1].iy);
		if (med > 0.2 && d > 3 * med && d > 1) out.jumps += 1;
		if (med > 0.2 && id > 3 * med && id > 1) out.jumpsIdeal += 1;
	}
	out.tremor = pixelTremors(
		f.map(r => r.px),
		f.map(r => r.py),
	);
	out.tremorIdeal = pixelTremors(
		f.map(r => ROUND(r.ipx)),
		f.map(r => ROUND(r.ipy)),
	);
	out.flipsDrawn = headingFlips(f.map(r => r.a));
	const drawn = trancos(f, "x", "y");
	const ideal = trancos(f, "ix", "iy");
	out.trDrawn = drawn.all;
	out.trIdeal = ideal.all;
	out.trDrawnHitch = drawn.shadowed;
	out.trIdealHitch = ideal.shadowed;
	out.trTruth = trancos(f, "tx", "ty").all;
	return out;
}

/** the SERVER's own path, tick by tick: reversals are bodies ping-ponging, whatever the client does */
function serverPath(hist) {
	const ticks = [...hist.keys()].sort((a, b) => a - b);
	let reversals = 0;
	let wobble = 0;
	const angles = [];
	for (let i = 2; i < ticks.length; i++) {
		const p0 = hist.get(ticks[i - 2]);
		const p1 = hist.get(ticks[i - 1]);
		const p2 = hist.get(ticks[i]);
		const v1x = p1.x - p0.x;
		const v1y = p1.y - p0.y;
		const v2x = p2.x - p1.x;
		const v2y = p2.y - p1.y;
		const l1 = Math.hypot(v1x, v1y);
		const l2 = Math.hypot(v2x, v2y);
		// a quarter of a unit a tick (15 u/s) each way: below that it is a nudge no pixel shows
		if (l1 > 0.25 && l2 > 0.25 && (v1x * v2x + v1y * v2y) / (l1 * l2) < -0.5) reversals += 1;
		wobble += Math.hypot(v2x - v1x, v2y - v1y);
		angles.push(p2.a);
	}
	return { seconds: ticks.length / SIM_HZ, reversals, wobble, flips: headingFlips(angles) };
}

function summarize(res) {
	const sum = { ...ZERO(), srvSeconds: 0, srvReversals: 0, srvWobble: 0, srvFlips: 0, per: [] };
	for (const [netId, frames] of res.rec) {
		const m = measure(frames);
		const s = serverPath(res.truth.get(netId));
		sum.per.push({ netId, m, s });
		for (const k of Object.keys(m)) {
			if (k === "errMax") sum.errMax = Math.max(sum.errMax, m.errMax);
			else sum[k] += m[k];
		}
		sum.srvSeconds += s.seconds;
		sum.srvReversals += s.reversals;
		sum.srvWobble += s.wobble;
		sum.srvFlips += s.flips;
	}
	sum.srvWobble /= Math.max(1, sum.srvSeconds * SIM_HZ);
	const finite = res.lag.filter(Number.isFinite);
	sum.lagMean = finite.reduce((a, b) => a + b, 0) / Math.max(1, finite.length);
	sum.lagP95 = percentile(res.lag, 0.95);
	sum.lagPast = res.lag.length - finite.length;
	sum.delayMin = Math.min(...res.delays);
	sum.delayMax = Math.max(...res.delays);
	sum.rateMin = Math.min(...res.rates);
	sum.rateMax = Math.max(...res.rates);
	return sum;
}

/**
 * A breakpoint run after the server came back: the longest the (only) zombie's drawing stood still while the server
 * had it walking, how many frames from half a second on were drawn past what the server had simulated, and the delay
 * the run ended on.
 */
function afterPause(res) {
	const [frames] = [...res.rec.values()];
	let freeze = 0;
	let still = 0;
	let prev;
	for (const f of frames ?? []) {
		if (f.t > res.resumeT && prev !== undefined && f.live !== undefined && prev.live !== undefined) {
			const drawn = Math.hypot(f.x - prev.x, f.y - prev.y);
			const live = Math.hypot(f.live.x - prev.live.x, f.live.y - prev.live.y);
			if (drawn < 0.05 && live > 0.3) still += f.dt;
			else if (drawn >= 0.05) still = 0;
			freeze = Math.max(freeze, still);
		}
		prev = f;
	}
	let pastAfter = 0;
	for (let i = 0; i < res.lag.length; i++) {
		if (res.lagT[i] > res.resumeT + 0.5 && !Number.isFinite(res.lag[i])) pastAfter += 1;
	}
	return { freeze, pastAfter, delayEnd: res.delayEnd };
}

/**
 * (h)–(k) THE MAX DRAWN SPEED. Every drawn frame of every zombie against the fastest that very body ever moved on the
 * server (tick to tick, its whole life): a frame may cover at most SPEED_MARGIN × that speed × dt + SPEED_SLACK_U. The
 * one exception is a snap nobody sees: the frame lands at an alpha of at most FADE_SNAP_ALPHA (it starts a fade-in),
 * or both ends of it are off the screen. A body drawn racing from one region to another -- the owner's report of
 * 2026-09-24 -- is exactly a frame that breaks this with the body on screen and opaque.
 */
const SPEED_MARGIN = 1.25;
/** §5.1: how far past its newest sample a body is extrapolated, at most */
const EXTRAPOLATE_S = CFG.EXTRAPOLATE_MAX_S ?? 0.1;
const SPEED_SLACK_U = 4;
const FADE_SNAP_ALPHA = 0.1;
const SCREEN_MARGIN = 40;
/** (l): the alpha a body that had fully appeared may dip to in a loss burst (M1: no blink) */
const ALPHA_FLOOR = 0.8;
/** (l), (m): the most a bridge may owe (client/net/snapshotBuffer.ts BRIDGE_MAX_U, review of 6e6dfa0) */
const BRIDGE_MAX_U = 64;
/** (h): at most this share of the relocated bodies may land on the 1920 x 1080 screen (§3.5 "Limpeza") */
const SPAWN_IN_VIEW_MAX_PCT = 10;

function drawnSpeed(res, strict = false) {
	const out = { frames: 0, fast: 0, worstRatio: 0, worstStep: 0, worstUps: 0, samples: [] };
	const onScreen = f =>
		f.px >= -SCREEN_MARGIN &&
		f.px <= res.viewW + SCREEN_MARGIN &&
		f.py >= -SCREEN_MARGIN &&
		f.py <= res.viewH + SCREEN_MARGIN;
	for (const [netId, frames] of res.rec) {
		const list = res.lives.get(netId);
		if (list === undefined) continue;
		// the fastest this body really went, tick to tick, over its whole life (a move across the map is not a speed:
		// the server-side check counts it apart); a frame is judged against the life its render tick is in
		const vmaxAt = tick => {
			let life = list[0];
			for (const l of list) if (l.from <= tick) life = l;
			return life.vmax;
		};
		for (let i = 1; i < frames.length; i++) {
			const a = frames[i - 1];
			const b = frames[i];
			// consecutive client frames of the same track only (a body that retired and came back is a new drawing)
			if (Math.abs(b.t - a.t - b.dt) > 1e-6) continue;
			const shown = b.alpha > FADE_SNAP_ALPHA && (onScreen(a) || onScreen(b));
			if (!shown) continue;
			out.frames += 1;
			const vmax = vmaxAt(b.tick);
			const d = Math.hypot(b.x - a.x, b.y - a.y);
			// a frame that ends an extrapolation (§5.1: up to EXTRAPOLATE_MAX_S along the last velocity) catches up by what
			// the guess could be off: the body going the other way at its top speed. A charger stopping mid-rush is the
			// case (40 u in one frame at 750 u/s) -- a correction of a few frames' walk, never a run across the map
			const ending = a.stale === true || frames[i - 2]?.stale === true;
			// (l) is strict: a stream that went silent is caught up smoothly, never in one frame (M1)
			const catchUp = ending && !strict ? 2 * vmax * EXTRAPOLATE_S : 0;
			const allowed = vmax * b.dt * SPEED_MARGIN + SPEED_SLACK_U + catchUp;
			if (vmax > 0) out.worstRatio = Math.max(out.worstRatio, d / (vmax * b.dt));
			if (d > out.worstStep) {
				out.worstStep = d;
				out.worstUps = d / b.dt;
			}
			if (d > allowed) {
				out.fast += 1;
				if (out.samples.length < 4) {
					out.samples.push(
						`#${netId} t=${b.t.toFixed(2)} s: ${d.toFixed(0)} u in one frame (${(d / b.dt).toFixed(0)} u/s, ` +
							`it never went over ${vmax.toFixed(0)} u/s), alpha ${b.alpha.toFixed(2)}, ` +
							`stale ${frames[i - 2]?.stale === true ? 1 : 0}${a.stale ? 1 : 0}${b.stale ? 1 : 0}`,
					);
				}
			}
		}
	}
	return out;
}

const rate = (n, s) => (s > 0 ? n / s : 0);
const f2 = v => v.toFixed(2);

function printRow(label, s, res) {
	console.log(
		`    ${label.padEnd(6)} desenho: stale ${((100 * s.stale) / Math.max(1, s.frames)).toFixed(1)}% | ` +
			`congela ${f2(rate(s.frozen, s.seconds))}/s | tras ${f2(rate(s.back, s.seconds))}/s | ` +
			`salto ${f2(rate(s.jumps, s.seconds))}/s (ideal ${f2(rate(s.jumpsIdeal, s.seconds))}) | ` +
			`trancos ${s.trDrawn} (ideal ${s.trIdeal}, servidor ${s.trTruth}; em travada da maquina ${s.trDrawnHitch}/${s.trIdealHitch}) ` +
			`em ${s.seconds.toFixed(0)} s-zumbi | ` +
			`erro max ${s.errMax.toFixed(1)} u | px-tras ${f2(rate(s.pxBack, s.seconds))}/s | ` +
			`tremor ${f2(rate(s.tremor, s.seconds))}/s (ideal ${f2(rate(s.tremorIdeal, s.seconds))})`,
	);
	console.log(
		`           tempo: atraso real ${(s.lagMean * 1000).toFixed(0)} ms (p95 ${(s.lagP95 * 1000).toFixed(0)}), ` +
			`alem do servidor ${s.lagPast} quadros | buffer ${(s.delayMin * 1000).toFixed(0)}-${(s.delayMax * 1000).toFixed(0)} ms | ` +
			`relogio de render ${f2(s.rateMin)}x-${f2(s.rateMax)}x | ticks perdidos ${res.dropped} | fps ${res.fps.toFixed(0)} | ` +
			`epoca reancorada +${(res.epochShift * 1000).toFixed(0)} ms, travadas absorvidas ${(res.absorbed * 1000).toFixed(0)} ms, ` +
			`atraso fixado ${res.relocks}x`,
	);
	console.log(
		`           servidor: trancos ${f2(rate(s.trTruth, s.seconds))}/s-zumbi | reversoes ${f2(rate(s.srvReversals, s.srvSeconds))}/s | ` +
			`oscilacao ${s.srvWobble.toFixed(3)} u/tick | giros ${f2(rate(s.srvFlips, s.srvSeconds))}/s ` +
			`(desenhados ${f2(rate(s.flipsDrawn, s.seconds))}/s) | camera suave px-tras ideal ${s.idealPxBack}`,
	);
	if (!VERBOSE) return;
	for (const p of s.per) {
		console.log(
			`             #${p.netId} ${p.m.seconds.toFixed(1)} s stale ${p.m.stale} congela ${p.m.frozen} tras ${p.m.back} ` +
				`salto ${p.m.jumps}/${p.m.jumpsIdeal} trancos ${p.m.trDrawn}/${p.m.trIdeal}/${p.m.trTruth} ` +
				`srv-rev ${p.s.reversals} srv-giros ${p.s.flips}`,
		);
	}
}

// ---------------------------------------------------------------- the scenarios

/** a hunting zombie facing the survivor, told where they are (it would see them on its next tick anyway) */
function hunter(type, x, y, sx, sy) {
	const z = createZombie(type, x, y, 5, false);
	z.angle = Math.atan2(sy - y, sx - x);
	z.angleSlow = z.angle;
	z.detect = true;
	Brain.seedHunt(z, sx, sy);
	return z;
}

const still = () => ({ x: 0, y: 0 });

/** (h), (i): a long loop through town at the survivor's full speed, legs of [x, y, seconds], from t = 1 s */
const EXPLORE_LEGS = [
	[1, 0, 12],
	[0, 1, 8],
	[-1, 0, 6],
	[0, 1, 6],
	[1, 0, 10],
	[0, -1, 14],
	[-1, 0, 8],
	[0, 1, 4],
	[1, 1, 10],
	[-1, 0, 12],
];
function explore(t) {
	let at = 1;
	if (t < at) return still();
	for (const [x, y, s] of EXPLORE_LEGS) {
		if (t < at + s) {
			const l = Math.hypot(x, y);
			return { x: x / l, y: y / l };
		}
		at += s;
	}
	return still();
}

const SCENARIOS = {
	a: {
		title: "(a) um andador persegue o sobrevivente, que anda e depois para",
		seconds: 14,
		warmup: 0.5,
		setup: ({ sx, sy }) => [hunter(1, sx - 420, sy + 60, sx, sy)],
		// stands 1 s, walks away (+x) for 2.5 s, stands: the walker closes in and bites
		input: t => (t >= 1 && t < 3.5 ? { x: 1, y: 0 } : still()),
	},
	b: {
		title: "(b) dez andadores cercando um sobrevivente parado (o print do dono)",
		seconds: 14,
		warmup: 0.5,
		setup: ({ sx, sy }) => {
			const out = [];
			for (let i = 0; i < 10; i++) {
				const a = (i / 10) * TAU + 0.2;
				const r = 180 + ((i * 53) % 120);
				out.push(hunter(1, sx + Math.cos(a) * r, sy + Math.sin(a) * r, sx, sy));
			}
			return out;
		},
		input: still,
	},
	c: {
		title: "(c) um andador cruzando o limite de 800 u (anel proximo/medio) numa tela 1920x1080",
		seconds: 14,
		warmup: 0.5,
		viewW: 1920,
		viewH: 1080,
		// it comes in from 920 u (mid ring, 10 Hz) and crosses 800; the survivor then walks away and it leaves again
		setup: ({ sx, sy }) => [hunter(1, sx - 900, sy - 200, sx, sy)],
		input: t => (t >= 5 && t < 9 ? { x: 1, y: 0 } : still()),
	},
	/*
	 * A Studio breakpoint on the server (review of 2026-09-23, #4). The Heartbeat stops for 10 s; its next delta is
	 * clipped to MAX_FRAME_S and the rest is dropped (§3.1). With the epoch fixed at tick0Time the clients' delay
	 * then held those ~10 s for the rest of the session; re-anchored on the TimePongs it comes back down.
	 */
	e: {
		title: "(e) breakpoint de 10 s no servidor, com um andador vindo de longe",
		seconds: 10,
		warmup: 0.5,
		pause: { at: 2, seconds: 10 },
		profiles: ["clean", "studio"],
		ownVerdict: true,
		setup: ({ sx, sy }) => [hunter(1, sx - 760, sy + 40, sx, sy)],
		input: still,
	},
	/*
	 * A pause between DELAY_SNAP_S (0.3 s) and RENDER_RESET_S (it was 1 s), on a client that goes on drawing through
	 * it: the delay snapped up, the render time jumped back by less than RENDER_RESET_S and was HELD -- the horde stood
	 * frozen for the whole pause again after the server was back.
	 */
	f: {
		title: "(f) o servidor para 0,6 s e o cliente segue desenhando",
		seconds: 9,
		warmup: 0.5,
		pause: { at: 2, seconds: 0.6 },
		profiles: ["clean"],
		ownVerdict: true,
		setup: ({ sx, sy }) => [hunter(1, sx - 760, sy + 40, sx, sy)],
		input: still,
	},
	/*
	 * The client's clock re-locking (review #4): GetServerTimeNow() steps 0.6 s -- past CLOCK_SNAP_S, so the tick
	 * estimate jumps -- while the server and the link are perfectly fine. The render time used to follow the clock:
	 * it jumped with it, the delay snapped after it, and the jump back was HELD (it was under the old 1 s
	 * RENDER_RESET_S), the horde standing still for the whole step with every snapshot arriving on time.
	 */
	g: {
		title: "(g) o relogio do cliente salta 0,6 s (GetServerTimeNow ressincroniza) com o servidor normal",
		seconds: 9,
		warmup: 0.5,
		clockStep: { at: 3, seconds: 0.6 },
		profiles: ["clean"],
		ownVerdict: true,
		setup: ({ sx, sy }) => [hunter(1, sx - 760, sy + 40, sx, sy)],
		input: still,
	},
	/*
	 * The owner's report of 2026-09-24: "when I explore, the enemies left behind get teleported to other places: I see
	 * enemies on screen going very fast from one region to another". The REAL population this time -- ambient walkers,
	 * specials, the recycling of shared/sim/ai/population.ts `cleanup` -- around a survivor who walks a long loop through
	 * an open town at 210 u/s, on a 1920 x 1080 screen. Before the fix a special left behind was put back on the
	 * survivor's ring under the same netId, every few seconds, and drawn crossing the screen at 10 000-23 000 u/s.
	 */
	h: {
		title: "(h) 90 s explorando de dia com a populacao real (reciclagem e realocacao), tela 1920x1080",
		seconds: 90,
		warmup: 1,
		population: true,
		worldSize: 14000,
		start: { x: 2000, y: 2000 },
		day: 6,
		hour: 12,
		viewW: 1920,
		viewH: 1080,
		profiles: ["clean", "wan"],
		ownVerdict: true,
		speedCheck: true,
		setup: () => [],
		input: explore,
	},
	/* the same walk at night, with the waves on: the dark rule hides most of it, the ring still refills the tide */
	i: {
		title: "(i) o mesmo passeio a noite, com as ondas (19h30)",
		seconds: 60,
		warmup: 1,
		population: true,
		worldSize: 14000,
		start: { x: 2000, y: 2000 },
		day: 6,
		hour: 19.5,
		night: true,
		viewW: 1920,
		viewH: 1080,
		profiles: ["clean"],
		ownVerdict: true,
		speedCheck: true,
		setup: () => [],
		input: explore,
	},
	/*
	 * A re-entry (§4.4): the wire stops carrying a body for longer than its ring's despawn timeout -- it stepped out of
	 * the light, behind a roof, out of the interest -- and carries it again before the client retired the track (which
	 * is fading it out by then): six samples of a walker in the near ring (0.35 s against a 0.3 s timeout) and six of one
	 * in the mid ring (0.7 s against 0.6 s). Each came back tens of units further on and used to be interpolated from
	 * where it was last seen: held, half faded, then jumping most of the way in one frame.
	 */
	j: {
		title: "(j) dois andadores somem do fio e voltam antes de a trilha se aposentar (reentrada, anel proximo e medio)",
		seconds: 6,
		warmup: 0.5,
		viewW: 1920,
		viewH: 1080,
		profiles: ["clean", "wan"],
		ownVerdict: true,
		speedCheck: true,
		restartExpected: 2,
		setup: ({ sx, sy }) => [hunter(1, sx - 520, sy + 40, sx, sy), hunter(1, sx - 900, sy - 480, sx, sy)],
		input: still,
		filterPart: (zs, t, { watched, horde, state }) => {
			const which = zs.netId === horde.netIdOf(watched[0]) ? 0 : zs.netId === horde.netIdOf(watched[1]) ? 1 : -1;
			if (which < 0 || t < (which === 0 ? 2 : 1)) return true;
			const dropped = state[which] ?? 0;
			if (dropped >= 6) return true;
			state[which] = dropped + 1;
			return false;
		},
	},
	/*
	 * The client's own guard: the SERVER moves a body 670 u under the same netId, on screen (nothing does since the
	 * population gives a relocation a new identity; this stands for whatever could). 670 u in 50 ms is not a walk.
	 */
	/*
	 * (l) The review of 577c729, M1: a loss burst on the Snap stream -- 350 ms, and later 400 ms, nothing arrives at all
	 * -- longer than the near ring's 0.3 s despawn timeout. It is a gap in the WHOLE stream, not in one track: no body
	 * left, so none may blink (fade out and back in) and none may jump. Before the fix every track came back through a
	 * restart at alpha 0; before that one, every one faded towards 0 after 0.3 s of silence and back up after it.
	 */
	l: {
		title: "(l) rajadas de perda de 350 e 400 ms no Snap com seis andadores na tela (nada pisca, nada salta)",
		seconds: 9,
		warmup: 1,
		viewW: 1920,
		viewH: 1080,
		profiles: ["clean", "wan"],
		ownVerdict: true,
		speedCheck: true,
		alphaCheck: true,
		strictSpeed: true,
		lossBursts: [
			[3, 0.35],
			[6, 0.4],
		],
		setup: ({ sx, sy }) => {
			const out = [];
			for (let i = 0; i < 6; i++) {
				const a = (i / 6) * TAU + 0.3;
				out.push(hunter(1, sx + Math.cos(a) * 600, sy + Math.sin(a) * 420, sx, sy));
			}
			return out;
		},
		input: still,
	},
	/*
	 * (m) The review of 6e6dfa0: the bridge of (l) has a ceiling. A 1.6 s silence of the whole stream leaves each walker
	 * ~80-100 u from where it was held: eased at 150 u/s it would slide for most of a second, drawn where the server
	 * no longer has it. Past BRIDGE_MAX_U the track starts again, faded in, where the body is; the short burst before it
	 * is still one walk.
	 */
	m: {
		title: "(m) um silencio de 1,6 s no Snap: nenhuma ponte deve mais que 64 u (quem deveria recomeca, aparecendo aos poucos)",
		seconds: 9,
		warmup: 1,
		viewW: 1920,
		viewH: 1080,
		profiles: ["clean", "wan"],
		ownVerdict: true,
		speedCheck: true,
		strictSpeed: true,
		bridgeCap: true,
		lossBursts: [
			[2.5, 0.35],
			[5, 1.6],
		],
		setup: ({ sx, sy }) => {
			const out = [];
			for (let i = 0; i < 6; i++) {
				const a = (i / 6) * TAU + 0.3;
				out.push(hunter(1, sx + Math.cos(a) * 700, sy + Math.sin(a) * 480, sx, sy));
			}
			return out;
		},
		input: still,
	},
	k: {
		title: "(k) o servidor move um corpo 670 u sem trocar o netId (a guarda do cliente)",
		seconds: 6,
		warmup: 0.5,
		viewW: 1920,
		viewH: 1080,
		profiles: ["clean", "wan"],
		ownVerdict: true,
		speedCheck: true,
		restartExpected: 1,
		setup: ({ sx, sy }) => [hunter(1, sx - 520, sy + 40, sx, sy)],
		input: still,
		event: (t, { watched }) => {
			const z = watched[0];
			if (t >= 2.5 && z._moved !== true) {
				z._moved = true;
				z.x += 600;
				z.y -= 300;
			}
		},
	},
	d: {
		title: "(d) um investidor guardando distancia e investindo, e um andador recuando de tiro duas vezes",
		seconds: 12,
		warmup: 0.5,
		setup: ({ sx, sy }) => [hunter(4, sx + 380, sy - 40, sx, sy), hunter(1, sx - 260, sy + 30, sx, sy)],
		input: still,
		// a headshot-strength hit on the walker at 2.5 s and again at 6 s, through combat's own hook
		event: (t, { watched, sx, sy }) => {
			const w = watched[1];
			if (w.hp <= 0) return;
			const n = w._knocks ?? 0;
			if ((t >= 2.5 && n === 0) || (t >= 6 && n === 1)) {
				w._knocks = n + 1;
				Brain.reactToHit(w, Math.atan2(w.y - sy, w.x - sx), 9);
			}
		},
	},
};

// ---------------------------------------------------------------- run everything

console.log(
	`andador a 90 u/s, sobrevivente a 210 u/s | servidor ${SIM_HZ} Hz, snapshot ${CFG.SNAP_NEAR_HZ}/${CFG.SNAP_MID_HZ} Hz | ` +
		`1 u = 1 px | links: clean (80 ms), wan (140 ms, 2 % perda), studio (um processo, quadros irregulares)`,
);

const results = {};
/** the breakpoint scenarios' raw runs, judged on their own (`ownVerdict`) */
const pauses = {};
/** (h)–(k): the max drawn speed of each run */
const speeds = {};
for (const key of Object.keys(SCENARIOS).sort()) {
	if (ONLY !== undefined && !ONLY.includes(key)) continue;
	const scn = SCENARIOS[key];
	console.log("\n" + scn.title);
	results[key] = {};
	for (const prof of scn.profiles ?? Object.keys(PROFILES)) {
		const res = run(scn, prof);
		const s = summarize(res);
		results[key][prof] = s;
		printRow(prof, s, res);
		if (scn.speedCheck === true) {
			const sp = drawnSpeed(res, scn.strictSpeed === true);
			speeds[`(${key}) ${prof}`] = { sp, res, scn };
			console.log(
				`           velocidade desenhada: ${sp.fast} quadros mais rapidos que o proprio zumbi, em ${sp.frames} quadros ` +
					`na tela | pior ${sp.worstRatio.toFixed(2)}x a velocidade real dele (${sp.worstStep.toFixed(1)} u num quadro, ` +
					`${sp.worstUps.toFixed(0)} u/s)`,
			);
			console.log(
				`           servidor: ${res.relocations} realocacoes, ${res.teleports.length} saltos de um mesmo netId, ` +
					`${res.spawns} corpos novos (${res.spawnsInView} surgiram na tela), ${res.relocLanded} corpos movidos ` +
					`(${res.relocInView} cairam na tela) | cliente: ${res.restarts} trilhas ` +
					`recomecadas | zumbis no fim ${res.zombiesEnd}`,
			);
			for (const line of sp.samples) console.log(`             ${line}`);
		}
		if (scn.pause !== undefined || scn.clockStep !== undefined) {
			const p = afterPause(res);
			p.clockStep = scn.clockStep !== undefined;
			p.summary = s;
			pauses[`(${key}) ${prof}`] = p;
			console.log(
				`           depois do evento: parado no maximo ${(p.freeze * 1000).toFixed(0)} ms com o zumbi andando, ` +
					`${p.pastAfter} quadros alem do servidor, atraso final ${(res.delayEnd * 1000).toFixed(0)} ms`,
			);
		}
	}
}

// ---------------------------------------------------------------- the verdict

console.log("\nveredito");

console.log(" o desenho (o cliente contra o cliente perfeito, em todo cenario e link)");
for (const key of Object.keys(results)) {
	if (SCENARIOS[key].ownVerdict) continue;
	for (const prof of Object.keys(results[key])) {
		const s = results[key][prof];
		const tag = `(${key}) ${prof}`;
		const stalePct = (100 * s.stale) / Math.max(1, s.frames);
		check(`${tag}: no maximo 2 % dos quadros extrapolados ou parados`, stalePct <= 2, `${stalePct.toFixed(1)} %`);
		check(
			`${tag}: nenhum quadro congelado que o cliente perfeito moveria`,
			rate(s.frozen, s.seconds) <= 0.05,
			`${s.frozen} quadros, ${f2(rate(s.frozen, s.seconds))}/s`,
		);
		check(
			`${tag}: o desenho nao anda para tras`,
			rate(s.back, s.seconds) <= 0.05,
			`${s.back} quadros, ${f2(rate(s.back, s.seconds))}/s`,
		);
		const drawnJolts = s.trDrawn - s.trDrawnHitch;
		const idealJolts = s.trIdeal - s.trIdealHitch;
		check(
			`${tag}: nenhum tranco a mais que o cliente perfeito (fora de travada da maquina)`,
			drawnJolts <= idealJolts + Math.max(1, Math.ceil(idealJolts * 0.1)),
			`${drawnJolts} contra ${idealJolts}`,
		);
		check(`${tag}: nada desenhado alem do que o servidor simulou`, s.lagPast === 0, `${s.lagPast} quadros`);
		// hypothesis 1: the adaptive delay slews the render clock; within ±12 % nobody sees a speed change
		check(
			`${tag}: o relogio de render anda a 1x ±12 %`,
			s.rateMin >= 0.88 && s.rateMax <= 1.12,
			`${f2(s.rateMin)}x-${f2(s.rateMax)}x`,
		);
		// hypothesis 4: the eased camera plus rounding never steps a perfectly drawn body backwards
		check(`${tag}: camera suave + arredondamento nao fazem pixel voltar`, s.idealPxBack === 0, `${s.idealPxBack}`);
	}
}

console.log(" o servidor (o caminho de cada zumbi, tick a tick)");
if (results.b !== undefined && results.d !== undefined) {
	const b = results.b.clean;
	check(
		"(b) a roda de andadores assenta: trancos do servidor por zumbi-segundo <= 0,3",
		rate(b.trTruth, b.seconds) <= 0.3,
		`${f2(rate(b.trTruth, b.seconds))}/s (${b.trTruth} em ${b.seconds.toFixed(0)} s)`,
	);
	const d = results.d.clean;
	check(
		"(d) o investidor nao treme guardando distancia: reversoes do servidor <= 1/s",
		rate(d.srvReversals, d.srvSeconds) <= 1,
		`${f2(rate(d.srvReversals, d.srvSeconds))}/s`,
	);
}

console.log(" o atraso (o 'meio lagado')");
if (results.a !== undefined) {
	const st = results.a.studio;
	check(
		"(a) studio: o desenho tem no maximo 170 ms (p95) e nunca passa do servidor",
		st.lagP95 <= 0.17 && st.lagPast === 0,
		`p95 ${(st.lagP95 * 1000).toFixed(0)} ms, alem do servidor ${st.lagPast}`,
	);
	const cl = results.a.clean;
	check("(a) clean: atraso real medio <= 150 ms", cl.lagMean <= 0.15, `${(cl.lagMean * 1000).toFixed(0)} ms`);
}

console.log(" a pausa do servidor (breakpoint) e o salto do relogio");
for (const [tag, p] of Object.entries(pauses)) {
	if (p.clockStep) {
		// the render time is measured on the snapshots' arrivals, not on the clock: a clock that re-locks moves it by
		// nothing (snapshotBuffer.ts `clockCorrected`)
		const s = p.summary;
		check(
			`${tag}: o relogio de render nao salta com o relogio do cliente (1x ±12 %)`,
			s.rateMin >= 0.88 && s.rateMax <= 1.12,
			`${f2(s.rateMin)}x-${f2(s.rateMax)}x`,
		);
	} else {
		// review #4: with a fixed epoch the delay kept the whole pause for good (9.8 s after a 10 s breakpoint)
		check(
			`${tag}: o atraso volta ao normal (<= 300 ms)`,
			p.delayEnd <= 0.3,
			`${(p.delayEnd * 1000).toFixed(0)} ms`,
		);
	}
	// review #4: between DELAY_SNAP_S and the old 1 s RENDER_RESET_S the render time was HELD after a resync
	check(
		`${tag}: depois do evento, o desenho nunca fica parado mais de 250 ms com o zumbi andando no servidor`,
		p.freeze <= 0.25,
		`${(p.freeze * 1000).toFixed(0)} ms`,
	);
	check(
		`${tag}: meio segundo depois da volta, nada desenhado alem do servidor`,
		p.pastAfter === 0,
		`${p.pastAfter} quadros`,
	);
}

console.log(" a velocidade desenhada (h-k): nenhum zumbi cruza a tela mais rapido do que anda");
for (const [tag, { sp, res, scn }] of Object.entries(speeds)) {
	check(
		`${tag}: nenhum zumbi na tela desenhado mais rapido que a velocidade real dele (${SPEED_MARGIN}x + ` +
			`${SPEED_SLACK_U} u por quadro${scn.strictSpeed === true ? ", sem folga para o fim de uma extrapolacao" : ""}; ` +
			`um salto so com alfa <= ${FADE_SNAP_ALPHA} ou fora da tela)`,
		sp.fast === 0,
		`${sp.fast} quadros em ${sp.frames}; pior ${sp.worstRatio.toFixed(2)}x, ${sp.worstUps.toFixed(0)} u/s`,
	);
	if (scn.population === true) {
		check(
			`${tag}: nenhum netId pula de lugar no servidor (a realocacao da populacao e um corpo novo, com outro netId)`,
			res.teleports.length === 0,
			`${res.teleports.length} saltos, ${res.relocations} realocacoes`,
		);
	}
	if (scn.alphaCheck === true) {
		// every body that had faded fully in, from then on: its lowest alpha (a blink is a dip and a rise)
		let lowest = 1;
		let who = "";
		for (const [netId, frames] of res.rec) {
			let seenFull = false;
			for (const f of frames) {
				if (f.alpha >= 0.999) seenFull = true;
				else if (seenFull && f.alpha < lowest) {
					lowest = f.alpha;
					who = `#${netId} t=${f.t.toFixed(2)} s`;
				}
			}
		}
		check(
			`${tag}: nenhum corpo pisca na rajada: o alfa de quem ja apareceu nao cai abaixo de ${ALPHA_FLOOR}`,
			lowest >= ALPHA_FLOOR,
			`menor alfa ${lowest.toFixed(2)}${who !== "" ? ` (${who})` : ""}`,
		);
		check(
			`${tag}: nenhuma trilha recomeca (a lacuna e do fluxo inteiro, nao de um corpo)`,
			res.restarts === 0 && res.bridged > 0,
			`${res.restarts} recomecos, ${res.bridged} trilhas mantidas como uma caminhada`,
		);
	}
	if (scn.alphaCheck === true) {
		check(
			`${tag}: nenhuma ponte chega ao teto (ela nunca deve mais que ${BRIDGE_MAX_U} u numa rajada curta)`,
			res.bridgeCapped === 0 && res.bridgeMax <= BRIDGE_MAX_U,
			`a maior ${res.bridgeMax.toFixed(1)} u, ${res.bridgeCapped} no teto`,
		);
	}
	if (scn.bridgeCap === true) {
		check(
			`${tag}: nenhuma ponte deve mais que ${BRIDGE_MAX_U} u; quem deveria recomeca onde esta, aparecendo aos poucos`,
			// each counted once, as what it is: a capped bridge is neither a kept one (`bridged`) nor a restart
			res.bridgeMax <= BRIDGE_MAX_U && res.bridgeCapped > 0 && res.restarts === 0,
			`a maior mantida ${res.bridgeMax.toFixed(1)} u, ${res.bridgeCapped} recomecadas no teto, ` +
				`${res.bridged} mantidas, ${res.restarts} recomecos (reentrada ou salto)`,
		);
		check(
			`${tag}: a rajada curta antes dela continua uma caminhada (pontes mantidas)`,
			res.bridged > 0 && res.bridgeMax > 0,
			`${res.bridged} mantidas, a maior ${res.bridgeMax.toFixed(1)} u`,
		);
	}
	if (scn.restartExpected !== undefined) {
		check(
			`${tag}: cada trilha recomeca no lugar novo (e aparece aos poucos) em vez de deslizar ate la`,
			res.restarts === scn.restartExpected,
			`${res.restarts} recomeco(s) de ${scn.restartExpected}`,
		);
	}
}
{
	const h = speeds["(h) clean"]?.res;
	if (h !== undefined) {
		// the walk has to exercise what it is about, or the checks above prove nothing
		check("(h) clean: o passeio faz a populacao realocar zumbis", h.relocations >= 5, `${h.relocations}`);
		// L4: the rewind of a shot at the old drawing finds no past for the moved body (it is judged where it is now)
		check(
			"(h) clean: um zumbi realocado perde o historico de rebobinagem do tiro (combat.history)",
			h.historyKept === 0,
			`${h.historyKept} de ${h.relocations} ainda com historico`,
		);
		// a new body fades in wherever the ring puts it, as always (the waves' pacing depends on the ring); a MOVED one is a
		// body the player already saw, and lands off the screen
		const pct = (100 * h.relocInView) / Math.max(1, h.relocLanded);
		check(
			`(h) clean: um zumbi realocado quase nunca cai na tela 1920x1080 (<= ${SPAWN_IN_VIEW_MAX_PCT} %)`,
			pct <= SPAWN_IN_VIEW_MAX_PCT,
			`${h.relocInView} de ${h.relocLanded}, ${pct.toFixed(1)} %; corpos novos na tela: ${h.spawnsInView} de ${h.spawns}`,
		);
	}
}

console.log("");
if (REPORT_ONLY) {
	console.log("(--report: so os numeros)");
} else if (failures > 0) {
	console.error(`${failures} verificacao(oes) falharam`);
	process.exit(1);
} else {
	console.log("OK: a horda chega na tela sem congelar, sem voltar, sem tranco a mais que o servidor e sem tremer");
}
