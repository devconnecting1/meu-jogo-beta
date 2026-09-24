#!/usr/bin/env node
/*
 * The lobby's Servers list (docs/DESIGN_RULES.md MP-26, docs/MULTIPLAYER.md §4.10): server/match/serverList.ts and the
 * wire of shared/net/townNet.ts, against a fake MemoryStore sorted map and a fake TeleportService.
 *
 *   npm run test:serverlist
 *   PZ_SRC=<another checkout>/src node tools/test-serverlist.mjs   (measures that version)
 *
 * The fake map keeps what the engine reference says a MemoryStoreSortedMap keeps (memory-stores/sorted-map.md): an
 * expiration per item (≤ 3 888 000 s), items in sort-key order then key order, GetRangeAsync ≤ 200 items; and it bills
 * what memory-stores/index.md bills: one request unit per write, GetAsync and RemoveAsync, and one per item a
 * GetRangeAsync returns (one for an empty answer). It checks:
 *
 *   1. WHO PUBLISHES     only a public, live server: never a private one, a reserved one (Play solo) or Studio; nothing
 *                        with nobody on it (the entry is removed), at shutdown the entry goes at once.
 *   2. HOW OFTEN         a changed entry at most every PUBLISH_MIN_GAP_S, an unchanged one every PUBLISH_EVERY_S, with
 *                        a TTL of ENTRY_TTL_S: a server that dies drops off on its own; a failing write is not
 *                        retried faster, and warns a fixed sentence.
 *   3. THE LIST          this server left out, stale / malformed / non-public entries dropped, not full first, then the
 *                        day closest to the player's best day; one read serves the whole server READ_CACHE_S.
 *   4. THE JOIN          the server reads the target's entry again and refuses: Studio, no service, a JobId that is not
 *                        one, this server, still loading, in the city, one already under way, too soon, gone, stale,
 *                        not public, full. Then TeleportAsync with ServerInstanceId, retried while the player is still
 *                        in the lobby; a TeleportInitFailed tells the player why.
 *   5. THE WIRE          what a client may send (`readTownRequest`) and what a client takes (`readServerRows`).
 *   6. THE QUOTA         the per-server arithmetic of the header (≤ 120 units a minute per player), and an hour of 40
 *                        servers whose every lobby player keeps the list open: measured units a minute per server and
 *                        for the whole experience, against 1000 + 120 × CCU and the 100 000 a structure takes.
 *   7. THE ROBLOX SIDE   startServerList with the real call shapes: SetAsync(JobId, entry, 90, sortKey),
 *                        GetRangeAsync(Enum.SortDirection.Ascending, 50), TeleportAsync(PlaceId, {player},
 *                        TeleportOptions{ServerInstanceId}), TeleportInitFailed, BindToClose; in Studio neither service
 *                        is even asked for.
 *
 * Pure Node (>= 18) plus the project's TypeScript.
 */
import { join } from "node:path";
import { installShims } from "./luau-shim.mjs";

const { SRC, require } = installShims({ seed: 1 });

// ---------------------------------------------------------------- checks

let failures = 0;
let checks = 0;
function check(what, ok, detail) {
	checks += 1;
	const tail = detail === undefined ? "" : `  (${detail})`;
	if (ok) console.log(`  ok    ${what}${tail}`);
	else {
		failures += 1;
		console.log(`  FAIL  ${what}${tail}`);
	}
	return ok;
}
function section(title, fn) {
	console.log(`\n${title}\n`);
	try {
		fn();
	} catch (e) {
		failures += 1;
		console.log(`  FAIL  the section threw: ${e?.stack?.split("\n").slice(0, 4).join(" | ") ?? e}`);
	}
}

// ---------------------------------------------------------------- the fake Roblox

class Yield extends Error {}
let clockNow = 1000;
const printed = [];
const warned = [];
globalThis.print = (...a) => printed.push(a.join(" "));
globalThis.warn = (...a) => warned.push(a.join(" "));
globalThis.tostring = v => String(v);
globalThis.os = { clock: () => clockNow, time: () => Math.floor(1_700_000_000 + clockNow) };
globalThis.pcall = (fn, ...args) => {
	try {
		return [true, fn(...args)];
	} catch (e) {
		if (e instanceof Yield) throw e;
		return [false, e instanceof Error ? e.message : e];
	}
};
const spawned = [];
globalThis.task = {
	spawn: (fn, ...args) => {
		spawned.push(fn);
		try {
			return fn(...args);
		} catch (e) {
			if (!(e instanceof Yield)) throw e;
		}
	},
	wait: () => {
		throw new Yield();
	},
};
class Signal {
	constructor() {
		this.fns = [];
	}
	Connect(fn) {
		this.fns.push(fn);
		return { Disconnect: () => (this.fns = this.fns.filter(f => f !== fn)) };
	}
	Fire(...a) {
		for (const fn of [...this.fns]) fn(...a);
	}
}
class Inst {
	constructor(className) {
		this.ClassName = className;
	}
	SetTeleportData(data) {
		this.teleportData = data;
	}
}
globalThis.Instance = Inst;
globalThis.Enum = {
	SortDirection: { Ascending: { Name: "Ascending", Value: 0 }, Descending: { Name: "Descending", Value: 1 } },
};

const clone = v => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
const MAX_EXPIRATION = 3_888_000;

