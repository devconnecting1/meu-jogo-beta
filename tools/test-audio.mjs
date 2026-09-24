#!/usr/bin/env node
/*
 * The sounds of P0-4 (docs/research/DEAD_TOWN_GAP_ANALYSIS.md): the bite, the doors, using a usable, the
 * flamethrower, the motorcycle's engine and horn (and the bicycle's bell), and the horde's voice -- from the catalogue
 * to the speaker, through the REAL modules.
 *
 *   npm run test:audio
 *   PZ_SRC=<another checkout>/src node tools/test-audio.mjs
 *
 *   A. THE CATALOGUE   every P0-4 event has its entry; ids are official-library or engine content (never a user
 *                      upload), base volumes <= 0.6, windows and loop regions make sense; design/audio-credits.md lists
 *                      every asset id the catalogue uses; the one empty slot (the adrenaline shot) is documented.
 *   B. THE WIRE        each world sound goes simulation -> toWireFx -> encodeFx -> decodeFx -> fromWireFx and comes back
 *                      as itself; an id this build does not know stays silent.
 *   C. THE SERVER      decides them, in a real ServerSimulation driven through the wire: a walker's bite that drew blood,
 *                      a door opened and closed by E (wood and iron), each usable used (eat, bandage, kit, pills, shot),
 *                      the motorcycle's horn and the bicycle's bell -- each an Fx Sound where it happened.
 *   D. THE CLIENT      plays them on the SFX group, at their position, and not at all with the SFX slider at 0; the empty
 *                      slot plays nothing and breaks nothing.
 *   E. HELD LOOPS      the engine is ONE looping voice per rider (its steady window as the LoopRegion), following the
 *                      rider, its pitch and level rising with the speed, fading out and freeing itself when released;
 *                      six at once, a seventh is not heard; the slider at 0 stops them; 600 frames create no Instance.
 *   F. THE FLAMETHROWER fires a held jet with one ignition burst, never the stun gun's ping, and stops with the trigger.
 *   G. THE HORDE       sixty zombies are a few voices: every vocal spends the budget (3, one back every 0.75 s), groans
 *                      never closer than the minimum gap, never the same take twice in a row, one zombie never twice
 *                      within 7 s, the pitch by the type; a group turning at once is ONE shout; a lone one, a snarl.
 *
 * Pure Node (>= 18) + the project's TypeScript on the shared shims (tools/ui-shim.mjs).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { installUiShims } from "./ui-shim.mjs";

const ui = installUiShims({ seed: 3, viewport: [1120, 630] });
const { SRC, ROOT, require, flush, service, setClock, getClock } = ui;

// ---------------------------------------------------------------- what plays, and what is created

/** every Sound:Play(), in order */
const plays = [];
let created = 0;
{
	const make = globalThis.Instance;
	globalThis.Instance = function Instance(className) {
		created += 1;
		const inst = make(className);
		if (className === "Sound") {
			inst.IsPlaying = false;
			inst.Play = () => {
				inst.IsPlaying = true;
				plays.push({
					id: inst.SoundId,
					group: inst.SoundGroup?.Name,
					volume: inst.Volume,
					speed: inst.PlaybackSpeed,
					pos: inst.TimePosition ?? 0,
					sound: inst,
					at: getClock(),
				});
			};
			inst.Stop = () => {
				inst.IsPlaying = false;
			};
		}
		return inst;
	};
}
/** the listener's CFrame (the ear only needs to be SET here: the panning is the engine's) */
globalThis.CFrame ??= class CFrame {
	constructor(p) {
		this.Position = p;
	}
};
/** the engine's LoopRegion value type (the shims do not model it) */
globalThis.NumberRange = class NumberRange {
	constructor(min, max) {
		this.Min = min;
		this.Max = max ?? min;
	}
};

let failures = 0;
let checks = 0;
function check(ok, what, detail) {
	checks += 1;
	const tail = detail === undefined ? "" : `  (${detail})`;
	if (ok) console.log(`  ok    ${what}${tail}`);
	else {
		failures += 1;
		console.log(`  FAIL  ${what}${tail}`);
	}
	return ok;
}
/** distinct values (the Luau shims replace the global Set, so a plain array does it) */
const uniq = a => a.filter((v, i) => a.indexOf(v) === i).length;
function section(title, fn) {
	console.log(`\n${title}`);
	try {
		fn();
	} catch (e) {
		failures += 1;
		console.log(`  FAIL  the section threw: ${e?.stack?.split("\n").slice(0, 6).join(" | ") ?? e}`);
	}
}

