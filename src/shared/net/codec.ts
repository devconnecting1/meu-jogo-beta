//!native
/*
 * Binary codec over the Luau `buffer` (docs/MULTIPLAYER.md §1.1, §4.2). Little-endian, like buffer.*.
 * Shared by client and server; pure (no Roblox services), so tools/test-net.mjs runs it in Node.
 *
 * NetWriter
 *   Cursor + controlled growth: the backing buffer doubles up to `maxBytes` and never beyond. Every
 *   integer is rounded and clamped to its wire range BEFORE buffer.write* (Luau would wrap silently), so a
 *   bad value saturates instead of corrupting its neighbours. A write past `maxBytes` latches `failed()`
 *   and is dropped; rollback(mark) undoes the last writes (used to split batches into packets).
 *
 * NetReader
 *   Bounds are checked BEFORE every buffer.read* (the Luau read throws out of bounds). A read past the end
 *   returns 0 and latches `ok() = false`; decoders check ok()/atEnd() once and return undefined. Floats
 *   that are NaN or ±inf also latch the failure. Nothing here throws on hostile input.
 *
 * Quantization (§4.2)
 *   position u16 at 0.5 u (0..32767.5 u; the world is 22 400 × 16 640 u)
 *   angle u8 (256 steps, 1.41°) and u16 (65 536 steps, 0.0055°); relative angle i8 (same step, ±178°)
 *   fraction u8 (0..1 in 1/255) and u16 (1/65535)
 *   angles are radians; dequantized angles are in [0, 2π)
 *
 * Ticks and seqs are u16 modulo 65 536: compare with seqNewer/seqDiff, rebuild with unwrapTick.
 * No varint: every layout in the doc is fixed-width.
 *
 * roblox-ts notes: `%` compiles to Luau's floored modulo and bitwise operators to bit32.*, which differ
 * from JS for negative operands; this file only uses them on non-negative values (wrap() adds the
 * modulus back), so Luau and the Node test behave the same.
 */

const TAU = math.pi * 2;
const U16_MOD = 65536;
const HALF_U16 = 32768;
/** largest finite f32 */
const F32_MAX = 3.4028234663852886e38;

/** position quantization: 2 steps per world unit (0.5 u) */
export const POS_SCALE = 2;
/** largest position that fits a u16 at 0.5 u */
export const POS_MAX = 65535 / POS_SCALE;

// ---------------------------------------------------------------- numbers

/** a real number (not NaN, not ±inf) */
export function isFiniteNumber(v: unknown): v is number {
	return typeIs(v, "number") && v === v && v !== math.huge && v !== -math.huge;
}

/** floor(v) clamped to [lo, hi]; NaN → lo */
export function clampInt(v: number, lo: number, hi: number): number {
	if (!(v >= lo)) return lo;
	if (v >= hi) return hi;
	return math.floor(v);
}

/** v rounded to the nearest integer (half up) and clamped to [lo, hi]; NaN → lo */
export function roundClamp(v: number, lo: number, hi: number): number {
	return clampInt(math.floor(v + 0.5), lo, hi);
}

/** floor(v) modulo m, always in [0, m); NaN/±inf → 0 */
function wrap(v: number, m: number): number {
	if (!isFiniteNumber(v)) return 0;
	return ((math.floor(v) % m) + m) % m;
}

// ---------------------------------------------------------------- u16 ticks and sequences

/** v modulo 65 536 in [0, 65535] */
export function wrapU16(v: number): number {
	return wrap(v, U16_MOD);
}

/** signed modular difference a − b in [−32768, 32767] (positive: a is newer) */
export function seqDiff(a: number, b: number): number {
	const d = wrapU16(a - b);
	return d >= HALF_U16 ? d - U16_MOD : d;
}

/** a is strictly newer than b in u16 modular order (valid while they are < 32 768 apart) */
export function seqNewer(a: number, b: number): boolean {
	return seqDiff(a, b) > 0;
}