/** a MemoryStoreSortedMap as the engine reference describes it, billing request units as memory-stores/index.md does */
class FakeSortedMap {
	constructor() {
		this.items = new Map();
		this.units = 0;
		this.calls = { set: 0, get: 0, range: 0, remove: 0 };
		this.failNext = 0;
		this.log = [];
	}
	maybeFail(what) {
		if (this.failNext > 0) {
			this.failNext -= 1;
			throw new Error(`${what}: the request was throttled`);
		}
	}
	purge() {
		for (const [k, it] of this.items) if (it.exp <= clockNow) this.items.delete(k);
	}
	SetAsync(key, value, expiration, sortKey) {
		this.maybeFail("SetAsync");
		if (typeof key !== "string" || key.length === 0 || key.length > 128) throw new Error("bad key");
		if (typeof expiration !== "number" || expiration <= 0 || expiration > MAX_EXPIRATION) {
			throw new Error("bad expiration");
		}
		if (sortKey !== undefined && typeof sortKey !== "number" && typeof sortKey !== "string") {
			throw new Error("bad sort key");
		}
		if (JSON.stringify(value).length > 32 * 1024) throw new Error("value too large");
		this.units += 1;
		this.calls.set += 1;
		this.log.push({ kind: "set", key, value: clone(value), expiration, sortKey });
		this.items.set(key, { value: clone(value), sortKey, exp: clockNow + expiration });
		return true;
	}
	GetAsync(key) {
		this.maybeFail("GetAsync");
		this.units += 1;
		this.calls.get += 1;
		this.purge();
		const it = this.items.get(key);
		return it === undefined ? [] : [clone(it.value), it.sortKey];
	}
	GetRangeAsync(direction, count) {
		// every attempt counts as a call, the throttled ones too
		this.calls.range += 1;
		this.maybeFail("GetRangeAsync");
		if (!Number.isInteger(count) || count < 1 || count > 200) throw new Error("bad count");
		this.log.push({ kind: "range", direction, count });
		this.purge();
		const all = [...this.items].map(([key, it]) => ({ key, value: clone(it.value), sortKey: it.sortKey }));
		// sort key first (numbers before strings, none last), then the key
		const rank = v => (v === undefined ? 2 : typeof v === "number" ? 0 : 1);
		all.sort((a, b) => {
			if (rank(a.sortKey) !== rank(b.sortKey)) return rank(a.sortKey) - rank(b.sortKey);
			if (a.sortKey !== b.sortKey) return a.sortKey < b.sortKey ? -1 : 1;
			return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
		});
		if (direction?.Name === "Descending") all.reverse();
		const out = all.slice(0, count);
		this.units += Math.max(1, out.length);
		return out;
	}
	RemoveAsync(key) {
		this.maybeFail("RemoveAsync");
		this.units += 1;
		this.calls.remove += 1;
		this.log.push({ kind: "remove", key });
		this.items.delete(key);
	}
}

const SL = require(join(SRC, "server/match/serverList.ts"));
/** the place every fake server of this suite runs (game.PlaceId) */
const PLACE = 5555;
const TN = require(join(SRC, "shared/net/townNet.ts"));
const Names = require(join(SRC, "shared/data/townNames.ts"));

let nextUser = 100;
function makePlayer() {
	const id = ++nextUser;
	return { UserId: id, Name: `P${id}`, ClassName: "Player" };
}

/** the store port of serverList.ts over the fake map (what startServerList builds over the real one) */
function portOf(map) {
	return {
		set: (key, value, ttl, sortKey) => {
			map.SetAsync(key, value, ttl, sortKey);
		},
		get: key => map.GetAsync(key)[0],
		range: count => map.GetRangeAsync(Enum.SortDirection.Ascending, count),
		remove: key => map.RemoveAsync(key),
	};
}

/**
 * One fake game server: its kind, its players (who is in the city, who is loading), its town, and a ServerList over
 * the shared map. `teleports` keeps every TeleportAsync; `teleportFails` makes the next ones throw.
 */
function makeServer(map, opts = {}) {
	const server = {
		jobId: opts.jobId ?? `job-${++nextUser}`,
		players: new Set(),
		inCity: new Set(),
		loadingSet: new Set(),
		deadSet: new Set(),
		dangerSet: new Set(),
		tripSet: new Set(),
		gone: new Set(),
		best: new Map(),
		seed: opts.seed ?? 1234,
		day: opts.day ?? 1,
		capacity: opts.capacity ?? 6,
		teleports: [],
		teleportFails: 0,
		warns: [],
	};
	const teleport =
		opts.teleport === false
			? undefined
			: (player, jobId) => {
					server.teleports.push({ player, jobId });
					if (server.teleportFails > 0) {
						server.teleportFails -= 1;
						throw new Error("HTTP 429 (Too many requests)");
					}
				};
	server.list = new SL.ServerList({
		kind: opts.kind ?? "public",
		jobId: server.jobId,
		placeId: opts.placeId ?? PLACE,
		store: opts.store === false ? undefined : portOf(map),
		teleport: opts.teleportHook !== undefined ? (p, id) => opts.teleportHook(server, p, id) : teleport,
		clock: () => clockNow,
		now: () => Math.floor(1_700_000_000 + clockNow),
		wait: s => {
			clockNow += s;
		},
		town: () => ({ seed: server.seed, day: server.day }),
		players: () => [...server.players].length,
		capacity: () => server.capacity,
		inWorld: p => server.inCity.has(p),
		loading: p => server.loadingSet.has(p),
		isDead: p => server.deadSet.has(p),
		keptInDanger: p => server.dangerSet.has(p),
		travelling: p => server.tripSet.has(p),
		connected: p => server.players.has(p) && !server.gone.has(p),
		bestDay: p => server.best.get(p),
		log: () => {},
		warn: (what, detail) => server.warns.push(`${what} | ${detail}`),
	});
	server.add = (n = 1) => {
		const out = [];
		for (let i = 0; i < n; i++) {
			const p = makePlayer();
			server.players.add(p);
			out.push(p);
		}
		return out;
	};
	return server;
}

// ================================================================ 1. who publishes

