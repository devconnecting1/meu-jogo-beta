#!/usr/bin/env node
/*
 * No menu pauses the world (docs/DESIGN_RULES.md UI-06), proven end to end under Node.
 *
 *   npm run test:menus                    # everything (exit code 1 on any failure)
 *   node tools/test-menus.mjs --seed 7    # another seed for the spawn point and the horde's dice (default 1)
 *   PZ_SRC=path/to/src node tools/test-menus.mjs
 *
 * The playtest: the Bag open for ~40 s next to 7–8 zombies, and the survivor went from 100 to 35 HP. The world is
 * the server's (MP_PHASE 2, shared/net/mpConfig.ts) and the client only PRETENDED to pause: main.client.ts skipped
 * `loop.update(dt)` while the Bag or the menu was open, and GameLoop.update began with `if (p.dead) return;`.
 * Neither stops a server. A client that stops sending leaves the server's input queue dry, and a dry queue WAITS
 * with the survivor standing still and vulnerable (server/sim/players.ts, "Empty queue") -- so the zombies kept
 * biting a player who had been told the game was paused.
 *
 * UI-06 turns the accident into the rule: no screen pauses the world, and what a screen stops is the SURVIVOR. Held
 * (InputState.setHeld), they send the honest standing command with empty hands at 60 Hz, and the screen flashes
 * when a hit lands (client/ui/hitAlarm.ts). This file runs the real pieces of both halves:
 *
 *   1. THE CLIENT SENDS HONEST COMMANDS   the real InputState with setHeld(true) every frame (as main.client.ts
 *                                         does), the real readRawInput (client/net/localInput.ts, over a stand-in
 *                                         for bootstrap's syncKeyboardMove) and the real CommandStream (client/net/
 *                                         commands.ts), fed the way netClient's predict() feeds them. W and the
 *                                         attack button held, E, R and the 1 key pressed, 40 s at 60 fps: every
 *                                         command stands still with empty hands and no edge, and they keep going
 *                                         out at ~60 Hz. Control: the same hands with setHeld(false) walk and
 *                                         attack. Then the Bag closes with W and the button still down (on a quiet
 *                                         street, so the survivor is alive to do it): the first frame walks, and
 *                                         the attack stays blocked -- no Attack bit, no swing on the server -- until
 *                                         the button is let go; the next click attacks again.
 *   2. THE SERVER KEEPS THE WORLD GOING   those very packets, through ingestInput and the §2.2 queue, into
 *                                         `new ServerSimulation({ world })` (as server/net/mpHost.ts builds it) with
 *                                         the real Replicator, 7 walkers 150–300 u away in daylight (placed once the
 *                                         3 s spawn protection has run out), 40 s of ticks: the clock advances what
 *                                         shared/sim/clock.ts says it must, the zombies close in and bite, HP falls
 *                                         at least as far as the playtest's -- in this street it kills, ~20 s in --
 *                                         and the survivor neither walks nor swings.
 *   3. THE OLD "PAUSE" NEVER EXISTED      the same street with NO command at all (what the client used to do with
 *                                         the Bag open): the server stands the survivor still and the bites land
 *                                         the same.
 *   4. THE WARNING                        HitAlarm over section 2's HP, per 60 Hz frame and per 20 Hz self block (the
 *                                         snapshot cadence): it flashes for every bite, never more than 3 times in
 *                                         any second (WCAG 2.3.1), and stays dark for the slow drains of the real
 *                                         stepPlayer, for a hit taken before the Bag opened and for a hit the
 *                                         armour absorbed whole.
 *   5. SOURCE GUARDS                      main.client.ts calls setHeld, has no `simulate`, and calls loop.update(dt)
 *                                         unconditionally in the run's Heartbeat; GameLoop.update never returns
 *                                         early (no more `if (p.dead) return`); netClient.ts predict() sends the
 *                                         very edges the copy below sends (a blocked button's release is none).
 *   6. NO SAVE BUTTON (SAV-01)            the in-run menu's rows are Back to game, Shop, Settings and Home: saving is
 *                                         automatic, so no handler, no "manual" report reason, no Save row.
 *
 * `netClient.ts` itself cannot load under Node (it talks to Roblox services), so its predict() -- four lines:
 * addEdges, readRawInput, sample, and the send -- is reproduced below; every module it calls is the real one.
 *
 * Pure Node (>= 18) + the project's TypeScript on the shared shims of tools/luau-shim.mjs. Deterministic: the
 * horde's dice are the seeded `math.random` of the shims, reseeded identically for sections 2 and 3, so the two
 * runs share the same street, the same spawn point and the same walkers.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { installShims } from "./luau-shim.mjs";

const args = process.argv.slice(2);
const argValue = (name, fallback) => {
	const i = args.indexOf(name);
	return i >= 0 && args[i + 1] !== undefined ? Number(args[i + 1]) : fallback;
};
const SEED = argValue("--seed", 1);

const { SRC, require, setSeed } = installShims({ seed: SEED });
const Module = require("node:module");
const ts = require("typescript");

// roblox-ts `array.insert(i, v)` (shared/sim/ai/alert.ts); the shared shims do not carry it
Object.defineProperty(Array.prototype, "insert", {
	value: function (i, v) {
		this.splice(i, 0, v);
	},
	configurable: true,
	writable: true,
});

// ---------------------------------------------------------------- the stand-in for client/bootstrap.ts

/**
 * client/net/localInput.ts imports `syncKeyboardMove` from ../bootstrap, and bootstrap builds the whole client
 * (Instances, services) when it loads. So a module is planted in the require cache under bootstrap's own path
 * BEFORE localInput.ts is loaded, carrying `syncKeyboardMove` line for line (client/bootstrap.ts), over the very
 * InputState the scene is driving (`liveInput`). There is no pad and no touch stick here, so its two extra
 * "is something else moving the survivor" flags are both false.
 */
let liveInput;
let syncCalls = 0;
{
	const path = join(SRC, "client", "bootstrap.ts");
	const fake = new Module(path);
	fake.filename = path;
	fake.loaded = true;
	fake.exports = {
		syncKeyboardMove() {
			syncCalls += 1;
			const input = liveInput;
			if (input.keyW || input.keyA || input.keyS || input.keyD) {
				let dx = 0;
				let dy = 0;
				if (input.keyD) dx += 1;
				if (input.keyA) dx -= 1;
				if (input.keyS) dy += 1;
				if (input.keyW) dy -= 1;
				const l = Math.sqrt(dx * dx + dy * dy);
				if (l > 0) {
					input.moveX = dx / l;
					input.moveY = dy / l;
					input.moveMagnitude = 1;
				}
			} else if (!input.joystickActive) {
				input.moveX = 0;
				input.moveY = 0;
				input.moveMagnitude = 0;
			}
		},
	};
	Module._cache[path] = fake;
}

// ---------------------------------------------------------------- the modules under test

