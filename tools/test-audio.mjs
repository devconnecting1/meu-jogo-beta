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
 * The audit of 2026-09-24 (DESIGN_RULES SND). Each of these failed on the code before it (f5f386a), with the number
 * in the check's text:
 *   H1. WINDOWS        a window of a file is FILE time (Sound.PlaybackRegion; the deadline divided by the speed): a groan
 *                      pitched down is not cut early, one pitched up does not run into the next phrase.
 *   H2. MIN GAP        the same sound within its minGap is one event: eight pellets, ten deaths in one blast, one sound.
 *   H3. OUR SOUNDS     without a bank id every event is the library entry, unchanged (SND-01); with one, the bank's
 *                      window, takes in rotation; a bank the client cannot load goes back to the library.
 *   H4. VARIATION      volume jitter and pitch on every repeat; no base volume over 0.6.
 *   H5. LEAVING        stopRun stops the world (voices, loops, tracks), not the UI click that left.
 *   H6. TRACKS         a clip change never jumps in (heartbeat 1 -> 2 -> 3 in 1.5 s); a fading clip is taken back.
 *   H7. HYSTERESIS     HP wandering across 35 % does not flap the heartbeat.
 *   H8. OWN SOUNDS     the survivor's own sounds are flat (the camera trails them); allies' are spatial; the engine you
 *                      ride is on the ear.
 *   H9. HURT           poison and starvation do not restart the grunt every frame; a hit does, once per 0.35 s.
 *   H10. BOSS, STINGER a boss at the interest edge roars at most every 12 s; a clock stinger does not repeat.
 *   H11. ONE READER    refs.fx is played once (fxView), never drained a second time before render.
 *   H12. PICKUPS       ammo, food, material, gear: each its sound; building and refusing have one; level up too.
 *   H13. LOOPS END     dismount, death, respawn, leaving, the MP-22 town, an ally's ride or session gone, out of fuel,
 *                      put away (ITM-06): every held loop stops within a third of a second.
 *   H14. FOCUS         the real bootstrap: losing the window's focus lets go of the trigger.
 *   I.  TEN MINUTES    36 000 frames of horde, guns, motorcycles, UI, day and night, the slider at 0 and MP-22 resets:
 *                      no Instance created, voices within the pool and each sound within its limit, the horde's memory
 *                      bounded, nothing left playing after leaving.
 *   J.  OUR BANKS      every take of tools/gen-sfx.mjs: true peak <= -1 dBTP, loudness on its category's target, silent
 *                      edges, no DC, windows that never overlap, heart loops continuous at the wrap; the committed WAVs,
 *                      the manifest and the generated audioAssets.ts are what the generator makes; the mix order.
 *   K.  UPLOAD         `npm run cloud -- upload-audio`: the dry run reads no key; against tools/fake-open-cloud.mjs,
 *                      Audio assets in audio/wav, only new or changed banks, ids and hashes written, a stale id left
 *                      out of the module, a bank refused by moderation kept out.
 *   L.  THUNDER        (LUZ-05) a storm plays one thunderclap per clap of the schedule the server masks the horde's ears
 *                      with, at the strike's level; none in a plain rain or a clear day; a clock that jumps plays none;
 *                      the library's thunder without the bank's id, our three takes with it.
 *
 * Pure Node (>= 18) + the project's TypeScript on the shared shims (tools/ui-shim.mjs).
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installUiShims } from "./ui-shim.mjs";