section("1) quem publica: so um servidor publico e ao vivo, com alguem nele", () => {
	check(
		"o tipo do servidor vem do DataModel: publico, privado (com dono), reservado (sem dono: Play solo), Studio",
		SL.serverKindOf(false, "job-1", "", 0) === "public" &&
			SL.serverKindOf(false, "job-1", "ps-1", 42) === "private" &&
			SL.serverKindOf(false, "job-1", "ps-1", 0) === "reserved" &&
			SL.serverKindOf(true, "job-1", "", 0) === "studio" &&
			SL.serverKindOf(false, "", "", 0) === "studio",
	);
	for (const kind of ["private", "reserved", "studio"]) {
		const map = new FakeSortedMap();
		const s = makeServer(map, { kind });
		s.add(3);
		for (let i = 0; i < 20; i++) {
			s.list.tick();
			clockNow += SL.TICK_S;
		}
		check(
			`um servidor ${kind} nunca escreve na lista`,
			map.calls.set === 0 && !s.list.publishes(),
			`${map.calls.set} escritas`,
		);
	}
	const map = new FakeSortedMap();
	const s = makeServer(map, { seed: 777, day: 5 });
	s.list.tick();
	check("vazio (ninguem nele): nada publicado", map.calls.set === 0);
	const [p1, p2] = s.add(2);
	s.list.tick();
	const w = map.log.find(x => x.kind === "set");
	check(
		"com gente: a entrada e o JobId -> semente, dia, jogadores, capacidade, hora; TTL de ENTRY_TTL_S; chave de ordem 0 (nao cheio)",
		w !== undefined &&
			w.key === s.jobId &&
			w.value.seed === 777 &&
			w.value.day === 5 &&
			w.value.n === 2 &&
			w.value.max === 6 &&
			w.value.kind === "public" &&
			w.expiration === SL.ENTRY_TTL_S &&
			w.sortKey === 0,
		JSON.stringify(w),
	);
	check(
		"...e nada de ninguem: nenhum UserId, nenhum nome na entrada",
		!JSON.stringify(w.value).includes(String(p1.UserId)) && !JSON.stringify(w.value).includes(p1.Name),
	);
	s.players.delete(p1);
	s.players.delete(p2);
	clockNow += SL.PUBLISH_MIN_GAP_S;
	s.list.tick();
	check("todos sairam: a entrada e removida (nada para entrar)", map.calls.remove === 1 && !map.items.has(s.jobId));
	s.list.tick();
	check("...uma vez so", map.calls.remove === 1);
	s.add(1);
	clockNow += SL.PUBLISH_MIN_GAP_S;
	s.list.tick();
	check("alguem voltou: a entrada volta", map.items.has(s.jobId));
	s.list.withdraw();
	check("desligando (BindToClose): a entrada sai na hora, sem esperar o TTL", !map.items.has(s.jobId));
});

// ================================================================ 2. how often

section("2) com que frequencia: mudou -> no maximo a cada 15 s; parado -> a cada 30 s; TTL de 90 s", () => {
	const map = new FakeSortedMap();
	const s = makeServer(map);
	s.add(1);
	const t0 = clockNow;
	for (let t = 0; t < 300; t += SL.TICK_S) {
		s.list.tick();
		clockNow += SL.TICK_S;
	}
	check(
		"parado por 5 minutos: uma escrita a cada PUBLISH_EVERY_S",
		map.calls.set === Math.ceil(300 / SL.PUBLISH_EVERY_S),
		`${map.calls.set} escritas em ${clockNow - t0} s`,
	);
	const before = map.calls.set;
	for (let t = 0; t < 300; t += SL.TICK_S) {
		// the player count changes on every tick: the worst case
		if ([...s.players].length > 3) s.players.clear();
		s.add(1);
		s.list.tick();
		clockNow += SL.TICK_S;
	}
	const changed = map.calls.set - before;
	check(
		"mudando a cada tique por 5 minutos: nunca mais de uma escrita a cada PUBLISH_MIN_GAP_S",
		changed <= Math.ceil(300 / SL.PUBLISH_MIN_GAP_S) && changed >= 300 / SL.PUBLISH_EVERY_S,
		`${changed} escritas`,
	);
	// full: the sort key says so, and the list puts it last
	s.players.clear();
	s.add(6);
	clockNow += SL.PUBLISH_MIN_GAP_S;
	s.list.tick();
	const last = map.log.filter(x => x.kind === "set").at(-1);
	check("cheio: chave de ordem 1 (os abertos vem antes numa leitura)", last.sortKey === 1 && last.value.n === 6);
	// the server dies: no more writes, and after the TTL nobody sees it
	clockNow += SL.ENTRY_TTL_S - 1;
	map.purge();
	check("um servidor que morre continua na lista ate o TTL...", map.items.has(s.jobId));
	clockNow += 2;
	map.purge();
	check("...e some sozinho depois dele", !map.items.has(s.jobId));
	// a failing store: warned with a fixed sentence, not retried faster than the cadence
	const s2 = makeServer(map);
	s2.add(2);
	map.failNext = 100;
	const calls0 = map.calls.set;
	for (let t = 0; t < 120; t += SL.TICK_S) {
		s2.list.tick();
		clockNow += SL.TICK_S;
	}
	map.failNext = 0;
	const tries = s2.warns.length;
	check(
		"a loja falhando: uma tentativa por janela (nao a cada tique), cada falha avisada numa frase fixa",
		tries <= Math.ceil(120 / SL.PUBLISH_MIN_GAP_S) &&
			tries >= 2 &&
			s2.warns.every(w => w.startsWith("the server list entry could not be written | ")) &&
			map.calls.set === calls0,
		`${tries} tentativas em 120 s`,
	);
});

// ================================================================ 3. the list

