/*
 * The smallest PNG reader/writer the art tools need, in pure Node (zlib only).
 *
 *   import { encodePNG, decodePNG } from "./png-lite.mjs";
 *   writeFileSync("a.png", encodePNG({ w, h, data }));   // data: RGBA bytes, w * h * 4
 *   const { w, h, data } = decodePNG(readFileSync("a.png"));
 *
 * The encoder is the one tools/gen-sprites.mjs and tools/gen-ui-skin.mjs carry (8-bit RGBA, filter None). The
 * decoder reads what the art tools write and what a PNG optimiser might turn it into: 8-bit greyscale, grey +
 * alpha, RGB, RGBA and palette images, every scanline filter, no interlacing (tools/render-map.mjs samples the
 * world textures with it, and tools/test-world-art.mjs checks that the renders decode).
 */
import { deflateSync, inflateSync } from "node:zlib";

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const CRC_TABLE = (() => {
	const t = new Uint32Array(256);
	for (let n = 0; n < 256; n++) {
		let c = n;
		for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
		t[n] = c >>> 0;
	}
	return t;
})();

function crc32(buf) {
	let c = 0xffffffff;
	for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
	return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
	const len = Buffer.alloc(4);
	len.writeUInt32BE(data.length, 0);
	const typeBuf = Buffer.from(type, "latin1");
	const crcBuf = Buffer.alloc(4);
	crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
	return Buffer.concat([len, typeBuf, data, crcBuf]);
}

/** RGBA canvas { w, h, data } -> PNG bytes; `opaque` drops the alpha channel (smaller screenshots) */
export function encodePNG(canvas, opaque = false) {
	const { w, h, data } = canvas;
	const ihdr = Buffer.alloc(13);
	ihdr.writeUInt32BE(w, 0);
	ihdr.writeUInt32BE(h, 4);
	ihdr[8] = 8;
	ihdr[9] = opaque ? 2 : 6;
	const bpp = opaque ? 3 : 4;
	const stride = w * bpp;
	const raw = Buffer.alloc((stride + 1) * h);
	for (let y = 0; y < h; y++) {
		// filter "Up" for screenshots (large flat areas compress far better), None for tiny textures
		const filter = opaque && y > 0 ? 2 : 0;
		const row = y * (stride + 1);
		raw[row] = filter;
		for (let x = 0; x < w; x++) {
			const s = (y * w + x) * 4;
			const d = row + 1 + x * bpp;
			for (let c = 0; c < bpp; c++) {
				const v = data[s + c];
				raw[d + c] = filter === 2 ? (v - data[s - w * 4 + c]) & 0xff : v;
			}
		}
	}
	const idat = deflateSync(raw, { level: 9 });
	return Buffer.concat([
		PNG_MAGIC,
		pngChunk("IHDR", ihdr),
		pngChunk("IDAT", idat),
		pngChunk("IEND", Buffer.alloc(0)),
	]);
}

function paeth(a, b, c) {
	const p = a + b - c;
	const pa = Math.abs(p - a);
	const pb = Math.abs(p - b);
	const pc = Math.abs(p - c);
	if (pa <= pb && pa <= pc) return a;
	return pb <= pc ? b : c;
}

/** PNG bytes -> { w, h, data } (RGBA, 8 bits per channel); throws on anything it cannot read */
export function decodePNG(buf) {
	if (buf.length < 8 || !buf.subarray(0, 8).equals(PNG_MAGIC)) throw new Error("not a PNG");
	let pos = 8;
	let w = 0;
	let h = 0;
	let depth = 0;
	let type = 0;
	let interlace = 0;
	let palette;
	let trns;
	const idat = [];
	while (pos < buf.length) {
		const len = buf.readUInt32BE(pos);
		const kind = buf.toString("latin1", pos + 4, pos + 8);
		const body = buf.subarray(pos + 8, pos + 8 + len);
		const crc = buf.readUInt32BE(pos + 8 + len);
		if (crc !== crc32(buf.subarray(pos + 4, pos + 8 + len))) throw new Error(`bad CRC in ${kind}`);
		if (kind === "IHDR") {
			w = body.readUInt32BE(0);
			h = body.readUInt32BE(4);
			depth = body[8];
			type = body[9];
			interlace = body[12];
		} else if (kind === "PLTE") palette = body;
		else if (kind === "tRNS") trns = body;
		else if (kind === "IDAT") idat.push(body);
		else if (kind === "IEND") break;
		pos += 12 + len;
	}
	if (w === 0 || h === 0) throw new Error("PNG without IHDR");
	if (depth !== 8) throw new Error(`bit depth ${depth} not supported`);
	if (interlace !== 0) throw new Error("interlaced PNG not supported");
	const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[type];
	if (channels === undefined) throw new Error(`colour type ${type} not supported`);
	const raw = inflateSync(Buffer.concat(idat));
	const stride = w * channels;
	if (raw.length < (stride + 1) * h) throw new Error("truncated image data");
	const px = Buffer.alloc(stride * h);
	for (let y = 0; y < h; y++) {
		const f = raw[y * (stride + 1)];
		const src = y * (stride + 1) + 1;
		const dst = y * stride;
		for (let x = 0; x < stride; x++) {
			const v = raw[src + x];
			const a = x >= channels ? px[dst + x - channels] : 0;
			const b = y > 0 ? px[dst - stride + x] : 0;
			const c = x >= channels && y > 0 ? px[dst - stride + x - channels] : 0;
			let out;
			if (f === 0) out = v;
			else if (f === 1) out = v + a;
			else if (f === 2) out = v + b;
			else if (f === 3) out = v + ((a + b) >> 1);
			else if (f === 4) out = v + paeth(a, b, c);
			else throw new Error(`bad filter ${f}`);
			px[dst + x] = out & 0xff;
		}
	}
	const data = Buffer.alloc(w * h * 4);
	for (let i = 0; i < w * h; i++) {
		const s = i * channels;
		const d = i * 4;
		if (type === 0) {
			data[d] = data[d + 1] = data[d + 2] = px[s];
			data[d + 3] = 255;
		} else if (type === 4) {
			data[d] = data[d + 1] = data[d + 2] = px[s];
			data[d + 3] = px[s + 1];
		} else if (type === 2) {
			data[d] = px[s];
			data[d + 1] = px[s + 1];
			data[d + 2] = px[s + 2];
			data[d + 3] = 255;
		} else if (type === 6) {
			data[d] = px[s];
			data[d + 1] = px[s + 1];
			data[d + 2] = px[s + 2];
			data[d + 3] = px[s + 3];
		} else {
			const k = px[s];
			if (palette === undefined) throw new Error("palette image without PLTE");
			data[d] = palette[k * 3];
			data[d + 1] = palette[k * 3 + 1];
			data[d + 2] = palette[k * 3 + 2];
			data[d + 3] = trns !== undefined && k < trns.length ? trns[k] : 255;
		}
	}
	return { w, h, data };
}