/** the full tick congruent to the u16 `wire` value that is closest to `reference` (a full tick) */
export function unwrapTick(wire: number, reference: number): number {
	const ref = isFiniteNumber(reference) ? math.floor(reference) : 0;
	return ref + seqDiff(wire, ref);
}

// ---------------------------------------------------------------- quantization

export function quantPos(v: number): number {
	return roundClamp(v * POS_SCALE, 0, 65535);
}

export function dequantPos(q: number): number {
	return q / POS_SCALE;
}

/** absolute angle → u8 (256 steps; 45° = 32 steps, so the 8 keyboard directions are exact) */
export function quantAngle8(rad: number): number {
	if (!isFiniteNumber(rad)) return 0;
	return wrap(math.floor((rad / TAU) * 256 + 0.5), 256);
}

export function dequantAngle8(q: number): number {
	return (q / 256) * TAU;
}

/** absolute angle → u16 (65 536 steps) */
export function quantAngle16(rad: number): number {
	if (!isFiniteNumber(rad)) return 0;
	return wrap(math.floor((rad / TAU) * U16_MOD + 0.5), U16_MOD);
}

export function dequantAngle16(q: number): number {
	return (q / U16_MOD) * TAU;
}

/** relative angle (−π..π) → i8 in the u8 angle step, clamped to ±127 steps (±178.6°) */
export function quantRelAngle8(rad: number): number {
	return roundClamp((rad / TAU) * 256, -127, 127);
}

export function dequantRelAngle8(q: number): number {
	return (q / 256) * TAU;
}

/** 0..1 → u8 */
export function quantFrac8(f: number): number {
	return roundClamp(f * 255, 0, 255);
}

export function dequantFrac8(q: number): number {
	return q / 255;
}

/** 0..1 → u16 */
export function quantFrac16(f: number): number {
	return roundClamp(f * 65535, 0, 65535);
}

export function dequantFrac16(q: number): number {
	return q / 65535;
}

/** the value a quantizer would give back: handy to quantize input before predicting (§2.2) */
export function roundTripPos(v: number): number {
	return dequantPos(quantPos(v));
}

// ---------------------------------------------------------------- bit fields

/** any bit of `mask` set in `flags` */
export function hasBits(flags: number, mask: number): boolean {
	return (flags & mask) !== 0;
}

/** unsigned field of `width` bits starting at bit `shift` (flags must be a non-negative integer < 2^31) */
export function getBits(flags: number, shift: number, width: number): number {
	return (flags >> shift) & ((1 << width) - 1);
}

/** flags with the `width`-bit field at `shift` replaced by `value` (clamped to the field; shift + width ≤ 30) */
export function setBits(flags: number, shift: number, width: number, value: number): number {
	const v = clampInt(value, 0, (1 << width) - 1);
	return flags - (getBits(flags, shift, width) << shift) + (v << shift);
}

// ---------------------------------------------------------------- writer

export class NetWriter {
	private buf: buffer;
	private capacity: number;
	private cursor = 0;
	private overflowed = false;
	private readonly maxBytes: number;

	/** `initialBytes` is grown by doubling up to `maxBytes` (hard ceiling of what this writer produces) */
	constructor(initialBytes: number, maxBytes: number) {
		this.maxBytes = math.max(1, math.floor(maxBytes));
		this.capacity = clampInt(initialBytes, 1, this.maxBytes);
		this.buf = buffer.create(this.capacity);
	}

	/** bytes written so far */
	length(): number {
		return this.cursor;
	}

	/** bytes still available before `maxBytes` */
	room(): number {
		return this.maxBytes - this.cursor;
	}

	limit(): number {
		return this.maxBytes;
	}

	/** some write did not fit in `maxBytes` (and was dropped) since the last reset/rollback */
	failed(): boolean {
		return this.overflowed;
	}

	/** start over (keeps the grown backing buffer) */
	reset(): void {
		this.cursor = 0;
		this.overflowed = false;
	}

	/** undo every write after `mark` (a previous length()) and clear the overflow latch */
	rollback(mark: number): void {
		this.cursor = clampInt(mark, 0, this.cursor);
		this.overflowed = false;
	}