const { DESIGN } = require(join(SRC, "shared/engine/constants.ts"));
const { InputState } = require(join(SRC, "shared/engine/input.ts"));
const { Camera } = require(join(SRC, "shared/engine/camera.ts"));
const { CommandStream } = require(join(SRC, "client/net/commands.ts"));
const { readRawInput, createRawInput } = require(join(SRC, "client/net/localInput.ts"));
const { HitAlarm, HIT_ALARM } = require(join(SRC, "client/ui/hitAlarm.ts"));
const { generateTown, buildingAt } = require(join(SRC, "shared/game/world.ts"));
const { circleBlocked, PLAYER_RADIUS } = require(join(SRC, "shared/game/physics.ts"));
const { defaultSave } = require(join(SRC, "shared/game/save.ts"));
const { applyPlayerDamage, createPlayer, playerEquipDefence } = require(join(SRC, "shared/game/player.ts"));
const { createZombie, resetEntityIds, zombieRadius } = require(join(SRC, "shared/game/entities.ts"));
const { EQUIPS } = require(join(SRC, "shared/data/equips.ts"));
const { stepPlayer } = require(join(SRC, "shared/sim/playerMove.ts"));
const CLOCK = require(join(SRC, "shared/sim/clock.ts"));
const CFG = require(join(SRC, "shared/net/mpConfig.ts"));
const P = require(join(SRC, "shared/net/protocol.ts"));
const { quantAngle16, wrapU16 } = require(join(SRC, "shared/net/codec.ts"));
const PL = require(join(SRC, "server/sim/players.ts"));
const { ServerSimulation } = require(join(SRC, "server/sim/simulation.ts"));
const { Replicator, mapHashOf } = require(join(SRC, "server/net/replication.ts"));

const TICK_DT = 1 / CFG.SIM_HZ;
/** the playtest: ~40 s with the Bag open */
const BAG_SECONDS = 40;
const BAG_FRAMES = Math.round(BAG_SECONDS * CFG.SIM_HZ);
/** after the Bag closes: W and the button still down this long, then the button is let go, then clicked again */
const CLOSE_HOLD = 30;
const CLOSE_CLICK = 40;
const CLOSE_FRAMES = 70;
/** daylight, like the playtest (and away from 07:00, whose "Good morning" makes the horde forget its trail) */
const START_DAY = 1;
const START_HOUR = 10;
/** the playtest had 7–8 zombies around; 7 walkers, 150–300 u out (with 8 the story is the same: i-frames rule) */
const WALKERS = 7;
const RING_MIN = 150;
const RING_MAX = 300;
/** HP the playtest's survivor lost with the Bag open (100 → 35) */
const PLAYTEST_LOSS = 65;
/** where the survivor is looking when they open the Bag; the aim must stay there (localInput.ts) */
const AIM = 1.1;
/** what the client's interpolation draws behind the server (§5.1), for the view tick of its packets */
const VIEW_LAG_TICKS = Math.round(CFG.INTERP_DEFAULT_S * CFG.SIM_HZ);

// ---------------------------------------------------------------- reporting

let failures = 0;
function check(name, ok, detail) {
	const tail = detail === undefined ? "" : `  (${detail})`;
	if (ok) {
		console.log(`  ok    ${name}${tail}`);
	} else {
		console.error(`  FAIL  ${name}${tail}`);
		failures += 1;
	}
	return ok;
}
const info = msg => console.log(`        ${msg}`);
const section = title => console.log(`\n${title}`);

const f1 = v => v.toFixed(1);
const clockText = h => {
	const hh = Math.floor(h);
	const mm = Math.floor((h - hh) * 60);
	const ss = Math.round(((h - hh) * 60 - mm) * 60);
	return `${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}:${String(ss).padStart(2, "0")}`;
};
const mean = a => (a.length > 0 ? a.reduce((s, v) => s + v, 0) / a.length : NaN);
const has = (held, bit) => (held & bit) !== 0;
const edges = (cmd, shift) => P.edgeCount(cmd.edges, shift);

// ---------------------------------------------------------------- the player's hands (client/bootstrap.ts wiring)

/** what InputBegan / InputEnded do in client/bootstrap.ts for the handful of inputs this file plays */
const hands = {
	/** MouseButton1 down: addAttackSource → pressAttack */
	mouseDown(input) {
		input.attackPressed = true;
		input.attackHeld = true;
	},
	/** MouseButton1 up: removeAttackSource → releaseAttack */
	mouseUp(input) {
		input.attackReleased = true;
		input.attackHeld = false;
	},
	keyDown(input, key) {
		if (key === "W") input.keyW = true;
		else if (key === "E") {
			input.keyE = true;
			input.actionPressed = true;
		} else if (key === "R") {
			input.keyR = true;
			input.reloadPressed = true;
		} else if (key === "1") input.weaponSlotPressed = 0;
	},
	keyUp(input, key) {
		if (key === "W") input.keyW = false;
		else if (key === "E") input.keyE = false;
		else if (key === "R") input.keyR = false;
	},
};

/**
 * The hands of the playtest, frame by frame: W and the attack button down from the first frame (the survivor was
 * walking and swinging when they opened the Bag) and kept down, E every 0.75 s, R every second, the 1 key every
 * 1.33 s, and every 2.5 s a click (button up, and down again 4 frames later) -- presses a player really makes
 * while their eyes are on the Bag, and every one of them belongs to the Bag.
 */
function playtestHands(f) {
	return input => {
		if (f === 0) {
			hands.keyDown(input, "W");
			hands.mouseDown(input);
		}
		if (f % 45 === 10) hands.keyDown(input, "E");
		if (f % 45 === 16) hands.keyUp(input, "E");
		if (f % 60 === 25) hands.keyDown(input, "R");
		if (f % 60 === 29) hands.keyUp(input, "R");
		if (f % 80 === 40) hands.keyDown(input, "1");
		if (f % 150 === 100) hands.mouseUp(input);
		if (f % 150 === 104) hands.mouseDown(input);
	};
}

// ---------------------------------------------------------------- the client (main.client.ts + netClient.ts)

/**
 * One survivor's client: the real InputState, Camera, CommandStream and readRawInput, stepped the way one
 * Heartbeat of main.client.ts's `mountRun` steps them -- input events land, `input.setHeld(held)`, then
 * `loop.update(dt)`, whose netUpdate reconciles the self blocks that arrived (ack + bufDepth), predicts (the four
 * lines of netClient.ts `predict`) and sends, and whose last line is `input.beginFrame()`.
 */
class Client {
	constructor() {
		this.input = new InputState();
		this.input.aimAngle = AIM;
		this.cam = new Camera();
		this.commands = new CommandStream();
		this.commands.reset(0);
		this.raw = createRawInput();
		/** self blocks delivered since the last frame (netClient's `queue`) */
		this.inbox = [];
		this.now = 0;
	}

	frame(dt, held, events, viewTick) {
		const input = this.input;
		liveInput = input;
		if (events !== undefined) events(input);
		// main.client.ts, mountRun's Heartbeat: before the loop runs
		input.setHeld(held);
		// what the loop sees this frame, once the screen has taken its share of the presses
		const seen = {
			held: input.held,
			attackHeld: input.attackHeld,
			attackBlocked: input.attackBlocked,
			attackPressed: input.attackPressed,
			attackReleased: input.attackReleased,
			actionPressed: input.actionPressed,
			reloadPressed: input.reloadPressed,
			weaponSlotPressed: input.weaponSlotPressed,
			keyE: input.keyE,
		};
		// netUpdate step 3 (reconcile): the ack goes BEFORE the replay, and the queue depth steers the dilation
		for (const self of this.inbox) {
			this.commands.ack(self.ackSeq);
			this.commands.noteBufDepth(self.bufDepth);
		}
		this.inbox.length = 0;
		// netUpdate step 4 (predict), as netClient.ts writes it
		this.commands.addEdges(
			input.attackPressed,
			input.attackReleased && !input.attackBlocked,
			input.actionPressed,
			input.reloadPressed,
			input.actionGlass,
		);
		readRawInput(this.cam, input, false, this.raw);
		const cmds = [];
		this.commands.sample(dt, this.raw, cmds);
		// netUpdate step 6 (send), as netClient.ts writes it since ff523ca: one packet per NEW command (the
		// command and the two before it), each through the local token bucket -- so a frame that built no command
		// sends nothing, and a long frame sends several
		const packets = [];
		this.commands.flush(wrapU16(Math.max(0, viewTick)), 0, this.now, packets);
		const payloads = packets.map(p => P.encodeInput(p)).filter(p => p !== undefined);
		// GameLoop.update's last line
		input.beginFrame();
		this.now += dt;
		return { seen, cmds, payloads, afterBlocked: input.attackBlocked };
	}
}

