/*
 * A tiny reader for the flat, single-directory ZIP archives GitHub release assets ship as (Store or Deflate,
 * no ZIP64, no spanning). Just enough to pull `luau-compile[.exe]` out of the official Luau release zips in
 * `tools/luauRelease.mjs` without adding a dependency -- Node's `zlib` already speaks raw deflate.
 */
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";

const EOCD_SIG = 0x06054b50;
const CENTRAL_SIG = 0x02014b50;
const LOCAL_SIG = 0x04034b50;

function findEndOfCentralDirectory(buf) {
	// The record is fixed-size (22 bytes) plus a variable comment (0-65535 bytes) at the very end of the file.
	const maxBack = Math.min(buf.length, 22 + 65535);
	for (let i = buf.length - 22; i >= buf.length - maxBack; i--) {
		if (i < 0) break;
		if (buf.readUInt32LE(i) === EOCD_SIG) return i;
	}
	throw new Error("minizip: end-of-central-directory record not found (not a zip file?)");
}

/** @returns {{name: string, method: number, compressedSize: number, size: number, localHeaderOffset: number}[]} */
function listEntries(buf) {
	const eocd = findEndOfCentralDirectory(buf);
	const entryCount = buf.readUInt16LE(eocd + 10);
	let off = buf.readUInt32LE(eocd + 16);

	const entries = [];
	for (let i = 0; i < entryCount; i++) {
		if (buf.readUInt32LE(off) !== CENTRAL_SIG) {
			throw new Error(`minizip: bad central directory entry at offset ${off}`);
		}
		const method = buf.readUInt16LE(off + 10);
		const compressedSize = buf.readUInt32LE(off + 20);
		const size = buf.readUInt32LE(off + 24);
		const nameLen = buf.readUInt16LE(off + 28);
		const extraLen = buf.readUInt16LE(off + 30);
		const commentLen = buf.readUInt16LE(off + 32);
		const localHeaderOffset = buf.readUInt32LE(off + 42);
		const name = buf.toString("utf8", off + 46, off + 46 + nameLen);
		entries.push({ name, method, compressedSize, size, localHeaderOffset });
		off += 46 + nameLen + extraLen + commentLen;
	}
	return entries;
}

function readEntryData(buf, entry) {
	const off = entry.localHeaderOffset;
	if (buf.readUInt32LE(off) !== LOCAL_SIG) {
		throw new Error(`minizip: bad local file header for "${entry.name}"`);
	}
	const nameLen = buf.readUInt16LE(off + 26);
	const extraLen = buf.readUInt16LE(off + 28);
	const dataStart = off + 30 + nameLen + extraLen;
	const raw = buf.subarray(dataStart, dataStart + entry.compressedSize);

	let out;
	if (entry.method === 0)
		out = raw; // stored
	else if (entry.method === 8)
		out = zlib.inflateRawSync(raw); // deflate
	else throw new Error(`minizip: unsupported compression method ${entry.method} for "${entry.name}"`);

	if (out.length !== entry.size) {
		throw new Error(`minizip: "${entry.name}" extracted to ${out.length} bytes, expected ${entry.size}`);
	}
	return out;
}

/** Extracts every entry of `zipPath` as a flat file into `destDir` (entries with `/` are rejected -- these archives have none). */
export function extractZip(zipPath, destDir) {
	const buf = fs.readFileSync(zipPath);
	const entries = listEntries(buf);
	fs.mkdirSync(destDir, { recursive: true });
	for (const entry of entries) {
		if (entry.name.includes("/") || entry.name.includes("\\") || entry.name.includes("..")) {
			throw new Error(`minizip: refusing to extract path-like entry "${entry.name}"`);
		}
		fs.writeFileSync(path.join(destDir, entry.name), readEntryData(buf, entry));
	}
	return entries.map(e => e.name);
}
