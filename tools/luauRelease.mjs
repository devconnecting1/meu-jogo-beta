/*
 * The pinned, official Luau CLI (github.com/luau-lang/luau releases), fetched on first use into a
 * gitignored cache and verified against a hard-coded SHA-256 before it is ever run.
 *
 * Why a real binary at all: Luau enforces several load-time limits when a chunk is compiled -- at most 200
 * active locals per function, 255 registers, a bounded constant table -- and `tools/check-registers.mjs`'s
 * text heuristic only models (imperfectly) the first one. The compiler itself is the only source of truth;
 * see `tools/check-luau.mjs`.
 *
 * Bumping the pinned version: run the `new-release` workflow's build for the new tag, download
 * `luau-ubuntu.zip` / `luau-windows.zip` from the new release, `sha256sum` them, and update VERSION and the
 * two hashes below together. A stale hash fails closed (`ensureLuauCompile` throws) rather than silently
 * running an unverified binary.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { extractZip } from "./minizip.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(__dirname, "..");

export const LUAU_VERSION = "0.739";

/** github.com/luau-lang/luau/releases/download/{LUAU_VERSION}/{asset} */
const RELEASES = {
	linux: {
		asset: "luau-ubuntu.zip",
		sha256: "8a9b4b381021722c82d6e6cda0964b5c9e7f354ec1035fcd8b657acc22e49247",
		bin: "luau-compile",
	},
	win32: {
		asset: "luau-windows.zip",
		sha256: "c5db8c3273f056416da224fd3cf20aa4644afb5af8498303b6b87ca0bd843ad1",
		bin: "luau-compile.exe",
	},
};

export const CACHE_ROOT = path.join(REPO_ROOT, ".cache", "luau");

function platformDir() {
	return path.join(CACHE_ROOT, LUAU_VERSION, process.platform);
}

/** The pinned `luau-compile` path if it is already cached on disk, or null (never downloads). */
export function cachedLuauCompile() {
	const release = RELEASES[process.platform];
	if (!release) return null;
	const p = path.join(platformDir(), release.bin);
	return fs.existsSync(p) ? p : null;
}

export function unsupportedPlatformMessage() {
	return (
		`no pinned Luau release for platform "${process.platform}" (supported: ${Object.keys(RELEASES).join(", ")}). ` +
		`Skipping the real compiler check -- run it on Linux or Windows, or in CI.`
	);
}

async function downloadToBuffer(url) {
	const res = await fetch(url, { redirect: "follow" });
	if (!res.ok) throw new Error(`GET ${url} -> ${res.status} ${res.statusText}`);
	return Buffer.from(await res.arrayBuffer());
}

/**
 * Returns the absolute path to the pinned `luau-compile` for this platform, downloading and verifying it
 * on first use. Returns null on a platform with no pinned release (see `unsupportedPlatformMessage`).
 */
export async function ensureLuauCompile({ log = () => {} } = {}) {
	const release = RELEASES[process.platform];
	if (!release) return null;

	const cached = cachedLuauCompile();
	if (cached) return cached;

	const dir = platformDir();
	const binPath = path.join(dir, release.bin);
	const url = `https://github.com/luau-lang/luau/releases/download/${LUAU_VERSION}/${release.asset}`;
	log(`check:luau: fetching Luau ${LUAU_VERSION} (${release.asset})...`);
	const zipBytes = await downloadToBuffer(url);

	const actual = crypto.createHash("sha256").update(zipBytes).digest("hex");
	if (actual !== release.sha256) {
		throw new Error(
			`check:luau: SHA-256 mismatch for ${release.asset} -- refusing to use it.\n` +
				`  expected ${release.sha256}\n` +
				`  got      ${actual}\n` +
				`Either the pinned hash in tools/luauRelease.mjs is stale, or the download was tampered with.`,
		);
	}

	fs.mkdirSync(dir, { recursive: true });
	const tmpZip = path.join(os.tmpdir(), `luau-${LUAU_VERSION}-${process.platform}-${process.pid}.zip`);
	fs.writeFileSync(tmpZip, zipBytes);
	try {
		extractZip(tmpZip, dir);
	} finally {
		fs.rmSync(tmpZip, { force: true });
	}

	if (!fs.existsSync(binPath)) {
		throw new Error(`check:luau: ${release.asset} did not contain ${release.bin} after extraction`);
	}
	if (process.platform !== "win32") fs.chmodSync(binPath, 0o755);
	return binPath;
}