section(
	"3) a lista: sem este servidor, sem velhos nem estranhos, abertos primeiro, depois o dia mais perto do seu recorde",
	() => {
		const map = new FakeSortedMap();
		const here = makeServer(map, { day: 3 });
		here.add(2);
		here.list.tick();
		const others = [
			makeServer(map, { seed: 11, day: 12 }),
			makeServer(map, { seed: 22, day: 5 }),
			makeServer(map, { seed: 33, day: 30 }),
			makeServer(map, { seed: 44, day: 6 }),
			makeServer(map, { seed: 55, day: 8 }),
		];
		others[0].add(2);
		others[1].add(6); // full
		others[2].add(1);
		others[3].add(4);
		others[4].add(3);
		for (const o of others) o.list.tick();
		// junk an old version or another experience's code might have left (and a private server's, which never writes)
		map.SetAsync("job-junk", { v: 99, seed: 5 }, 60, 0);
		map.SetAsync(
			"not a job id!",
			{ v: 1, kind: "public", place: PLACE, seed: 5, day: 1, n: 1, max: 6, t: 1_700_000_000 + clockNow },
			60,
			0,
		);
		map.SetAsync(
			"job-private",
			{ v: 1, kind: "private", place: PLACE, seed: 5, day: 1, n: 1, max: 6, t: 1_700_000_000 + clockNow },
			60,
			0,
		);
		map.SetAsync(
			"job-overfull",
			{ v: 1, kind: "public", place: PLACE, seed: 5, day: 1, n: 9, max: 6, t: 1_700_000_000 + clockNow },
			60,
			0,
		);
		map.SetAsync(
			"job-stale",
			{ v: 1, kind: "public", place: PLACE, seed: 5, day: 1, n: 1, max: 6, t: 1_700_000_000 + clockNow - 500 },
			600,
			0,
		);
		const [me] = here.add(1);
		here.best.set(me, 7);
		const reads0 = map.calls.range;
		const res = here.list.list(me);
		const ids = (res.servers ?? []).map(r => r.jobId);
		const expect = [others[3].jobId, others[4].jobId, others[0].jobId, others[2].jobId, others[1].jobId];
		check(
			"abertos antes do cheio; entre os abertos, o dia mais perto do recorde (7): 6, 8, 12, 30; e este servidor nunca",
			res.ok && JSON.stringify(ids) === JSON.stringify(expect),
			(res.servers ?? []).map(r => `d${r.day}${r.players >= r.max ? "(cheio)" : ""}`).join(" "),
		);
		check(
			"entradas malformadas, de chave estranha, privadas, lotadas alem da capacidade ou velhas nao aparecem",
			!ids.some(id => ["job-junk", "not a job id!", "job-private", "job-overfull", "job-stale"].includes(id)),
		);
		check(
			"cada linha e o que o servidor publicou: semente (o nome sai dela no cliente), dia, jogadores / capacidade",
			res.servers.every(r => TN.isJobId(r.jobId) && r.seed >= 1 && r.day >= 1 && r.players <= r.max),
			res.servers.map(r => `${Names.townNameOf(r.seed)} d${r.day} ${r.players}/${r.max}`).join(", "),
		);
		// one read serves every lobby on the server for READ_CACHE_S
		const lobby = here.add(5);
		for (let i = 0; i < SL.READ_CACHE_S - 1; i++) {
			for (const p of lobby) here.list.list(p);
			clockNow += 1;
		}
		check(
			"30 s de 5 jogadores pedindo a lista a cada segundo: uma leitura para o servidor todo (READ_CACHE_S)",
			map.calls.range - reads0 === 1,
			`${map.calls.range - reads0} leituras`,
		);
		// a failing read: "unavailable", and the store is not asked again before the cache runs out
		clockNow += SL.READ_CACHE_S;
		map.failNext = 1;
		const bad = here.list.list(me);
		clockNow += SL.READ_CACHE_S - 1;
		const again = here.list.list(me);
		check(
			"a leitura falhando: unavailable, avisado numa frase fixa, e nao se pergunta de novo antes do cache vencer",
			!bad.ok &&
				bad.reason === "unavailable" &&
				!again.ok &&
				map.calls.range - reads0 === 2 &&
				here.warns.at(-1)?.startsWith("the server list could not be read | "),
		);
		// never more than SERVER_ROWS_MAX rows, never more than READ_COUNT read
		const big = new FakeSortedMap();
		const hub = makeServer(big);
		hub.add(1);
		for (let i = 0; i < 80; i++) {
			const o = makeServer(big, { seed: 100 + i, day: 1 + (i % 20) });
			o.add(1 + (i % 6));
			o.list.tick();
		}
		const r2 = hub.list.list([...hub.players][0]);
		const lastRange = big.log.filter(x => x.kind === "range").at(-1);
		check(
			`80 servidores: le no maximo READ_COUNT (${SL.READ_COUNT}), mostra no maximo SERVER_ROWS_MAX (${TN.SERVER_ROWS_MAX})`,
			lastRange.count === SL.READ_COUNT && r2.servers.length <= TN.SERVER_ROWS_MAX && r2.servers.length > 0,
			`${r2.servers.length} linhas`,
		);
		const studio = makeServer(map, { kind: "studio" });
		const sr = studio.list.list(studio.add(1)[0]);
		check("no Studio: studio (a lista so existe no jogo publicado)", !sr.ok && sr.reason === "studio");
		const none = makeServer(map, { store: false });
		const nr = none.list.list(none.add(1)[0]);
		check("sem MemoryStoreService: unavailable", !nr.ok && nr.reason === "unavailable");
	},
);

// ================================================================ 4. the join