// ---------------------------------------------------------------- the server (server/net/mpHost.ts minus Roblox)

/** 8 walkers in a ring 150–300 u around (x, y), each on free ground outside every building */
function placeWalkers(sim, x, y) {
	const world = sim.world;
	const out = [];
	for (let i = 0; i < WALKERS; i++) {
		const r = RING_MIN + ((RING_MAX - RING_MIN) * i) / (WALKERS - 1);
		const base = (i / WALKERS) * Math.PI * 2;
		let spot;
		for (let k = 0; k < 72 && spot === undefined; k++) {
			const a = base + k * (Math.PI / 36);
			const zx = x + Math.cos(a) * r;
			const zy = y + Math.sin(a) * r;
			if (buildingAt(world, zx, zy) !== undefined) continue;
			if (circleBlocked(world, zx, zy, 24) !== undefined) continue;
			spot = { x: zx, y: zy };
		}
		if (spot === undefined) throw new Error(`no free ground for walker ${i} at ${r} u`);
		const z = createZombie(1, spot.x, spot.y, sim.clock.day, false);
		sim.horde.zombies.push(z);
		out.push(z);
	}
	return out;
}

/**
 * The street of the playtest, as mpHost builds a server: the generated town, `new ServerSimulation({ world })`,
 * the real Replicator on `onTick`/`onFx`, one survivor admitted at a safe spawn point (§7.1) and welcomed, then the
 * walkers around them in daylight. Every call reseeds the dice and the entity ids the same way, so two sessions
 * are the same street until their inputs differ.
 */
function newStreet(walkers = true) {
	resetEntityIds();
	setSeed((SEED * 7919 + 13) >>> 0);
	const world = generateTown(DESIGN.TOWN_SEED);
	const sim = new ServerSimulation({ world });
	if (sim.horde === undefined) return { sim };
	sim.clock.setClock(START_HOUR, START_DAY);
	const street = { world, sim, selfBlocks: [], inbox: undefined, deaths: 0, bites: [] };
	const replicator = new Replicator(
		sim,
		{
			snap(slot, part) {
				const decoded = P.decodeSnapshotPart(part);
				if (decoded === undefined || decoded.self === undefined) return;
				const self = decoded.self;
				street.selfBlocks.push({ tick: sim.tick, hp: self.hp, ackSeq: self.ackSeq, bufDepth: self.bufDepth });
				if (street.inbox !== undefined) street.inbox.push(self);
			},
			fx() {},
			world() {},
			worldAll() {},
		},
		{ tick0Time: 0, mapHash: mapHashOf(world) },
	);
	sim.onTick = t => replicator.afterTick(t);
	sim.onFx = event => replicator.queueFx(event);
	sim.onDeath = sp => {
		street.deaths += 1;
		replicator.life(sp.slot, P.LifeState.Dead);
	};
	const slot = sim.freeSlot();
	const spawn = PL.findSpawnPoint(world, { allies: [], zombies: sim.horde.zombies });
	const sp = PL.createServerPlayer(
		{ slot, userId: 1000 + slot, name: "survivor" },
		defaultSave(),
		spawn.x,
		spawn.y,
		sim.tick,
	);
	sim.add(sp);
	replicator.welcome(sp);
	// the playtest's survivor was well into a run: the 3 s spawn protection (§7.1) runs out before anyone comes
	const settle = Math.ceil((PL.SPAWN_SHIELD_S + 0.5) * sim.simHz);
	for (let i = 0; i < settle; i++) sim.step();
	street.selfBlocks.length = 0;
	street.sp = sp;
	street.walkers = walkers ? placeWalkers(sim, sp.state.x, sp.state.y) : [];
	// every landed hit, as the horde's damage sink reports it (observation only: the sink still decides)
	const sink = sim.horde.refs.damagePlayer;
	sim.horde.refs.damagePlayer = (p, save, raw, bypass) => {
		const before = p.hp;
		const landed = sink(p, save, raw, bypass);
		if (landed) street.bites.push({ tick: sim.tick, raw, dealt: before - p.hp });
		return landed;
	};
	return street;
}

const distTo = (z, p) => Math.hypot(z.x - p.x, z.y - p.y);
/** a walker close enough to bite: bodies touching, plus the bite's own reach */
const biteReach = z => zombieRadius(z) + PLAYER_RADIUS + 16;

/**
 * One session on a street: `frames` frames, each one client Heartbeat (when there is a client) followed by one
 * server tick, over a lossless link -- a packet sent in a frame is in the queue before the next tick, a snapshot is
 * on the client before its next frame. `bagOpen(f)` says whether the Bag is open on frame f, `handsAt(f)` what the
 * player's hands do just before it. Everything the checks need is recorded on the way, and `atEnd` is the world
 * at the last tick.
 */
function runSession({ withClient, walkers = true, frames: total, bagOpen, handsAt }) {
	const street = newStreet(walkers);
	const { sim, sp } = street;
	const client = withClient ? new Client() : undefined;
	street.inbox = client?.inbox;
	const p = sp.state;
	const run = {
		street,
		frames: [],
		ticks: [],
		verdicts: [],
		startHp: p.hp,
		startTick: sim.tick,
		startClock: { day: sim.clock.day, dayTime: sim.clock.dayTime },
		startPos: { x: p.x, y: p.y },
		startDist: street.walkers.map(z => distTo(z, p)),
		minDist: street.walkers.map(z => distTo(z, p)),
		reached: street.walkers.map(() => false),
		deathTick: undefined,
	};
	let now = 0;
	for (let f = 0; f < total; f++) {
		const bag = bagOpen(f);
		if (client !== undefined) {
			// main.client.ts: `held = menuOpen || !alive`
			const out = client.frame(TICK_DT, bag || p.dead, handsAt(f), sim.tick - VIEW_LAG_TICKS);
			run.frames.push({ f, bag, ...out });
			for (const payload of out.payloads) run.verdicts.push(PL.ingestInput(sp, payload, now));
		}
		const x0 = p.x;
		const y0 = p.y;
		const knock0 = p.reactionSpeed;
		const filled0 = sp.counters.filled;
		const consumed0 = sp.counters.consumed;
		sim.step();
		now += TICK_DT;
		const cmd = sp.lastCmd;
		if (p.dead && run.deathTick === undefined) run.deathTick = sim.tick;
		run.ticks.push({
			tick: sim.tick,
			f,
			bag,
			hp: p.hp,
			dead: p.dead,
			moved: Math.hypot(p.x - x0, p.y - y0),
			knock0,
			walking: sp.walking,
			swinging: p.swingerActive === true,
			real: sp.counters.consumed > consumed0,
			fill: sp.counters.filled > filled0,
			seq: cmd.seq,
			moveMag: cmd.moveMag,
			held: cmd.held,
			edges: cmd.edges,
		});
		street.walkers.forEach((z, i) => {
			if (z.hp <= 0) return;
			const d = distTo(z, p);
			run.minDist[i] = Math.min(run.minDist[i], d);
			if (d <= biteReach(z)) run.reached[i] = true;
		});
	}
	run.atEnd = snapshotOf(sim, sp, run);
	return run;
}

