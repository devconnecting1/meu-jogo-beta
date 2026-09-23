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
 * keeping its distance and rushing, plus a walker knocked back twice. Each on three links:
 *
 *   clean   60 Hz heartbeat and 60 fps apart, 80 ms RTT;
 *   wan     the same with 140 ms RTT, 15 ms jitter and 2 % loss;
 *   studio  server and client in ONE process sharing irregular frames, as the owner's [PZ-NET] log showed them.
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
const { SnapshotBuffer } = require(join(SRC, "client/net/snapshotBuffer.ts"));
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
/** zombies walk slower than a survivor (90 u/s against 210): their meter judges from this speed up */
const ZOMBIE_MOVING_UPS = HM.ZOMBIE_MOVING_UPS ?? 40;
/**
 * A frame this long is the machine hitching: in one process the server stood still for it too, and for a few
 * frames after it the server is paying back its debt (§3.1) while the client has nothing newer to draw. The jolt
 * comparison is not judged in that shadow -- for the drawing and the ideal alike -- and is reported apart.
 */
const HITCH_S = 0.1;
const HITCH_SHADOW_S = 0.15;

// ---------------------------------------------------------------- the link (as in tools/test-predict.mjs)

class Link {
	constructor(opts) {
		this.oneWay = opts.oneWay;
		this.jitter = opts.jitter ?? 0;
		this.loss = opts.loss ?? 0;
		this.random = opts.random;
		this.queue = [];
	}
	send(now, payload) {
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

	const world = W.createWorld(6000, 6000);
	const sim = new ServerSimulation({ world, zombies: true, interactive: false });
	const horde = sim.horde;
	horde.clock.setClock(12, 5);
	horde.clock.isRaining = false;
	// the ambient population would wander into the measurement: the scenario places every body itself
	horde.population.update = () => {};

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

	const sx = 3000;
	const sy = 3000;
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
	const sent = new Map(); // netId -> ascending ticks carried by a snapshot
	const tickWall = []; // tick -> wall-clock time it was simulated
	let serverWall = T0;
	sim.onTick = tick => {
		tickWall[tick] = serverWall;
		for (const z of watched) {
			const id = horde.netIdOf(z);
			if (!(id > 0)) continue;
			let m = truth.get(id);
			if (m === undefined) {
				m = new Map();
				truth.set(id, m);
			}
			m.set(tick, { x: z.x, y: z.y, a: z.angleSlow });
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
	cam.setView(scn.viewW ?? 1360, scn.viewH ?? 600);
	cam.x = sx;
	cam.y = sy;
	/** the same view locked on the survivor, against which the eased camera is judged (hypothesis 4) */
	const locked = new Camera();
	locked.setView(cam.viewW, cam.viewH);

	const down = new Link({ oneWay: prof.oneWay, jitter: prof.jitter, loss: prof.loss, random });
	const up = new Link({ oneWay: prof.oneWay, jitter: prof.jitter, loss: prof.loss, random: randomUp });
	const rel = new Reliable(prof.oneWay);

	// ---- the timeline: server heartbeats and client frames in wall-clock order
	const dts = prof.shared
		? studioFrames(scn.seconds + 1, randomFrames)
		: new Array(Math.ceil((scn.seconds + 1) * 60)).fill(1 / 60);
	const events = [];
	{
		let t = T0;
		for (const dt of dts) {
			t += dt;
			events.push({ at: t, kind: "server", dt });
		}
		// in one process the client's frame follows the server's step of the same frame; apart, the client is a
		// third of a frame out of phase so the two clocks are not in lock-step
		t = T0 + (prof.shared ? 1e-6 : 0.37 / 60);
		for (const dt of dts) {
			t += dt;
			events.push({ at: t, kind: "client", dt });
		}
		events.sort((a, b) => a.at - b.at || (a.kind === "server" ? -1 : 1));
	}

	const rec = new Map(); // netId -> per-frame records
	/** client time of the last frame long enough to be the machine hitching (the whole screen stood still) */
	let hitchAt = -Infinity;
	const lag = [];
	const delays = [];
	const rates = [];
	let lastRender;
	const endWall = T0 + scn.seconds;

	for (const ev of events) {
		if (ev.at > endWall) break;
		if (ev.kind === "server") {
			serverWall = ev.at;
			for (const payload of up.poll(ev.at)) PL.ingestInput(sp, payload, ev.at);
			if (scn.event !== undefined) scn.event(ev.at - T0, { watched, sx, sy });
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
			for (const e of batch.events) if (e.t === P.WorldEv.ZombieDied) cl.snapshots.forgetZombie(e.netId);
		}
		for (const payload of down.poll(now)) {
			const part = P.decodeSnapshotPart(payload);
			if (part !== undefined) cl.queue.push(part);
		}
		const serverNow = now + (prof.clockNoise > 0 ? (random() - 0.5) * 2 * prof.clockNoise : 0);
		const tick = cl.clock.update(dt, serverNow);
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
		// hypothesis 1: how fast the render clock runs against real time (1 = exactly real time)
		if (lastRender !== undefined && dt > 0) rates.push((render - lastRender) / (dt * SIM_HZ));
		lastRender = render;
		// how old the drawing is in wall-clock time: the "laggy" half of the complaint
		const rt = Math.floor(render);
		const w0 = tickWall[rt];
		const w1 = tickWall[rt + 1];
		if (w0 !== undefined && w1 !== undefined) lag.push(now - (w0 + (w1 - w0) * (render - rt)));
		else lag.push(NaN); // the render time is past anything the server has simulated
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
		delays,
		rates,
		dropped: sim.stats.droppedTicks,
		fps: dts.length / dts.reduce((a, b) => a + b, 0),
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
			`relogio de render ${f2(s.rateMin)}x-${f2(s.rateMax)}x | ticks perdidos ${res.dropped} | fps ${res.fps.toFixed(0)}`,
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
for (const key of Object.keys(SCENARIOS)) {
	const scn = SCENARIOS[key];
	console.log("\n" + scn.title);
	results[key] = {};
	for (const prof of Object.keys(PROFILES)) {
		const res = run(scn, prof);
		const s = summarize(res);
		results[key][prof] = s;
		printRow(prof, s, res);
	}
}

// ---------------------------------------------------------------- the verdict

console.log("\nveredito");

console.log(" o desenho (o cliente contra o cliente perfeito, em todo cenario e link)");
for (const key of Object.keys(results)) {
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
{
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
{
	const st = results.a.studio;
	check(
		"(a) studio: o desenho tem no maximo 170 ms (p95) e nunca passa do servidor",
		st.lagP95 <= 0.17 && st.lagPast === 0,
		`p95 ${(st.lagP95 * 1000).toFixed(0)} ms, alem do servidor ${st.lagPast}`,
	);
	const cl = results.a.clean;
	check("(a) clean: atraso real medio <= 150 ms", cl.lagMean <= 0.15, `${(cl.lagMean * 1000).toFixed(0)} ms`);
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
