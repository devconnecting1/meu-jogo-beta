/*
 * A fake Roblox Open Cloud (data stores v2, and the Assets API's upload), preloaded with `node --import` so
 * `tools/cloud.mjs` can be driven end to end without the network or a real key (tools/test-save.mjs, `erase`;
 * tools/test-audio.mjs, `upload-audio`).
 *
 *   PZ_FAKE_CLOUD_STATE=<file.json>   the stores to start from: { "<store>": { "<key>": <value> } }; rewritten
 *                                     with the final state (and every request made, and every asset uploaded) when
 *                                     the process exits
 *   PZ_FAKE_CLOUD_CONFLICTS=<n>       the first n PATCHes answer 409, as if a server wrote the key meanwhile
 *   PZ_FAKE_CLOUD_FAIL=<store/key>    every GET of that entry answers 500 (a key that keeps failing)
 *   PZ_FAKE_CLOUD_MODERATION=<state>:<displayName fragment>
 *                                     the upload whose displayName contains the fragment finishes with that moderation
 *                                     state (REJECTED, REVIEWING); every other upload is APPROVED
 *
 * The Assets API as documented (create.roblox.com/docs/cloud/guides/usage-assets): POST /assets/v1/assets takes a
 * multipart form with `request` (JSON: assetType, displayName, description, creationContext.creator) and
 * `fileContent` (the file, with its content type), and answers an Operation; GET /assets/v1/operations/{id} answers it
 * done, with `response.assetId` and `response.moderationResult.moderationState`. The fake checks what the real one
 * would refuse: a known assetType, a creator, a file with an accepted content type for that type.
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
	if (u.pathname.startsWith("/assets/v1/")) return assetsApi(u, method, init);
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

// ---------------------------------------------------------------- the Assets API (upload only)

/** the content types the Assets API accepts per asset type (usage-assets, "Supported asset types and limits") */
const ACCEPTS = {
	Audio: ["audio/mpeg", "audio/ogg", "audio/wav", "audio/flac"],
	Image: ["image/png", "image/jpeg", "image/bmp", "image/tga"],
	Decal: ["image/png", "image/jpeg", "image/bmp", "image/tga"],
};
const uploads = [];
const operations = new Map();
let nextAsset = 900000000;
const moderation = process.env.PZ_FAKE_CLOUD_MODERATION;

async function assetsApi(u, method, init) {
	if (method === "POST" && u.pathname === "/assets/v1/assets") {
		const form = init.body;
		if (!(form instanceof FormData)) return json(400, { message: "multipart form expected" });
		let request;
		try {
			request = JSON.parse(String(form.get("request")));
		} catch {
			return json(400, { message: "request is not JSON" });
		}
		const file = form.get("fileContent");
		const accepts = ACCEPTS[request.assetType];
		if (accepts === undefined) return json(400, { message: `unknown assetType ${request.assetType}` });
		const creator = request.creationContext?.creator ?? {};
		if (creator.userId === undefined && creator.groupId === undefined) return json(400, { message: "no creator" });
		if (!(file instanceof Blob) || !accepts.includes(file.type))
			return json(400, { message: `content type ${file?.type} not accepted for ${request.assetType}` });
		if (file.size > 20 * 1024 * 1024) return json(400, { message: "file over 20 MB" });
		const bytes = Buffer.from(await file.arrayBuffer());
		const assetId = String(nextAsset++);
		let state = "MODERATION_STATE_APPROVED";
		if (moderation !== undefined) {
			const [want, fragment] = moderation.split(":");
			if (fragment !== undefined && String(request.displayName).includes(fragment))
				state = `MODERATION_STATE_${want}`;
		}
		uploads.push({
			assetId,
			assetType: request.assetType,
			displayName: request.displayName,
			creator,
			fileName: file.name,
			contentType: file.type,
			size: bytes.length,
			sha1: createHash("sha1").update(bytes).digest("hex"),
			moderation: state,
		});
		const opId = `op${assetId}`;
		operations.set(opId, { assetId, state });
		return json(200, { path: `operations/${opId}`, done: false });
	}
	const op = /^\/assets\/v1\/operations\/([^/]+)$/.exec(u.pathname);
	if (method === "GET" && op) {
		const o = operations.get(op[1]);
		if (o === undefined) return json(404, { message: "no such operation" });
		return json(200, {
			path: `operations/${op[1]}`,
			done: true,
			response: {
				assetId: o.assetId,
				moderationResult: { moderationState: o.state },
			},
		});
	}
	return json(404, { message: "not an assets route of the fake" });
}

process.on("exit", () => {
	if (statePath !== undefined) writeFileSync(statePath, JSON.stringify({ state, requests, uploads }));
});