/** the survivor and the world right now */
function snapshotOf(sim, sp, run) {
	const p = sp.state;
	const stats = sim.combat.statsOf(sp.slot);
	return {
		tick: sim.tick,
		hp: p.hp,
		dead: p.dead,
		clock: { day: sim.clock.day, dayTime: sim.clock.dayTime },
		pos: { x: p.x, y: p.y },
		dist: run.street.walkers.map(z => distTo(z, p)),
		alive: run.street.walkers.filter(z => z.hp > 0).length,
		stats: { ...stats },
		counters: { ...sp.counters },
		bites: run.street.bites.length,
		selfBlocks: run.street.selfBlocks.length,
	};
}

const started = Date.now();

// ================================================================ 0: the chain under test

section("0) the chain under test");

const probe = new ServerSimulation({ world: generateTown(DESIGN.TOWN_SEED) });
if (
	!check(
		"MP_PHASE ≥ 2: `new ServerSimulation({ world })` owns the horde, the clock and the damage",
		CFG.MP_PHASE >= 2 && probe.horde !== undefined && probe.combat !== undefined,
		`MP_PHASE = ${CFG.MP_PHASE}`,
	)
) {
	console.error("\nno server horde: a menu over a client-owned world is another test");
	process.exit(1);
}
info(
	`a bite is ${createZombie(1, 0, 0, START_DAY).damage} before armour, the i-frames last ${f1(DESIGN.IFRAMES)} s, ` +
		`a fed survivor regenerates 1.2 HP/s (shared/sim/playerMove.ts)`,
);

/** the playtest: the Bag open for 40 s among the walkers, with the hands of `playtestHands` */
const bagRun = runSession({ withClient: true, frames: BAG_FRAMES, bagOpen: () => true, handsAt: playtestHands });
/** the old client on the same street: the Bag open and not a single packet */
const oldRun = runSession({ withClient: false, frames: BAG_FRAMES, bagOpen: () => true, handsAt: () => undefined });
/**
 * Closing the Bag, on the same street without the walkers (the survivor has to be alive to walk away): open for
 * BRIEF frames with W and the button down, closed with both still down, the button let go CLOSE_HOLD frames
 * later and clicked again at CLOSE_CLICK.
 */
const BRIEF = 60;
const closeRun = runSession({
	withClient: true,
	walkers: false,
	frames: BRIEF + CLOSE_FRAMES,
	bagOpen: f => f < BRIEF,
	handsAt: f => input => {
		if (f === 0) {
			hands.keyDown(input, "W");
			hands.mouseDown(input);
		}
		if (f === BRIEF + CLOSE_HOLD) hands.mouseUp(input);
		if (f === BRIEF + CLOSE_CLICK) hands.mouseDown(input);
	},
});
const secondsAt = (run, tick) => (tick - run.startTick) * TICK_DT;

// ================================================================ 1: the client