const ui = installUiShims({ seed: 3, viewport: [1120, 630] });
const { SRC, ROOT, require, flush, service, setClock, getClock } = ui;
/** Luau's pairs, for the catalogue's name list and the bank table (the shims do not model it) */
globalThis.pairs ??= t => Object.entries(t);

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
				inst.playStarted = getClock();
				plays.push({
					region: inst.PlaybackRegionsEnabled === true ? inst.PlaybackRegion?.Min : undefined,
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

// ================================================================ H. the mixer's edge cases (the audit, 2026-09-24)

const S = require(join(SRC, "shared/data/sounds.ts"));
const AA = require(join(SRC, "shared/data/audioAssets.ts"));
const MIX = require(join(SRC, "client/audio/audio.ts"));
const PK = require(join(SRC, "client/systems/pickups.ts"));
const BC = require(join(SRC, "client/systems/buildCues.ts"));
const { ItemKind } = require(join(SRC, "shared/data/kinds.ts"));
const { GameMusic } = require(join(SRC, "client/audio/music.ts"));
const GA = require(join(SRC, "client/audio/gameAudio.ts"));
const near = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps;
/** seconds of mixer frames (the Heartbeat the mixer runs on) */
const advance = (seconds, dt = 1 / 60) => {
	for (let t = 0; t < seconds - 1e-9; t += dt) frame(dt);
};
/** every audio.play(name) asked for, by name, whether it sounded or not (a spy on the real mixer) */
const asked = [];
{
	const real = audio.play.bind(audio);
	audio.play = (name, opts) => {
		asked.push(name);
		real(name, opts);
	};
}
const askedOf = n => asked.filter(a => a === n).length;
const isFlat = snd => snd.Parent?.ClassName !== "Attachment";
const BANK_IDS = { ui: "rbxassetid://7001", items: "rbxassetid://7002", weapons: "rbxassetid://7003" };
Object.assign(BANK_IDS, { impacts: "rbxassetid://7004", cues: "rbxassetid://7005", weather: "rbxassetid://7006" });
/** hands every bank an id (as an upload would), or takes them all away */
function banks(on) {
	for (const b of Object.keys(AA.AUDIO_BANK_IDS)) AA.AUDIO_BANK_IDS[b] = on ? BANK_IDS[b] : "";
	S.refreshSounds();
}

section("H1. uma janela e tempo do ARQUIVO: grave dura mais, agudo nao invade a frase seguinte", () => {
	audio.stopAll();
	advance(0.2);
	plays.length = 0;
	audio.play("zombieGroanD", { x: 100, y: 0, pitch: 0.6 });
	const low = plays.at(-1)?.sound;
	check(
		low?.PlaybackRegionsEnabled === true && near(low.PlaybackRegion.Min, 0) && near(low.PlaybackRegion.Max, 1.1),
		"a janela vira Sound.PlaybackRegion (0 a 1,1 s do arquivo): o motor a encerra na amostra certa, em qualquer altura",
		`${low?.PlaybackRegion?.Min}..${low?.PlaybackRegion?.Max}`,
	);
	advance(1.5);
	const aliveAt15 = low?.IsPlaying === true;
	advance(0.4);
	check(
		aliveAt15 && low.IsPlaying === false,
		"a 0,6x a janela de 1,1 s dura 1,83 s: viva a 1,5 s (antes era cortada a 1,1 s), parada a 1,9 s",
	);
	plays.length = 0;
	audio.play("zombieGroanA", { x: 100, y: 0, pitch: 1.2 });
	const high = plays.at(-1)?.sound;
	advance(1.75);
	check(
		high?.IsPlaying === false && near(high.PlaybackRegion.Max, 1.08 + 2.05),
		"a 1,2x a janela de 2,05 s acaba em 1,71 s (antes corria ate 2,05 s: entrava na engasgada do gemido B, 3,46 s)",
	);
	// a plain sound on the voice a window used: the region is switched off, once
	audio.stopAll();
	advance(0.2);
	plays.length = 0;
	audio.play("zombieGroanB", { x: 50, y: 0 });
	const first = plays.at(-1)?.sound;
	audio.stopAll();
	advance(0.2);
	audio.play("explosion", { x: 50, y: 0 });
	const second = plays.at(-1)?.sound;
	check(
		first === second && second.PlaybackRegionsEnabled === false,
		"a voz do pool que tocou uma janela toca o proximo som inteiro (PlaybackRegionsEnabled volta a false)",
	);
	audio.stopAll();
});

section("H2. o mesmo som dentro do intervalo minimo e o mesmo evento: oito chumbos, dez mortes, UM som", () => {
	advance(0.2);
	plays.length = 0;
	for (let i = 0; i < 8; i++) audio.play("hitFlesh", { x: 100 + i * 12, y: 30 });
	const hits = plays.filter(p => p.id === idOf("hitFlesh")).length;
	check(
		hits === 1,
		"oito chumbos da escopeta no mesmo quadro: UM impacto (antes 8 Play(), 4 vozes somadas)",
		`${hits}`,
	);
	plays.length = 0;
	for (let i = 0; i < 10; i++) audio.play("zombieDeath", { x: 200 + i * 20, y: -40 });
	check(plays.filter(p => p.id === idOf("zombieDeath")).length === 1, "dez zumbis mortos numa explosao: UMA morte");
	advance(soundDef("hitFlesh").minGap + 0.02);
	plays.length = 0;
	audio.play("hitFlesh", { x: 100, y: 30 });
	check(plays.length === 1, "passado o intervalo (50 ms), o proximo impacto toca");
	plays.length = 0;
	audio.play("footstepA", { scale: 0.85 });
	audio.play("footstepA", { x: 60, y: 0 });
	check(plays.length === 1, "dois passos do mesmo take no mesmo quadro (voce e um aliado colado): um so");
	audio.stopAll();
});

section(
	"H3. nossos sons: sem id nada muda (SND-01); com id, a janela do banco, takes alternados; banco que nao carrega volta a biblioteca",
	() => {
		banks(false);
		const names = S.soundNames();
		const same = names.filter(n => S.soundDef(n) === S.librarySoundDef(n));
		check(
			same.length === names.length,
			`sem id de banco, cada um dos ${names.length} eventos toca a entrada da biblioteca, a mesma de antes`,
			names.filter(n => !same.includes(n)).join(", "),
		);
		const synthNames = Object.keys(AA.SYNTH_SOUNDS);
		check(
			synthNames.every(n => S.SOUNDS[n] !== undefined),
			`os ${synthNames.length} eventos sintetizados existem no catalogo (cada um com a sua entrada de biblioteca)`,
			synthNames.filter(n => S.SOUNDS[n] === undefined).join(", "),
		);
		const noFallback = synthNames.filter(n => S.SOUNDS[n].id === "");
		check(
			noFallback.join() === "useInject",
			"e so a injecao nao tinha som na biblioteca: o nosso banco e o primeiro a preenche-la",
			noFallback.join(", "),
		);
		banks(true);
		const pistol = S.soundDef("shotPistol");
		const lib = S.librarySoundDef("shotPistol");
		check(
			pistol.id === BANK_IDS.weapons &&
				pistol.source === "synth" &&
				pistol.takes.length === 3 &&
				pistol.bus === lib.bus &&
				pistol.voices === lib.voices &&
				pistol.priority === lib.priority &&
				pistol.spatial === lib.spatial &&
				pistol.maxPlay === undefined,
			"com o banco no ar: o tiro toca o nosso banco (3 takes), com o papel da biblioteca (barramento, vozes, prioridade)",
		);
		const heart = S.soundDef("heartbeat1");
		check(
			heart.loop === true && heart.loopStart > 0 && heart.loopEnd > heart.loopStart && heart.takes === undefined,
			"o batimento: um loop, a sua regiao do banco (LoopRegion), sem takes",
			`${heart.loopStart}..${heart.loopEnd}`,
		);
		// round robin: thirty shots never repeat the take before
		plays.length = 0;
		for (let i = 0; i < 30; i++) {
			audio.play("shotPistol");
			advance(0.1);
		}
		const shots = plays.filter(p => p.id === BANK_IDS.weapons).map(p => p.region);
		let repeats = 0;
		for (let i = 1; i < shots.length; i++) if (shots[i] === shots[i - 1]) repeats++;
		const windows = pistol.takes.map(t => t.startAt);
		check(
			shots.length === 30 && repeats === 0 && windows.every(w => shots.includes(w)),
			"30 tiros: os 3 takes, nunca o mesmo duas vezes seguidas, cada um na sua janela do banco",
			`${shots.length} tiros, ${repeats} repeticoes`,
		);
		const pos = plays.filter(p => p.id === BANK_IDS.weapons).map(p => p.pos);
		check(
			pos.every((v, i) => near(v, shots[i])),
			"e cada um comeca na sua janela (TimePosition = inicio do take)",
		);
		// a heartbeat track plays its region
		const music = new GameMusic();
		plays.length = 0;
		music.update({ isNight: false, dayTime: 12, hpRatio: 0.3, dead: false });
		advance(0.5);
		const hb = plays.find(p => p.id === BANK_IDS.cues)?.sound;
		check(
			hb !== undefined &&
				hb.PlaybackRegionsEnabled === true &&
				near(hb.LoopRegion.Min, heart.loopStart) &&
				near(hb.TimePosition, heart.loopStart),
			"a faixa do batimento toca a sua regiao do banco em loop (LoopRegion) e comeca nela, nao no inicio do banco",
		);
		music.stop();
		advance(2);
		// a bank this client cannot load: back to the library, and the library takes fetched
		const cp = service("ContentProvider");
		const fetched = [];
		cp.PreloadAsync = (list, cb) => {
			for (const inst of list) {
				fetched.push(inst.SoundId);
				const failed = inst.SoundId === BANK_IDS.cues;
				cb(inst.SoundId, failed ? Enum.AssetFetchStatus.Failure : Enum.AssetFetchStatus.Success);
			}
		};
		const created0 = created;
		const missed = audio.preloadSounds(S.soundAssetIds());
		const heartAfter = S.soundDef("heartbeat1");
		check(
			missed === 1 &&
				heartAfter.id === S.librarySoundDef("heartbeat1").id &&
				S.soundDef("shotPistol").id === BANK_IDS.weapons,
			"o banco 'cues' nao carrega: o batimento e as vinhetas voltam a biblioteca nesta sessao; os outros bancos seguem",
			`${missed} faltou, batimento ${heartAfter.id}`,
		);
		check(
			fetched.includes(S.librarySoundDef("heartbeat1").id) &&
				fetched.includes(S.librarySoundDef("stingerWave1").id),
			"...e os takes da biblioteca que entram no lugar sao buscados na mesma hora (nao tocam mudos na primeira vez)",
		);
		check(
			SoundService.FindFirstChild("ProjectZAudio")?.FindFirstChild("Preload") === undefined,
			"o preload nao deixa nada para tras (a pasta temporaria e destruida)",
			`${created - created0} Instances temporarias`,
		);
		check(
			!S.dropSoundAsset("rbxassetid://9114716927"),
			"um id da biblioteca que falha nao derruba nada (nao ha para onde voltar)",
		);
		cp.PreloadAsync = () => {};
		banks(false);
		check(S.soundDef("shotPistol") === S.librarySoundDef("shotPistol"), "tirando o id, volta a biblioteca");
		audio.stopAll();
		advance(0.3);
	},
);

section("H4. variacao: volume com jitter, altura sorteada, nunca identico", () => {
	plays.length = 0;
	for (let i = 0; i < 40; i++) {
		audio.play("footstepA", { x: 30, y: 0 });
		advance(0.1);
	}
	const def = soundDef("footstepA");
	const vols = plays.filter(p => p.id === def.id).map(p => p.volume);
	const inRange = vols.every(v => v <= def.volume + 1e-9 && v >= def.volume * (1 - def.volJitter) - 1e-9);
	check(
		vols.length === 40 && inRange && uniq(vols.map(v => v.toFixed(4))) >= 20,
		`40 passos: volume entre ${(def.volume * (1 - def.volJitter)).toFixed(3)} e ${def.volume} e quase nunca igual`,
		`${uniq(vols.map(v => v.toFixed(4)))} volumes distintos`,
	);
	const speeds = plays.filter(p => p.id === def.id).map(p => p.speed.toFixed(3));
	check(uniq(speeds) >= 20, "e a altura tambem varia a cada passo", `${uniq(speeds)} alturas`);
	const loud = Object.entries(S.SOUNDS).filter(([, d]) => d.volume > 0.6);
	check(loud.length === 0, "nenhum volume base passa de 0,6 (nenhum susto)", loud.map(([n]) => n).join(", "));
	audio.stopAll();
});

section("H5. sair da partida para o mundo, nao o clique que saiu (a UI continua)", () => {
	const ga = new GameAudio();
	const refs = runRefs();
	ga.startRun(refs);
	for (let f = 0; f < 5; f++) runFrame(ga, refs);
	plays.length = 0;
	audio.play("uiClick");
	audio.play("shotRifle", { x: 40, y: 0 });
	audio.holdLoop(4242, "engineMoto", 0, 0, 1, 1);
	const click = plays.find(p => p.id === idOf("uiClick"))?.sound;
	const shot = plays.find(p => p.id === idOf("shotRifle"))?.sound;
	ga.stopRun();
	check(
		click?.IsPlaying === true && shot?.IsPlaying === false && audio.activeLoops() === 0,
		"stopRun: o tiro e o motor param na hora; o clique do botao 'Home' continua (antes era cortado no mesmo quadro)",
	);
	advance(0.5);
});

section("H6. a faixa: trocar de clipe nunca entra aos saltos (batimento 1 -> 2 -> 3 em 1,5 s)", () => {
	const music = new GameMusic();
	const heart = music.heart;
	const fadeIn = heart.fadeIn;
	let worstJump = 0;
	let badEntry = "";
	let prev = heart.slots.map(s => ({ id: s.sound.SoundId, gain: s.gain }));
	const step = hp => {
		music.update({ isNight: false, dayTime: 12, hpRatio: hp, dead: false });
		frame(1 / 60);
		heart.slots.forEach((s, i) => {
			const was = prev[i];
			const jump = s.gain - (was.id === s.sound.SoundId ? was.gain : 0);
			if (jump > worstJump) worstJump = jump;
			if (was.id !== s.sound.SoundId && was.gain > 0.001 && s.sound.IsPlaying && s.gain > 1 / 60 / fadeIn + 1e-6)
				badEntry = `${s.sound.SoundId} entrou a ${s.gain.toFixed(2)}`;
		});
		prev = heart.slots.map(s => ({ id: s.sound.SoundId, gain: s.gain }));
	};
	for (let f = 0; f < 30; f++) step(0.3);
	for (let f = 0; f < 30; f++) step(0.2);
	for (let f = 0; f < 30; f++) step(0.05);
	check(
		worstJump <= 1 / 60 / fadeIn + 1e-6 && badEntry === "",
		"tres niveis em 1,5 s: cada faixa sobe no maximo o passo do fade por quadro; um clipe novo sempre entra do zero",
		badEntry || `maior subida ${worstJump.toFixed(3)} por quadro (fade ${(1 / 60 / fadeIn).toFixed(3)})`,
	);
	// 1 -> 2 -> 1 inside the fade: heartbeat 1 is taken back where it was, not restarted
	music.stop();
	advance(3);
	plays.length = 0;
	for (let f = 0; f < 40; f++) step(0.3);
	for (let f = 0; f < 10; f++) step(0.2);
	for (let f = 0; f < 20; f++) step(0.3);
	check(
		plays.filter(p => p.id === idOf("heartbeat1")).length === 1,
		"1 -> 2 -> 1 dentro do fade: o batimento 1 e retomado onde estava (um Play so), sem recomecar",
		`${plays.filter(p => p.id === idOf("heartbeat1")).length} Play()`,
	);
	music.stop();
	advance(3);
});

section("H7. o batimento nao vai-e-vem em cima do limiar (histerese)", () => {
	const music = new GameMusic();
	plays.length = 0;
	for (let f = 0; f < 300; f++) {
		music.update({ isNight: false, dayTime: 12, hpRatio: f % 2 === 0 ? 0.345 : 0.36, dead: false });
		frame(1 / 60);
	}
	const hb = plays.filter(p => [idOf("heartbeat1"), idOf("heartbeat2"), idOf("heartbeat3")].includes(p.id)).length;
	check(
		hb === 1 && music.heartLevel === 1,
		"HP oscilando 34,5 % / 36 % por 5 s: o batimento 1 entra uma vez e fica (antes: troca a cada quadro)",
		`${hb} Play(), nivel ${music.heartLevel}`,
	);
	for (let f = 0; f < 10; f++) music.update({ isNight: false, dayTime: 12, hpRatio: 0.4, dead: false });
	check(music.heartLevel === 0, "curado acima de 35 % + 3 %: o batimento sai");
	music.stop();
	advance(3);
});

section("H8. os sons do PROPRIO sobrevivente sao centrados; os do mundo, espaciais", () => {
	const ga = new GameAudio();
	const refs = runRefs();
	const p = refs.player;
	p.weapon.pointer = WEAPONS.findIndex(w => w?.name === "Pistol");
	p.weapon.ammoCount = 12;
	ga.startRun(refs);
	// running right at 250 u/s: the camera trails by speed / 8 (camera.follow, lerp dt * 8)
	const cam = () => [p.x - 250 / 8, p.y];
	const run = mutate => {
		ga.beforeUpdate(refs);
		mutate?.();
		p.x += 250 / 60;
		ga.afterUpdate(refs, 1 / 60);
		ga.frame(refs, ...cam());
		frame(1 / 60);
	};
	for (let f = 0; f < 10; f++) run();
	plays.length = 0;
	run(() => (p.weapon.ammoCount -= 1));
	run(() => (p.weapon.reloading = true));
	for (let f = 0; f < 5; f++) run();
	run(() => {
		p.weapon.reloading = false;
		p.weapon.ammoCount = 12;
	});
	ga.emptyMagazine();
	advance(0.1);
	run(() => (p.weapon.pointer = 0));
	const own = plays.filter(q =>
		["shotPistol", "reloadStart", "reloadEnd", "emptyClick", "weaponSwitch"].some(n => q.id === idOf(n)),
	);
	check(
		own.length >= 5 && own.every(q => isFlat(q.sound)),
		"correndo com a camera 31 u atras: tiro, recarga, clique vazio e troca de arma tocam centrados, nao puxados para o lado",
		`${own.length} sons, ${own.filter(q => !isFlat(q.sound)).length} espaciais`,
	);
	// an ally's shot is in the world
	plays.length = 0;
	FA.remoteShotSound(
		WEAPONS.findIndex(w => w?.name === "Pistol"),
		p.x + 400,
		p.y,
	);
	const ally = plays.at(-1)?.sound;
	check(
		ally !== undefined && !isFlat(ally) && near(ally.Parent.Position.X, (p.x + 400) / 16, 1e-6),
		"o tiro de um aliado a 400 u a direita: espacial, no lugar dele",
	);
	// the engine you ride is held at the ear
	refs.save.oil = 10;
	p.ride = { kind: VehicleKind.Motorcycle, heading: 0, speed: 200 };
	plays.length = 0;
	for (let f = 0; f < 20; f++) run();
	const eng = plays.find(q => q.id === idOf("engineMoto"))?.sound;
	const [cx] = cam();
	check(
		eng !== undefined && near(eng.Parent.Position.X, cx / 16, 0.2),
		"o motor da sua moto fica no ouvido (na camera), nao 25 u a frente dele",
		`${eng?.Parent?.Position?.X?.toFixed(2)} vs ${(cx / 16).toFixed(2)} studs`,
	);
	p.ride = undefined;
	ga.stopRun();
	advance(0.5);
});

section("H9. dor e um GOLPE: veneno e fome nao repetem o gemido a cada quadro", () => {
	const ga = new GameAudio();
	const refs = runRefs();
	const p = refs.player;
	ga.startRun(refs);
	asked.length = 0;
	// poison: 1.8 HP/s, every frame (client prediction)
	for (let f = 0; f < 300; f++) runFrame(ga, refs, 1 / 60, () => (p.hp -= 1.8 / 60));
	// starvation at 30 fps: 0.02 HP a frame
	for (let f = 0; f < 150; f++) runFrame(ga, refs, 1 / 30, () => (p.hp -= 0.6 / 30));
	// poison through the server's snapshots (20 Hz)
	for (let f = 0; f < 300; f++) runFrame(ga, refs, 1 / 60, () => (p.hp -= f % 3 === 0 ? 0.09 : 0));
	check(
		askedOf("playerHurt") === 0,
		"veneno 5 s, fome 5 s a 30 fps, veneno por snapshot 5 s: nenhum gemido",
		`${askedOf("playerHurt")}`,
	);
	p.hp = 60;
	for (let f = 0; f < 5; f++) runFrame(ga, refs);
	asked.length = 0;
	runFrame(ga, refs, 1 / 60, () => (p.hp -= 12));
	for (let f = 0; f < 5; f++) runFrame(ga, refs);
	runFrame(ga, refs, 1 / 60, () => (p.hp -= 12));
	check(
		askedOf("playerHurt") === 1,
		"duas mordidas a 0,1 s: um gemido (HURT_GAP 0,35 s)",
		`${askedOf("playerHurt")}`,
	);
	for (let f = 0; f < 30; f++) runFrame(ga, refs);
	runFrame(ga, refs, 1 / 60, () => (p.hp -= 12));
	check(askedOf("playerHurt") === 2, "a terceira, meio segundo depois: outro gemido");
	ga.stopRun();
	advance(0.5);
});

section("H10. um chefe na borda da area de interesse nao ruge a cada volta; a vinheta nao repete", () => {
	const ga = new GameAudio();
	const refs = runRefs();
	ga.startRun(refs);
	asked.length = 0;
	const boss = { id: 77, x: 500, y: 0, hp: 500, dead: false };
	for (let f = 0; f < 20 * 60; f++) {
		const inside = Math.floor(f / 30) % 2 === 0;
		runFrame(ga, refs, 1 / 60, () => {
			refs.bosses.length = 0;
			if (inside) refs.bosses.push(boss);
		});
	}
	check(
		askedOf("bossRoar") <= Math.ceil(20 / GA.BOSS_ROAR_REPEAT),
		`sai e entra do snapshot a cada 0,5 s por 20 s: no maximo um rugido a cada ${GA.BOSS_ROAR_REPEAT} s (antes: 20)`,
		`${askedOf("bossRoar")} rugidos`,
	);
	asked.length = 0;
	ga.onMessage("Wave 1");
	advance(2);
	ga.onMessage("Wave 1");
	check(askedOf("stingerWave1") === 1, "o mesmo anuncio duas vezes (uma reconexao): uma vinheta");
	ga.stopRun();
	advance(0.5);
});

section("H11. refs.fx tem UM leitor: um som posto entre o update e o render toca uma vez (antes: duas)", () => {
	const { FxView } = require(join(SRC, "client/view/fxView.ts"));
	const view = new FxView();
	const ga = new GameAudio();
	const refs = runRefs();
	ga.startRun(refs);
	const cam = { shake() {} };
	const particles = { bloodBurst() {}, debrisBurst() {} };
	plays.length = 0;
	// update: interaction pushes a door, GameLoop.update's playFx plays and clears it
	refs.fx.push({ kind: "sound", sound: "doorOpen", x: 120, y: 0 });
	view.playSim(refs, cam, particles);
	// between update and render: something else pushes (an admin tool, trackAfter)
	refs.fx.push({ kind: "sound", sound: "ironDoorClose", x: 140, y: 0 });
	ga.frame(refs, 0, 0);
	view.playSim(refs, cam, particles);
	const opens = plays.filter(p => p.id === idOf("doorOpen")).length;
	const closes = plays.filter(p => p.id === idOf("ironDoorClose")).length;
	check(
		opens === 1 && closes === 1,
		"a porta aberta no update e a fechada depois dele: cada uma toca UMA vez",
		`${opens} / ${closes}`,
	);
	check(
		!/drainFxAudio/.test(readFileSync(join(SRC, "client/audio/gameAudio.ts"), "utf8")),
		"o GameAudio nao le mais refs.fx (a leitura dupla saiu da fonte)",
	);
	ga.stopRun();
	advance(0.3);
});

section("H12. a coleta soa como o que foi coletado; construir e recusar tem som", () => {
	const ga = new GameAudio();
	const refs = runRefs();
	ga.startRun(refs);
	const cases = [
		[() => PK.took(ItemKind.Etc, 44), "pickupAmmo", "municao"],
		[() => PK.took(ItemKind.Use, USABLES.find(u => u.name === "Apple").id), "pickupFood", "comida"],
		[() => PK.took(ItemKind.Etc, 23), "pickupMaterial", "madeira"],
		[() => PK.took(ItemKind.Weapon, 1), "pickupItem", "uma arma"],
		[() => PK.took(), "pickupItem", "o saque de um predio"],
	];
	const bad = [];
	for (const [act, want, what] of cases) {
		asked.length = 0;
		runFrame(ga, refs, 1 / 60, act);
		if (!asked.includes(want)) bad.push(`${what}: ${asked.join(",")}`);
		advance(0.1);
	}
	check(bad.length === 0, "municao, comida, material, arma e saque: cada um o seu som", bad.join("; "));
	// the server's path: E press, ItemRemove of a shotgun shell box, the bag grew
	asked.length = 0;
	runFrame(ga, refs, 1 / 60, () => {
		PK.pressed("item", 100, 100);
		PK.itemGone(110, 100, ItemKind.Etc, 45);
		PK.bagGrew();
	});
	check(
		asked.includes("pickupAmmo"),
		"pelo servidor (E, ItemRemove, a mochila cresceu): a caixa de cartuchos soa como municao",
	);
	asked.length = 0;
	runFrame(ga, refs, 1 / 60, () => BC.noteRefused());
	advance(0.3);
	runFrame(ga, refs, 1 / 60, () => BC.notePlaced());
	check(
		asked.includes("buildDeny") && asked.includes("buildPlace"),
		"clicar com o fantasma vermelho: o som de 'nao'; assentar: o baque",
	);
	asked.length = 0;
	ga.levelUp();
	check(asked.includes("levelUp"), "subir de nivel tem o seu som (junto do 'Level UP')");
	ga.stopRun();
	advance(0.3);
});

section(
	"H13. todo loop termina: desmontar, morrer, renascer, sair, mundo novo (MP-22), aliado que sai, sem combustivel, guardado, sem foco",
	() => {
		const ga = new GameAudio();
		const refs = runRefs();
		const p = refs.player;
		refs.save.oil = 10;
		let allies = [];
		GA.setAudioNet({ netActive: () => true, remotePlayers: () => allies });
		ga.startRun(refs);
		const ride = () => (p.ride = { kind: VehicleKind.Motorcycle, heading: 0, speed: 120 });
		const framesUntil = (cond, max = 120) => {
			for (let f = 1; f <= max; f++) {
				runFrame(ga, refs);
				if (cond()) return f;
			}
			return Infinity;
		};
		const local = () => audio.loopActive(1);
		ride();
		for (let f = 0; f < 20; f++) runFrame(ga, refs);
		const on = local();
		p.ride = undefined;
		const offDismount = framesUntil(() => !local());
		ride();
		for (let f = 0; f < 20; f++) runFrame(ga, refs);
		p.dead = true;
		const offDeath = framesUntil(() => !local());
		p.dead = false;
		for (let f = 0; f < 20; f++) runFrame(ga, refs);
		const back = local() && audio.activeLoops() === 1;
		check(
			on && offDismount <= 20 && offDeath <= 20 && back,
			"o motor: liga montado, some ao desmontar e ao morrer (<= 0,33 s), volta ao renascer montado, UMA voz",
			`desmontar ${offDismount}, morrer ${offDeath} quadros`,
		);
		ga.stopRun();
		check(audio.activeLoops() === 0 && !local(), "sair da partida: nenhum loop sobra, no mesmo quadro");
		// MP-22: the town rebuilt around the survivor (stopRun + startRun on the same watcher)
		ga.startRun(refs);
		for (let f = 0; f < 5; f++) runFrame(ga, refs);
		p.ride = undefined;
		const offAfterReset = framesUntil(() => audio.activeLoops() === 0);
		check(offAfterReset <= 20, "mundo novo (MP-22) sem moto: nada do mundo velho continua", `${offAfterReset}`);
		// an ally: riding, then the ride gone from the wire (the vehicle destroyed), then gone from the session
		allies = [{ userId: 55, x: 300, y: 0, ride: VehicleKind.Motorcycle, dead: false }];
		for (let f = 0; f < 20; f++) runFrame(ga, refs);
		const allyOn = audio.loopActive(55 * 4 + 1);
		allies[0].ride = undefined;
		const allyOff = framesUntil(() => !audio.loopActive(55 * 4 + 1));
		allies[0].ride = VehicleKind.Motorcycle;
		for (let f = 0; f < 20; f++) runFrame(ga, refs);
		allies = [];
		const allyGone = framesUntil(() => !audio.loopActive(55 * 4 + 1));
		check(
			allyOn && allyOff <= 20 && allyGone <= 20,
			"a moto de um aliado: toca; o veiculo sai do fio (destruido) ou o aliado sai da sessao: para",
			`${allyOff} / ${allyGone} quadros`,
		);
		// the flamethrower: out of fuel, put away (ITM-06), and the window losing focus (the real bootstrap)
		p.weapon.pointer = FA.FLAMETHROWER_ID;
		p.weapon.ammoCount = 500;
		const jet = () => audio.loopActive(2);
		const fire = n => {
			for (let f = 0; f < n; f++) runFrame(ga, refs, 1 / 60, () => (p.weapon.ammoCount -= f % 4 === 0 ? 1 : 0));
		};
		fire(30);
		const burning = jet();
		const offFuel = framesUntil(() => !jet());
		fire(30);
		p.holstered = true;
		const offHolster = framesUntil(() => !jet());
		p.holstered = undefined;
		check(
			burning && offFuel <= 40 && offHolster <= 40,
			"o jato: acaba o combustivel ou a arma e guardada (as chamas param): some em < 0,7 s",
			`${offFuel} / ${offHolster} quadros`,
		);
		GA.setAudioNet(undefined);
		ga.stopRun();
		advance(0.5);
	},
);

section("H14. perder o foco solta o gatilho (bootstrap real): o jato nao fica preso", () => {
	let boot;
	try {
		boot = require(join(SRC, "client/bootstrap.ts"));
	} catch (e) {
		check(false, "o bootstrap real carrega no shim", String(e).split("\n")[0]);
		return;
	}
	flush();
	const input = boot.getCtx().input;
	boot.pressAttack();
	const held = input.attackHeld === true;
	service("UserInputService").WindowFocusReleased.Fire();
	flush();
	check(held && input.attackHeld === false, "segurando o ataque, a janela perde o foco: attackHeld volta a false");
});

// ================================================================ I. ten minutes of play

section("I. dez minutos de partida: nenhuma Instance nova, vozes no teto, nenhum loop ou faixa sobrando", () => {
	const ga = new GameAudio();
	const refs = runRefs();
	const p = refs.player;
	refs.save.oil = 50;
	let allies = [{ userId: 91, x: 200, y: 100, ride: undefined, dead: false }];
	GA.setAudioNet({ netActive: () => true, remotePlayers: () => allies });
	const music = ga.music;
	settings.soundEffect = 0.6;
	settings.bgm = 0.5;
	ga.startRun(refs);
	for (let f = 0; f < 120; f++) runFrame(ga, refs);
	const c0 = created;
	let nextId = 5000;
	const spawn = () => {
		const a = Math.random() * Math.PI * 2;
		const r = 200 + Math.random() * 900;
		refs.zombies.push({
			id: nextId++,
			type: 1 + (nextId % 5),
			x: p.x + Math.cos(a) * r,
			y: p.y + Math.sin(a) * r,
			hp: 20,
			detect: false,
			scale: 1,
		});
	};
	for (let i = 0; i < 40; i++) spawn();
	let maxVoices = 0;
	let maxLoops = 0;
	let overName = "";
	let hitsPerFrame = 0;
	const FRAMES = 10 * 60 * 60;
	const pistol = WEAPONS.findIndex(w => w?.name === "Pistol");
	for (let f = 0; f < FRAMES; f++) {
		const t = f / 60;
		// the engine ends a one-shot when its file does (the shim never does): at most 2 s here, as the takes are
		for (const v of audio.voices) {
			if (v.active && !v.sound.Looped && getClock() - (v.sound.playStarted ?? 0) > 2) v.sound.IsPlaying = false;
		}
		const n0 = plays.length;
		runFrame(ga, refs, 1 / 60, () => {
			// the horde: walking, noticing, dying and coming back
			for (const z of refs.zombies) {
				z.x += Math.sin(t + z.id) * 0.8;
				if (f % 97 === z.id % 97) z.detect = !z.detect;
			}
			if (f % 45 === 0 && refs.zombies.length > 0) {
				const z = refs.zombies[f % refs.zombies.length];
				z.hp -= 10;
			}
			for (let i = refs.zombies.length - 1; i >= 0; i--) {
				if (refs.zombies[i].hp <= 0) {
					refs.zombies.splice(i, 1);
					spawn();
				}
			}
			// a shotgun blast: eight zombies hit in one frame
			if (f % 600 === 300) for (const z of refs.zombies.slice(0, 8)) z.hp -= 1;
			// the survivor's gun, reloads and switches
			if (f % 900 === 0) p.weapon.pointer = pistol;
			if (f % 20 === 0 && p.weapon.ammoCount > 0 && !p.weapon.reloading) p.weapon.ammoCount -= 1;
			if (p.weapon.ammoCount === 0 && !p.weapon.reloading) p.weapon.reloading = true;
			else if (p.weapon.reloading && f % 90 === 0) {
				p.weapon.reloading = false;
				p.weapon.ammoCount = 12;
			}
			// the motorcycle, a quarter of the time; the ally rides the other half
			p.ride = t % 120 < 30 ? { kind: VehicleKind.Motorcycle, heading: 0, speed: 60 + (t % 7) * 20 } : undefined;
			allies[0].ride = t % 120 >= 60 ? VehicleKind.Motorcycle : undefined;
			allies[0].x += 1;
			// HP down and up (the heartbeat), a bite now and then
			p.hp = 50 + 45 * Math.sin(t / 20);
			// day and night
			refs.daynight.isNight = t % 240 >= 120;
			refs.daynight.dayTime = refs.daynight.isNight ? 22 : 12;
			// the UI and a pickup
			if (f % 300 === 0) audio.play("uiClick");
			if (f % 1800 === 900) PK.took(ItemKind.Etc, 44);
			// the SFX slider to 0 and back once a minute
			settings.soundEffect = t % 60 < 3 ? 0 : 0.6;
		});
		if (f % 60 === 0) {
			const active = audio.voices.filter(v => v.active);
			maxVoices = Math.max(maxVoices, active.length);
			maxLoops = Math.max(maxLoops, audio.activeLoops());
			const counts = {};
			for (const v of active) counts[v.name] = (counts[v.name] ?? 0) + 1;
			for (const [n, c] of Object.entries(counts)) if (c > soundDef(n).voices) overName = `${n} x${c}`;
		}
		if (f % 600 === 300) {
			const blast = plays.slice(n0).filter(q => q.id === idOf("hitFlesh")).length;
			hitsPerFrame = Math.max(hitsPerFrame, blast);
		}
		// MP-22 every 2.5 minutes: the town rebuilt around the survivor
		if (f % 9000 === 8999) {
			ga.stopRun();
			ga.startRun(refs);
		}
		if (f % 600 === 0) plays.length = 0;
	}
	check(
		created === c0,
		"36 000 quadros (10 min) de horda, tiros, motos, UI, dia e noite: ZERO Instance nova",
		`${created - c0}`,
	);
	check(
		maxVoices <= MIX.SPATIAL_VOICES + MIX.FLAT_VOICES && overName === "",
		`vozes nunca acima do pool (${MIX.SPATIAL_VOICES} + ${MIX.FLAT_VOICES}), nem de um som acima do seu limite`,
		`pico ${maxVoices}${overName ? `, ${overName}` : ""}`,
	);
	check(maxLoops <= 2, "no maximo os dois motores (o seu e o do aliado) em loop", `${maxLoops}`);
	check(
		hitsPerFrame === 1,
		"cada rajada de escopeta (8 zumbis atingidos no mesmo quadro): UM impacto",
		`${hitsPerFrame}`,
	);
	check(
		ga.lastGroan.size() <= 60 && ga.lastAggro.size() <= 60 && ga.bossRoarAt.size() <= 4 && ga.riders.size() <= 1,
		"a memoria da horda e das motos nao cresce com a noite (zumbis que se foram sao esquecidos)",
		`gemidos ${ga.lastGroan.size()}, rosnados ${ga.lastAggro.size()}, motos ${ga.riders.size()}`,
	);
	ga.stopRun();
	for (let f = 0; f < 300; f++) frame(1 / 60);
	const tracksLeft = audio.tracks.filter(tr => tr.slots.some(s => s.sound.IsPlaying));
	check(
		audio.activeLoops() === 0 &&
			tracksLeft.length === 0 &&
			audio.voices.filter(v => v.active && v.bus !== "ui").length === 0,
		"ao sair: nenhum loop, nenhuma faixa tocando (depois do fade), nenhuma voz do mundo",
		`${audio.activeLoops()} loops, ${tracksLeft.length} faixas`,
	);
	GA.setAudioNet(undefined);
	settings.soundEffect = 0.5;
});

// ================================================================ J. our own sounds, as rendered

const SFX = await import(join(ROOT, "tools", "gen-sfx.mjs"));

section(
	"J. os nossos sons: pico <= -1 dBTP, loudness no alvo da categoria, bordas em silencio, os bancos batem com o gerador",
	() => {
		const manifest = JSON.parse(readFileSync(join(ROOT, "design", "audio", "manifest.json"), "utf8"));
		const { banks: rendered, sounds } = SFX.renderAll();
		const bad = [];
		for (const [name, s] of Object.entries(sounds)) {
			s.metrics.forEach((m, i) => {
				if (m.truePeak > SFX.PEAK_CEILING + 1e-9) bad.push(`${name}#${i + 1} pico ${m.truePeak}`);
				if (m.lufs > s.target + 0.3 || m.lufs < s.target - SFX.SHORTFALL)
					bad.push(`${name}#${i + 1} ${m.lufs} LUFS (alvo ${s.target})`);
			});
		}
		check(
			bad.length === 0,
			`${Object.values(sounds).reduce((a, s) => a + s.takes.length, 0)} takes: pico real <= ${SFX.PEAK_CEILING} dBTP e loudness entre alvo - ${SFX.SHORTFALL} e alvo + 0,3 LU`,
			bad.slice(0, 6).join("; "),
		);
		// edges, DC, silence between takes
		const edgeBad = [];
		for (const [name, s] of Object.entries(sounds)) {
			const bank = rendered[s.bank];
			for (const t of s.takes) {
				const a = Math.round((t.startAt + 0.01) * SFX.SR);
				const b = Math.round((t.startAt + t.maxPlay - 0.03) * SFX.SR);
				const x = bank.subarray(a, b);
				let mean = 0;
				for (const v of x) mean += v;
				mean /= x.length;
				if (s.loopStart === undefined && (Math.abs(x[0]) > 0.02 || Math.abs(x[x.length - 1]) > 0.002))
					edgeBad.push(`${name} borda`);
				// a thump's mean over its 100 ms is its low end, not an offset: -40 dB is the line
				if (Math.abs(mean) > 0.01) edgeBad.push(`${name} DC ${mean.toFixed(4)}`);
				if (
					Math.abs(bank[Math.round(t.startAt * SFX.SR)]) > 1e-6 ||
					Math.abs(bank[Math.round((t.startAt + t.maxPlay) * SFX.SR) - 1]) > 1e-6
				)
					edgeBad.push(`${name} a janela nao abre e fecha em silencio`);
			}
		}
		check(
			edgeBad.length === 0,
			"cada take comeca e acaba em silencio, sem DC, e a janela dele tem silencio dos dois lados",
			edgeBad.slice(0, 6).join("; "),
		);
		// the windows of a bank never overlap
		const overlap = [];
		for (const bank of SFX.BANKS) {
			const w = Object.entries(sounds)
				.filter(([, s]) => s.bank === bank)
				.flatMap(([n, s]) => s.takes.map(t => [n, t.startAt, t.startAt + t.maxPlay]))
				.sort((a, b) => a[1] - b[1]);
			for (let i = 1; i < w.length; i++) if (w[i][1] < w[i - 1][2]) overlap.push(`${w[i - 1][0]} / ${w[i][0]}`);
		}
		check(
			overlap.length === 0,
			"as janelas de um banco nunca se sobrepoem (um take nunca toca o vizinho)",
			overlap.join(", "),
		);
		// the loops loop: the step across the wrap (last sample -> first) is no bigger than any step inside the loop
		const loopBad = [];
		for (const [name, s] of Object.entries(sounds)) {
			if (s.loopStart === undefined) continue;
			const bank = rendered[s.bank];
			const a = Math.round(s.loopStart * SFX.SR);
			const b = Math.round(s.loopEnd * SFX.SR);
			let maxStep = 0;
			for (let i = a + 1; i < b; i++) maxStep = Math.max(maxStep, Math.abs(bank[i] - bank[i - 1]));
			const wrap = Math.abs(bank[a] - bank[b - 1]);
			if (wrap > maxStep) loopBad.push(`${name} ${wrap.toFixed(4)} > ${maxStep.toFixed(4)}`);
		}
		check(
			loopBad.length === 0,
			"os loops do batimento sao continuos na volta do LoopRegion (o rabo da ultima batida dobrado no inicio): nao estala",
			loopBad.join(", "),
		);
		// the committed banks are what the renderer makes (1 LSB of tolerance), and the manifest matches
		const drift = [];
		for (const b of SFX.BANKS) {
			const have = SFX.decodeWav(readFileSync(join(ROOT, "design", "audio", "banks", `${b}.wav`)));
			const want = SFX.decodeWav(SFX.encodeWav(rendered[b]));
			let worst = have.samples.length === want.samples.length ? 0 : Infinity;
			for (let i = 0; i < Math.min(have.samples.length, want.samples.length); i++)
				worst = Math.max(worst, Math.abs(have.samples[i] - want.samples[i]));
			if (worst > 1 || have.sampleRate !== SFX.SR || have.channels !== 1) drift.push(`${b} ${worst}`);
		}
		check(
			drift.length === 0,
			`os ${SFX.BANKS.length} bancos em design/audio/banks sao os do gerador (deterministico; npm run audio:sfx)`,
			drift.join(", "),
		);
		const windowsMatch = Object.entries(sounds).every(
			([n, s]) => JSON.stringify(s.takes) === JSON.stringify(manifest.sounds[n]?.takes),
		);
		check(windowsMatch, "e o manifest tem as mesmas janelas");
		const synthMatch = Object.entries(manifest.sounds).every(([n, s]) => {
			const g = AA.SYNTH_SOUNDS[n];
			return (
				g !== undefined &&
				g.bank === s.bank &&
				JSON.stringify(g.takes) === JSON.stringify(s.takes) &&
				g.volume === s.volume
			);
		});
		check(synthMatch, "e src/shared/data/audioAssets.ts (gerado) tem as mesmas janelas e volumes");
		// banks within Roblox's limits
		const limits = manifest.banks.filter(b => b.seconds > 7 * 60 || statSize(b.file) > 20 * 1024 * 1024);
		check(
			limits.length === 0 && SFX.SR <= 48000,
			"cada banco dentro dos limites do Roblox para audio (<= 7 min, <= 20 MB, <= 48 kHz)",
		);
		// what each take is, roughly: a sanity check on the recipes
		const bright = n => Math.max(...sounds[n].metrics.map(m => m.brightness));
		const dark = n => Math.min(...sounds[n].metrics.map(m => m.brightness));
		check(
			bright("footstepA") < 0.1 &&
				bright("heartbeat1") < 0.05 &&
				dark("emptyClick") > 0.3 &&
				dark("useInject") > 0.5,
			"passos e batimento sao graves; clique vazio e o chiado da injecao sao agudos",
		);
		// the mix: gunshots over impacts over the interface over the feet
		const mixLevel = n => Math.max(...sounds[n].metrics.map(m => m.lufs)) + 20 * Math.log10(sounds[n].volume);
		check(
			mixLevel("shotRifle") > mixLevel("hitFlesh") &&
				mixLevel("hitFlesh") > mixLevel("uiClick") &&
				mixLevel("uiClick") > mixLevel("footstepA"),
			"no mix: tiro > impacto > interface > passo",
			["shotRifle", "hitFlesh", "uiClick", "footstepA"].map(n => `${n} ${mixLevel(n).toFixed(1)}`).join(", "),
		);
	},
);

function statSize(file) {
	return readFileSync(join(ROOT, "design", "audio", file)).length;
}

// ================================================================ K. upload-audio

section(
	"K. npm run cloud -- upload-audio: dry run sem chave; so os bancos novos ou alterados, como Audio audio/wav",
	() => {
		const dry = spawnSync(process.execPath, [join(ROOT, "tools", "cloud.mjs"), "upload-audio", "--dry-run"], {
			encoding: "utf8",
			env: Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("ROBLOX_"))),
		});
		check(
			dry.status === 0 &&
				/nenhuma chave foi lida/.test(dry.stdout) &&
				new RegExp(`${SFX.BANKS.length} bancos de som`).test(dry.stdout),
			`--dry-run lista os ${SFX.BANKS.length} bancos sem ler chave nenhuma`,
			(dry.stdout || dry.stderr).split("\n")[0],
		);
		const tmp = mkdtempSync(join(tmpdir(), "pz-audio-"));
		try {
			const dir = join(tmp, "audio");
			mkdirSync(join(dir, "banks"), { recursive: true });
			copyFileSync(join(ROOT, "design", "audio", "manifest.json"), join(dir, "manifest.json"));
			for (const b of SFX.BANKS)
				copyFileSync(join(ROOT, "design", "audio", "banks", `${b}.wav`), join(dir, "banks", `${b}.wav`));
			const envFile = join(tmp, "fake.env");
			writeFileSync(envFile, "ROBLOX_API_KEY=sk-test-never-print\nROBLOX_CREATOR_USER_ID=4242\n");
			const statePath = join(tmp, "state.json");
			const assetsState = join(tmp, "fake-assets.json");
			const tsOut = join(tmp, "audioAssets.ts");
			/** one owner's run (no --ci) against the fake Open Cloud; `uploads`: the assets THIS run created */
			const run = extra => {
				writeFileSync(statePath, "{}");
				const known = existsSync(assetsState)
					? Object.keys(JSON.parse(readFileSync(assetsState, "utf8")).byId ?? {})
					: [];
				const r = spawnSync(
					process.execPath,
					[
						"--import",
						join(ROOT, "tools", "fake-open-cloud.mjs"),
						join(ROOT, "tools", "cloud.mjs"),
						"upload-audio",
					],
					{
						encoding: "utf8",
						env: {
							...Object.fromEntries(
								Object.entries(process.env).filter(([k]) => !k.startsWith("ROBLOX_")),
							),
							PZ_CLOUD_ENV: envFile,
							PZ_FAKE_CLOUD_STATE: statePath,
							PZ_FAKE_ASSETS_STATE: assetsState,
							PZ_AUDIO_DIR: dir,
							PZ_AUDIO_TS: tsOut,
							...extra,
						},
					},
				);
				const byId = JSON.parse(readFileSync(assetsState, "utf8")).byId ?? {};
				return {
					status: r.status,
					out: `${r.stdout}\n${r.stderr}`,
					uploads: Object.entries(byId)
						.filter(([id]) => !known.includes(id))
						.map(([, a]) => a),
				};
			};
			const first = run();
			const assets = JSON.parse(readFileSync(join(dir, "assets.json"), "utf8"));
			const ts = readFileSync(tsOut, "utf8");
			check(
				first.status === 0 &&
					first.uploads.length === SFX.BANKS.length &&
					first.uploads.every(
						u => u.assetType === "Audio" && u.contentType === "audio/wav" && u.creator.userId === "4242",
					),
				`a primeira vez: os ${SFX.BANKS.length} bancos sobem como Audio, audio/wav, do criador do .env`,
				first.status === 0
					? first.uploads.map(u => u.displayName).join(", ")
					: first.out.trim().split("\n").slice(-2).join(" | "),
			);
			check(
				SFX.BANKS.every(
					b =>
						/^rbxassetid:\/\/\d+$/.test(assets.ids?.[b] ?? "") &&
						assets.sha1?.[b] === first.uploads.find(u => u.displayName.endsWith(b))?.sha1,
				) && SFX.BANKS.every(b => ts.includes(assets.ids[b])),
				"assets.json guarda id e sha1 de cada banco, e o audioAssets.ts gerado ja tem os ids",
			);
			check(!/sk-test-never-print/.test(first.out), "a chave nunca aparece na saida");
			const again = run();
			check(
				again.status === 0 && again.uploads.length === 0,
				"de novo, nada mudou: nada sobe",
				`${again.uploads.length}`,
			);
			// one bank changed (re-rendered by a new recipe): only that one goes up again
			const wav = join(dir, "banks", "ui.wav");
			const bytes = readFileSync(wav);
			bytes[bytes.length - 2] ^= 1;
			writeFileSync(wav, bytes);
			const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
			manifest.banks.find(b => b.name === "ui").sha1 = createHash("sha1").update(bytes).digest("hex");
			writeFileSync(join(dir, "manifest.json"), JSON.stringify(manifest));
			const changed = run();
			check(
				changed.status === 0 && changed.uploads.length === 1 && changed.uploads[0].displayName.endsWith("ui"),
				"um banco alterado: so ele sobe de novo (um id novo: audio nao se atualiza no Roblox)",
				changed.uploads.map(u => u.displayName).join(", "),
			);
			// a bank whose sha1 is not the uploaded one keeps no id in the module (a stale window would play the wrong take)
			const before = JSON.parse(readFileSync(join(dir, "assets.json"), "utf8"));
			before.sha1.cues = "0".repeat(40);
			writeFileSync(join(dir, "assets.json"), JSON.stringify(before));
			spawnSync(process.execPath, [join(ROOT, "tools", "gen-sfx.mjs"), "--assets"], {
				encoding: "utf8",
				env: { ...process.env, PZ_AUDIO_DIR: dir, PZ_AUDIO_TS: tsOut },
			});
			const stale = readFileSync(tsOut, "utf8");
			check(
				/cues: ""/.test(stale) && stale.includes(before.ids.ui),
				"um id cujo sha1 nao e o do WAV de hoje fica de fora do modulo (o banco volta a biblioteca ate subir de novo)",
			);
			// moderation: a rejected bank keeps no id
			rmSync(join(dir, "assets.json"));
			const rejected = run({ PZ_FAKE_ASSETS: JSON.stringify({ weapons: "reject" }) });
			const after = JSON.parse(readFileSync(join(dir, "assets.json"), "utf8"));
			check(
				rejected.status !== 0 && after.ids.weapons === undefined && after.ids.ui !== undefined,
				"a moderacao recusa um banco: ele fica sem id (e o comando diz para tentar de novo); os outros ficam",
			);
		} finally {
			rmSync(tmp, { recursive: true, force: true });
		}
	},
);

