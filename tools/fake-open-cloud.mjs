/*
 * A fake Roblox Open Cloud (data stores v2 only), preloaded with `node --import` so `tools/cloud.mjs` can be driven
 * end to end without the network or a real key (tools/test-save.mjs, `erase`).
 *
 *   PZ_FAKE_CLOUD_STATE=<file.json>   the stores to start from: { "<store>": { "<key>": <value> } }; rewritten
 *                                     with the final state (and every request made) when the process exits
 *   PZ_FAKE_CLOUD_CONFLICTS=<n>       the first n PATCHes answer 409, as if a server wrote the key meanwhile
 *   PZ_FAKE_CLOUD_FAIL=<store/key>    every GET of that entry answers 500 (a key that keeps failing)
 *
 * Stricter than the real API on purpose: an entry is only reached by the SCOPED path
 * (`/data-stores/<ds>/scopes/global/entries/<key>`), the one tools/cloud.mjs uses everywhere; the unscoped form answers
 * 400, so a call that drifts to it fails here instead of at the owner's first real run. Every request must carry the
 * x-api-key header; the key's text is never written anywhere by this file.
 */
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";

/** tools/cloud.mjs refuses to call anything under test unless this is set (never the real apis.roblox.com) */
globalThis.__PZ_FAKE_OPEN_CLOUD = true;

const statePath = process.env.PZ_FAKE_CLOUD_STATE;
const state = statePath !== undefined ? JSON.parse(readFileSync(statePath, "utf8")) : {};
let conflicts = Number(process.env.PZ_FAKE_CLOUD_CONFLICTS ?? 0);
const failing = process.env.PZ_FAKE_CLOUD_FAIL;
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
	const key0 = init.headers?.["x-api-key"];
	const keyed = typeof key0 === "string" && key0 !== "";
	// which key was used, as a short hash (a test compares it with the hash of the key it planted)
	const keyHash = keyed ? createHash("sha256").update(key0).digest("hex").slice(0, 12) : "";
	requests.push({ method, path: decodeURIComponent(u.pathname), host: u.host, keyed, keyHash });
	if (!keyed) return json(401, { message: "no key" });
	const m = /^\/cloud\/v2\/universes\/([^/]+)\/data-stores\/([^/]+)(\/scopes\/global)?\/entries(?:\/([^/]+))?$/.exec(
		u.pathname,
	);
	if (!m) return json(404, { message: "not a data store route" });
	const [, universe, rawStore, scoped, rawKey] = m;
	const store = decodeURIComponent(rawStore);
	const key = rawKey !== undefined ? decodeURIComponent(rawKey) : undefined;
	if (key !== undefined && scoped === undefined)
		return json(400, { message: "unscoped entry path refused by the fake" });
	const docs = state[store] ?? {};
	if (key === undefined) {
		const ids = Object.keys(docs);
		return json(200, {
			dataStoreEntries: ids.map(id => ({
				id,
				path: `universes/${universe}/data-stores/${store}/scopes/global/entries/${id}`,
			})),
		});
	}
	if (failing === `${store}/${key}` && method === "GET") return json(500, { message: "injected failure" });
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

process.on("exit", () => {
	if (statePath !== undefined) writeFileSync(statePath, JSON.stringify({ state, requests }));
});