section("1) with the Bag open the client sends honest commands: standing, empty hands, 60 Hz (UI-06)");
{
	const frames = bagRun.frames;
	const cmds = frames.flatMap(fr => fr.cmds);
	check(
		"the harness drives the REAL localInput.ts through the stand-in bootstrap",
		syncCalls >= frames.length,
		`syncKeyboardMove ran ${syncCalls} times`,
	);
	// what the scripted hands pressed during the 40 s
	const presses = { E: 0, R: 0, key1: 0, click: 0, release: 0 };
	for (let f = 0; f < BAG_FRAMES; f++) {
		if (f % 45 === 10) presses.E += 1;
		if (f % 60 === 25) presses.R += 1;
		if (f % 80 === 40) presses.key1 += 1;
		if (f === 0 || f % 150 === 104) presses.click += 1;
		if (f % 150 === 100) presses.release += 1;
	}
	info(
		`the hands: W and the button down all along, ${presses.E} E, ${presses.R} R, ${presses.key1} "1", ` +
			`${presses.click} clicks and ${presses.release} releases, over ${BAG_FRAMES} frames at 60 fps`,
	);
	if (bagRun.deathTick !== undefined) {
		info(
			`the survivor died inside the Bag at ${f1(secondsAt(bagRun, bagRun.deathTick))} s (section 2); from there ` +
				"they are held by death too (main.client.ts: held = menuOpen || !alive), and the commands keep flowing",
		);
	}
	const leaked = frames.filter(
		fr =>
			fr.seen.attackPressed ||
			fr.seen.attackReleased ||
			fr.seen.actionPressed ||
			fr.seen.reloadPressed ||
			fr.seen.weaponSlotPressed !== -1,
	);
	check(
		"setHeld(true) takes every press made inside the Bag: no click, release, E, R or weapon key reaches the loop",
		leaked.length === 0,
		`${leaked.length} frame(s) leaked a press`,
	);
	const unblocked = frames.filter(fr => fr.seen.attackHeld && !fr.seen.attackBlocked);
	check(
		"a button held inside the Bag is BLOCKED on every frame it is down",
		unblocked.length === 0,
		`${unblocked.length} frame(s) with the button down and not blocked`,
	);
	const walking = cmds.filter(c => c.moveMag !== 0);
	const holding = cmds.filter(c => c.held !== 0);
	const edged = cmds.filter(c => c.edges !== 0);
	check(
		"every command stands still: moveMag 0, with W down for all 40 s",
		cmds.length > 0 && walking.length === 0,
		`${walking.length} of ${cmds.length} commands move`,
	);
	check(
		"...with empty hands: held 0 (no Attack, no Action) while the button and E are down",
		holding.length === 0,
		`${holding.length} of ${cmds.length} commands hold something`,
	);
	check("...and no edge at all: no attack press or release, no action press, no reload", edged.length === 0);
	const aim = P.makeCommand(0, 0, 0, AIM, 0, 0).aim;
	check(
		"the aim stays where the survivor was looking when the Bag opened",
		cmds.every(c => c.aim === aim),
		`aim ${AIM} rad → u16 ${aim} = ${quantAngle16(AIM)}`,
	);
	const hz = cmds.length / BAG_SECONDS;
	check(
		"the commands keep going out at ~60 Hz (58.8–61.2 Hz, the ±2% dilation): the server is never starved",
		hz >= CFG.INPUT_HZ * (1 - CFG.INPUT_DILATION) && hz <= CFG.INPUT_HZ * (1 + CFG.INPUT_DILATION),
		`${cmds.length} commands in ${BAG_SECONDS} s = ${hz.toFixed(2)} Hz`,
	);
	let gaps = 0;
	for (let i = 1; i < cmds.length; i++) if (cmds[i].seq !== wrapU16(cmds[i - 1].seq + 1)) gaps += 1;
	// since ff523ca the client sends one packet per NEW command, not one per frame: with the ±2% dilation a
	// frame now and then builds no command and rightly sends nothing, and its neighbour builds two. What must
	// hold is that no command is ever built and left unsent.
	const unsent = frames.filter(fr => fr.cmds.length > 0 && fr.payloads.length === 0).length;
	const sentPackets = frames.reduce((a, fr) => a + fr.payloads.length, 0);
	check(
		"one packet per command, consecutive seqs: every command built goes out",
		gaps === 0 && unsent === 0 && sentPackets === cmds.length,
		`${sentPackets} packets for ${cmds.length} commands, ${unsent} frame(s) that built a command and sent nothing, ${gaps} seq gap(s)`,
	);
}
{
	// control: the same hands with nothing open
	const client = new Client();
	const frames = [];
	for (let f = 0; f < 120; f++) frames.push(client.frame(TICK_DT, false, playtestHands(f), 0));
	const cmds = frames.flatMap(fr => fr.cmds);
	const up = P.makeCommand(0, 0, -1, 0, 0, 0).moveAng;
	check(
		"control, setHeld(false), the same hands: every command walks where W points",
		cmds.length === 120 && cmds.every(c => c.moveMag > 0 && c.moveAng === up),
		`${cmds.filter(c => c.moveMag > 0).length} of ${cmds.length} walk`,
	);
	const attackFrames = frames.filter(fr => fr.seen.attackHeld).length;
	const attackCmds = cmds.filter(c => has(c.held, P.HeldBit.Attack)).length;
	const actionCmds = cmds.filter(c => has(c.held, P.HeldBit.Action)).length;
	check(
		"...the button down is the Attack bit, E down the Action bit",
		attackCmds === attackFrames && attackCmds > 100 && actionCmds === frames.filter(fr => fr.seen.keyE).length,
		`Attack on ${attackCmds} commands (${attackFrames} frames down), Action on ${actionCmds}`,
	);
	const count = shift => cmds.reduce((s, c) => s + edges(c, shift), 0);
	check(
		"...and every press arrives as its edge: 2 clicks, 1 release, 3 E, 2 R (the mask, not the harness)",
		count(P.EdgeShift.AttackPress) === 2 &&
			count(P.EdgeShift.AttackRelease) === 1 &&
			count(P.EdgeShift.ActionPress) === 3 &&
			count(P.EdgeShift.Reload) === 2,
		`${count(P.EdgeShift.AttackPress)}/${count(P.EdgeShift.AttackRelease)}/${count(P.EdgeShift.ActionPress)}/` +
			`${count(P.EdgeShift.Reload)}`,
	);
	check(
		'...and the "1" reaches the loop as a weapon switch',
		frames.filter(fr => fr.seen.weaponSlotPressed === 0).length === 1,
	);
}
{
	// the Bag closes with W and the button still down (a quiet street: the survivor is alive)
	const run = closeRun;
	const inBag = run.frames.filter(fr => fr.bag).flatMap(fr => fr.cmds);
	check(
		`closing scene: ${BRIEF} frames in the Bag with W and the button down, standing with empty hands`,
		inBag.length > 0 && inBag.every(c => c.moveMag === 0 && c.held === 0 && c.edges === 0) && !run.atEnd.dead,
		`${inBag.length} commands`,
	);
	const after = run.frames.filter(fr => !fr.bag);
	const first = after[0];
	check(
		"the Bag closes with W still down: the very first frame walks",
		first !== undefined && first.cmds.length > 0 && first.cmds.every(c => c.moveMag > 0),
		first !== undefined
			? `${first.cmds.length} command(s), moveMag ${first.cmds.map(c => c.moveMag).join(",")}`
			: "",
	);
	const closeTick = run.ticks[BRIEF - 1].tick;
	const firstSeq = first?.cmds[0]?.seq;
	const walkTick = run.ticks.find(t => t.real && firstSeq !== undefined && t.seq === firstSeq);
	check(
		"...and the server walks the survivor on the tick that command is consumed",
		walkTick !== undefined && walkTick.walking,
		walkTick !== undefined ? `tick ${walkTick.tick}, ${walkTick.tick - closeTick} after the close` : "never",
	);
	const holdFrames = after.slice(0, CLOSE_HOLD + 1);
	check(
		"the button still down stays BLOCKED on every frame until it is let go",
		holdFrames.every(fr => fr.seen.attackBlocked) && after[CLOSE_HOLD + 1]?.seen.attackBlocked === false,
		`blocked on ${holdFrames.filter(fr => fr.seen.attackBlocked).length} of ${holdFrames.length} frames, ` +
			`then ${after[CLOSE_HOLD + 1]?.seen.attackBlocked}`,
	);
	const holdCmds = after.slice(0, CLOSE_HOLD).flatMap(fr => fr.cmds);
	const armed = holdCmds.filter(c => has(c.held, P.HeldBit.Attack));
	check(
		"...so no command sent while it is blocked carries the Attack bit (the server swings on that bit)",
		armed.length === 0,
		`${armed.length} of ${holdCmds.length} commands carry HeldBit.Attack` +
			(armed.length > 0 ? " -- client/net/localInput.ts reads attackHeld without attackBlocked" : ""),
	);
	const seqs = new Set(holdCmds.map(c => c.seq));
	const swung = run.ticks.filter(t => t.real && seqs.has(t.seq) && t.swinging);
	check(
		"...and the server starts no swing on the commands of those frames",
		swung.length === 0,
		`${swung.length} tick(s) swinging on them` +
			(swung.length > 0 ? `, from ${swung[0].tick - closeTick} tick(s) after the close` : ""),
	);
	const releaseEdges = after[CLOSE_HOLD].cmds.reduce((s, c) => s + edges(c, P.EdgeShift.AttackRelease), 0);
	check(
		"...and letting it go sends no AttackRelease edge (server/sim/combat.ts fires a bolt-action sniper on one)",
		releaseEdges === 0,
		`${releaseEdges} edge(s) on the frame the swallowed button is let go` +
			(releaseEdges > 0
				? " -- client/net/netClient.ts predict() sends attackReleased without attackBlocked"
				: ""),
	);
	const click = after[CLOSE_CLICK];
	const clickSeqs = new Set(after.slice(CLOSE_CLICK).flatMap(fr => fr.cmds.map(c => c.seq)));
	const swingAgain = run.ticks.find(t => t.real && clickSeqs.has(t.seq) && t.swinging);
	check(
		"once it was let go, the next click attacks: its edge and bit go out, and the server swings",
		!click.seen.attackBlocked &&
			click.cmds.some(c => edges(c, P.EdgeShift.AttackPress) > 0 && has(c.held, P.HeldBit.Attack)) &&
			swingAgain !== undefined,
		swingAgain !== undefined ? `swinging from tick ${swingAgain.tick - closeTick} after the close` : "no swing",
	);
}

// ================================================================ 2: the server