section("4) entrar: o servidor le a entrada de novo e decide; depois TeleportAsync com ServerInstanceId", () => {
	const map = new FakeSortedMap();
	const here = makeServer(map);
	const there = makeServer(map, { seed: 4242, day: 9 });
	const full = makeServer(map, { seed: 99, day: 2 });
	here.add(1);
	there.add(3);
	full.add(6);
	for (const s of [here, there, full]) s.list.tick();
	const [me] = here.add(1);
	const join = (s, p, id) => {
		const r = s.list.join(p, id);
		clockNow += SL.JOIN_GAP_S;
		return r;
	};
	const reason = r => (r.ok ? "ok" : r.reason);
	const cases = [];
	cases.push(["um JobId que nao e um", reason(join(here, me, "../../etc")), "invalid"]);
	cases.push(["um JobId longo demais", reason(join(here, me, "a".repeat(TN.JOB_ID_MAX + 1))), "invalid"]);
	cases.push(["este mesmo servidor", reason(join(here, me, here.jobId)), "same"]);
	cases.push(["um servidor que nao esta na lista", reason(join(here, me, "job-nowhere")), "gone"]);
	cases.push(["um servidor cheio (lido AGORA, nao do cache)", reason(join(here, me, full.jobId)), "full"]);
	here.loadingSet.add(me);
	cases.push(["o save ainda carregando", reason(join(here, me, there.jobId)), "loading"]);
	here.loadingSet.delete(me);
	here.inCity.add(me);
	cases.push([
		"de dentro da cidade (nunca um teleporte no meio da luta)",
		reason(join(here, me, there.jobId)),
		"inWorld",
	]);
	here.inCity.delete(me);
	// the same gates as Play solo's trip (server/match/matchHost.ts `blocker`, merged with MP-25): refused before the
	// store is read, so no gap is spent (the clock stays where it is: `there` must not go stale)
	here.deadSet.add(me);
	cases.push(["morto (a morte se responde onde aconteceu, MP-21)", reason(here.list.join(me, there.jobId)), "dead"]);
	here.deadSet.delete(me);
	here.dangerSet.add(me);
	cases.push([
		"o corpo vivo guardado no meio da luta (nenhuma fuga gratis da horda, H1)",
		reason(here.list.join(me, there.jobId)),
		"danger",
	]);
	here.dangerSet.delete(me);
	here.tripSet.add(me);
	cases.push([
		"uma viagem do Play solo a caminho (um teleporte por vez)",
		reason(here.list.join(me, there.jobId)),
		"trip",
	]);
	here.tripSet.delete(me);
	// an entry that is still in the map but stale (its server stopped writing and the clock moved on)
	map.SetAsync(
		"job-old",
		{ v: 1, kind: "public", place: PLACE, seed: 5, day: 1, n: 1, max: 6, t: 1_700_000_000 + clockNow - 1000 },
		600,
		0,
	);
	cases.push(["uma entrada velha (o servidor parou de publicar)", reason(join(here, me, "job-old")), "gone"]);
	map.SetAsync(
		"job-priv",
		{ v: 1, kind: "private", place: PLACE, seed: 5, day: 1, n: 1, max: 6, t: 1_700_000_000 + clockNow },
		60,
		0,
	);
	cases.push(["uma entrada que nao e publica", reason(join(here, me, "job-priv")), "gone"]);
	map.SetAsync("job-bad", { v: 1, kind: "public", place: PLACE, seed: "x", day: 1, n: 1, max: 6, t: 1 }, 60, 0);
	cases.push(["uma entrada malformada", reason(join(here, me, "job-bad")), "gone"]);
	const wrong = cases.filter(([, got, want]) => got !== want);
	check(
		"recusas: " + cases.map(([what, , want]) => `${what} -> ${want}`).join("; "),
		wrong.length === 0 && here.teleports.length === 0,
		wrong.map(([what, got]) => `${what}: ${got}`).join("; ") || `${cases.length} casos, nenhum teleporte`,
	);
	// another place of the experience: never listed, never joined (review of 0b44458, L6)
	map.SetAsync(
		"job-otherplace",
		{ v: 1, kind: "public", place: PLACE + 1, seed: 5, day: 1, n: 1, max: 6, t: 1_700_000_000 + clockNow },
		60,
		0,
	);
	const other = here.list.join(me, "job-otherplace");
	clockNow += SL.JOIN_GAP_S;
	check(
		"uma entrada de OUTRO place da experiencia: gone, nenhum teleporte (e a lista nunca a mostra)",
		!other.ok && other.reason === "gone" && here.teleports.length === 0,
		JSON.stringify(other),
	);
	const ok = here.list.join(me, there.jobId);
	check(
		"uma cidade aberta: TeleportAsync para ESSE servidor (o JoinedFromList e contado na chegada, no destino)",
		ok.ok && here.teleports.length === 1 && here.teleports[0].jobId === there.jobId,
		JSON.stringify(ok),
	);
	// while it is under way the host keeps them out of the city (server/net/mpHost.ts `mayEnter`), and never for longer
	// than JOIN_TIMEOUT_S: a teleport that never happens and never says so does not hold anyone forever
	const heldNow = here.list.joining(me);
	const t0 = clockNow;
	clockNow += SL.JOIN_TIMEOUT_S;
	const heldLater = here.list.joining(me);
	clockNow = t0;
	check(
		"...e enquanto ela esta a caminho o servidor nao poe o jogador na cidade (joining), por no maximo JOIN_TIMEOUT_S",
		heldNow === true && heldLater === false,
	);
	const busy = here.list.join(me, there.jobId);
	check("...e um segundo pedido enquanto o primeiro esta a caminho: busy", !busy.ok && busy.reason === "busy");
	// TeleportInitFailed: the player is still here, and told why; the next try is theirs
	const why = here.list.initFailed(me, "GameFull");
	check(
		"TeleportInitFailed (GameFull): o jogador fica e ouve 'full'; nada mais a caminho",
		why === "full" && !here.list.joining(me),
	);
	check(
		"...GameEnded -> gone, Flooded -> rate, o resto -> failed; e um aviso de quem nao estava indo nao diz nada",
		(() => {
			const map2 = [
				["GameEnded", "gone"],
				["Flooded", "rate"],
				["Unauthorized", "failed"],
			];
			for (const [result, want] of map2) {
				clockNow += SL.JOIN_GAP_S;
				here.list.join(me, there.jobId);
				if (here.list.initFailed(me, result) !== want) return false;
			}
			return here.list.initFailed(me, "GameFull") === undefined;
		})(),
	);
	// too soon after the last one
	clockNow += SL.JOIN_GAP_S;
	here.list.join(me, there.jobId);
	here.list.initFailed(me, "Failure");
	const rate = here.list.join(me, there.jobId);
	check("dois pedidos em menos de JOIN_GAP_S: rate", !rate.ok && rate.reason === "rate");
	// the platform refuses TeleportAsync twice, then takes it: the docs' SafeTeleport
	clockNow += SL.JOIN_GAP_S;
	here.list.initFailed(me, "Failure");
	const [you] = here.add(1);
	here.teleportFails = 2;
	const tele0 = here.teleports.length;
	const retried = here.list.join(you, there.jobId);
	check(
		"TeleportAsync falhando duas vezes: tentado de novo a cada segundo, e vai na terceira",
		retried.ok && here.teleports.length - tele0 === 3,
		`${here.teleports.length - tele0} tentativas`,
	);
	// it keeps failing: "failed", a fixed sentence, and nothing left under way
	const [they] = here.add(1);
	here.teleportFails = 10;
	const warns0 = here.warns.length;
	const failed = here.list.join(they, there.jobId);
	check(
		"falhando sempre: TELEPORT_TRIES tentativas, failed, uma frase fixa no aviso, e nada fica a caminho",
		!failed.ok &&
			failed.reason === "failed" &&
			!here.list.joining(they) &&
			here.warns.length - warns0 === 1 &&
			here.warns.at(-1).startsWith("a join from the server list could not be sent | "),
	);
	here.teleportFails = 0;
	// the player walks into the city between two tries: no teleport out of a fight
	const [runner] = here.add(1);
	here.teleportFails = 1;
	const tele1 = here.teleports.length;
	const origWait = clockNow;
	// the wait between the tries is where they walk in
	const list = here.list;
	const hostWait = list.host.wait;
	list.host.wait = s => {
		hostWait(s);
		here.inCity.add(runner);
	};
	const walked = list.join(runner, there.jobId);
	list.host.wait = hostWait;
	check(
		"entrou na cidade entre duas tentativas: nenhum teleporte a mais (inWorld)",
		!walked.ok && walked.reason === "inWorld" && here.teleports.length - tele1 === 1 && clockNow > origWait,
	);
	here.teleportFails = 0;
	// Studio / no service
	const studio = makeServer(map, { kind: "studio" });
	const st = studio.list.join(studio.add(1)[0], there.jobId);
	const noTp = makeServer(map, { teleport: false });
	const nt = noTp.list.join(noTp.add(1)[0], there.jobId);
	check(
		"Studio: studio; sem TeleportService: unavailable",
		!st.ok && st.reason === "studio" && !nt.ok && nt.reason === "unavailable",
	);
	// leaving forgets the player
	here.list.forget(me);
	check("quem sai do servidor e esquecido (nada fica guardado dele)", !here.list.joining(me));
});