const { SOUNDS, soundDef } = require(join(SRC, "shared/data/sounds.ts"));
const FW = require(join(SRC, "shared/net/fxWire.ts"));
const P = require(join(SRC, "shared/net/protocol.ts"));
const RunService = service("RunService");
const SoundService = service("SoundService");
function frame(dt = 1 / 60) {
	setClock(getClock() + dt);
	RunService.Heartbeat.Fire(dt);
	flush();
}

/** the P0-4 events and the entry each one plays */
const P04 = {
	bite: ["bite"],
	doors: ["doorOpen", "doorClose", "ironDoorOpen", "ironDoorClose"],
	use: ["useEat", "useBandage", "useMedkit", "usePills", "useInject"],
	flamethrower: ["flameLoop", "flameIgnite"],
	motorcycle: ["engineMoto", "hornMoto", "bellBike"],
	horde: [
		"zombieGroanA",
		"zombieGroanB",
		"zombieGroanC",
		"zombieGroanD",
		"zombieAggroA",
		"zombieAggroB",
		"zombieShout",
	],
};
const ALL = Object.values(P04).flat();

// ================================================================ A. the catalogue

section(
	"A. o catalogo: cada evento do P0-4 tem entrada, de biblioteca oficial, com volume e janela que fazem sentido",
	() => {
		const missing = ALL.filter(n => SOUNDS[n] === undefined);
		check(missing.length === 0, `os ${ALL.length} sons do P0-4 estao no catalogo`, missing.join(", "));
		const bad = [];
		for (const [name, d] of Object.entries(SOUNDS)) {
			if (d.id !== "" && !/^rbxassetid:\/\/\d+$|^rbxasset:\/\/sounds\//.test(d.id)) bad.push(`${name}: ${d.id}`);
			if (d.volume > 0.6) bad.push(`${name}: volume ${d.volume}`);
			if (d.pitchMax < d.pitchMin) bad.push(`${name}: pitch`);
			if ((d.loopStart === undefined) !== (d.loopEnd === undefined)) bad.push(`${name}: meia regiao de loop`);
			if (d.loopStart !== undefined && !(d.loopEnd > d.loopStart + 1)) bad.push(`${name}: regiao de loop curta`);
			if (d.maxPlay !== undefined && d.maxPlay <= 0) bad.push(`${name}: maxPlay`);
		}
		check(
			bad.length === 0,
			"todo id e rbxassetid ou conteudo do motor, volume base <= 0,6, janelas coerentes",
			bad.join("; "),
		);
		check(
			SOUNDS.engineMoto.loop === true &&
				SOUNDS.flameLoop.loop === true &&
				SOUNDS.engineMoto.loopStart !== undefined,
			"o motor e o jato sao loops com a sua janela estavel (LoopRegion)",
		);
		const empties = Object.entries(SOUNDS)
			.filter(([, d]) => d.id === "")
			.map(([n]) => n);
		check(
			empties.join() === "useInject",
			"um slot vazio so, o da injecao (adrenalina): silencio de proposito",
			empties.join(", "),
		);
		const credits = readFileSync(join(ROOT, "design", "audio-credits.md"), "utf8");
		const ids = Object.values(SOUNDS)
			.map(d => d.id)
			.filter((id, i, a) => id.startsWith("rbxassetid://") && a.indexOf(id) === i);
		const undocumented = ids.filter(id => !credits.includes(id.replace("rbxassetid://", "")));
		check(
			undocumented.length === 0,
			`design/audio-credits.md registra cada um dos ${ids.length} assets da biblioteca que o catalogo usa`,
			undocumented.join(", "),
		);
		for (const n of ALL) {
			if (SOUNDS[n].id === "") continue;
			if (!credits.includes(`\`${n}\``)) check(false, `o credito cita ${n}`);
		}
		check(credits.includes("`useInject`"), "e o slot vazio esta documentado como pendencia para o dono");
		const horde = P04.horde.filter(n => SOUNDS[n].spatial === true && SOUNDS[n].bus === "sfx");
		check(horde.length === P04.horde.length, "a voz da horda: toda ela espacial, no grupo SFX");
		check(
			!Object.keys(SOUNDS).includes("zombieGrowl") && !Object.keys(SOUNDS).includes("zombieAlert"),
			"o rosnado de robo (Goliath) saiu da voz dos zumbis (fica so no rugido de chefe)",
		);
	},
);

// ================================================================ B. the wire

section("B. o fio: cada som do mundo vai e volta pelo codec real; um id desconhecido fica mudo", () => {
	const got = [];
	for (const s of FW.WIRE_SOUNDS) {
		const wire = FW.toWireFx({ kind: "sound", sound: s, x: 1234.5, y: 678 }, i => i);
		const enc = P.encodeFx({ tick: 7, events: [wire] });
		const dec = P.decodeFx(enc.packets[0]);
		const back = FW.fromWireFx(dec.events[0]);
		if (back?.kind !== "sound" || back.sound !== s || Math.abs(back.x - 1234.5) > 1 || Math.abs(back.y - 678) > 1)
			got.push(s);
	}
	check(got.length === 0, `os ${FW.WIRE_SOUNDS.length} sons do mundo atravessam o fio iguais`, got.join(", "));
	check(uniq(FW.WIRE_SOUNDS) === FW.WIRE_SOUNDS.length, "ids unicos (a lista so cresce no fim)");
	check(
		FW.WIRE_SOUNDS.every(s => SOUNDS[s] !== undefined),
		"todo som do fio e uma entrada do catalogo (o mesmo nome)",
	);
	check(
		FW.fromWireFx({ t: P.FxType.Sound, sound: 250, x: 0, y: 0, volume: 1 }) === undefined,
		"um id que este build nao conhece (servidor mais novo): nada toca",
	);
});

// ================================================================ C. the server decides

const W = require(join(SRC, "shared/game/world.ts"));
const SAVE = require(join(SRC, "shared/game/save.ts"));
const PL = require(join(SRC, "server/sim/players.ts"));
const { ServerSimulation } = require(join(SRC, "server/sim/simulation.ts"));
const { WorldClock } = require(join(SRC, "server/sim/waves.ts"));
const { PLACEABLES, placedSolid } = require(join(SRC, "shared/sim/placement.ts"));
const { createZombie, resetEntityIds } = require(join(SRC, "shared/game/entities.ts"));
const V = require(join(SRC, "shared/sim/vehicle.ts"));
const { VehicleKind, vehicleDef, vehicleKindOfItem } = require(join(SRC, "shared/data/buildings.ts"));
const { USABLES, useSoundOf } = require(join(SRC, "shared/data/usables.ts"));

function server({ zombies = false } = {}) {
	resetEntityIds();
	const world = W.serverWorld(W.createWorld(8000, 8000));
	const sim = new ServerSimulation({
		world,
		clock: new WorldClock({ day: 1, dayTime: 12 }),
		zombies,
		interactive: true,
	});
	const fx = [];
	sim.onFx = e => fx.push(e);
	return { world, sim, fx };
}
function addPlayer(sim, slot, x, y, save = SAVE.defaultSave()) {
	const sp = PL.createServerPlayer({ slot, userId: 900 + slot, name: `p${slot}` }, save, x, y, sim.tick, sim.simHz);
	sim.add(sp);
	sp.state.x = x;
	sp.state.y = y;
	return sp;
}
function driver(sim, sp) {
	let seq = 100;
	return {
		tick(mx = 0, my = 0, edges = 0, held = 0) {
			const cmd = P.makeCommand(seq, mx, my, 0, held, edges);
			seq += 1;
			PL.ingestInput(sp, P.encodeInput({ viewTick: 0, viewFrac: 0, cmds: [cmd] }), sim.tick / 60);
			sim.step();
		},
		ticks(n, mx = 0, my = 0) {
			for (let i = 0; i < n; i++) this.tick(mx, my);
		},
	};
}
const PRESS_E = P.packEdges(0, 0, 1, 0);
const PRESS_ATTACK = P.packEdges(1, 0, 0, 0);
const soundsIn = list => list.filter(e => e.t === P.FxType.Sound).map(e => ({ ...e, name: FW.wireSoundOf(e.sound) }));

section("C. o servidor decide: mordida, porta, item usado, buzina e campainha viram Fx Sound onde aconteceram", () => {
	// the bite: a walker beside a survivor; the horde's own Fx (what replication sends) carries it
	{
		const { sim } = server({ zombies: true });
		const sp = addPlayer(sim, 0, 3000, 3000);
		const d = driver(sim, sp);
		d.ticks(5);
		const z = createZombie(1, 3030, 3000, 1, false);
		z.detect = true;
		sim.horde.zombies.push(z);
		const hp0 = sp.state.hp;
		const horde = [];
		for (let i = 0; i < 240 && sp.state.hp >= hp0; i++) {
			d.tick();
			sim.horde.takeFx(horde);
		}
		for (let i = 0; i < 3; i++) {
			d.tick();
			sim.horde.takeFx(horde);
		}
		const bites = horde.filter(e => e.kind === "sound" && e.sound === "bite");
		const blood = horde.filter(e => e.kind === "blood" && e.source === "player");
		check(
			sp.state.hp < hp0 && bites.length >= 1 && bites.length <= blood.length,
			"uma mordida que tirou sangue e ouvida (so a que tirou sangue: nunca mais mordidas que sangue)",
			`${(hp0 - sp.state.hp).toFixed(0)} hp, ${bites.length} mordida(s), ${blood.length} sangue(s)`,
		);
		check(
			bites.every(b => Math.hypot(b.x - sp.state.x, b.y - sp.state.y) < 40),
			"no sobrevivente que foi mordido (qualquer um: e espacial para todos)",
		);
		const wire = FW.toWireFx(bites[0], i => i);
		check(wire?.t === P.FxType.Sound && FW.wireSoundOf(wire.sound) === "bite", "e vai pelo fio como Sound 'bite'");
	}
	// the doors: a built wooden door and an iron one, opened and closed by E
	const placeableOf = kind => Number(Object.keys(PLACEABLES).find(k => PLACEABLES[k].kind === kind));
	for (const [item, open, close] of [
		[placeableOf("door"), "doorOpen", "doorClose"],
		[placeableOf("iron_door"), "ironDoorOpen", "ironDoorClose"],
	]) {
		const { world, sim, fx } = server();
		const def = PLACEABLES[item];
		const door = W.addSolid(world, {
			...placedSolid(def, { x: 2000, y: 2000, w: def.w, h: def.h }, 0),
			placeable: item,
			owner: 0,
		});
		const sp = addPlayer(sim, 0, 2000 + def.w / 2, 2000 + def.h + 22);
		const d = driver(sim, sp);
		d.ticks(5);
		d.tick(0, 0, PRESS_E);
		d.ticks(30);
		d.tick(0, 0, PRESS_E);
		d.ticks(5);
		const s = soundsIn(fx);
		check(
			s.map(e => e.name).join() === `${open},${close}` &&
				s.every(e => Math.abs(e.x - (door.x + door.w / 2)) < 2 && Math.abs(e.y - (door.y + door.h / 2)) < 2),
			`${def.kind}: E abre e fecha, e cada giro e ouvido no meio da porta`,
			s.map(e => e.name).join(", "),
		);
	}
	// using a usable: the server accepted it -> the sound of what it is
	{
		const { sim, fx } = server();
		const save = SAVE.defaultSave();
		for (const u of USABLES) save.invenUse[u.id] = 3;
		const sp = addPlayer(sim, 0, 3000, 3000, save);
		sp.state.godMode = true;
		let seq = 0;
		const verb = (kind, arg, nonce) => P.decodeIntentMessage(P.encodeIntentArgs(kind, 0, arg, nonce));
		const tick = () => {
			seq += 1;
			PL.ingestInput(
				sp,
				P.encodeInput({ viewTick: 0, viewFrac: 0, cmds: [P.makeCommand(seq, 0, 0, 0, 0, 0)] }),
				sim.tick,
			);
			sim.step();
		};
		for (let i = 0; i < 5; i++) tick();
		const want = [];
		let nonce = 1;
		for (const name of ["Apple", "Bandage", "First aid kit", "Pain killer", "Adrenaline", "Sedative"]) {
			const u = USABLES.find(x => x.name === name);
			sp.state.hp = 40;
			sp.state.hungry = 20;
			sim.queueIntent(0, verb(P.IntentKind.UseItem, u.id, nonce++));
			for (let i = 0; i < 20; i++) tick();
			want.push(useSoundOf(u.id));
		}
		const s = soundsIn(fx).map(e => e.name);
		check(
			s.join() === want.join() && want.join() === "useEat,useBandage,useMedkit,usePills,useInject,usePills",
			"comer, enfaixar, abrir o kit, as pilulas e a injecao: cada uso aceito tem o seu som",
			s.join(", "),
		);
		// a use the server refuses (nothing to heal, nothing to feed) makes no sound
		const before = soundsIn(fx).length;
		sp.state.hp = sp.state.hpMax;
		sp.state.hungry = sp.state.hungryMax;
		sim.queueIntent(0, verb(P.IntentKind.UseItem, USABLES.find(x => x.name === "Bandage").id, nonce++));
		for (let i = 0; i < 20; i++) tick();
		check(soundsIn(fx).length === before, "um uso recusado (nada a curar) nao faz som");
	}
	// the horn and the bell: the attack button on a vehicle
	for (const [item, name] of [
		[22, "hornMoto"],
		[21, "bellBike"],
	]) {
		const { world, sim, fx } = server();
		const save = SAVE.defaultSave();
		save.oil = 40;
		const sp = addPlayer(sim, 0, 3000, 3000, save);
		const vdef = vehicleDef(vehicleKindOfItem(item));
		W.addSolid(world, {
			...placedSolid(PLACEABLES[item], V.parkedRect(vdef, 3000, 3040, 0), 0),
			placeable: item,
			owner: 0,
		});
		const d = driver(sim, sp);
		d.tick(0, 0, PRESS_E);
		d.ticks(40);
		d.tick(0, 0, PRESS_ATTACK);
		d.tick(0, 0, PRESS_ATTACK);
		const s = soundsIn(fx);
		check(
			s.length === 1 && s[0].name === name && Math.hypot(s[0].x - sp.state.x, s[0].y - sp.state.y) < 40,
			`${vdef.name}: o botao de ataque e ${name === "hornMoto" ? "a buzina" : "a campainha"}, ouvida uma vez por intervalo`,
			s.map(e => e.name).join(", "),
		);
	}
});

// ================================================================ D. the client plays them

const { audio } = require(join(SRC, "client/audio/audio.ts"));
const FA = require(join(SRC, "client/audio/fxAudio.ts"));
const settings = SAVE.defaultSettings();
audio.start();
audio.bindSettings(() => settings);
audio.setListener(0, 0);
frame();
const group = bus => SoundService.FindFirstChild("ProjectZAudio")?.FindFirstChild(bus);

section("D. o cliente toca cada um no grupo SFX, onde aconteceu; com o SFX em 0, nada; o slot vazio, nada", () => {
	const bad = [];
	for (const s of FW.WIRE_SOUNDS) {
		plays.length = 0;
		FA.playFxEvent({ kind: "sound", sound: s, x: 200, y: 100 });
		const def = soundDef(s);
		if (def.id === "") {
			if (plays.length !== 0) bad.push(`${s} tocou`);
			continue;
		}
		const p = plays[0];
		if (p === undefined || p.id !== def.id || p.group !== "sfx") bad.push(`${s}: ${p?.id} ${p?.group}`);
		else if (p.sound.Parent?.ClassName !== "Attachment") bad.push(`${s}: nao espacial`);
		else if (Math.abs(p.sound.Parent.Position.X - 200 / 16) > 0.01) bad.push(`${s}: fora do lugar`);
	}
	check(
		bad.length === 0,
		"cada som do mundo toca o seu asset, no grupo SFX, preso ao emissor no lugar dele",
		bad.join("; "),
	);
	settings.soundEffect = 0;
	frame();
	plays.length = 0;
	for (const s of FW.WIRE_SOUNDS) FA.playFxEvent({ kind: "sound", sound: s, x: 10, y: 10 });
	check(
		plays.length === 0 && group("sfx").Volume === 0,
		"SFX em 0: nenhum deles toca (nem stream)",
		`${plays.length}`,
	);
	settings.soundEffect = 0.5;
	frame();
});

// ================================================================ E. held loops

section(
	"E. loops presos: um motor por piloto, segue, sobe com a velocidade, some solto; seis no maximo; sem Instance",
	() => {
		const engine = soundDef("engineMoto");
		plays.length = 0;
		for (let i = 0; i < 30; i++) {
			audio.holdLoop(1001, "engineMoto", 100 + i * 5, 0, 0.55, 0.8);
			frame();
		}
		const started = plays.filter(p => p.id === engine.id);
		const voice = started[0]?.sound;
		check(
			started.length === 1 && voice.Looped === true,
			"segurar 30 quadros: UMA voz, em loop",
			`${started.length} Play()`,
		);
		check(
			voice?.PlaybackRegionsEnabled === true &&
				voice.LoopRegion?.Min === engine.loopStart &&
				voice.LoopRegion?.Max === engine.loopEnd,
			`so a janela estavel do take faz o loop (${engine.loopStart}-${engine.loopEnd} s)`,
		);
		check(voice?.SoundGroup?.Name === "sfx" && voice.Parent?.ClassName === "Attachment", "no grupo SFX, espacial");
		check(
			Math.abs(voice.Parent.Position.X - (100 + 29 * 5) / 16) < 0.2,
			"o emissor segue o piloto",
			`${voice.Parent.Position.X.toFixed(2)} studs`,
		);
		const quiet = voice.Volume;
		for (let i = 0; i < 60; i++) {
			audio.holdLoop(1001, "engineMoto", 300, 0, 1, 1.8);
			frame();
		}
		check(
			voice.Volume > quiet * 1.5 && voice.PlaybackSpeed > 1.7,
			"na maxima: mais alto e mais agudo (o giro), sem salto (a altura anda ate la)",
			`volume ${quiet.toFixed(3)} -> ${voice.Volume.toFixed(3)}, pitch ${voice.PlaybackSpeed.toFixed(2)}`,
		);
		let off = -1;
		for (let i = 0; i < 40; i++) {
			frame();
			if (off < 0 && !voice.IsPlaying) off = i + 1;
		}
		check(off > 0 && off <= 20, "solto: esvai e para sozinho (e a voz volta ao pool)", `${off} quadros`);
		check(!audio.loopActive(1001), "...e ninguem mais o segura");
		// six sources: six voices; a seventh is not heard
		plays.length = 0;
		for (let i = 0; i < 10; i++) {
			for (let k = 0; k < 7; k++) audio.holdLoop(2000 + k, "engineMoto", k * 50, 0, 1, 1);
			frame();
		}
		const six = [0, 1, 2, 3, 4, 5, 6].filter(k => audio.loopActive(2000 + k)).length;
		check(
			six === 6 && !audio.loopActive(2006),
			"seis motores ao mesmo tempo; o setimo nao e ouvido (o pool nao cresce)",
			`${six}`,
		);
		settings.soundEffect = 0;
		frame();
		check(
			[0, 1, 2, 3, 4, 5].every(k => !audio.loopActive(2000 + k)),
			"SFX em 0: todos param (nada em stream)",
		);
		settings.soundEffect = 0.5;
		for (let i = 0; i < 30; i++) frame();
		// no churn: 600 frames of engines coming and going
		const c0 = created;
		for (let f = 0; f < 600; f++) {
			for (let k = 0; k < 4; k++)
				if ((f + k * 37) % 200 < 120) audio.holdLoop(3000 + k, "engineMoto", f, k * 100, 0.7, 1 + k * 0.2);
			if (f % 90 < 30) audio.holdLoop(4000, "flameLoop", 0, 0, 1, 0.55);
			frame();
		}
		check(created === c0, "600 quadros de motores e jato indo e vindo: nenhuma Instance criada", `${created - c0}`);
		// out of earshot: never started
		plays.length = 0;
		audio.holdLoop(5000, "engineMoto", 50000, 0, 1, 1);
		frame();
		check(plays.length === 0 && !audio.loopActive(5000), "longe demais: nem comeca");
		for (let i = 0; i < 30; i++) frame();
	},
);

// ================================================================ F / G. the run's watcher

const { GameAudio } = require(join(SRC, "client/audio/gameAudio.ts"));
const Ply = require(join(SRC, "shared/game/player.ts"));
const { WEAPONS } = require(join(SRC, "shared/data/weapons.ts"));

function runRefs() {
	const save = SAVE.defaultSave();
	const player = Ply.createPlayer(save, 0, 0);
	return {
		player,
		players: [player],
		save,
		zombies: [],
		bosses: [],
		bullets: [],
		fx: [],
		explosions: [],
		daynight: { isNight: false, dayTime: 12 },
	};
}
function runFrame(ga, refs, dt = 1 / 60, mutate) {
	ga.beforeUpdate(refs);
	mutate?.();
	ga.afterUpdate(refs, dt);
	ga.frame(refs, refs.player.x, refs.player.y);
	frame(dt);
}
const idOf = n => soundDef(n).id;
const named = p => Object.keys(SOUNDS).find(n => SOUNDS[n].id === p.id && SOUNDS[n].startAt === undefined) ?? p.id;

section(
	"F. o lanca-chamas: um jato preso com uma ignicao, nunca o 'ping' da arma de choque; para com o gatilho",
	() => {
		const ga = new GameAudio();
		const refs = runRefs();
		const p = refs.player;
		p.weapon.pointer = 25;
		p.weapon.ammoCount = 100;
		ga.startRun(refs);
		plays.length = 0;
		for (let f = 0; f < 60; f++) runFrame(ga, refs, 1 / 60, () => (p.weapon.ammoCount -= f % 4 === 0 ? 1 : 0));
		const ignite = plays.filter(q => q.id === idOf("flameIgnite")).length;
		const jet = plays.filter(q => q.id === idOf("flameLoop")).length;
		const ping = plays.filter(q => q.id === idOf("shotElectric")).length;
		check(WEAPONS[25].name === "Flamethrower", "a arma 25 e o lanca-chamas");
		check(
			ignite === 1 && jet === 1 && ping === 0,
			"um segundo de fogo: uma ignicao, um jato, zero 'ping'",
			`${ignite} / ${jet} / ${ping}`,
		);
		let stopped = -1;
		const jetSound = plays.find(q => q.id === idOf("flameLoop"))?.sound;
		for (let f = 0; f < 60; f++) {
			runFrame(ga, refs);
			if (stopped < 0 && jetSound !== undefined && !jetSound.IsPlaying) stopped = f + 1;
		}
		check(stopped > 0 && stopped <= 40, "soltou o gatilho: o jato para em menos de 0,7 s", `${stopped} quadros`);
		ga.stopRun();
	},
);

section(
	"F2. o motor da moto: o do proprio piloto, sobe com a velocidade; sem oleo, mudo; a bicicleta nao tem motor",
	() => {
		const ga = new GameAudio();
		const refs = runRefs();
		const p = refs.player;
		refs.save.oil = 10;
		ga.startRun(refs);
		plays.length = 0;
		p.ride = { kind: VehicleKind.Motorcycle, heading: 0, speed: 0 };
		for (let f = 0; f < 60; f++) runFrame(ga, refs);
		const eng = plays.find(q => q.id === idOf("engineMoto"))?.sound;
		const idle = eng?.PlaybackSpeed ?? 0;
		p.ride.speed = 255;
		for (let f = 0; f < 90; f++) runFrame(ga, refs);
		check(
			eng !== undefined && idle < 0.9 && eng.PlaybackSpeed > 1.6,
			"parado em ponto morto, grave; na maxima, o giro sobe",
			`${idle.toFixed(2)} -> ${eng?.PlaybackSpeed.toFixed(2)}`,
		);
		refs.save.oil = 0;
		for (let f = 0; f < 60; f++) runFrame(ga, refs);
		check(eng !== undefined && !eng.IsPlaying, "sem oleo o motor nao liga (VEI-05): o som para");
		refs.save.oil = 10;
		p.ride = { kind: VehicleKind.Bicycle, heading: 0, speed: 100 };
		plays.length = 0;
		for (let f = 0; f < 60; f++) runFrame(ga, refs);
		check(!plays.some(q => q.id === idOf("engineMoto")), "de bicicleta, nenhum motor");
		p.ride = undefined;
		ga.stopRun();
	},
);

section("G. a horda: sessenta zumbis sao poucas vozes, variadas, com orcamento; um grupo que vira e UM grito", () => {
	const { VOICE_TOKENS, VOICE_REFILL, GROAN_MIN_GAP, GROAN_REPEAT } = require(join(SRC, "client/audio/gameAudio.ts"));
	const vocalIds = P04.horde.map(idOf);
	const vocal = { has: id => vocalIds.includes(id) };
	const nameOfPlay = q => P04.horde.find(n => idOf(n) === q.id && Math.abs((SOUNDS[n].startAt ?? 0) - q.pos) < 0.01);
	function horde(n, seconds) {
		const ga = new GameAudio();
		const refs = runRefs();
		for (let i = 0; i < n; i++) {
			const a = (i / n) * Math.PI * 2;
			refs.zombies.push({
				id: i + 1,
				type: [1, 1, 4, 2, 5, 3][i % 6],
				x: Math.cos(a) * 500,
				y: Math.sin(a) * 400,
				hp: 1,
				detect: false,
				scale: 1,
			});
		}
		ga.startRun(refs);
		plays.length = 0;
		for (let f = 0; f < seconds * 60; f++) runFrame(ga, refs);
		const v = plays.filter(q => vocal.has(q.id));
		ga.stopRun();
		return v;
	}
	const one = horde(1, 60);
	const sixty = horde(60, 60);
	const cap = VOICE_TOKENS + 60 / VOICE_REFILL;
	check(
		one.length >= 5 && one.length <= 16,
		"um zumbi perto: um gemido a cada poucos segundos",
		`${one.length} em 60 s`,
	);
	check(
		sixty.length <= cap && sixty.length <= 60 / GROAN_MIN_GAP + VOICE_TOKENS,
		`sessenta: no maximo o orcamento (${cap.toFixed(0)}) e o intervalo minimo permitem, nunca um por zumbi`,
		`${sixty.length} em 60 s`,
	);
	check(
		sixty.length > one.length,
		"...mas mais que um zumbi so (a horda se ouve maior)",
		`${one.length} -> ${sixty.length}`,
	);
	let gapMin = Infinity;
	for (let i = 1; i < sixty.length; i++) gapMin = Math.min(gapMin, sixty[i].at - sixty[i - 1].at);
	check(gapMin >= GROAN_MIN_GAP * 0.7 - 1e-6, "nunca dois gemidos colados", `menor intervalo ${gapMin.toFixed(2)} s`);
	const names = sixty.map(nameOfPlay);
	let repeats = 0;
	for (let i = 1; i < names.length; i++) if (names[i] === names[i - 1]) repeats++;
	check(
		repeats === 0 && uniq(names) >= 3,
		"nunca o mesmo take duas vezes seguidas; pelo menos tres takes",
		`${uniq(names)} takes, ${repeats} repeticoes`,
	);
	const pitches = uniq(sixty.map(q => q.speed.toFixed(2)));
	check(pitches >= 5, "e a altura varia (sorteio e tipo)", `${pitches} alturas`);
	// the type's voice: a charger lower than a spitter, on average
	{
		const ga = new GameAudio();
		const refs = runRefs();
		refs.zombies.push({ id: 1, type: 4, x: 300, y: 0, hp: 1, detect: false, scale: 1 });
		ga.startRun(refs);
		plays.length = 0;
		for (let f = 0; f < 60 * 40; f++) runFrame(ga, refs);
		const charger = plays.filter(q => vocal.has(q.id)).map(q => q.speed / (q.sound.PlaybackSpeed > 0 ? 1 : 1));
		refs.zombies[0].type = 2;
		ga.startRun(refs);
		plays.length = 0;
		for (let f = 0; f < 60 * 40; f++) runFrame(ga, refs);
		const spitter = plays.filter(q => vocal.has(q.id)).map(q => q.speed);
		const avg = a => a.reduce((s, v) => s + v, 0) / Math.max(1, a.length);
		check(
			avg(charger) < avg(spitter) * 0.85,
			"a voz do tipo: o charger mais grave que o cuspidor",
			`${avg(charger).toFixed(2)} vs ${avg(spitter).toFixed(2)}`,
		);
		ga.stopRun();
	}
	// one zombie never twice within GROAN_REPEAT
	{
		const ga = new GameAudio();
		const refs = runRefs();
		refs.zombies.push({ id: 7, type: 1, x: 200, y: 0, hp: 1, detect: false, scale: 1 });
		ga.startRun(refs);
		plays.length = 0;
		for (let f = 0; f < 60 * 60; f++) runFrame(ga, refs);
		const v = plays.filter(q => vocal.has(q.id));
		let min = Infinity;
		for (let i = 1; i < v.length; i++) min = Math.min(min, v[i].at - v[i - 1].at);
		check(
			min >= GROAN_REPEAT - 1e-6,
			`o mesmo zumbi nunca geme duas vezes em ${GROAN_REPEAT} s`,
			`menor ${min.toFixed(2)} s`,
		);
		ga.stopRun();
	}
	// aggro: a lone zombie snarls; ten turning at once are ONE shout
	for (const [n, want] of [
		[1, "aggro"],
		[10, "zombieShout"],
	]) {
		const ga = new GameAudio();
		const refs = runRefs();
		for (let i = 0; i < n; i++)
			refs.zombies.push({ id: 100 + i, type: 1, x: 300 + i * 20, y: 0, hp: 1, detect: false, scale: 1 });
		ga.startRun(refs);
		for (let f = 0; f < 5; f++) runFrame(ga, refs);
		plays.length = 0;
		runFrame(ga, refs, 1 / 60, () => refs.zombies.forEach(z => (z.detect = true)));
		for (let f = 0; f < 10; f++) runFrame(ga, refs);
		const v = plays.filter(q => vocal.has(q.id)).map(nameOfPlay);
		const ok = want === "aggro" ? v.length === 1 && /^zombieAggro/.test(v[0]) : v.join() === "zombieShout";
		check(
			ok,
			n === 1 ? "um zumbi que te viu: um rosnado" : "dez que viram juntos: UM grito, nao dez",
			v.join(", "),
		);
		ga.stopRun();
	}
});

console.log(`\n[test-audio] ${checks - failures}/${checks} checks passed`);
if (failures > 0) {
	console.log(`[test-audio] ${failures} FAILED`);
	process.exit(1);
}
