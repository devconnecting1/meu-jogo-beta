#!/usr/bin/env node
/*
 * Proximity chat: who hears a line, and how long it floats over a head.
 *
 *   npm run test:chat
 *
 * These are the two rules of the feature that fail QUIETLY. A delivery rule that is one condition wrong does
 * not crash: it just leaks every word (and, from who answers whom, roughly every position) to the whole
 * server, or it silences the co-op partner standing next to you — and either way the game still runs, and a
 * Studio playtest with two clients in the same room proves nothing. The bubble stack is the same story: a cap
 * that is off by one only shows up when somebody is talkative during a horde.
 *
 * So shared/chat/chatRules.ts holds both rules with no service, no Player and no Instance, and this file
 * drives them directly. What it pins:
 *   1. earshot is exactly INTEREST_MID, the ring the server replicates a survivor in at all;
 *   2. no body in the world, no voice and no ear -- in either direction;
 *   3. MP_PHASE = 0 has no authoritative position anywhere, so every line goes to everyone;
 *   4. a head carries at most MAX_LINES, and the newest line never queues behind an older one;
 *   5. a line that has run out frees its slot without costing a live one;
 *   6. a line is solid for most of its life and only fades at the end of it.
 *
 * Pure Node (>= 18) plus the project's TypeScript, with the same shims the other tools use.
 */
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = resolve(process.env.PZ_SRC ?? join(ROOT, "src"));
const require = createRequire(import.meta.url);
const Module = require("node:module");
const ts = require("typescript");

globalThis.math = { floor: Math.floor, max: Math.max, min: Math.min, huge: Infinity };

// roblox-ts arrays expose size() as a method; nothing else of Luau is needed here
Object.defineProperty(Array.prototype, "size", {
	value: function () {
		return this.length;
	},
	configurable: true,
	writable: true,
});

const resolveFilename = Module._resolveFilename;
Module._resolveFilename = function (req, parent, ...rest) {
	if (req.startsWith("shared/")) return join(SRC, req + ".ts");
	if (req.startsWith(".") && parent?.filename?.endsWith(".ts")) {
		const p = resolve(dirname(parent.filename), req);
		if (existsSync(p + ".ts")) return p + ".ts";
	}
	return resolveFilename.call(this, req, parent, ...rest);
};
Module._extensions[".ts"] = function (m, filename) {
	const out = ts.transpileModule(readFileSync(filename, "utf8"), {
		compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
	});
	m._compile(out.outputText, filename);
};

const {
	CHAT_RANGE,
	LINE_FADE_S,
	LINE_LIFE_S,
	MAX_LINES,
	dropCount,
	lineFade,
	shouldDeliver,
	withinChatRange,
} = require(join(SRC, "shared/chat/chatRules.ts"));
const { INTEREST_MID, MP_PHASE } = require(join(SRC, "shared/net/mpConfig.ts"));

let failures = 0;
function check(name, ok, detail) {
	const tail = detail === undefined ? "" : "  (" + detail + ")";
	if (ok) {
		console.log("  ok    " + name + tail);
	} else {
		console.error("  FALHA " + name + tail);
		failures += 1;
	}
}

/** a body `d` units away from the origin, on a diagonal so both axes take part in the distance */
function at(d) {
	const k = d / Math.SQRT2;
	return { x: k, y: k };
}

console.log(
	"constantes lidas do codigo: alcance " +
		CHAT_RANGE +
		" u, " +
		MAX_LINES +
		" balao(oes) por sobrevivente, vida " +
		LINE_LIFE_S +
		" s (fade " +
		LINE_FADE_S +
		" s), MP_PHASE = " +
		MP_PHASE,
);

// ---------------------------------------------------------------- 1: the range is the interest ring

console.log("\n1) o alcance e o anel de interesse, nao um numero novo");
{
	check("CHAT_RANGE == INTEREST_MID", CHAT_RANGE === INTEREST_MID, CHAT_RANGE + " vs " + INTEREST_MID);
	const me = { x: 0, y: 0 };
	check("colado", withinChatRange(me, me));
	check("meio do anel", withinChatRange(me, at(CHAT_RANGE / 2)));
	check("na borda", withinChatRange(me, at(CHAT_RANGE)));
	check("um passo alem da borda", withinChatRange(me, at(CHAT_RANGE + 1)) === false);
	check("longe", withinChatRange(me, at(CHAT_RANGE * 3)) === false);
	// the rule has to be symmetric, or two survivors would disagree about whether they are talking
	const a = { x: 900, y: -400 };
	const b = { x: 900 + CHAT_RANGE * 0.9, y: -400 };
	check("simetrica", withinChatRange(a, b) === withinChatRange(b, a));
	// x and y both count: a rule that only measured one axis would pass every test above
	check("as duas coordenadas contam", withinChatRange({ x: 0, y: 0 }, { x: CHAT_RANGE, y: CHAT_RANGE }) === false);
}

// ---------------------------------------------------------------- 2: no body, no voice and no ear