	/** exact-size copy of what was written; undefined when a write overflowed */
	finish(): buffer | undefined {
		if (this.overflowed) return undefined;
		const out = buffer.create(this.cursor);
		if (this.cursor > 0) buffer.copy(out, 0, this.buf, 0, this.cursor);
		return out;
	}

	/** reserves n bytes at the cursor; returns the offset to write at, or -1 (overflow latched) */
	private reserve(n: number): number {
		if (this.overflowed) return -1;
		const need = this.cursor + n;
		if (need > this.maxBytes) {
			this.overflowed = true;
			return -1;
		}
		if (need > this.capacity) {
			const grown = math.min(this.maxBytes, math.max(this.capacity * 2, need));
			const nb = buffer.create(grown);
			if (this.cursor > 0) buffer.copy(nb, 0, this.buf, 0, this.cursor);
			this.buf = nb;
			this.capacity = grown;
		}
		const at = this.cursor;
		this.cursor = need;
		return at;
	}

	u8(v: number): void {
		const at = this.reserve(1);
		if (at >= 0) buffer.writeu8(this.buf, at, roundClamp(v, 0, 255));
	}

	i8(v: number): void {
		const at = this.reserve(1);
		if (at >= 0) buffer.writei8(this.buf, at, roundClamp(v, -128, 127));
	}

	u16(v: number): void {
		const at = this.reserve(2);
		if (at >= 0) buffer.writeu16(this.buf, at, roundClamp(v, 0, 65535));
	}

	i16(v: number): void {
		const at = this.reserve(2);
		if (at >= 0) buffer.writei16(this.buf, at, roundClamp(v, -32768, 32767));
	}

	u32(v: number): void {
		const at = this.reserve(4);
		if (at >= 0) buffer.writeu32(this.buf, at, roundClamp(v, 0, 4294967295));
	}

	/** NaN → 0, ±inf and out-of-range → ±largest f32 */
	f32(v: number): void {
		const at = this.reserve(4);
		if (at < 0) return;
		let x = v === v ? v : 0;
		if (x > F32_MAX) x = F32_MAX;
		else if (x < -F32_MAX) x = -F32_MAX;
		buffer.writef32(this.buf, at, x);
	}

	/** NaN and ±inf → 0 */
	f64(v: number): void {
		const at = this.reserve(8);
		if (at >= 0) buffer.writef64(this.buf, at, isFiniteNumber(v) ? v : 0);
	}

	/** modular u16 (ticks, seqs) */
	tick16(v: number): void {
		this.u16(wrapU16(v));
	}

	pos(v: number): void {
		this.u16(quantPos(v));
	}

	angle8(rad: number): void {
		this.u8(quantAngle8(rad));
	}

	angle16(rad: number): void {
		this.u16(quantAngle16(rad));
	}

	relAngle8(rad: number): void {
		this.i8(quantRelAngle8(rad));
	}

	frac8(f: number): void {
		this.u8(quantFrac8(f));
	}

	frac16(f: number): void {
		this.u16(quantFrac16(f));
	}

	bool(v: boolean): void {
		this.u8(v ? 1 : 0);
	}

	/**
	 * u8 byte length + bytes, at most min(maxBytes, 255). A longer string is cut at a UTF-8 character
	 * boundary (a multi-byte character is never split in half).
	 */
	str(s: string, maxBytes: number): void {
		const total = s.size();
		let n = math.min(total, clampInt(maxBytes, 0, 255));
		const at = this.reserve(1 + n);
		if (at < 0) return;
		if (n > 0) buffer.writestring(this.buf, at + 1, s, n);
		if (n < total && n > 0) {
			// walk back to the lead byte of the last character and drop it when its sequence was cut
			let lead = n - 1;
			while (lead > 0 && (buffer.readu8(this.buf, at + 1 + lead) & 0xc0) === 0x80) lead -= 1;
			const b = buffer.readu8(this.buf, at + 1 + lead);
			const seqLen = b < 0x80 ? 1 : b >= 0xf0 ? 4 : b >= 0xe0 ? 3 : b >= 0xc0 ? 2 : 1;
			if (lead + seqLen > n) n = lead;
			this.cursor = at + 1 + n;
		}
		buffer.writeu8(this.buf, at, n);
	}

