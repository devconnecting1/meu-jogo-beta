/*
 * A fake Roblox Open Cloud (data stores v2 and the Assets API), preloaded with `node --import` so `tools/cloud.mjs`
 * can be driven end to end without the network or a real key (tools/test-save.mjs: `erase`; tools/test-assets-ci.mjs:
 * `upload-art --ci` and `upload-audio --ci`; tools/test-audio.mjs: `upload-audio`).
 *
 *   PZ_FAKE_CLOUD_STATE=<file.json>   the stores to start from: { "<store>": { "<key>": <value> } }; rewritten
 *                                     with the final state (and every request made) when the process exits
 *   PZ_FAKE_CLOUD_CONFLICTS=<n>       the first n PATCHes answer 409, as if a server wrote the key meanwhile
 *   PZ_FAKE_CLOUD_FAIL=<store/key>    every GET of that entry answers 500 (a key that keeps failing)
 *
 * Assets (POST /assets/v1/assets, GET /assets/v1/operations/{id}, GET /assets/v1/assets/{id}[/versions/{n}]):
 *
 *   PZ_FAKE_ASSETS_STATE=<file.json>  the assets made so far (read at start when it exists, rewritten at exit): a
 *                                     second run sees the first one's uploads, as Roblox would
 *   PZ_FAKE_ASSETS='{"<name>": "<plan>", "*": "<plan>"}'   what happens to each upload, by the name in its
 *                                     displayName ("LastTown world <name>", "LastTown sfx <bank>"); a plan is
 *                                     comma-separated tokens:
 *        approve (default) | reject | review:N (N moderation reads say "reviewing", then approved)
 *        | review:N:reject (then rejected) | review (in review forever)
 *        op:N        the operation answers done=false for its first N polls
 *        error       the operation finishes with an error (no asset)
 *        429:N / 500:N   the first N uploads of that name answer 429 / 500 (counted across runs)
 *        imageBad    assetType "Image" answers 400 (as an older API revision did); "Decal" is accepted
 *        nomod       neither the operation nor the asset carry moderationResult; only the version does
 *        denied      the upload answers 403 (a key without asset:write)
 *   PZ_FAKE_ASSETS_STYLE=doc          moderation states as the reference describes them ("Approved"), instead of
 *                                     the API's "MODERATION_STATE_APPROVED"
 *
 * Stricter than the real API on purpose: an entry is only reached by the SCOPED path
 * (`/data-stores/<ds>/scopes/global/entries/<key>`), the one tools/cloud.mjs uses everywhere; the unscoped form answers
 * 400, so a call that drifts to it fails here instead of at the owner's first real run. An upload must be the
 * multipart form the Assets API documents (a `request` JSON with assetType, displayName, description and a numeric
 * creator; a non-empty `fileContent` with a content type), or it answers 400 -- and the content type has to be one the
 * docs list for that assetType (cloud/guides/usage-assets: Audio .mp3/.ogg/.wav/.flac, Image and Decal
 * .png/.jpeg/.bmp/.tga), within 20 MB. Every request must carry the x-api-key header; the key's text is never written
 * anywhere by this file.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";

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

/** the content types the Assets API takes per assetType (usage-assets, "Supported asset types and limits") */
const ACCEPTS = {
	Audio: ["audio/mpeg", "audio/ogg", "audio/wav", "audio/flac"],
	Image: ["image/png", "image/jpeg", "image/bmp", "image/tga"],
	Decal: ["image/png", "image/jpeg", "image/bmp", "image/tga"],
};
/** one upload's file, at most (usage-assets: "file size up to 20 MB") */
const MAX_UPLOAD = 20 * 1024 * 1024;

// ---------------------------------------------------------------- the Assets API

const assetsPath = process.env.PZ_FAKE_ASSETS_STATE;
const assets =
	assetsPath !== undefined && existsSync(assetsPath)
		? JSON.parse(readFileSync(assetsPath, "utf8"))
		: { nextId: 9_000_001, nextOp: 1, byId: {}, ops: {}, posts: {} };
const plans = JSON.parse(process.env.PZ_FAKE_ASSETS ?? "{}");
const docStyle = process.env.PZ_FAKE_ASSETS_STYLE === "doc";

/** a plan string -> { moderation: [reviews, final], opPolls, error, fail429, fail500, imageBad, nomod, denied } */
function planOf(name) {
	const plan = { reviews: 0, final: "APPROVED", opPolls: 0, error: false, fail429: 0, fail500: 0 };
	for (const tok of String(plans[name] ?? plans["*"] ?? "approve").split(",")) {
		const [word, a, b] = tok.trim().split(":");
		if (word === "reject") plan.final = "REJECTED";
		else if (word === "review") {
			plan.reviews = a === undefined ? Infinity : Number(a);
			if (b === "reject") plan.final = "REJECTED";
		} else if (word === "op") plan.opPolls = Number(a);
		else if (word === "error") plan.error = true;
		else if (word === "429") plan.fail429 = Number(a);
		else if (word === "500") plan.fail500 = Number(a);
		else if (word === "imageBad" || word === "nomod" || word === "denied") plan[word] = true;
	}
	return plan;
}