// ================================================================ 5. the wire

section("5) o fio: o que o cliente pode mandar, e o que o cliente aceita de volta", () => {
	const good = [
		{ kind: "servers" },
		{ kind: "restart" },
		{ kind: "join", jobId: "0f8fad5b-d9cb-469f-a165-70867728950e" },
	];
	const bad = [
		undefined,
		7,
		"servers",
		{},
		{ kind: "join" },
		{ kind: "join", jobId: 5 },
		{ kind: "join", jobId: "" },
		{ kind: "join", jobId: "a b" },
		{ kind: "join", jobId: "x".repeat(65) },
		{ kind: "join", jobId: "job\n1" },
		{ kind: "join", jobId: "jób" },
		{ kind: "teleport", jobId: "job-1" },
		{ kind: "restart", seed: 5 },
	];
	check(
		"readTownRequest: so servers, join{jobId de GUID} e restart; qualquer outra coisa e undefined (invalid)",
		good.every(r => TN.readTownRequest(r) !== undefined) &&
			bad.slice(0, 12).every(r => TN.readTownRequest(r) === undefined),
	);
	check(
		"...e um restart nunca leva nada do cliente (nem semente, nem dia): so o pedido",
		JSON.stringify(TN.readTownRequest({ kind: "restart", seed: 5, day: 9 })) ===
			JSON.stringify({ kind: "restart" }),
	);
	const rows = TN.readServerRows([
		{ jobId: "job-1", seed: 5, day: 2, players: 1, max: 6 },
		{ jobId: "job-2", seed: 0, day: 2, players: 1, max: 6 },
		{ jobId: "job 3", seed: 5, day: 2, players: 1, max: 6 },
		{ jobId: "job-4", seed: 5, day: 2, players: 7, max: 6 },
		{ jobId: "job-5", seed: 5, day: 1.5, players: 1, max: 6 },
		"junk",
		...Array.from({ length: 40 }, (_, i) => ({ jobId: `job-x${i}`, seed: 9, day: 1, players: 0, max: 6 })),
	]);
	check(
		"readServerRows (o cliente): linhas malformadas caem, e nunca mais de SERVER_ROWS_MAX",
		rows[0].jobId === "job-1" &&
			rows.every(r => r.jobId !== "job-2" && r.jobId !== "job 3" && r.jobId !== "job-4") &&
			rows.length === TN.SERVER_ROWS_MAX,
		`${rows.length} linhas`,
	);
	const r = TN.readTownResponse({ ok: false, reason: "nonsense" });
	check("uma resposta com motivo desconhecido vira failed", !r.ok && r.reason === "failed");
});

// ================================================================ 6. the quota

section("6) a cota do MemoryStore: por servidor e para a experiencia inteira", () => {
	for (const p of [1, 2, 3, 6]) {
		const q = SL.quotaPerMinute(p);
		check(
			`${p} jogador(es): no pior caso ${q.writes} escritas + ${q.reads} de leitura + ${q.joins} de entradas = ${q.total} unidades/min <= 120 x ${p}`,
			q.total <= 120 * p,
		);
	}
	// an hour of 40 servers; every lobby player keeps the list open (a request a second) and joins every minute
	const map = new FakeSortedMap();
	const servers = [];
	let ccu = 0;
	for (let i = 0; i < 40; i++) {
		const s = makeServer(map, { seed: 1000 + i, day: 1 + (i % 15) });
		const n = 1 + (i % 6);
		s.add(n);
		ccu += n;
		servers.push(s);
	}
	const perServer = new Map(servers.map(s => [s, 0]));
	const units0 = map.units;
	let worstMinute = 0;
	let minuteUnits = 0;
	for (let t = 0; t < 3600; t++) {
		for (const s of servers) {
			const u0 = map.units;
			if (t % SL.TICK_S === 0) s.list.tick();
			for (const p of s.players) {
				s.list.list(p);
				// a join attempt a minute per player, to a town that is full (it stays: the numbers do not move)
				if ((t + p.UserId) % 60 === 0) {
					s.list.join(p, "job-full-town");
				}
			}
			perServer.set(s, perServer.get(s) + (map.units - u0));
		}
		clockNow += 1;
		if ((t + 1) % 60 === 0) {
			worstMinute = Math.max(worstMinute, map.units - units0 - minuteUnits);
			minuteUnits = map.units - units0;
		}
	}
	const total = map.units - units0;
	const worstServer = Math.max(...servers.map(s => perServer.get(s) / 60 / [...s.players].length));
	check(
		`uma hora, 40 servidores, ${ccu} jogadores sempre com a lista aberta: por servidor, no pior caso ${worstServer.toFixed(1)} unidades/min por jogador (<= 120)`,
		worstServer <= 120,
	);
	check(
		`...a experiencia inteira: o pior minuto ${worstMinute} unidades, contra 1000 + 120 x ${ccu} = ${1000 + 120 * ccu}`,
		worstMinute <= 1000 + 120 * ccu,
		`${(total / 60).toFixed(0)} unidades/min em media`,
	);
	check(
		`...e contra o teto de uma estrutura (${SL.STRUCTURE_UNITS_PER_MINUTE} unidades/min): ${worstMinute}`,
		worstMinute <= SL.STRUCTURE_UNITS_PER_MINUTE,
	);
	const perStructureServers = Math.floor(SL.STRUCTURE_UNITS_PER_MINUTE / SL.quotaPerMinute(1).total);
	check(
		`o teto da estrutura so apertaria com ~${perStructureServers} servidores de 1 jogador lendo e entrando no pior ritmo ao mesmo tempo`,
		perStructureServers > 800,
	);
});