	/** overwrite a u8 already written at `offset` (counts patched after the fact) */
	patchU8(offset: number, v: number): void {
		if (offset >= 0 && offset + 1 <= this.cursor) buffer.writeu8(this.buf, offset, roundClamp(v, 0, 255));
	}

	/** overwrite a u16 already written at `offset` */
	patchU16(offset: number, v: number): void {
		if (offset >= 0 && offset + 2 <= this.cursor) buffer.writeu16(this.buf, offset, roundClamp(v, 0, 65535));
	}
}

// ---------------------------------------------------------------- reader

export class NetReader {
	private readonly buf: buffer;
	private readonly size: number;
	private cursor = 0;
	private bad = false;

	constructor(buf: buffer) {
		this.buf = buf;
		this.size = buffer.len(buf);
	}

	/** no read went past the end and no float was NaN/inf */
	ok(): boolean {
		return !this.bad;
	}

	/** ok() and every byte was consumed (decoders require exact lengths) */
	done(): boolean {
		return !this.bad && this.cursor === this.size;
	}

	offset(): number {
		return this.cursor;
	}

	remaining(): number {
		return this.size - this.cursor;
	}

	/** mark the payload as malformed (semantic check failed) */
	fail(): void {
		this.bad = true;
	}

	/** consumes n bytes; returns their offset, or -1 and latches the failure */
	private take(n: number): number {
		if (this.bad || this.cursor + n > this.size) {
			this.bad = true;
			return -1;
		}
		const at = this.cursor;
		this.cursor += n;
		return at;
	}

	skip(n: number): void {
		this.take(n);
	}

	u8(): number {
		const at = this.take(1);
		return at < 0 ? 0 : buffer.readu8(this.buf, at);
	}

	i8(): number {
		const at = this.take(1);
		return at < 0 ? 0 : buffer.readi8(this.buf, at);
	}

	u16(): number {
		const at = this.take(2);
		return at < 0 ? 0 : buffer.readu16(this.buf, at);
	}

	i16(): number {
		const at = this.take(2);
		return at < 0 ? 0 : buffer.readi16(this.buf, at);
	}

	u32(): number {
		const at = this.take(4);
		return at < 0 ? 0 : buffer.readu32(this.buf, at);
	}

	f32(): number {
		const at = this.take(4);
		if (at < 0) return 0;
		const v = buffer.readf32(this.buf, at);
		if (!isFiniteNumber(v)) {
			this.bad = true;
			return 0;
		}
		return v;
	}

	f64(): number {
		const at = this.take(8);
		if (at < 0) return 0;
		const v = buffer.readf64(this.buf, at);
		if (!isFiniteNumber(v)) {
			this.bad = true;
			return 0;
		}
		return v;
	}

	pos(): number {
		return dequantPos(this.u16());
	}

	angle8(): number {
		return dequantAngle8(this.u8());
	}

	angle16(): number {
		return dequantAngle16(this.u16());
	}

	relAngle8(): number {
		return dequantRelAngle8(this.i8());
	}

	frac8(): number {
		return dequantFrac8(this.u8());
	}

	frac16(): number {
		return dequantFrac16(this.u16());
	}

	/** strict boolean: only 0 or 1 are valid */
	bool(): boolean {
		const v = this.u8();
		if (v > 1) this.bad = true;
		return v === 1;
	}

	/** u8 length + bytes; a length above `maxBytes` latches the failure */
	str(maxBytes: number): string {
		const n = this.u8();
		if (n > maxBytes) {
			this.bad = true;
			return "";
		}
		const at = this.take(n);
		return at < 0 || n === 0 ? "" : buffer.readstring(this.buf, at, n);
	}
}