console.log("\n2) quem nao esta no mundo nao fala nem ouve");
{
	const near = { x: 0, y: 0 };
	const alsoNear = { x: 10, y: 10 };
	check("dois no mundo e perto: entrega", shouldDeliver(near, alsoNear, 1));
	check("quem fala esta no lobby", shouldDeliver(undefined, alsoNear, 1) === false);
	check("quem ouve esta no lobby", shouldDeliver(near, undefined, 1) === false);
	check("os dois no lobby", shouldDeliver(undefined, undefined, 1) === false);
	// being in the world is not enough on its own
	check("no mundo, mas longe", shouldDeliver(near, at(CHAT_RANGE + 1), 1) === false);
	// you always hear yourself: distance zero, and the same body on both sides
	check("o proprio jogador se ouve", shouldDeliver(near, near, 1));
}

// ---------------------------------------------------------------- 3: MP_PHASE = 0 has no positions at all

console.log("\n3) sem servidor dono da posicao (MP_PHASE = 0), todo mundo recebe");
{
	check("sem corpo nenhum", shouldDeliver(undefined, undefined, 0));
	check("longe demais para a fase 1", shouldDeliver({ x: 0, y: 0 }, at(CHAT_RANGE * 10), 0));
	// the default is the real switch, so the production path is the one the other cases described
	const near = { x: 0, y: 0 };
	check("o padrao e o MP_PHASE do projeto", shouldDeliver(near, near) === shouldDeliver(near, near, MP_PHASE));
	const everyoneHears = MP_PHASE < 1;
	check("a fase do projeto filtra por distancia", shouldDeliver(near, at(CHAT_RANGE * 10)) === everyoneHears);
}

// ---------------------------------------------------------------- 4: at most MAX_LINES over one head

console.log("\n4) no maximo " + MAX_LINES + " baloes, e o mais novo nunca espera");
{
	const now = 1000;
	/** `n` lines said in the last second, oldest first */
	const fresh = n => Array.from({ length: n }, (_, i) => now - (n - i) * 0.2);
	check("pilha vazia", dropCount([], now) === 0);
	for (let n = 1; n < MAX_LINES; n++) {
		check("ainda cabe com " + n, dropCount(fresh(n), now) === 0);
	}
	check("cheia: o mais antigo sai na hora", dropCount(fresh(MAX_LINES), now) === 1);
	// the eviction is immediate, not "one per frame": the same full stack answers the same way every time
	check("e sai so um", dropCount(fresh(MAX_LINES), now) === 1);
	// a stack that somehow overflowed comes back to the cap in one step instead of staying over it
	check("acima do teto volta ao teto", dropCount(fresh(MAX_LINES + 2), now) === 3);
}

// ---------------------------------------------------------------- 5: an expired line frees its own slot

console.log("\n5) um balao vencido libera o lugar sem custar um vivo");
{
	const now = 1000;
	const dead = now - LINE_LIFE_S - 1;
	check("so o vencido sai", dropCount([dead, now - 1, now - 0.5], now) === 1);
	check("os tres vencidos saem", dropCount([dead, dead, dead], now) === 3);
	check("dois vencidos, um vivo", dropCount([dead, dead, now - 0.5], now) === 2);
	// exactly at its life a line is over: the boundary belongs to the dead side, like lineFade below
	check("na borda da vida ja venceu", dropCount([now - LINE_LIFE_S], now) === 1);
	check("um instante antes ainda vale", dropCount([now - LINE_LIFE_S + 0.01], now) === 0);
}

// ---------------------------------------------------------------- 6: solid for most of its life

console.log("\n6) o balao fica solido e so apaga no fim");
{
	check("recem-chegado", lineFade(0) === 0);
	check("meia vida", lineFade(LINE_LIFE_S / 2) === 0);
	check("no instante em que o fade comeca", lineFade(LINE_LIFE_S - LINE_FADE_S) === 0);
	check("meio do fade", Math.abs(lineFade(LINE_LIFE_S - LINE_FADE_S / 2) - 0.5) < 1e-9);
	check("no fim da vida", lineFade(LINE_LIFE_S) === 1);
	check("depois do fim", lineFade(LINE_LIFE_S * 3) === 1);
	// monotonic: a bubble never gets darker again, which would read as a second message
	let previous = -1;
	let monotonic = true;
	for (let t = 0; t <= LINE_LIFE_S + 1; t += 0.05) {
		const f = lineFade(t);
		if (f < previous - 1e-9) monotonic = false;
		previous = f;
	}
	check("nunca volta atras", monotonic);
	// the fade is short next to the life: the line is readable, not a slow dissolve
	check("fade curto perto da vida", LINE_FADE_S > 0 && LINE_FADE_S <= LINE_LIFE_S / 10, LINE_FADE_S + " s");
	check("vida entre 6 e 8 s", LINE_LIFE_S >= 6 && LINE_LIFE_S <= 8, LINE_LIFE_S + " s");
}

console.log("");
if (failures > 0) {
	console.error(failures + " verificacao(oes) falharam");
	process.exit(1);
}
console.log("OK: alcance, presenca, fase 0, teto de baloes, expiracao e fade");