section("2) the server with those commands: the zombies, the clock and the damage go on (the playtest)");
{
	const { street, atEnd } = bagRun;
	const { sp } = street;
	const ticks = bagRun.ticks;
	const verdicts = bagRun.verdicts;
	check(
		"every packet the Bag's client sent was accepted (token bucket, decodeInput, §2.2 queue)",
		verdicts.length === bagRun.frames.reduce((a, fr) => a + fr.payloads.length, 0) &&
			verdicts.length > 0 &&
			verdicts.every(v => v === PL.InputVerdict.Ok),
		`${verdicts.filter(v => v === PL.InputVerdict.Ok).length} of ${verdicts.length} Ok, ` +
			`${atEnd.counters.malformed} malformed, ${atEnd.counters.rateDropped} rate-dropped`,
	);
	const fills = ticks.filter(t => t.fill).length;
	const real = ticks.filter(t => t.real);
	check(
		"the queue never ran dry: one of the client's own commands every tick, not a server fill",
		fills === 0 && real.length === ticks.length,
		`${real.length} consumed, ${fills} filled of ${ticks.length} ticks`,
	);
	const dishonest = real.filter(t => t.moveMag !== 0 || t.held !== 0 || t.edges !== 0);
	check(
		"...and every one the server simulated stood still with empty hands",
		dishonest.length === 0,
		`${dishonest.length} moved, held or pressed`,
	);
	const t0 = bagRun.startClock;
	const want = CLOCK.normalizeClock(t0.day, CLOCK.advanceClock(t0.dayTime, ticks.length * TICK_DT));
	const got = atEnd.clock;
	const gameMin = (CLOCK.advanceClock(t0.dayTime, ticks.length * TICK_DT) - t0.dayTime) * 60;
	check(
		`the world's clock ran the whole ${BAG_SECONDS} s: ${clockText(t0.dayTime)} → ${clockText(got.dayTime)}`,
		got.day === want.day && Math.abs(got.dayTime - want.dayTime) < 1e-6 && gameMin > 0,
		`+${gameMin.toFixed(1)} game minutes; shared/sim/clock.ts says ${clockText(want.dayTime)} of day ${want.day}`,
	);
	const reached = bagRun.reached.filter(Boolean).length;
	check(
		"the walkers closed in: most of them got within biting reach",
		reached >= Math.ceil(WALKERS / 2),
		`${reached} of ${WALKERS} reached; distance mean ${f1(mean(bagRun.startDist))} → ${f1(mean(atEnd.dist))} u, ` +
			`closest ${f1(Math.min(...bagRun.minDist))} u`,
	);
	const bites = street.bites;
	const dealt = bites.reduce((s, b) => s + b.dealt, 0);
	check(
		"...and bit: hits landed on the survivor through the server's own damage sink",
		bites.length >= 3,
		`${bites.length} bites, ${f1(dealt)} HP taken (${atEnd.stats.damageTaken.toFixed(1)} by combat's count), ` +
			`the first at ${f1(secondsAt(bagRun, bites[0]?.tick ?? NaN))} s`,
	);
	const lowest = Math.min(...ticks.map(t => t.hp));
	const died = bagRun.deathTick;
	check(
		`HP fell at least as far as the playtest's (100 → 35): ${f1(bagRun.startHp)} → ` +
			(died !== undefined ? `dead at ${f1(secondsAt(bagRun, died))} s` : f1(atEnd.hp)),
		bagRun.startHp - lowest >= PLAYTEST_LOSS,
		`lowest ${f1(lowest)}; ${bites.length} bites of 10 against the regeneration of a fed survivor`,
	);
	if (died !== undefined) {
		info(
			`${WALKERS} walkers in daylight kill a survivor standing in the Bag: once two of them touch, only the ` +
				`${f1(DESIGN.IFRAMES)} s i-frames space the bites. The playtest's survivor got off lighter (100 → 35).`,
		);
		info(
			`after the death the server keeps stepping the body (simulation.ts, §7.3 is F4's) and stepPlayer ` +
				`regenerates it: ${f1(atEnd.hp)} HP on a dead survivor at ${BAG_SECONDS} s`,
		);
	}
	const strolled = ticks.filter(t => t.walking);
	const unexplained = ticks.filter(t => t.moved > 1e-6 && t.knock0 <= 0);
	const drift = Math.hypot(atEnd.pos.x - bagRun.startPos.x, atEnd.pos.y - bagRun.startPos.y);
	check(
		"the survivor did not walk of their own will: never `walking`, and every step they moved was a bite's knockback",
		strolled.length === 0 && unexplained.length === 0,
		`${strolled.length} walking tick(s), ${unexplained.length} move(s) without knockback; ` +
			`knocked ${f1(drift)} u from the spot`,
	);
	const s = atEnd.stats;
	const swings = ticks.filter(t => t.swinging).length;
	check(
		"...and did not attack: no shot, no swing, not even a press refused for cadence",
		s.shots === 0 && s.melee === 0 && s.blockedCadence === 0 && s.damageDealt === 0 && swings === 0,
		`shots ${s.shots}, melee hits ${s.melee}, cadence ${s.blockedCadence}, swinging ${swings} tick(s)`,
	);
	check(
		"the snapshots kept coming at 20 Hz: the client drew the street it was standing in",
		Math.abs(atEnd.selfBlocks - BAG_SECONDS * (CFG.SIM_HZ / CFG.SNAP_NEAR_EVERY_TICKS)) <= 2,
		`${atEnd.selfBlocks} self blocks in ${BAG_SECONDS} s`,
	);
	info(`${sp.counters.consumed} commands consumed, queue depth at the end ${PL.bufferDepth(sp)}`);
}

// ================================================================ 3: the old "pause"

section('3) the old "pause": the same street with NO command at all (what the client sent with the Bag open)');
{
	const { street, atEnd } = oldRun;
	const { sp } = street;
	const bites = street.bites;
	const dealt = bites.reduce((s, b) => s + b.dealt, 0);
	check(
		"the server never heard from the survivor and stood them still (STANDING, §2.2 / §9.1)",
		sp.counters.packets === 0 && oldRun.ticks.every(t => t.moveMag === 0 && !t.walking),
		`${sp.counters.packets} packets, ${sp.counters.consumed} consumed`,
	);
	const died = oldRun.deathTick;
	check(
		`...and the bites landed all the same: ${f1(oldRun.startHp)} → ` +
			(died !== undefined ? `dead at ${f1(secondsAt(oldRun, died))} s` : f1(atEnd.hp)),
		bites.length > 0 && dealt > 0,
		`${bites.length} bites, ${f1(dealt)} HP taken`,
	);
	const a = bagRun.ticks.map(t => t.hp);
	const b = oldRun.ticks.map(t => t.hp);
	const same = a.length === b.length && a.every((v, i) => v === b[i]);
	info(
		`honest commands: ${bagRun.street.bites.length} bites; silence: ${bites.length} bites -- ` +
			(same
				? "the very same HP, tick for tick"
				: "not tick for tick (the aim differs: 0 against the survivor's)"),
	);
	info("the pause never existed on the server: all it ever stopped was the client SHOWING the bites");
}

// ================================================================ 4: the warning

/** feeds (dt, watching, hp) samples to a fresh HitAlarm; returns the times each flash started */
function flashesOf(samples) {
	const alarm = new HitAlarm();
	const starts = [];
	let t = 0;
	for (const s of samples) {
		t += s.dt;
		const before = alarm.flashes;
		alarm.step(s.dt, s.watching, s.hp);
		if (alarm.flashes > before) starts.push(t);
	}
	return { starts, alarm };
}

/** the most flash starts inside any 1 s window (the WCAG 2.3.1 count) */
function worstSecond(starts) {
	let worst = 0;
	for (let i = 0; i < starts.length; i++) {
		let n = 0;
		for (let j = i; j < starts.length && starts[j] < starts[i] + 1 - 1e-9; j++) n += 1;
		worst = Math.max(worst, n);
	}
	return worst;
}