// ================================================================ 7. the Roblox side

section("7) o lado Roblox: startServerList com as chamadas como a API as pede", () => {
	const map = new FakeSortedMap();
	const services = new Map();
	const teleportCalls = [];
	const ts = {
		TeleportInitFailed: new Signal(),
		TeleportAsync: (placeId, players, options) => {
			teleportCalls.push({ placeId, players, options });
			return {};
		},
	};
	const asked = [];
	const closers = [];
	const makeGame = ({ studio, privateId = "", owner = 0, jobId = "live-job-1" }) => {
		asked.length = 0;
		services.clear();
		services.set("RunService", { IsStudio: () => studio });
		services.set("MemoryStoreService", { GetSortedMap: name => (asked.push(`map:${name}`), map) });
		services.set("TeleportService", ts);
		globalThis.game = {
			GetService: name => {
				asked.push(name);
				const s = services.get(name);
				if (s === undefined) throw new Error(`no ${name}`);
				return s;
			},
			JobId: jobId,
			PrivateServerId: privateId,
			PrivateServerOwnerId: owner,
			PlaceId: 5555,
			BindToClose: fn => closers.push(fn),
		};
	};
	const players = new Set();
	const player = makePlayer();
	players.add(player);
	const notices = [];
	const gameSide = {
		town: () => ({ seed: 31337, day: 4 }),
		players: () => [...players].length,
		capacity: () => 6,
		inWorld: () => false,
		loading: () => false,
		isDead: () => false,
		keptInDanger: () => false,
		travelling: () => false,
		connected: p => players.has(p),
		bestDay: () => 4,
		log: () => {},
		warn: () => {},
	};
	// Studio: neither service is even asked for
	makeGame({ studio: true });
	const inStudio = SL.startServerList(gameSide, (p, why) => notices.push(why));
	check(
		"no Studio: nem MemoryStoreService nem TeleportService sao pedidos; a lista diz studio",
		!asked.includes("MemoryStoreService") &&
			!asked.includes("TeleportService") &&
			inStudio.list(player).reason === "studio",
		asked.join(", "),
	);
	// a live public server
	makeGame({ studio: false });
	spawned.length = 0;
	const live = SL.startServerList(gameSide, (p, why) => notices.push({ p, why }));
	const set = map.log.find(x => x.kind === "set");
	check(
		`publico: GetSortedMap("${SL.SERVER_LIST_MAP}"), e o laco do tique publica logo: SetAsync(JobId, entrada, ${SL.ENTRY_TTL_S}, 0)`,
		asked.includes(`map:${SL.SERVER_LIST_MAP}`) &&
			set?.key === "live-job-1" &&
			set.expiration === SL.ENTRY_TTL_S &&
			set.sortKey === 0 &&
			set.value.seed === 31337 &&
			spawned.length === 1,
		JSON.stringify(set),
	);
	// another server's entry, then a read and a join through the real adapters
	map.SetAsync(
		"other-job",
		{ v: 1, kind: "public", place: PLACE, seed: 7, day: 4, n: 2, max: 6, t: 1_700_000_000 + clockNow },
		60,
		0,
	);
	const res = live.list(player);
	const range = map.log.filter(x => x.kind === "range").at(-1);
	check(
		"a leitura: GetRangeAsync(Enum.SortDirection.Ascending, READ_COUNT)",
		res.ok &&
			res.servers.length === 1 &&
			range.direction === Enum.SortDirection.Ascending &&
			range.count === SL.READ_COUNT,
	);
	const j = live.join(player, "other-job");
	const call = teleportCalls.at(-1);
	check(
		"a entrada: TeleportAsync(game.PlaceId, {player}, TeleportOptions com ServerInstanceId = o JobId escolhido)",
		j.ok &&
			call.placeId === 5555 &&
			call.players.length === 1 &&
			call.players[0] === player &&
			call.options.ClassName === "TeleportOptions" &&
			call.options.ServerInstanceId === "other-job",
		JSON.stringify({ ok: j.ok, placeId: call?.placeId, id: call?.options?.ServerInstanceId }),
	);
	check(
		"...carregando SERVER_LIST_TELEPORT_DATA (SetTeleportData): o destino conta a entrada quando ela CHEGA (L5)",
		JSON.stringify(call.options.teleportData) === JSON.stringify(SL.SERVER_LIST_TELEPORT_DATA),
		JSON.stringify(call.options.teleportData),
	);
	ts.TeleportInitFailed.Fire(player, { Name: "GameFull" }, "The game is full", 5555, call.options);
	check(
		"TeleportInitFailed: o jogador ouve o motivo (TownNotice joinFailed, full)",
		notices.length === 1 && notices[0].p === player && notices[0].why === "full",
	);
	for (const fn of closers) fn();
	check("BindToClose: RemoveAsync(JobId) -- a entrada sai na hora", !map.items.has("live-job-1"));
	// a tick that throws (a host callback, a store past its own pcall) is warned and never ends the loop (L4)
	closers.length = 0;
	makeGame({ studio: false, jobId: "live-job-2" });
	const warns = [];
	const badSide = {
		...gameSide,
		town: () => {
			throw new Error("the host is gone");
		},
		warn: (what, detail) => warns.push(`${what} | ${detail}`),
	};
	let threw = false;
	try {
		SL.startServerList(badSide, () => {});
	} catch {
		threw = true;
	}
	check(
		"um tique que lanca: avisado numa frase fixa, o laco segue (nunca derruba o servidor)",
		!threw && warns.some(w => w.startsWith("the server list tick failed | ")),
		warns.join("; "),
	);
	for (const fn of closers) fn();
	// a private server: reads and joins, never publishes
	const writes0 = map.calls.set;
	closers.length = 0;
	makeGame({ studio: false, privateId: "ps-1", owner: 42, jobId: "private-job" });
	const priv = SL.startServerList(gameSide, () => {});
	check(
		"um servidor privado le a lista e entra, mas nunca publica (nem laco, nem BindToClose)",
		!priv.publishes() && map.calls.set === writes0 && closers.length === 0 && priv.list(player).ok,
	);
});