/** the state an asset is in now; each call is one moderation read ("review:N" counts them) */
function moderationRead(asset) {
	const state = asset.reads < asset.reviews ? "REVIEWING" : asset.final;
	asset.reads++;
	return { moderationState: docStyle ? state[0] + state.slice(1).toLowerCase() : `MODERATION_STATE_${state}` };
}

function assetBody(asset, withModeration) {
	return {
		path: `assets/${asset.id}`,
		assetId: String(asset.id),
		assetType: asset.assetType,
		displayName: asset.displayName,
		description: asset.description,
		creationContext: { creator: asset.creator },
		revisionId: "1",
		...(withModeration ? { moderationResult: moderationRead(asset) } : {}),
	};
}

async function assetsRoute(u, method, init) {
	const path = u.pathname;
	if (path === "/assets/v1/assets" && method === "POST") {
		const form = init.body;
		if (!(form instanceof FormData)) return json(400, { message: "multipart form expected" });
		let request;
		try {
			request = JSON.parse(String(form.get("request")));
		} catch {
			return json(400, { message: "request is not JSON" });
		}
		const file = form.get("fileContent");
		const creator = request?.creationContext?.creator ?? {};
		const who = creator.userId ?? creator.groupId;
		if (
			typeof request.assetType !== "string" ||
			typeof request.displayName !== "string" ||
			typeof request.description !== "string" ||
			!/^\d+$/.test(String(who ?? "")) ||
			!(file instanceof Blob) ||
			file.size === 0 ||
			file.type === ""
		) {
			return json(400, { message: "invalid create request" });
		}
		const accepts = ACCEPTS[request.assetType];
		if (accepts !== undefined && !accepts.includes(file.type)) {
			return json(400, { message: `content type ${file.type} is not accepted for ${request.assetType}` });
		}
		if (file.size > MAX_UPLOAD) return json(400, { message: "file over 20 MB" });
		const name = request.displayName.replace(/^LastTown (?:world|sfx) /, "");
		const plan = planOf(name);
		const tries = (assets.posts[name] = (assets.posts[name] ?? 0) + 1);
		if (plan.denied) return json(403, { message: "insufficient scope" });
		if (tries <= plan.fail429) return json(429, { message: "too many requests" });
		if (tries <= plan.fail429 + plan.fail500) return json(500, { message: "internal" });
		if (plan.imageBad && request.assetType === "Image") return json(400, { message: "unknown asset type" });
		const bytes = Buffer.from(await file.arrayBuffer());
		const op = String(assets.nextOp++);
		const asset = plan.error
			? undefined
			: {
					id: assets.nextId++,
					name,
					sha1: createHash("sha1").update(bytes).digest("hex"),
					assetType: request.assetType,
					displayName: request.displayName,
					description: request.description,
					contentType: file.type,
					fileName: file.name,
					size: bytes.length,
					creator,
					reviews: plan.reviews === Infinity ? 1e9 : plan.reviews,
					final: plan.final,
					reads: 0,
					nomod: plan.nomod === true,
				};
		if (asset !== undefined) assets.byId[asset.id] = asset;
		assets.ops[op] = { assetId: asset?.id, polls: 0, opPolls: plan.opPolls, error: plan.error };
		return json(200, { path: `operations/${op}`, done: false });
	}
	const opMatch = /^\/assets\/v1\/operations\/([^/]+)$/.exec(path);
	if (opMatch && method === "GET") {
		const op = assets.ops[decodeURIComponent(opMatch[1])];
		if (op === undefined) return json(404, { message: "operation not found" });
		op.polls++;
		if (op.polls <= op.opPolls) return json(200, { path: `operations/${opMatch[1]}`, done: false });
		if (op.error) {
			return json(200, { path: `operations/${opMatch[1]}`, done: true, error: { code: 3, message: "bad file" } });
		}
		const asset = assets.byId[op.assetId];
		return json(200, { path: `operations/${opMatch[1]}`, done: true, response: assetBody(asset, !asset.nomod) });
	}
	const assetMatch = /^\/assets\/v1\/assets\/(\d+)(?:\/versions\/(\d+))?$/.exec(path);
	if (assetMatch && method === "GET") {
		const asset = assets.byId[assetMatch[1]];
		if (asset === undefined) return json(404, { message: "asset not found" });
		if (assetMatch[2] !== undefined) {
			return json(200, {
				path: `assets/${asset.id}/versions/${assetMatch[2]}`,
				moderationResult: moderationRead(asset),
			});
		}
		return json(200, assetBody(asset, !asset.nomod));
	}
	return undefined;
}

globalThis.fetch = async (url, init = {}) => {
	const u = new URL(url);
	const method = init.method ?? "GET";
	const key0 = init.headers?.["x-api-key"];
	const keyed = typeof key0 === "string" && key0 !== "";
	// which key was used, as a short hash (a test compares it with the hash of the key it planted)
	const keyHash = keyed ? createHash("sha256").update(key0).digest("hex").slice(0, 12) : "";
	requests.push({ method, path: decodeURIComponent(u.pathname), host: u.host, keyed, keyHash });
	if (!keyed) return json(401, { message: "no key" });
	if (u.pathname.startsWith("/assets/v1/")) {
		return (await assetsRoute(u, method, init)) ?? json(404, { message: "not an assets route" });
	}
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
	if (assetsPath !== undefined) writeFileSync(assetsPath, JSON.stringify(assets));
});