section("4) the warning: HitAlarm over the HP of section 2 (client/ui/hitAlarm.ts)");
{
	const ticks = bagRun.ticks;
	const tick0 = bagRun.startTick;
	const byTick = new Map(ticks.map(t => [t.tick, t]));
	// `watching` is main.client.ts's: a screen is open over the run (the Bag, all along) and the survivor is alive.
	// Death comes on the reliable channel, not from the hp number: the server keeps regenerating a dead body.
	// The 60 Hz series: the HP the loop reads every frame (the predicted survivor carries the server's number).
	const s60 = ticks.map(t => ({ dt: TICK_DT, watching: !t.dead, hp: t.hp }));
	// the 20 Hz series: the self block's hp, exactly as the wire carried it (×1/100)
	const blocks = bagRun.street.selfBlocks;
	const s20 = blocks.map((b, i) => ({
		dt: (b.tick - (i > 0 ? blocks[i - 1].tick : tick0)) * TICK_DT,
		watching: byTick.get(b.tick)?.dead !== true,
		hp: b.hp,
	}));
	// the bites the survivor lived through: the one that kills is announced by the end-of-run screen instead
	const bites = bagRun.street.bites.filter(b => b.dealt >= HIT_ALARM.MIN_DROP && byTick.get(b.tick)?.hp > 0);
	info(
		`${bites.length} bites taken alive` +
			(bagRun.deathTick !== undefined
				? `, and the one that killed at ${f1(secondsAt(bagRun, bagRun.deathTick))} s`
				: ""),
	);
	for (const [label, series, lag] of [
		["60 Hz, every frame", s60, 0],
		["20 Hz, every self block", s20, CFG.SNAP_NEAR_EVERY_TICKS * TICK_DT],
	]) {
		const { starts } = flashesOf(series);
		const worst = worstSecond(starts);
		let minGap = Infinity;
		for (let i = 1; i < starts.length; i++) minGap = Math.min(minGap, starts[i] - starts[i - 1]);
		check(
			`${label}: it flashes`,
			starts.length >= 1,
			`${starts.length} flash(es) for ${bites.length} bites that took ≥ ${HIT_ALARM.MIN_DROP} HP`,
		);
		check(
			`${label}: never more than 3 flashes in any 1 s (WCAG 2.3.1)`,
			worst <= 3 && (starts.length < 2 || minGap >= HIT_ALARM.GAP_S - 1e-9),
			`worst second ${worst}, closest two ${Number.isFinite(minGap) ? minGap.toFixed(2) : "-"} s apart`,
		);
		const missed = bites.filter(b => {
			const tb = (b.tick - tick0) * TICK_DT;
			return !starts.some(s => s >= tb - HIT_ALARM.GAP_S - 1e-9 && s <= tb + lag + 1e-9);
		});
		check(
			`${label}: every bite is on screen -- a flash started with it, or under ${HIT_ALARM.GAP_S} s before`,
			missed.length === 0,
			`${missed.length} bite(s) with no flash`,
		);
	}
	{
		// seven zombies biting in turn, faster than any i-frame allows: a hit on every frame for 3 s
		const storm = [];
		let hp = 100;
		for (let i = 0; i < 180; i++) {
			hp -= 2;
			storm.push({ dt: TICK_DT, watching: true, hp });
		}
		const { starts } = flashesOf(storm);
		const worst = worstSecond(starts);
		check(
			"a hit on every frame for 3 s is a warning, not a strobe: ≤ 3 flashes in any second, and it keeps warning",
			worst <= 3 && starts.length >= 6,
			`${starts.length} flashes in 3 s, worst second ${worst}`,
		);
	}
	{
		// the slow drains, from the real stepPlayer: poison (1.8 HP/s), hunger (0.6 HP/s) and both at once
		const standing = { seq: 0, moveAng: 0, moveMag: 0, aim: 0, held: 0, edges: 0 };
		for (const [label, poison, starving] of [
			["poison", true, false],
			["hunger", false, true],
			["poison and hunger", true, true],
		]) {
			const world = bagRun.street.world;
			const save = defaultSave();
			const p = createPlayer(save, bagRun.startPos.x, bagRun.startPos.y);
			const hp0 = p.hp;
			const samples = [];
			for (let t = 0; t < 30 * CFG.SIM_HZ; t++) {
				if (poison) p.buffs.poison = 10;
				if (starving) p.hungry = 0;
				stepPlayer(world, p, save, standing, TICK_DT);
				// the self block's cadence and resolution
				if (t % CFG.SNAP_NEAR_EVERY_TICKS === 0) {
					samples.push({
						dt: CFG.SNAP_NEAR_EVERY_TICKS * TICK_DT,
						watching: true,
						hp: Math.round(p.hp * 100) / 100,
					});
				}
			}
			const { starts } = flashesOf(samples);
			check(
				`${label}, a slow drain at 20 Hz: no flash`,
				starts.length === 0 && hp0 - p.hp > 15,
				`${f1(hp0)} → ${f1(p.hp)} HP in 30 s, ${starts.length} flash(es)`,
			);
		}
	}
	{
		// a hit taken the frame BEFORE the Bag opened is not one taken inside it
		const seq = [];
		for (let i = 0; i < 10; i++) seq.push({ dt: TICK_DT, watching: false, hp: 100 });
		seq.push({ dt: TICK_DT, watching: false, hp: 90 });
		for (let i = 0; i < 60; i++) seq.push({ dt: TICK_DT, watching: true, hp: 90 });
		const before = flashesOf(seq).starts.length;
		seq.push({ dt: TICK_DT, watching: true, hp: 80 });
		const inside = flashesOf(seq).starts.length;
		check(
			"a hit taken before the Bag opened does not flash inside it (and the next one, inside, does)",
			before === 0 && inside === 1,
			`${before} flash(es) for the hit before, ${inside} once a hit lands inside`,
		);
	}
	{
		// the real damage rule: Steel armour (def 6) takes a hit of 6 whole, and 4 off a walker's bite of 10
		const save = defaultSave();
		save.equipCloth = EQUIPS.findIndex(e => e.name === "Steel armor");
		const def = playerEquipDefence(save);
		const p = createPlayer(save, 0, 0);
		const hp0 = p.hp;
		const landed = applyPlayerDamage(p, save, def);
		const absorbed = p.hp;
		const quiet = flashesOf([
			{ dt: TICK_DT, watching: true, hp: hp0 },
			{ dt: TICK_DT, watching: true, hp: absorbed },
		]).starts.length;
		const q = createPlayer(save, 0, 0);
		applyPlayerDamage(q, save, 10);
		const loud = flashesOf([
			{ dt: TICK_DT, watching: true, hp: hp0 },
			{ dt: TICK_DT, watching: true, hp: q.hp },
		]).starts.length;
		check(
			"a hit the armour absorbs whole (HP unchanged) does not flash; one that gets through does",
			landed && absorbed === hp0 && quiet === 0 && q.hp < hp0 && loud === 1,
			`def ${def}: a hit of ${def} lands (i-frames, knockback) and leaves ${f1(absorbed)} HP → ${quiet} flash; ` +
				`a bite of 10 leaves ${f1(q.hp)} → ${loud}`,
		);
	}
}

// ================================================================ 5: the source

