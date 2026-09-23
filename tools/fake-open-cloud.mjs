/*
 * A fake Roblox Open Cloud (data stores v2 only), preloaded with `node --import` so `tools/cloud.mjs` can be driven
 * end to end without the network or a real key (tools/test-save.mjs, `erase`).
 *
 *   PZ_FAKE_CLOUD_STATE=<file.json>   the stores to start from: { "<store>": { "<key>": <value> } }; rewritten
 *                                     with the final state (and every request made) when the process exits
 *   PZ_FAKE_CLOUD_CONFLICTS=<n>       the first n PATCHes answer 409, as if a server wrote the key meanwhile
 *
 * Every request must carry the x-api-key header; the key's text is never written anywhere by this file.
 */
import { readFileSync, writeFileSync } from "node:fs";

const statePath = process.env.PZ_FAKE_CLOUD_STATE;
const state = JSON.parse(readFileSync(statePath, "utf8"));
let conflicts = Number(process.env.PZ_FAKE_CLOUD_CONFLICTS ?? 0);
const requests = [];
let etagSerial = 0;
const etags = new Map();
const etagOf = (store, key) => {
	const id = `${store}/${key}`;
	if (!etags.has(id)) etags.set(id, `e${++etagSerial}`);
	return etags.get(id);
};

const json = (status, body) =>
	new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

globalThis.fetch = async (url, init = {}) => {
	const u = new URL(url);
	const method = init.method ?? "GET";
	const keyed = typeof init.headers?.["x-api-key"] === "string" && init.headers["x-api-key"] !== "";
	requests.push({ method, path: decodeURIComponent(u.pathname), keyed });
	if (!keyed) return json(401, { message: "no key" });
	const m = /^\/cloud\/v2\/universes\/[^/]+\/data-stores\/([^/]+)(?:\/scopes\/global)?\/entries(?:\/([^/]+))?$/.exec(
		u.pathname,
	);
	if (!m) return json(404, { message: "not a data store route" });
	const store = decodeURIComponent(m[1]);
	const key = m[2] !== undefined ? decodeURIComponent(m[2]) : undefined;
	const docs = state[store] ?? {};
	if (key === undefined) {
		// list, with filter=id.startsWith("...")
		const prefix = /id\.startsWith\("([^"]*)"\)/.exec(u.searchParams.get("filter") ?? "")?.[1] ?? "";
		const ids = Object.keys(docs).filter(k => k.startsWith(prefix));
		return json(200, { dataStoreEntries: ids.map(id => ({ id, path: `x/entries/${id}` })) });
	}
	if (!(key in docs)) return json(404, { message: "entry not found" });
	if (method === "GET") return json(200, { id: key, value: docs[key], etag: etagOf(store, key), users: [] });
	if (method === "DELETE") {
		delete docs[key];
		return json(200, {});
	}
	if (method === "PATCH") {
		const body = JSON.parse(init.body);
		if (conflicts > 0) {
			conflicts--;
			etags.set(`${store}/${key}`, `e${++etagSerial}`);
			return json(409, { message: "etag mismatch" });
		}
		if (body.etag !== etagOf(store, key)) return json(409, { message: "etag mismatch" });
		docs[key] = body.value;
		etags.set(`${store}/${key}`, `e${++etagSerial}`);
		return json(200, { id: key, etag: etagOf(store, key) });
	}
	return json(405, { message: "method" });
};

process.on("exit", () => writeFileSync(statePath, JSON.stringify({ state, requests })));