// ================================================================ 8. the wiring

section("8) a fiacao (o que o Node nao roda): nenhum teleporte tira alguem de uma luta", () => {
	const { readFileSync } = require("node:fs");
	const host = readFileSync(join(SRC, "server/net/mpHost.ts"), "utf8");
	const main = readFileSync(join(SRC, "server/main.server.ts"), "utf8");
	// between the hold and the entry, only comments and the combat-log guard's hand-back (§7.2: a body still standing
	// in the fight it was left in is theirs again -- only once the hold has let them in)
	check(
		"mpHost admit: quem tem uma entrada a caminho nao e posto na cidade (mayEnter)",
		/function admit\(player: Player\)[\s\S]*?const mayEnter = options\.mayEnter;\s*if \(mayEnter !== undefined && !mayEnter\(player\)\) return;\s*(?:\/\/[^\n]*\n\s*)*(?:if \(lingers\.has\(player\.UserId\)\) endLinger\(player\.UserId, true\);\s*)?const sp = lives\.enter/.test(
			host,
		),
	);
	check(
		"main.server liga o mayEnter do host a lista (joining), junto com o do Play solo (match.admits)",
		/mayEnter: player =>\s*\(match === undefined \|\| match\.admits\(player\)\) && townServices\?\.list\.joining\(player\) !== true/.test(
			main,
		),
	);
	check(
		"...e os dois teleportes se excluem: a lista pergunta pela viagem do Play solo, o Play solo pela entrada da lista",
		/travelling: player => match\?\.travel\.inFlight\(player\) === true/.test(main) &&
			/joining: player => townServices\?\.list\.joining\(player\) === true/.test(main),
	);
	const services = readFileSync(join(SRC, "server/match/townServices.ts"), "utf8");
	check(
		"o remote le o pedido (uma olhada pura), conta o flood com ele (malformado de qualquer forma, L6), depois o balde",
		/OnServerInvoke = \(player: Player, raw: unknown\)[\s\S]*?readTownRequest\(raw\)[\s\S]*?host\.noteRemote\(player, req === undefined\)[\s\S]*?take\(player\)/.test(
			services,
		),
	);
});

// ================================================================ 9. the review of 0b44458

section(
	"9) a revisao de 0b44458: outro place, o fechamento contra uma escrita no ar, a falha que chega antes da resposta",
	() => {
		// L6: an entry of another place of the experience is never listed
		{
			const map = new FakeSortedMap();
			const here = makeServer(map);
			const there = makeServer(map, { seed: 77, day: 3 });
			const elsewhere = makeServer(map, { seed: 88, day: 3, placeId: PLACE + 7 });
			here.add(1);
			there.add(2);
			elsewhere.add(2);
			for (const x of [here, there, elsewhere]) x.list.tick();
			const rows = here.list.list([...here.players][0]).servers ?? [];
			check(
				"L6: a lista mostra a cidade deste place e nunca a de outro place da experiencia",
				rows.some(r => r.jobId === there.jobId) && !rows.some(r => r.jobId === elsewhere.jobId),
				rows.map(r => r.jobId).join(", "),
			);
		}
		// L4: the shutdown lands while a write is in flight (SetAsync yields): the entry is gone after both, and nothing
		// is written after
		{
			const map = new FakeSortedMap();
			const s = makeServer(map);
			s.add(2);
			const realSet = map.SetAsync.bind(map);
			map.SetAsync = (...a) => {
				// BindToClose runs while this request is in flight
				s.list.withdraw();
				return realSet(...a);
			};
			s.list.tick();
			map.SetAsync = realSet;
			const goneAfter = !map.items.has(s.jobId);
			clockNow += SL.PUBLISH_EVERY_S;
			s.list.tick();
			check(
				"L4: o fechamento chega com uma escrita no ar -- a entrada sai mesmo assim, e nada e escrito depois",
				goneAfter && !map.items.has(s.jobId),
				`${map.calls.set} escrita(s), ${map.calls.remove} remocao(oes)`,
			);
		}
		// L5: TeleportInitFailed comes while TeleportAsync still yields: the answer is that failure, never "sent"
		{
			const map = new FakeSortedMap();
			const here = makeServer(map, {
				teleportHook: (server, p) => {
					server.teleports.push({ p });
					server.list.initFailed(p, "GameFull");
				},
			});
			const there = makeServer(map, { seed: 5, day: 2 });
			here.add(1);
			there.add(2);
			there.list.tick();
			const [me] = here.add(1);
			const res = here.list.join(me, there.jobId);
			check(
				"L5: a falha do TeleportInitFailed chega antes de o TeleportAsync voltar: a resposta e essa falha (full), nada fica a caminho",
				!res.ok && res.reason === "full" && !here.list.joining(me) && here.teleports.length === 1,
				JSON.stringify(res),
			);
		}
		// L5: the join is counted where it lands -- the destination reads the flag, from this very place only
		{
			const data = SL.SERVER_LIST_TELEPORT_DATA;
			const cases = [
				[{ SourcePlaceId: PLACE, TeleportData: data }, true],
				[{ SourcePlaceId: PLACE, TeleportData: { pz: "servers", extra: 1 } }, true],
				[{ SourcePlaceId: PLACE + 1, TeleportData: data }, false],
				[{ TeleportData: data }, false],
				[{ SourcePlaceId: PLACE, TeleportData: { pz: "solo" } }, false],
				[{ SourcePlaceId: PLACE, TeleportData: "servers" }, false],
				[{ SourcePlaceId: PLACE }, false],
				[undefined, false],
				["x", false],
			];
			const wrong = cases.filter(([jd, want]) => SL.arrivedFromList(jd, PLACE) !== want);
			check(
				"L5: arrivedFromList -- so o sinal da lista, e so vindo deste mesmo place (a doc: conferir SourcePlaceId)",
				wrong.length === 0,
				wrong.map(([jd]) => JSON.stringify(jd)).join("; "),
			);
		}
	},
);

// ================================================================ verdict

console.log("");
if (failures > 0) {
	console.log(`${failures} of ${checks} check(s) FAILED`);
	process.exit(1);
}
console.log(`OK: ${checks} checks -- the Servers list publishes, reads, joins and stays inside the MemoryStore quota`);