/** a file's AST, and the same file printed without its comments */
function parse(rel) {
	const file = join(SRC, rel);
	const sf = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.ES2020, true, ts.ScriptKind.TS);
	const printer = ts.createPrinter({ removeComments: true });
	return {
		sf,
		printer,
		code: printer.printFile(sf),
		text: node => printer.printNode(ts.EmitHint.Unspecified, node, sf),
	};
}

/** every node under `root` for which `pick` is true, without entering nested functions when `shallow` */
function find(root, pick, shallow = false) {
	const out = [];
	const visit = node => {
		if (pick(node)) out.push(node);
		if (shallow && node !== root && ts.isFunctionLike(node)) return;
		ts.forEachChild(node, visit);
	};
	visit(root);
	return out;
}

section("5) source guards (UI-06): nothing left that pauses the world");
{
	const main = parse("client/main.client.ts");
	check("main.client.ts calls InputState.setHeld", /\.setHeld\(/.test(main.code));
	const simulate = find(main.sf, n => ts.isIdentifier(n) && n.text === "simulate");
	check(
		"main.client.ts has no `simulate` any more (the flag that skipped the world while a menu was open)",
		simulate.length === 0,
		`${simulate.length} use(s)`,
	);
	const mountRun = find(main.sf, n => ts.isFunctionDeclaration(n) && n.name?.text === "mountRun")[0];
	const connect =
		mountRun === undefined
			? undefined
			: find(
					mountRun,
					n => ts.isCallExpression(n) && main.text(n.expression) === "RunService.Heartbeat.Connect",
				)[0];
	const beat = connect?.arguments[0];
	const body =
		beat !== undefined && ts.isFunctionLike(beat) && beat.body !== undefined && ts.isBlock(beat.body)
			? beat.body.statements
			: [];
	const direct = (stmt, what) => ts.isExpressionStatement(stmt) && main.text(stmt.expression).startsWith(what);
	const updateAt = body.findIndex(st => direct(st, "loop.update(dt)"));
	const heldAt = body.findIndex(st => direct(st, "input.setHeld("));
	check(
		"mountRun's Heartbeat calls loop.update(dt) unconditionally: a statement of its own, under no `if`",
		updateAt >= 0,
		updateAt >= 0 ? `statement ${updateAt + 1} of ${body.length}` : "not found as a direct statement",
	);
	const early = body.slice(0, Math.max(0, updateAt)).filter(st => find(st, ts.isReturnStatement, true).length > 0);
	check(
		"...with no `return` before it that could skip the world (pack.isOpen(), pauseCleanup or anything else)",
		updateAt >= 0 && early.length === 0,
		early.map(st => main.text(st).split("\n")[0]).join(" | ") || "none",
	);
	check(
		"...and input.setHeld(...) comes first, every frame",
		heldAt >= 0 && heldAt < updateAt && !/setHeld\(\s*false\s*\)/.test(main.text(body[heldAt])),
		heldAt >= 0 ? main.text(body[heldAt]) : "not found as a direct statement",
	);

	const loop = parse("client/gameLoop.ts");
	const cls = find(loop.sf, n => ts.isClassDeclaration(n) && n.name?.text === "GameLoop")[0];
	const update = cls?.members.find(m => ts.isMethodDeclaration(m) && m.name.getText(loop.sf) === "update");
	const updateCode = update !== undefined ? loop.text(update) : "";
	check("GameLoop.update exists", update !== undefined);
	check(
		"GameLoop.update no longer starts with `if (p.dead) return`",
		update !== undefined && !/if\s*\(\s*(p|this\.player)\.dead\s*\)\s*(\{\s*)?return/.test(updateCode),
	);
	const returns = update?.body !== undefined ? find(update.body, ts.isReturnStatement, true) : [];
	check(
		"...nor returns early anywhere: the world is stepped on every frame of a run",
		update !== undefined && returns.length === 0,
		`${returns.length} return(s)`,
	);
	check("...and it reads `input.held` to hold the survivor instead", /\.held\b/.test(updateCode));

	// section 1 runs a COPY of netClient.ts predict() (the file cannot load under Node): the copy is only worth
	// what it matches, so the edges it sends are pinned to the source here
	const net = parse("client/net/netClient.ts");
	const predict = find(net.sf, n => ts.isFunctionDeclaration(n) && n.name?.text === "predict")[0];
	const addEdges =
		predict === undefined
			? undefined
			: find(predict, n => ts.isCallExpression(n) && net.text(n.expression) === "commands.addEdges")[0];
	const edgeArgs = addEdges?.arguments.map(a => net.text(a).replace(/\s+/g, " ")) ?? [];
	check(
		"netClient.ts predict() sends the edges this harness sends (a blocked button's release is no release)",
		edgeArgs.join(", ") ===
			"input.attackPressed, input.attackReleased && !input.attackBlocked, input.actionPressed, input.reloadPressed, input.actionGlass",
		edgeArgs.join(", ") || "commands.addEdges(...) not found in predict()",
	);
}

section("6) source guards (SAV-01): the in-run menu has no Save -- saving is automatic");
{
	const pause = parse("client/ui/pauseMenu.ts");
	const handlers = find(pause.sf, n => ts.isInterfaceDeclaration(n) && n.name.text === "PauseHandlers")[0];
	const members = handlers?.members.map(m => m.name?.getText(pause.sf)) ?? [];
	check("PauseHandlers has no onSave", handlers !== undefined && !members.includes("onSave"), members.join(", "));
	// the in-run menu's rows: the `key` of every object in the `items` array of showPause
	const items = find(
		pause.sf,
		n => ts.isVariableDeclaration(n) && n.name.getText(pause.sf) === "items" && n.initializer !== undefined,
	)[0];
	const keys =
		items !== undefined && ts.isArrayLiteralExpression(items.initializer)
			? items.initializer.elements.map(e =>
					ts.isObjectLiteralExpression(e)
						? e.properties
								.find(p => p.name?.getText(pause.sf) === "key")
								?.initializer?.getText(pause.sf)
								.replace(/"/g, "")
						: undefined,
				)
			: [];
	check(
		"the in-run menu's rows are Back to game, Shop, Settings, Home -- no Save",
		keys.join(" | ") === "Back to game | Shop | Settings | Home",
		keys.join(" | "),
	);
	const main = parse("client/main.client.ts");
	const onSave = find(main.sf, n => ts.isPropertyAssignment(n) && n.name.getText(main.sf) === "onSave");
	const manual = find(
		main.sf,
		n => ts.isCallExpression(n) && /requestSave$/.test(main.text(n.expression)) && /"manual"/.test(main.text(n)),
	);
	check(
		'main.client.ts hands the menu no onSave and never reports as "manual"',
		onSave.length === 0 && manual.length === 0,
		`${onSave.length} onSave, ${manual.length} manual`,
	);
	const client = parse("client/systems/saveClient.ts");
	const reason = find(client.sf, n => ts.isTypeAliasDeclaration(n) && n.name.text === "SaveReason")[0];
	check(
		'saveClient.ts: "manual" is no SaveReason (a report is never a write: the server decides, SAV-01)',
		reason !== undefined && !/"manual"/.test(client.text(reason)),
		reason !== undefined ? client.text(reason).replace(/\s+/g, " ") : "SaveReason not found",
	);
}

// ---------------------------------------------------------------- verdict

console.log(`\n${((Date.now() - started) / 1000).toFixed(1)} s`);
if (failures > 0) {
	console.error(`${failures} failure(s)`);
	process.exit(1);
}
console.log("all menu tests passed");