// ================================================================ L. the thunder (LUZ-05)

section(
	"L. o trovao (LUZ-05): um por estrondo da agenda da tempestade, alto se o raio caiu perto; nada fora dela; um relogio que pula nao toca",
	() => {
		const W = require(join(SRC, "shared/sim/weather.ts"));
		const CLOCK = require(join(SRC, "shared/sim/clock.ts"));
		banks(false);
		const lib = S.soundDef("thunder");
		check(
			lib === S.librarySoundDef("thunder") &&
				lib.id === S.SOUNDS.stingerWave1.id &&
				lib.bus === "sfx" &&
				lib.spatial !== true &&
				lib.volume <= 0.6 &&
				(lib.minGap ?? 0) >= 1,
			"sem id: o trovao da biblioteca (o mesmo das vinhetas), no SFX, plano (e o ceu), volume <= 0,6, um por vez",
			`${lib.id}, ${lib.bus}, vol ${lib.volume}`,
		);
		banks(true);
		const ours = S.soundDef("thunder");
		check(
			ours.id === BANK_IDS.weather &&
				ours.source === "synth" &&
				ours.takes?.length === 3 &&
				ours.bus === lib.bus &&
				AA.SYNTH_SOUNDS.thunder.bank === "weather" &&
				Object.values(AA.SYNTH_SOUNDS).every(s => s.bank !== "weather" || s === AA.SYNTH_SOUNDS.thunder),
			"com o banco no ar: os nossos 3 takes no banco `weather`, o dele (o `cues` aprovado nao muda), com o papel da biblioteca",
			`${ours.id}, ${ours.source}, ${ours.takes?.length} takes`,
		);
		banks(false);

		// the spy above keeps names; this one keeps the level each clap was asked at
		const levels = [];
		const spied = audio.play;
		audio.play = (name, opts) => {
			if (name === "thunder") levels.push(opts?.scale ?? 1);
			spied(name, opts);
		};
		try {
			const listen = (kind, day, from, hours, jumpAt) => {
				const ga = new GameAudio();
				const refs = runRefs();
				const dn = { isNight: false, day, dayTime: from, weather: kind };
				refs.daynight = dn;
				ga.startRun(refs);
				runFrame(ga, refs);
				levels.length = 0;
				const c0 = created;
				let jumped = false;
				while (dn.dayTime < from + hours) {
					if (jumpAt !== undefined && !jumped && dn.dayTime >= jumpAt) {
						// an admin moving the clock an hour on: the claps it flew over are not played
						dn.dayTime += 1;
						jumped = true;
					}
					dn.dayTime = CLOCK.advanceClock(dn.dayTime, 1 / 60);
					runFrame(ga, refs);
				}
				const made = created - c0;
				ga.stopRun();
				advance(0.5);
				const out = [...levels];
				out.made = made;
				return out;
			};
			const day = W.STORM_FROM_DAY + 5;
			const from = 8;
			const hours = 3;
			const claps = W.strikesOfDay(day).filter(s => {
				const onset = s.hour + s.delay * CLOCK.clockSpeed(s.hour);
				return onset > from && onset <= from + hours;
			});
			// a first storm builds the thunder's voices (the mixer's pool); the next one creates nothing
			listen(W.Weather.Storm, day, from, hours);
			const heard = listen(W.Weather.Storm, day, from, hours);
			check(
				heard.length === claps.length && claps.length >= 2,
				"3 horas de tempestade a 60 quadros por segundo: um trovao por estrondo da agenda (a mesma do servidor)",
				`${heard.length} trovoes, ${claps.length} estrondos`,
			);
			check(
				heard.every((v, i) => Math.abs(v - claps[i].power) < 1e-9) && Math.min(...heard) >= 0.5,
				"...cada um no nivel da distancia do raio (1 perto, 0,5 longe)",
				heard.map(v => v.toFixed(2)).join(" "),
			);
			check(
				heard.made === 0,
				"...e uma segunda tempestade nao cria Instance nenhuma (as vozes do pool)",
				`${heard.made}`,
			);
			const rain = listen(W.Weather.Rain, day, from, hours);
			const clear = listen(W.Weather.Clear, day, from, hours);
			check(rain.length === 0 && clear.length === 0, "chuva sem tempestade e dia limpo: nenhum trovao");
			const jump = listen(W.Weather.Storm, day, from, hours, from + 0.5);
			const skipped = claps.filter(s => {
				const onset = s.hour + s.delay * CLOCK.clockSpeed(s.hour);
				return onset > from + 0.5 && onset <= from + 1.5;
			}).length;
			check(
				jump.length <= claps.length - skipped,
				"um relogio que pula uma hora nao toca os trovoes que pulou",
				`${jump.length} de ${claps.length} (${skipped} pulados)`,
			);
		} finally {
			audio.play = spied;
		}
	},
);

console.log(`\n[test-audio] ${checks - failures}/${checks} checks passed`);
if (failures > 0) {
	console.log(`[test-audio] ${failures} FAILED`);
	process.exit(1);
}
