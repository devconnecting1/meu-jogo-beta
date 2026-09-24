#!/usr/bin/env node
/*
 * Project Z's OWN sound effects, synthesised here -- no sample, no library, no dependency (DESIGN_RULES SND-01..06).
 *
 *   npm run audio:sfx                     render every sound, pack them into design/audio/banks/*.wav, write
 *                                         design/audio/manifest.json, design/audio/README.md, docs/audio/preview.html
 *                                         and src/shared/data/audioAssets.ts
 *   npm run audio:sfx -- --check          render in memory and compare with the committed banks (1 LSB of tolerance:
 *                                         the renderer is deterministic, the float maths of another Node may round one
 *                                         sample the other way); exit 1 on drift
 *   npm run audio:sfx -- --split <dir>    also write every take as its own WAV into <dir> (for an audio editor)
 *   node tools/gen-sfx.mjs --assets       only regenerate src/shared/data/audioAssets.ts (tools/cloud.mjs upload-audio)
 *
 * WHY SYNTHESIS, AND WHY NOT EVERYTHING
 *   The game is pixel art made by code (ART-01..): its UI blips, pickups, gunshots, impacts and alarms are the same
 *   kind of thing -- short, stylised, the 8/16-bit vocabulary of noise bursts, pitch sweeps and square waves -- and
 *   making them here makes them OURS (no licence to track, no take that a library can withdraw) and consistent
 *   (one loudness rule, one key, variations on demand). What a synthesiser does badly is ORGANIC sound: a voice, a
 *   creaking door, chewing, fire, an engine, a street's ambience. Those stay on the official library takes
 *   (design/audio-credits.md), which is the honest split: synthesise what reads as game feedback, record what reads
 *   as the world.
 *
 * HOW A SOUND IS MADE
 *   Each entry of SPEC renders one take from a seeded PRNG (mulberry32 of the sha256 of "name#take"), so the same
 *   code always gives the same bytes on any machine. The building blocks are the classic ones: band-limited
 *   oscillators (PolyBLEP square / saw, triangle, sine) with pitch envelopes, white noise through time-varying RBJ
 *   biquads, exponential envelopes, tanh saturation, a Karplus-Strong string, a small Freeverb and a slap echo.
 *   Every take is then FINISHED the same way: a 25 Hz high-pass (no DC, no subsonics wasting headroom), a 1 ms
 *   fade-in, the tail trimmed where it falls under -66 dB and faded, and a gain that brings its loudness (momentary
 *   max, ITU-R BS.1770 K-weighted, 400 ms) to its category's target without its true peak (4x oversampled) going
 *   over -1 dBTP. What cannot reach the target under the ceiling (a 5 ms click) is allowed 4 LU short, never over.
 *
 * WHY BANKS
 *   Roblox takes WAV (Open Cloud Assets API: .mp3 / .ogg / .wav / .flac, <= 7 min, <= 20 MB, <= 48 kHz), but it
 *   COUNTS uploads: the Open Cloud guide lists 100 audio uploads a month for an ID-verified account and 10 for one
 *   that is not (docs: cloud/guides/usage-assets). Sixty takes as sixty files would spend a month's quota twice.
 *   So the takes are packed into five banks -- one WAV each, the takes 0.25 s of silence apart -- and the game plays
 *   a window of the bank (shared/data/sounds.ts `takes`, Sound.PlaybackRegion). Five uploads for the whole set; a
 *   change re-uploads only its bank.
 *
 * 32 kHz, 16-bit, mono: the sample rate of the 16-bit era, 16 kHz of bandwidth (plenty for these sounds, and part of
 * their character), and a third less data than 48 kHz.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
/** where the banks, the manifest and the uploaded ids live (a test points this at a copy) */
export const AUDIO_DIR = resolve(process.env.PZ_AUDIO_DIR ?? join(ROOT, "design", "audio"));
/** the generated module the game reads (a test points this at a scratch file) */
export const AUDIO_TS = resolve(process.env.PZ_AUDIO_TS ?? join(ROOT, "src", "shared", "data", "audioAssets.ts"));
const PREVIEW = join(ROOT, "docs", "audio", "preview.html");

export const SR = 32000;
/** the true-peak ceiling of every take (dBTP) */
export const PEAK_CEILING = -1;
/** how far under its target a take that hit the ceiling may stay (LU) */
export const SHORTFALL = 4;
/** silence before the first take of a bank, and between two takes */
const BANK_LEAD = 0.2;
const BANK_GAP = 0.25;
/** a window opens this much before its take and closes this much after it (both silent) */
const PRE = 0.01;
const POST = 0.03;

// ---------------------------------------------------------------- maths

const TAU = Math.PI * 2;
const len = sec => Math.max(1, Math.round(sec * SR));
const buf = sec => new Float64Array(len(sec));
const dbToGain = d => Math.pow(10, d / 20);
const gainToDb = v => (v <= 1e-12 ? -240 : 20 * Math.log10(v));
/** equal-tempered note frequency (A4 = 440) */
const hz = midi => 440 * Math.pow(2, (midi - 69) / 12);

function mulberry32(seed) {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = a;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}
const seedOf = text => createHash("sha256").update(text).digest().readUInt32LE(0);

/** exponential approach from a to b with time constant tau (a pitch or cutoff sweep) */
const sweep = (a, b, tau) => t => b + (a - b) * Math.exp(-t / tau);
/** linear attack then exponential decay */
const envAD = (attack, tau) => t => (t < attack ? t / attack : Math.exp(-(t - attack) / tau));
/** a raised-cosine bell from 0 to `length` peaking at `peak` (a whoosh) */
const bell = (peak, length) => t => {
	if (t <= 0 || t >= length) return 0;
	return t < peak
		? 0.5 - 0.5 * Math.cos((Math.PI * t) / peak)
		: 0.5 + 0.5 * Math.cos((Math.PI * (t - peak)) / (length - peak));
};
const asFn = v => (typeof v === "function" ? v : () => v);

function polyBlep(t, dt) {
	if (t < dt) {
		const x = t / dt;
		return x + x - x * x - 1;
	}
	if (t > 1 - dt) {
		const x = (t - 1) / dt;
		return x * x + x + x + 1;
	}
	return 0;
}

/** adds an oscillator into `out`: wave sine | tri | saw | square, frequency and amplitude as numbers or f(t) */
function osc(out, { wave = "sine", freq, amp = 1, at = 0, dur, duty = 0.5, phase = 0 }) {
	const F = asFn(freq);
	const A = asFn(amp);
	const s0 = Math.round(at * SR);
	const count = dur === undefined ? out.length - s0 : len(dur);
	let ph = phase;
	for (let i = 0; i < count && s0 + i < out.length; i++) {
		const t = i / SR;
		const dt = Math.min(0.5, Math.max(0, F(t) / SR));
		let v;
		if (wave === "sine") v = Math.sin(TAU * ph);
		else if (wave === "tri") v = 4 * Math.abs(ph - 0.5) - 1;
		else if (wave === "saw") v = 2 * ph - 1 - polyBlep(ph, dt);
		else {
			v = ph < duty ? 1 : -1;
			v += polyBlep(ph, dt);
			v -= polyBlep((ph - duty + 1) % 1, dt);
		}
		out[s0 + i] += v * A(t);
		ph += dt;
		ph -= Math.floor(ph);
	}
	return out;
}

/** white noise, `amp` as a number or f(t); `density` < 1 leaves only that share of the samples (grit, crackle) */
function noise(rng, dur, amp = 1, density = 1) {
	const out = buf(dur);
	const A = asFn(amp);
	for (let i = 0; i < out.length; i++) {
		const r = rng() * 2 - 1;
		if (density < 1 && rng() > density) continue;
		out[i] = r * A(i / SR);
	}
	return out;
}

/** RBJ cookbook biquad, coefficients recomputed from f(t) every 16 samples */
class Biquad {
	constructor(type, q = 0.707, gainDb = 0) {
		this.type = type;
		this.q = q;
		this.gainDb = gainDb;
		this.x1 = this.x2 = this.y1 = this.y2 = 0;
	}
	tune(freq) {
		const f = Math.min(Math.max(freq, 20), SR * 0.45);
		const w = (TAU * f) / SR;
		const cw = Math.cos(w);
		const alpha = Math.sin(w) / (2 * this.q);
		let b0;
		let b1;
		let b2;
		let a0;
		let a1;
		let a2;
		if (this.type === "lp") {
			b0 = (1 - cw) / 2;
			b1 = 1 - cw;
			b2 = (1 - cw) / 2;
			a0 = 1 + alpha;
			a1 = -2 * cw;
			a2 = 1 - alpha;
		} else if (this.type === "hp") {
			b0 = (1 + cw) / 2;
			b1 = -(1 + cw);
			b2 = (1 + cw) / 2;
			a0 = 1 + alpha;
			a1 = -2 * cw;
			a2 = 1 - alpha;
		} else {
			// band-pass, constant 0 dB peak gain
			b0 = alpha;
			b1 = 0;
			b2 = -alpha;
			a0 = 1 + alpha;
			a1 = -2 * cw;
			a2 = 1 - alpha;
		}
		this.b0 = b0 / a0;
		this.b1 = b1 / a0;
		this.b2 = b2 / a0;
		this.a1 = a1 / a0;
		this.a2 = a2 / a0;
	}
	run(x) {
		const y = this.b0 * x + this.b1 * this.x1 + this.b2 * this.x2 - this.a1 * this.y1 - this.a2 * this.y2;
		this.x2 = this.x1;
		this.x1 = x;
		this.y2 = this.y1;
		this.y1 = y;
		return y;
	}
}

/** a new buffer: `src` through a biquad whose frequency is a number or f(t) */
function filt(src, type, freq, q = 0.707) {
	const F = asFn(freq);
	const f = new Biquad(type, q);
	const out = new Float64Array(src.length);
	for (let i = 0; i < src.length; i++) {
		if ((i & 15) === 0) f.tune(F(i / SR));
		out[i] = f.run(src[i]);
	}
	return out;
}

/** adds `src` into `out` at `at` seconds, times `gain` */
function mix(out, src, gain = 1, at = 0) {
	const s0 = Math.round(at * SR);
	for (let i = 0; i < src.length && s0 + i < out.length; i++) out[s0 + i] += src[i] * gain;
	return out;
}

function shape(src, env) {
	const E = asFn(env);
	for (let i = 0; i < src.length; i++) src[i] *= E(i / SR);
	return src;
}

/** tanh saturation normalised to keep a full-scale sample at full scale (crunch without a volume jump) */
function saturate(src, drive) {
	const k = Math.tanh(drive);
	for (let i = 0; i < src.length; i++) src[i] = Math.tanh(src[i] * drive) / k;
	return src;
}

/** a slap echo: `src` plus copies `delay` apart, each `fb` of the one before, lowpassed a little more each time */
function echo(src, delay, fb, repeats = 3, tone = 3500) {
	const out = new Float64Array(src.length + len(delay * repeats));
	mix(out, src);
	let tap = src;
	let g = 1;
	for (let r = 1; r <= repeats; r++) {
		tap = filt(tap, "lp", tone);
		g *= fb;
		mix(out, tap, g, delay * r);
	}
	return out;
}

/** a small Freeverb (8 combs, 4 allpasses, Jezar's tunings scaled to 32 kHz): wet-only tail added to a copy */
function reverb(src, { size = 1, feedback = 0.8, damp = 0.3, wet = 0.25, tail = 1.2 } = {}) {
	const out = new Float64Array(src.length + len(tail));
	mix(out, src);
	const scale = (SR / 44100) * size;
	const combs = [1116, 1188, 1277, 1356, 1422, 1491, 1557, 1617].map(d => ({
		line: new Float64Array(Math.max(8, Math.round(d * scale))),
		i: 0,
		store: 0,
	}));
	const alls = [556, 441, 341, 225].map(d => ({ line: new Float64Array(Math.max(4, Math.round(d * scale))), i: 0 }));
	for (let n = 0; n < out.length; n++) {
		const x = n < src.length ? src[n] * 0.015 : 0;
		let acc = 0;
		for (const c of combs) {
			const y = c.line[c.i];
			c.store = y * (1 - damp) + c.store * damp;
			c.line[c.i] = x + c.store * feedback;
			c.i = (c.i + 1) % c.line.length;
			acc += y;
		}
		for (const a of alls) {
			const b = a.line[a.i];
			a.line[a.i] = acc + b * 0.5;
			a.i = (a.i + 1) % a.line.length;
			acc = b - acc;
		}
		out[n] += acc * wet;
	}
	return out;
}

/** Karplus-Strong: a plucked string (the bowstring) */
function pluck(rng, dur, freq, { damp = 0.995, bright = 0.5 } = {}) {
	const out = buf(dur);
	const n = Math.max(2, Math.round(SR / freq));
	const line = new Float64Array(n);
	let prev = 0;
	for (let i = 0; i < n; i++) {
		const r = rng() * 2 - 1;
		prev = prev + bright * (r - prev);
		line[i] = prev;
	}
	let k = 0;
	for (let i = 0; i < out.length; i++) {
		const a = line[k];
		const b = line[(k + 1) % n];
		out[i] = a;
		line[k] = damp * 0.5 * (a + b);
		k = (k + 1) % n;
	}
	return out;
}

/** inharmonic partials (metal, bells): ratios, amplitudes and decay constants, from a base frequency */
function partials(dur, base, list, at = 0) {
	const out = buf(dur);
	for (const [ratio, amp, tau] of list) {
		osc(out, { freq: base * ratio, amp: envAD(0.0015, tau), at });
		// a twin detuned by 1.3 Hz: the beating a real bar or panel has
		osc(out, { freq: base * ratio + 1.3, amp: t => 0.35 * envAD(0.0015, tau)(t), at });
	}
	return out;
}

// ---------------------------------------------------------------- measurement (ITU-R BS.1770-4)

/** the K-weighting pre-filter at SR (libebur128's bilinear transform of the two BS.1770 stages) */
function kWeight(x) {
	const out = new Float64Array(x.length);
	// stage 1: the head's high shelf
	{
		const f0 = 1681.974450955533;
		const G = 3.999843853973347;
		const Q = 0.7071752369554196;
		const K = Math.tan((Math.PI * f0) / SR);
		const Vh = Math.pow(10, G / 20);
		const Vb = Math.pow(Vh, 0.4996667741545416);
		const a0 = 1 + K / Q + K * K;
		const b0 = (Vh + (Vb * K) / Q + K * K) / a0;
		const b1 = (2 * (K * K - Vh)) / a0;
		const b2 = (Vh - (Vb * K) / Q + K * K) / a0;
		const a1 = (2 * (K * K - 1)) / a0;
		const a2 = (1 - K / Q + K * K) / a0;
		let x1 = 0;
		let x2 = 0;
		let y1 = 0;
		let y2 = 0;
		for (let i = 0; i < x.length; i++) {
			const y = b0 * x[i] + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
			x2 = x1;
			x1 = x[i];
			y2 = y1;
			y1 = y;
			out[i] = y;
		}
	}
	// stage 2: the RLB high-pass
	{
		const f0 = 38.13547087602444;
		const Q = 0.5003270373238773;
		const K = Math.tan((Math.PI * f0) / SR);
		const d = 1 + K / Q + K * K;
		const a1 = (2 * (K * K - 1)) / d;
		const a2 = (1 - K / Q + K * K) / d;
		let x1 = 0;
		let x2 = 0;
		let y1 = 0;
		let y2 = 0;
		for (let i = 0; i < out.length; i++) {
			const xi = out[i];
			const y = xi - 2 * x1 + x2 - a1 * y1 - a2 * y2;
			x2 = x1;
			x1 = xi;
			y2 = y1;
			y1 = y;
			out[i] = y;
		}
	}
	return out;
}

/** the loudest 400 ms of `x` (momentary loudness, LUFS); a take shorter than 400 ms is measured padded with silence */
export function momentaryMax(x) {
	const W = len(0.4);
	const padded = new Float64Array(Math.max(x.length, W) + W);
	padded.set(x);
	const y = kWeight(padded);
	let sum = 0;
	for (let i = 0; i < W; i++) sum += y[i] * y[i];
	let best = sum;
	const hop = len(0.005);
	for (let i = W; i < y.length; i++) {
		sum += y[i] * y[i] - y[i - W] * y[i - W];
		if ((i - W) % hop === 0 && sum > best) best = sum;
	}
	return -0.691 + 10 * Math.log10(Math.max(best / W, 1e-20));
}

/** integrated loudness with the BS.1770-4 gates (for the long takes: stingers, heartbeat) */
export function integrated(x) {
	const W = len(0.4);
	const hop = len(0.1);
	const padded = new Float64Array(Math.max(x.length, W));
	padded.set(x);
	const y = kWeight(padded);
	const blocks = [];
	for (let s = 0; s + W <= y.length; s += hop) {
		let sum = 0;
		for (let i = s; i < s + W; i++) sum += y[i] * y[i];
		blocks.push(sum / W);
	}
	const L = z => -0.691 + 10 * Math.log10(Math.max(z, 1e-20));
	const abs = blocks.filter(z => L(z) > -70);
	if (abs.length === 0) return -70;
	const mean = abs.reduce((a, b) => a + b, 0) / abs.length;
	const rel = abs.filter(z => L(z) > L(mean) - 10);
	return L(rel.reduce((a, b) => a + b, 0) / rel.length);
}

/** 4x-oversampled peak (a 32-tap Hann-windowed sinc per phase): what a codec's reconstruction can reach */
let SINC;
export function truePeak(x) {
	if (SINC === undefined) {
		SINC = [];
		for (let k = 1; k < 4; k++) {
			const frac = k / 4;
			const taps = [];
			for (let j = -15; j <= 16; j++) {
				const t = j - frac;
				const s = t === 0 ? 1 : Math.sin(Math.PI * t) / (Math.PI * t);
				const w = 0.5 + 0.5 * Math.cos((Math.PI * t) / 16.5);
				taps.push(s * w);
			}
			SINC.push(taps);
		}
	}
	let peak = 0;
	for (let i = 0; i < x.length; i++) {
		const a = Math.abs(x[i]);
		if (a > peak) peak = a;
		for (const taps of SINC) {
			let acc = 0;
			for (let j = -15; j <= 16; j++) {
				const k = i + j;
				if (k >= 0 && k < x.length) acc += x[k] * taps[j + 15];
			}
			const b = Math.abs(acc);
			if (b > peak) peak = b;
		}
	}
	return gainToDb(peak);
}

export function samplePeak(x) {
	let p = 0;
	for (const v of x) p = Math.max(p, Math.abs(v));
	return gainToDb(p);
}

/** share of the energy above 2 kHz (0 = a thump, 1 = a hiss): the tests' sanity check on what a take is */
export function brightness(x) {
	const hi = filt(x, "hp", 2000);
	let e = 0;
	let h = 0;
	for (let i = 0; i < x.length; i++) {
		e += x[i] * x[i];
		h += hi[i] * hi[i];
	}
	return e > 0 ? h / e : 0;
}

// ---------------------------------------------------------------- finishing

/** how loud each kind of sound is made (momentary max, LUFS) before the catalogue's base volume mixes it */
export const TARGETS = {
	shot: -14,
	weapon: -19,
	swing: -19,
	impact: -17,
	use: -19,
	step: -22,
	ui: -20,
	hover: -27,
	pickup: -18,
	reward: -17,
	stinger: -16,
	heart: -18,
};

/** the most a take's peaks are pushed down to reach its loudness (dB): a transient keeps its snap */
export const MAX_LIMIT = 6;

/**
 * A lookahead peak limiter: the gain each sample needs to stay under `ceilingDb`, as the minimum over the next 1.5 ms
 * (the reduction lands BEFORE the peak), falling in 0.3 ms and recovering in 40 ms, never below -`MAX_LIMIT` dB.
 * What game SFX go through before they ship; here it is what lets a gunshot's crack be loud without clipping.
 */
function limit(x, ceilingDb) {
	const ceil = dbToGain(ceilingDb);
	const floor = dbToGain(-MAX_LIMIT);
	const n = x.length;
	const need = new Float64Array(n);
	for (let i = 0; i < n; i++) need[i] = Math.max(floor, Math.min(1, ceil / Math.max(1e-9, Math.abs(x[i]))));
	const ahead = len(0.0015);
	const att = Math.exp(-1 / (0.0003 * SR));
	const rel = Math.exp(-1 / (0.04 * SR));
	let g = 1;
	for (let i = 0; i < n; i++) {
		let m = 1;
		for (let j = i; j < Math.min(n, i + ahead); j++) if (need[j] < m) m = need[j];
		g = m < g ? m + (g - m) * att : m + (g - m) * rel;
		x[i] *= Math.min(g, need[i]);
	}
	return x;
}

/** the same last stage for every take: no DC, clean edges, loudness to target under the ceiling */
function finish(raw, target, { loop = false } = {}) {
	let x = filt(filt(raw, "hp", 25), "hp", 25);
	if (loop && raw.loopLength !== undefined) {
		// a loop: what rings past its end is folded onto its start (the wrap is then a sample like any other)
		const L = raw.loopLength;
		const folded = x.slice(0, L);
		for (let i = L; i < x.length; i++) folded[(i - L) % L] += x[i];
		x = folded;
	}
	if (!loop) {
		// the tail: cut where it stays under -66 dB of the peak, then a short fade to digital silence
		let peak = 0;
		for (const v of x) peak = Math.max(peak, Math.abs(v));
		const floor = peak * dbToGain(-66);
		let end = x.length;
		while (end > 1 && Math.abs(x[end - 1]) < floor) end--;
		end = Math.min(x.length, end + len(0.004));
		x = x.slice(0, end);
		const fin = Math.min(len(0.001), x.length);
		for (let i = 0; i < fin; i++) x[i] *= i / fin;
		const fout = Math.min(len(0.008), x.length);
		for (let i = 0; i < fout; i++) x[x.length - 1 - i] *= i / fout;
	}
	// the gain that reaches the target, never more than the limiter can take off the peaks (MAX_LIMIT over the
	// ceiling); a few rounds, always from the untouched take, because the limiter gives a little loudness back
	const orig = x;
	const cap = dbToGain(PEAK_CEILING - 0.4 - truePeak(orig) + MAX_LIMIT);
	let gain = Math.min(dbToGain(target - momentaryMax(orig)), cap);
	for (let round = 0; round < 4; round++) {
		x = orig.map(v => v * gain);
		limit(x, PEAK_CEILING - 0.4);
		const m = momentaryMax(x);
		const next = Math.min(gain * dbToGain(target - m), cap);
		if (Math.abs(target - m) < 0.1 || Math.abs(next - gain) < 1e-4) break;
		gain = next;
	}
	// the inter-sample peak is the last word: whatever the limiter left over the ceiling is taken off the whole take
	const tp = truePeak(x);
	if (tp > PEAK_CEILING - 0.05) {
		const g = dbToGain(PEAK_CEILING - 0.05 - tp);
		for (let i = 0; i < x.length; i++) x[i] *= g;
	}
	return x;
}

// ---------------------------------------------------------------- the recipes

/** one gunshot: the supersonic crack, the blast (noise through a closing lowpass), the body, the street's tail */
function gunshot(rng, p) {
	const out = buf(p.dur);
	// the crack: a couple of ms of bright noise
	mix(out, shape(filt(noise(rng, 0.004), "hp", 2500), envAD(0.0002, 0.0012)), p.crack);
	// the blast
	const blast = filt(noise(rng, p.dur, envAD(0.0008, p.blastTau)), "lp", sweep(p.cut0, p.cut1, p.cutTau), 0.8);
	mix(out, blast, 1.1);
	if (p.spread)
		mix(
			out,
			filt(noise(rng, p.dur, envAD(0.002, p.blastTau * 1.3)), "lp", sweep(p.cut0 * 0.6, p.cut1, p.cutTau)),
			0.6,
			0.004,
		);
	// the body: a thump whose pitch falls
	osc(out, { freq: sweep(p.body0, p.body1, p.bodyTau * 0.8), amp: t => p.bodyAmp * envAD(0.001, p.bodyTau)(t) });
	// the room: a dull tail
	mix(out, filt(noise(rng, p.dur, envAD(0.01, p.tailTau)), "lp", 1100), p.tailAmp, 0.01);
	let x = saturate(out, p.drive);
	if (p.echo !== undefined) x = echo(x, p.echo, p.echoFb, 2, 2400);
	if (p.verb !== undefined) x = reverb(x, p.verb);
	return x;
}

/** a metallic click (mechanisms: the magazine, the hammer, a latch) */
function click(rng, { dur = 0.06, f = 3000, q = 5, ring = [], amp = 1 } = {}) {
	const out = buf(dur);
	mix(out, shape(filt(noise(rng, 0.008), "bp", f, q), envAD(0.0003, 0.0025)), 2.2 * amp);
	for (const [rf, ra, rt] of ring) osc(out, { freq: rf, amp: t => amp * ra * envAD(0.0005, rt)(t) });
	return out;
}

/** a whoosh: noise through a band-pass that travels up and back down under a bell */
function whoosh(rng, { dur, peak, lo, hi, q = 1.4, body = 0.5 }) {
	const b = bell(peak, dur);
	const center = t => lo + (hi - lo) * Math.pow(b(t), 0.8);
	const air = shape(filt(noise(rng, dur), "bp", center, q), b);
	const low = shape(
		filt(noise(rng, dur), "lp", t => center(t) * 0.5, 0.7),
		b,
	);
	return mix(air, low, body);
}

/** two notes or more on a square-and-triangle voice (the UI and the rewards) */
function notes(dur, list, { duty = 0.25, sq = 0.35, tri = 1, lp = 5000 } = {}) {
	const out = buf(dur);
	for (const [at, midi, noteDur, tau, amp = 1] of list) {
		const env = t =>
			amp * (t < noteDur ? envAD(0.004, tau)(t) : envAD(0.004, tau)(noteDur) * Math.exp(-(t - noteDur) / 0.012));
		osc(out, { wave: "tri", freq: hz(midi), amp: t => tri * env(t), at, dur: noteDur + 0.08 });
		if (sq > 0) osc(out, { wave: "square", duty, freq: hz(midi), amp: t => sq * env(t), at, dur: noteDur + 0.08 });
	}
	return filt(out, "lp", lp, 0.6);
}

/** one heart beat (lub or dub): a soft low thump with a falling pitch */
function beat(out, at, amp, f0, f1) {
	osc(out, { freq: sweep(f0, f1, 0.035), amp: t => amp * envAD(0.006, 0.075)(t), at, dur: 0.4 });
	osc(out, { freq: sweep(f0 * 2.02, f1 * 2, 0.02), amp: t => 0.18 * amp * envAD(0.004, 0.03)(t), at, dur: 0.2 });
}

/**
 * A heart loop of `beats` at `bpm`, sample-exact. At 128 bpm the last "dub" is still ringing when the loop ends, so the
 * render runs past the loop and `finish` FOLDS that tail back onto the start (`loopLength`): the waveform is continuous
 * across Sound.LoopRegion's wrap, as if it had always been looping -- no click at the loop point, at any tempo.
 */
function heartLoop(bpm, beats = 4) {
	const period = Math.round((60 / bpm) * SR) / SR;
	const loopLength = Math.round(period * SR) * beats;
	const out = new Float64Array(loopLength + len(0.8));
	const gap = Math.min(0.3, 0.16 + period * 0.14);
	for (let b = 0; b < beats; b++) {
		const at = 0.02 + b * period;
		beat(out, at, 1, 78, 46);
		beat(out, at + gap, 0.62, 92, 56);
	}
	out.loopLength = loopLength;
	return out;
}

/** the night's brass: a detuned minor chord on saws under a closing lowpass, a boom, a high tension note */
function nightStab(rng, { root, dur, boom = 1, grit = 1.2, double = false }) {
	const out = buf(dur);
	const pad = buf(dur);
	for (const [midi, amp] of [
		[root, 1],
		[root + 3, 0.75],
		[root + 7, 0.5],
		[root - 12, 0.7],
	]) {
		for (const det of [-0.004, 0, 0.0045]) {
			osc(pad, { wave: "saw", freq: hz(midi) * (1 + det), amp: t => 0.22 * amp * envAD(0.03, 0.9)(t) });
		}
	}
	mix(out, saturate(filt(pad, "lp", sweep(2400, 380, 0.7), 0.9), grit));
	const hitAt = [0];
	if (double) hitAt.push(0.34);
	for (const at of hitAt) {
		osc(out, { freq: sweep(70, 38, 0.12), amp: t => boom * envAD(0.004, 0.45)(t), at });
		mix(out, filt(noise(rng, 0.5, envAD(0.002, 0.08)), "lp", 700), 0.5 * boom, at);
	}
	// the tension: a tritone above, a bell that will not resolve
	osc(out, { wave: "tri", freq: hz(root + 30), amp: t => 0.12 * envAD(0.01, 0.6)(t), at: 0.05 });
	return reverb(out, { size: 1.3, feedback: 0.84, damp: 0.35, wet: 0.35, tail: 1.2 });
}

// ---------------------------------------------------------------- the set

/**
 * Every synthesised event: its bank, category (loudness target), takes, base volume and pitch range in the mix, and
 * WHY it sounds like that (the listening sheet prints it). `name` is the catalogue's (shared/data/sounds.ts): until
 * the bank has an id, the event plays the library take it had before.
 */
export const SPEC = [
	// ---------------------------------------------------------------- ui (the interface bus)
	{
		name: "uiHover",
		bank: "ui",
		category: "hover",
		volume: 0.3,
		pitch: [0.98, 1.03],
		why: "A 30 ms triangle tick on E6: sweeping a list is a row of tiny ticks, not a row of clicks.",
		render: () => notes(0.06, [[0, 88, 0.012, 0.008]], { sq: 0, lp: 6000 }),
	},
	{
		name: "uiClick",
		bank: "ui",
		category: "ui",
		volume: 0.36,
		pitch: [0.98, 1.03],
		why: "A falling square blip (A6 to E6 in 10 ms) with a pinch of noise: the pixel button's own click.",
		render: rng => {
			const out = buf(0.07);
			osc(out, { wave: "square", duty: 0.25, freq: sweep(1760, 1320, 0.01), amp: envAD(0.001, 0.012) });
			mix(out, shape(filt(noise(rng, 0.004), "hp", 2000), envAD(0.0002, 0.001)), 0.25);
			return filt(out, "lp", 5000, 0.6);
		},
	},
	{
		name: "uiOpen",
		bank: "ui",
		category: "ui",
		volume: 0.32,
		pitch: [1, 1.02],
		why: "Two notes up a fourth (E5, A5): a window opening rises.",
		render: () =>
			echo(
				notes(0.2, [
					[0, 76, 0.05, 0.03],
					[0.055, 81, 0.07, 0.035],
				]),
				0.06,
				0.2,
				1,
			),
	},
	{
		name: "uiClose",
		bank: "ui",
		category: "ui",
		volume: 0.28,
		pitch: [1, 1.02],
		why: "The same two notes falling (A5, E5), a little softer: closing is the answer to opening.",
		render: () =>
			notes(0.18, [
				[0, 81, 0.045, 0.025],
				[0.05, 76, 0.06, 0.03, 0.85],
			]),
	},
	{
		name: "uiBuy",
		bank: "ui",
		category: "reward",
		volume: 0.36,
		pitch: [1, 1],
		why: "A major arpeggio (A5, C#6, E6) with a short echo: confirmation, the purchase went through.",
		render: () =>
			echo(
				notes(
					0.45,
					[
						[0, 81, 0.05, 0.04],
						[0.06, 85, 0.05, 0.04],
						[0.12, 88, 0.18, 0.12],
					],
					{ sq: 0.45 },
				),
				0.09,
				0.28,
				2,
			),
	},
	{
		name: "uiError",
		bank: "ui",
		category: "ui",
		volume: 0.34,
		pitch: [0.98, 1],
		why: "Two low buzzy steps down (G3, F#3), lowpassed: 'no' without a harsh beep.",
		render: () => {
			const out = buf(0.28);
			for (const [at, f] of [
				[0, 196],
				[0.1, 185],
			]) {
				for (const det of [0, 2.5]) {
					osc(out, {
						wave: "square",
						freq: f + det,
						amp: t => 0.5 * envAD(0.004, 0.04)(t) * (t < 0.08 ? 1 : 0),
						at,
						dur: 0.09,
					});
				}
			}
			return filt(out, "lp", 1500, 0.7);
		},
	},

	// ---------------------------------------------------------------- items (pickups, rewards, building)
	{
		name: "pickupItem",
		bank: "items",
		category: "pickup",
		volume: 0.4,
		pitch: [0.97, 1.05],
		why: "A quick upward swish and an E6 blip: something went into the bag (gear, or a searched building).",
		render: rng => {
			const out = buf(0.16);
			mix(out, whoosh(rng, { dur: 0.08, peak: 0.05, lo: 800, hi: 3200, q: 1.2, body: 0.2 }), 0.8);
			mix(out, notes(0.1, [[0, 88, 0.03, 0.02]], { sq: 0.2 }), 0.7, 0.05);
			return out;
		},
	},
	{
		name: "pickupAmmo",
		bank: "items",
		category: "pickup",
		takes: 2,
		volume: 0.4,
		pitch: [0.96, 1.04],
		why: "Two metallic 'chk' 70 ms apart, ringing at inharmonic ratios: cartridges, not candy.",
		render: (rng, take) => {
			const out = buf(0.2);
			const f = take === 0 ? 3200 : 3500;
			mix(
				out,
				click(rng, {
					f,
					q: 4,
					ring: [
						[2400, 0.25, 0.025],
						[3700, 0.15, 0.018],
					],
				}),
			);
			mix(
				out,
				click(rng, {
					f: f * 1.08,
					q: 4,
					ring: [
						[2550, 0.22, 0.022],
						[3950, 0.12, 0.015],
					],
					amp: 0.8,
				}),
				1,
				0.07,
			);
			osc(out, { freq: 420, amp: t => 0.15 * envAD(0.001, 0.01)(t) });
			return out;
		},
	},
	{
		name: "pickupFood",
		bank: "items",
		category: "pickup",
		takes: 2,
		volume: 0.4,
		pitch: [0.96, 1.05],
		why: "A round 'bloop' rising 280 to 620 Hz and a little crinkle of wrapper: soft, edible.",
		render: (rng, take) => {
			const out = buf(0.2);
			osc(out, { freq: sweep(280 + take * 30, 640 + take * 40, 0.03), amp: envAD(0.003, 0.04) });
			mix(out, shape(filt(noise(rng, 0.1, 1, 0.08), "hp", 3000), envAD(0.005, 0.03)), 0.3, 0.02);
			return out;
		},
	},
	{
		name: "pickupMaterial",
		bank: "items",
		category: "pickup",
		takes: 2,
		volume: 0.4,
		pitch: [0.95, 1.05],
		why: "Two hollow knocks, a wood-and-stone 'tok-tok': a material, heavy in the hand.",
		render: (rng, take) => {
			const out = buf(0.2);
			for (const [at, f, a] of [
				[0, 240 + take * 20, 1],
				[0.06, 285 + take * 15, 0.7],
			]) {
				mix(out, shape(filt(noise(rng, 0.05), "bp", 900, 3), envAD(0.0005, 0.012)), 1.3 * a, at);
				osc(out, { freq: f, amp: t => a * envAD(0.001, 0.018)(t), at, dur: 0.12 });
			}
			return out;
		},
	},
	{
		name: "pickupCoin",
		bank: "items",
		category: "reward",
		volume: 0.36,
		pitch: [1, 1.03],
		why: "A square jump up a fifth (A5 to E6), the second note ringing: the universal 'coin', in our own interval.",
		render: () => {
			const out = buf(0.4);
			osc(out, { wave: "square", freq: hz(81), amp: t => 0.5 * (t < 0.055 ? 1 : 0), dur: 0.056 });
			osc(out, { wave: "square", freq: hz(88), amp: t => 0.5 * envAD(0.001, 0.09)(t), at: 0.055 });
			osc(out, { wave: "tri", freq: hz(88), amp: t => 0.4 * envAD(0.001, 0.12)(t), at: 0.055 });
			return filt(out, "lp", 6000, 0.6);
		},
	},
	{
		name: "levelUp",
		bank: "items",
		category: "reward",
		volume: 0.36,
		pitch: [1, 1],
		why: "An A-major run (A4 C#5 E5 A5) then A5 and E6 held with a vibrato: the classic level-up, in the UI's key.",
		render: () => {
			const run = notes(
				1.1,
				[
					[0, 69, 0.06, 0.05],
					[0.07, 73, 0.06, 0.05],
					[0.14, 76, 0.06, 0.05],
					[0.21, 81, 0.06, 0.05],
				],
				{
					sq: 0.45,
					duty: 0.125,
				},
			);
			const hold = buf(1.1);
			for (const [midi, amp] of [
				[81, 0.5],
				[88, 0.35],
			]) {
				osc(hold, {
					wave: "tri",
					freq: t => hz(midi) * (1 + 0.006 * Math.sin(TAU * 6 * t)),
					amp: t => amp * envAD(0.01, 0.35)(t),
					at: 0.28,
				});
			}
			return echo(mix(run, hold), 0.11, 0.25, 2);
		},
	},
	{
		name: "craftDone",
		bank: "items",
		category: "reward",
		volume: 0.34,
		pitch: [0.98, 1.02],
		why: "A workbench thunk, then a two-note chime with a bell's inharmonic partial: made by hand, and done.",
		render: rng => {
			const out = buf(0.7);
			osc(out, { freq: sweep(160, 90, 0.03), amp: envAD(0.001, 0.04) });
			mix(out, filt(noise(rng, 0.05, envAD(0.0005, 0.012)), "lp", 800), 0.7);
			for (const [at, midi] of [
				[0.12, 88],
				[0.19, 93],
			]) {
				osc(out, { wave: "tri", freq: hz(midi), amp: t => 0.4 * envAD(0.002, 0.12)(t), at });
				osc(out, { freq: hz(midi) * 2.76, amp: t => 0.08 * envAD(0.001, 0.05)(t), at });
			}
			return out;
		},
	},
	{
		name: "buildPlace",
		bank: "items",
		category: "pickup",
		takes: 2,
		volume: 0.42,
		pitch: [0.95, 1.04],
		why: "A heavy low thud and a wooden clack 40 ms later: a barricade or a door set down, solid.",
		render: (rng, take) => {
			const out = buf(0.3);
			osc(out, { freq: sweep(125 - take * 10, 58, 0.04), amp: envAD(0.002, 0.07) });
			mix(out, filt(noise(rng, 0.2, envAD(0.001, 0.04)), "lp", 600), 0.8);
			mix(out, shape(filt(noise(rng, 0.04), "bp", 1500 + take * 150, 5), envAD(0.0004, 0.012)), 2.2, 0.04);
			return saturate(out, 1.4);
		},
	},
	{
		name: "buildDeny",
		bank: "items",
		category: "ui",
		volume: 0.34,
		pitch: [1, 1],
		why: "Two short detuned low pulses (A2): 'can't put it there', heard without looking at the red ghost.",
		render: () => {
			const out = buf(0.24);
			for (const at of [0, 0.11]) {
				for (const f of [110, 116.5]) {
					osc(out, {
						wave: "square",
						freq: f,
						amp: t => 0.4 * envAD(0.003, 0.03)(t) * (t < 0.07 ? 1 : 0),
						at,
						dur: 0.08,
					});
				}
			}
			return filt(out, "lp", 900, 0.7);
		},
	},

	// ---------------------------------------------------------------- weapons
	{
		name: "shotPistol",
		bank: "weapons",
		category: "shot",
		takes: 3,
		volume: 0.4,
		pitch: [0.96, 1.05],
		why: "A tight 9 mm pop: a bright crack, a short blast closing from 9 to 1.4 kHz, a 180 Hz thump and a street slap.",
		render: (rng, take) =>
			gunshot(rng, {
				dur: 0.45,
				crack: 0.8,
				cut0: 9000 - take * 400,
				cut1: 1400,
				cutTau: 0.05,
				blastTau: 0.045,
				body0: 180 + take * 8,
				body1: 70,
				bodyTau: 0.03,
				bodyAmp: 0.9,
				tailTau: 0.12,
				tailAmp: 0.18,
				drive: 3.2,
				echo: 0.07,
				echoFb: 0.22,
			}),
	},
	{
		name: "shotRifle",
		bank: "weapons",
		category: "shot",
		takes: 3,
		volume: 0.42,
		pitch: [0.96, 1.04],
		why: "Heavier than the pistol: a longer blast, a deeper body (130 to 50 Hz) and a longer slap down the street.",
		render: (rng, take) =>
			gunshot(rng, {
				dur: 0.7,
				crack: 1,
				cut0: 8000 - take * 300,
				cut1: 900,
				cutTau: 0.08,
				blastTau: 0.07,
				body0: 130 + take * 6,
				body1: 50,
				bodyTau: 0.05,
				bodyAmp: 1,
				tailTau: 0.22,
				tailAmp: 0.25,
				drive: 2.5,
				echo: 0.09,
				echoFb: 0.28,
			}),
	},
	{
		name: "shotShotgun",
		bank: "weapons",
		category: "shot",
		takes: 2,
		volume: 0.46,
		pitch: [0.95, 1.03],
		why: "The widest blast (a second, delayed layer: the spread), the lowest body (95 to 40 Hz): one shot, not a burst.",
		render: (rng, take) =>
			gunshot(rng, {
				dur: 0.9,
				crack: 0.7,
				cut0: 6000 - take * 300,
				cut1: 600,
				cutTau: 0.1,
				blastTau: 0.1,
				spread: true,
				body0: 95,
				body1: 40,
				bodyTau: 0.07,
				bodyAmp: 1.2,
				tailTau: 0.3,
				tailAmp: 0.3,
				drive: 2.8,
				echo: 0.11,
				echoFb: 0.3,
			}),
	},
	{
		name: "shotMg",
		bank: "weapons",
		category: "shot",
		takes: 3,
		volume: 0.3,
		pitch: [1, 1.1],
		why: "Short and tight (0.3 s, no echo) so a burst stays a rhythm, never a wall; three takes rotate.",
		render: (rng, take) =>
			gunshot(rng, {
				dur: 0.3,
				crack: 0.7,
				cut0: 9000,
				cut1: 1600 + take * 100,
				cutTau: 0.04,
				blastTau: 0.04,
				body0: 200,
				body1: 90,
				bodyTau: 0.025,
				bodyAmp: 0.9,
				tailTau: 0.07,
				tailAmp: 0.14,
				drive: 3.6,
			}),
	},
	{
		name: "shotSniper",
		bank: "weapons",
		category: "shot",
		takes: 2,
		volume: 0.46,
		pitch: [0.97, 1.02],
		why: "The loudest crack and a long roll across the town (echo 160 ms + reverb): heard far, like it should be.",
		render: (rng, take) =>
			gunshot(rng, {
				dur: 0.8,
				crack: 1.3,
				cut0: 10000,
				cut1: 700 + take * 60,
				cutTau: 0.09,
				blastTau: 0.08,
				body0: 110,
				body1: 38,
				bodyTau: 0.07,
				bodyAmp: 1.1,
				tailTau: 0.4,
				tailAmp: 0.3,
				drive: 3,
				echo: 0.16,
				echoFb: 0.32,
				verb: { size: 1.4, feedback: 0.82, damp: 0.4, wet: 0.3, tail: 0.8 },
			}),
	},
	{
		name: "shotBow",
		bank: "weapons",
		category: "weapon",
		takes: 2,
		volume: 0.36,
		pitch: [0.96, 1.05],
		why: "A plucked string (Karplus-Strong at ~100 Hz) and the arrow's airy whoosh: the quiet weapon of daytime.",
		render: (rng, take) => {
			const out = buf(0.45);
			mix(out, filt(pluck(rng, 0.4, 98 + take * 12, { damp: 0.993, bright: 0.6 }), "lp", 3000), 0.9);
			mix(out, whoosh(rng, { dur: 0.2, peak: 0.04, lo: 500, hi: 1900, q: 1.1, body: 0.3 }), 0.8, 0.005);
			return out;
		},
	},
	{
		name: "shotElectric",
		bank: "weapons",
		category: "weapon",
		takes: 2,
		volume: 0.34,
		pitch: [0.95, 1.05],
		why: "A buzzing saw wobbling at 27 Hz, a crackle and a falling ping: electricity (LEG-02 yellow), not a gun.",
		render: (rng, take) => {
			const dur = 0.32;
			const out = buf(dur);
			const zap = buf(dur);
			osc(zap, { wave: "saw", freq: t => 90 + take * 8 + 40 * Math.sin(TAU * 27 * t), amp: envAD(0.002, 0.09) });
			mix(out, filt(zap, "bp", sweep(3000, 900, 0.08), 1.2), 1.2);
			mix(out, filt(noise(rng, dur, envAD(0.001, 0.07), 0.02), "hp", 2500), 1.2);
			osc(out, { wave: "square", freq: sweep(1500, 600, 0.06), amp: t => 0.12 * envAD(0.001, 0.05)(t) });
			return saturate(filt(out, "lp", 7000), 2.2);
		},
	},
	{
		name: "reloadStart",
		bank: "weapons",
		category: "weapon",
		volume: 0.36,
		pitch: [0.97, 1.03],
		why: "Click, slide, click: the magazine released and pulled out.",
		render: rng => {
			const out = buf(0.32);
			mix(
				out,
				click(rng, {
					f: 2800,
					q: 6,
					ring: [
						[1870, 0.3, 0.02],
						[3120, 0.2, 0.015],
					],
				}),
			);
			mix(out, shape(filt(noise(rng, 0.13), "bp", sweep(1200, 2400, 0.06), 2), bell(0.05, 0.12)), 0.35, 0.04);
			mix(out, click(rng, { f: 2200, q: 6, ring: [[1500, 0.25, 0.02]], amp: 0.8 }), 1, 0.17);
			return out;
		},
	},
	{
		name: "reloadEnd",
		bank: "weapons",
		category: "weapon",
		volume: 0.38,
		pitch: [0.97, 1.03],
		why: "The magazine seated (a low 'chk'), then the slide racked home with a hard metallic clack.",
		render: rng => {
			const out = buf(0.4);
			osc(out, { freq: 300, amp: envAD(0.0008, 0.015) });
			mix(out, click(rng, { f: 2000, q: 3, ring: [] }), 0.9);
			mix(out, shape(filt(noise(rng, 0.1), "bp", sweep(1500, 2600, 0.05), 2), bell(0.04, 0.09)), 0.3, 0.06);
			mix(
				out,
				click(rng, {
					f: 3200,
					q: 4,
					ring: [
						[1450, 0.35, 0.04],
						[2380, 0.25, 0.03],
						[3900, 0.15, 0.02],
					],
					amp: 1.2,
				}),
				1,
				0.17,
			);
			return out;
		},
	},
	{
		name: "weaponSwitch",
		bank: "weapons",
		category: "weapon",
		volume: 0.3,
		pitch: [0.96, 1.04],
		why: "A cloth-and-strap swish and a small latch click: the weapon drawn or put away (ITM-06).",
		render: rng => {
			const out = buf(0.2);
			mix(out, shape(filt(noise(rng, 0.12), "bp", 1400, 1.2), bell(0.05, 0.11)), 0.6);
			mix(out, click(rng, { f: 3500, q: 8, ring: [[2600, 0.25, 0.012]], amp: 0.7 }), 1, 0.12);
			return out;
		},
	},
	{
		name: "emptyClick",
		bank: "weapons",
		category: "weapon",
		// a 60 ms click cannot fill a 400 ms loudness window: its own, lower target keeps its limiter honest
		target: -24,
		volume: 0.5,
		pitch: [0.98, 1.03],
		why: "A dry hammer click and its tiny echo, nothing else: the most disappointing sound in the game, on purpose.",
		render: rng => {
			const out = buf(0.08);
			mix(
				out,
				click(rng, {
					f: 3000,
					q: 5,
					ring: [
						[2200, 0.35, 0.008],
						[4100, 0.2, 0.005],
					],
				}),
			);
			mix(out, click(rng, { f: 3300, q: 5, ring: [], amp: 0.45 }), 1, 0.025);
			return out;
		},
	},
	{
		name: "meleeSwing",
		bank: "weapons",
		category: "swing",
		takes: 3,
		volume: 0.34,
		pitch: [0.94, 1.08],
		why: "A whoosh whose band sweeps up and back (500 Hz to 1.7 kHz), three speeds: a blade or a bat through the air.",
		render: (rng, take) => {
			const dur = [0.2, 0.24, 0.18][take];
			return whoosh(rng, {
				dur,
				peak: dur * [0.55, 0.5, 0.6][take],
				lo: 450,
				hi: 1700 + take * 150,
				q: 1.5,
				body: 0.6,
			});
		},
	},

	// ---------------------------------------------------------------- impacts, the syringe, footsteps
	{
		name: "hitFlesh",
		bank: "impacts",
		category: "impact",
		takes: 4,
		volume: 0.34,
		pitch: [0.92, 1.08],
		why: "A low thump, a wet squelch (a band-pass wobbling at 12 Hz) and a short splat: a hit that landed on a body.",
		render: (rng, take) => {
			const out = buf(0.24);
			osc(out, { freq: sweep(95 + take * 6, 45, 0.025), amp: envAD(0.001, 0.03) });
			const sq = filt(
				noise(rng, 0.2, envAD(0.002, 0.05)),
				"bp",
				t => 550 + take * 40 + 150 * Math.sin(TAU * 12 * t),
				2.5,
			);
			mix(out, sq, 1.4);
			mix(out, filt(noise(rng, 0.06, envAD(0.0005, 0.015)), "lp", 2500), 0.6);
			return saturate(out, 3);
		},
	},
	{
		name: "debrisMetal",
		bank: "impacts",
		category: "impact",
		takes: 3,
		volume: 0.3,
		pitch: [0.92, 1.08],
		why: "Four inharmonic partials (x1, 2.32, 3.87, 5.61) each with its beating twin, over a sharp transient: a panel struck.",
		render: (rng, take) => {
			const out = buf(0.6);
			mix(
				out,
				partials(0.6, [470, 520, 560][take], [
					[1, 1, 0.22],
					[2.32, 0.6, 0.14],
					[3.87, 0.45, 0.08],
					[5.61, 0.3, 0.05],
				]),
				0.5,
			);
			mix(out, shape(filt(noise(rng, 0.01), "bp", 4000, 2), envAD(0.0002, 0.002)), 1.2);
			return out;
		},
	},
	{
		name: "debrisWood",
		bank: "impacts",
		category: "impact",
		takes: 3,
		volume: 0.3,
		pitch: [0.92, 1.08],
		why: "A hollow knock (band-passed noise at 750 Hz, a 210 Hz body, one partial) and a little splinter crunch.",
		render: (rng, take) => {
			const out = buf(0.22);
			mix(out, shape(filt(noise(rng, 0.08), "bp", 700 + take * 60, 2), envAD(0.0005, 0.02)), 1.6);
			osc(out, { freq: 200 + take * 12, amp: t => 0.7 * envAD(0.001, 0.035)(t) });
			osc(out, { freq: 530 + take * 20, amp: t => 0.3 * envAD(0.001, 0.02)(t) });
			mix(out, filt(noise(rng, 0.04, 1, 0.1), "lp", 3000), 0.25, 0.005);
			return saturate(out, 2.4);
		},
	},
	{
		name: "useInject",
		bank: "impacts",
		category: "use",
		volume: 0.4,
		pitch: [0.98, 1.02],
		why: "The autoinjector: a plastic snap, a 'pssht' of air, a glassy tink. Fills the slot the library could not (pendency D).",
		render: rng => {
			const out = buf(0.42);
			mix(out, click(rng, { f: 2400, q: 4, ring: [[1600, 0.3, 0.01]] }));
			const hiss = filt(filt(noise(rng, 0.3), "hp", 4000), "lp", 9000);
			mix(
				out,
				shape(hiss, t => (t < 0.01 ? t / 0.01 : t < 0.18 ? 1 : Math.exp(-(t - 0.18) / 0.04))),
				0.35,
				0.02,
			);
			osc(out, { freq: 3600, amp: t => 0.1 * envAD(0.001, 0.03)(t), at: 0.33 });
			osc(out, { freq: 5900, amp: t => 0.05 * envAD(0.001, 0.02)(t), at: 0.33 });
			return out;
		},
	},
	{
		name: "footstepA",
		bank: "impacts",
		category: "step",
		takes: 3,
		volume: 0.3,
		pitch: [0.94, 1.06],
		why: "A soft heel thump (noise under 700 Hz, a 80 Hz body) with a trace of asphalt grit: felt more than heard.",
		render: (rng, take) => {
			const out = buf(0.14);
			mix(out, filt(noise(rng, 0.12, envAD(0.003, 0.025)), "lp", 650 + take * 50, 0.9), 1.2);
			osc(out, { freq: sweep(82, 55, 0.02), amp: t => 0.45 * envAD(0.002, 0.018)(t) });
			mix(out, filt(noise(rng, 0.05, envAD(0.002, 0.015), 0.15), "hp", 2500), 0.08);
			return out;
		},
	},
	{
		name: "footstepB",
		bank: "impacts",
		category: "step",
		takes: 3,
		volume: 0.3,
		pitch: [0.94, 1.06],
		why: "The other foot: a toe roll, a little brighter and shorter, so left and right never sound like a metronome.",
		render: (rng, take) => {
			const out = buf(0.13);
			mix(out, filt(noise(rng, 0.1, envAD(0.002, 0.02)), "lp", 850 + take * 60, 0.9), 1.1);
			mix(out, filt(noise(rng, 0.08, envAD(0.002, 0.015)), "lp", 700), 0.5, 0.018);
			osc(out, { freq: sweep(95, 62, 0.02), amp: t => 0.35 * envAD(0.002, 0.015)(t) });
			mix(out, filt(noise(rng, 0.05, envAD(0.002, 0.015), 0.2), "hp", 2800), 0.1);
			return out;
		},
	},

	// ---------------------------------------------------------------- cues (the music bus)
	{
		name: "stingerWave1",
		bank: "cues",
		category: "stinger",
		volume: 0.4,
		pitch: [1, 1],
		why: "19:00, night falls and the first wave: a detuned A-minor brass stab, a boom, an unresolved tritone above.",
		render: rng => nightStab(rng, { root: 45, dur: 2.2, boom: 1, grit: 1.2 }),
	},
	{
		name: "stingerWave2",
		bank: "cues",
		category: "stinger",
		volume: 0.43,
		pitch: [1, 1],
		why: "22:00, wave 2: the same motif a whole tone lower (G), grittier.",
		render: rng => nightStab(rng, { root: 43, dur: 2.4, boom: 1.1, grit: 1.6 }),
	},
	{
		name: "stingerWave3",
		bank: "cues",
		category: "stinger",
		volume: 0.46,
		pitch: [1, 1],
		why: "01:00, wave 3: lower still (F) and the boom doubles like a heartbeat: the worst of the night.",
		render: rng => nightStab(rng, { root: 41, dur: 2.6, boom: 1.2, grit: 2, double: true }),
	},
	{
		name: "stingerDawn",
		bank: "cues",
		category: "stinger",
		volume: 0.34,
		pitch: [1, 1],
		why: "07:00, you made it: an A-major arpeggio over a soft pad, two bird chirps, a long room.",
		render: () => {
			const out = buf(2.2);
			for (const [at, midi] of [
				[0, 69],
				[0.12, 73],
				[0.24, 76],
				[0.36, 81],
			]) {
				osc(out, { wave: "tri", freq: hz(midi), amp: t => 0.3 * envAD(0.01, 0.6)(t), at });
			}
			for (const midi of [57, 64]) osc(out, { freq: hz(midi), amp: t => 0.18 * envAD(0.4, 0.9)(t) });
			for (const at of [0.62, 0.9]) {
				osc(out, { freq: sweep(3200, 4300, 0.02), amp: t => 0.06 * envAD(0.004, 0.02)(t), at, dur: 0.06 });
			}
			return reverb(filt(out, "lp", 5000), { size: 1.2, feedback: 0.83, damp: 0.3, wet: 0.3, tail: 1 });
		},
	},
	{
		name: "heartbeat1",
		bank: "cues",
		category: "heart",
		loop: true,
		volume: 0.4,
		pitch: [1, 1],
		why: "Below 35 % HP: lub-dub at 76 bpm, four beats, its tail folded onto its start so the loop point never clicks.",
		render: () => heartLoop(76),
	},
	{
		name: "heartbeat2",
		bank: "cues",
		category: "heart",
		loop: true,
		volume: 0.46,
		pitch: [1, 1],
		why: "Below 22 %: 100 bpm. A real faster tempo instead of the same loop sped up (the pitch stays a heart's).",
		render: () => heartLoop(100),
	},
	{
		name: "heartbeat3",
		bank: "cues",
		category: "heart",
		loop: true,
		volume: 0.52,
		pitch: [1, 1],
		why: "Below 10 %: 128 bpm, the beats almost on top of each other.",
		render: () => heartLoop(128),
	},
];

export const BANKS = ["ui", "items", "weapons", "impacts", "cues"];

// ---------------------------------------------------------------- rendering

/** renders one take, finished (a Float64Array at SR) */
export function renderTake(spec, take) {
	const rng = mulberry32(seedOf(`${spec.name}#${take}`));
	const raw = spec.render(rng, take);
	for (const v of raw) if (!Number.isFinite(v)) throw new Error(`${spec.name}#${take}: a sample is not a number`);
	return finish(raw, spec.target ?? TARGETS[spec.category], { loop: spec.loop === true });
}

const round3 = v => Math.round(v * 1000) / 1000;
const floor3 = v => Math.floor(v * 1000) / 1000;
const ceil3 = v => Math.ceil(v * 1000) / 1000;

/**
 * Every take, packed into its bank. Returns { banks: { name: Float64Array }, sounds: { name: entry } } where an entry
 * has its bank, its takes as windows (startAt, maxPlay, in seconds of the bank) and each take's measurements.
 */
export function renderAll() {
	const placed = new Map(BANKS.map(b => [b, []]));
	for (const spec of SPEC) {
		const n = spec.takes ?? 1;
		for (let t = 0; t < n; t++) placed.get(spec.bank).push({ spec, take: t, x: renderTake(spec, t) });
	}
	const banks = {};
	const sounds = {};
	for (const bank of BANKS) {
		const list = placed.get(bank);
		let total = BANK_LEAD;
		const at = [];
		for (const p of list) {
			// every take starts on a whole 10 ms: windows stay readable, and there is always silence before it
			const start = Math.ceil(total * 100) / 100;
			at.push(start);
			total = start + p.x.length / SR + BANK_GAP;
		}
		const data = new Float64Array(len(total));
		list.forEach((p, i) => {
			const s0 = Math.round(at[i] * SR);
			data.set(p.x, s0);
			const e = (sounds[p.spec.name] ??= {
				bank,
				category: p.spec.category,
				target: p.spec.target ?? TARGETS[p.spec.category],
				volume: p.spec.volume,
				pitchMin: p.spec.pitch[0],
				pitchMax: p.spec.pitch[1],
				why: p.spec.why,
				takes: [],
				metrics: [],
			});
			const seconds = p.x.length / SR;
			if (p.spec.loop === true) {
				// a loop is played as a region of the bank, to the sample (the heart loops are silent at both ends)
				e.loopStart = Math.round((s0 / SR) * 1e6) / 1e6;
				e.loopEnd = Math.round(((s0 + p.x.length) / SR) * 1e6) / 1e6;
			}
			e.takes.push({ startAt: floor3(at[i] - PRE), maxPlay: ceil3(seconds + PRE + POST) });
			e.metrics.push({
				seconds: round3(seconds),
				lufs: Math.round(momentaryMax(p.x) * 10) / 10,
				truePeak: Math.round(truePeak(p.x) * 100) / 100,
				brightness: Math.round(brightness(p.x) * 1000) / 1000,
			});
		});
		banks[bank] = data;
	}
	return { banks, sounds };
}

// ---------------------------------------------------------------- WAV (16-bit PCM, mono): the whole encoder

export function encodeWav(samples) {
	const data = Buffer.alloc(samples.length * 2);
	for (let i = 0; i < samples.length; i++) {
		const v = Math.max(-1, Math.min(1, samples[i]));
		data.writeInt16LE(Math.round(v * 32767), i * 2);
	}
	const h = Buffer.alloc(44);
	h.write("RIFF", 0, "ascii");
	h.writeUInt32LE(36 + data.length, 4);
	h.write("WAVE", 8, "ascii");
	h.write("fmt ", 12, "ascii");
	h.writeUInt32LE(16, 16);
	h.writeUInt16LE(1, 20); // PCM
	h.writeUInt16LE(1, 22); // mono
	h.writeUInt32LE(SR, 24);
	h.writeUInt32LE(SR * 2, 28);
	h.writeUInt16LE(2, 32);
	h.writeUInt16LE(16, 34);
	h.write("data", 36, "ascii");
	h.writeUInt32LE(data.length, 40);
	return Buffer.concat([h, data]);
}

/** reads what encodeWav writes (and any plain 16-bit PCM WAV): { sampleRate, channels, samples: Int16Array } */
export function decodeWav(bytes) {
	if (bytes.toString("ascii", 0, 4) !== "RIFF" || bytes.toString("ascii", 8, 12) !== "WAVE")
		throw new Error("not a WAV");
	let p = 12;
	let fmt;
	while (p + 8 <= bytes.length) {
		const id = bytes.toString("ascii", p, p + 4);
		const size = bytes.readUInt32LE(p + 4);
		if (id === "fmt ") {
			fmt = {
				format: bytes.readUInt16LE(p + 8),
				channels: bytes.readUInt16LE(p + 10),
				sampleRate: bytes.readUInt32LE(p + 12),
				bits: bytes.readUInt16LE(p + 22),
			};
		} else if (id === "data") {
			if (fmt === undefined || fmt.format !== 1 || fmt.bits !== 16) throw new Error("only 16-bit PCM");
			const samples = new Int16Array(size / 2);
			for (let i = 0; i < samples.length; i++) samples[i] = bytes.readInt16LE(p + 8 + i * 2);
			return { sampleRate: fmt.sampleRate, channels: fmt.channels, samples };
		}
		p += 8 + size + (size & 1);
	}
	throw new Error("no data chunk");
}

const sha1 = bytes => createHash("sha1").update(bytes).digest("hex");

// ---------------------------------------------------------------- the generated module

/** the uploaded ids (design/audio/assets.json), each kept only while it is the upload of THIS bank file */
export function liveBankIds(manifest, assets) {
	const ids = {};
	for (const b of manifest.banks) {
		const id = assets.ids?.[b.name] ?? "";
		ids[b.name] = id !== "" && assets.sha1?.[b.name] === b.sha1 ? id : "";
		if (id !== "" && ids[b.name] === "") {
			console.log(
				`${b.name}: the uploaded bank is not this WAV (run npm run cloud -- upload-audio); its id is left out`,
			);
		}
	}
	return ids;
}

export function moduleSource(manifest, ids) {
	const L = [];
	L.push("// generated by tools/gen-sfx.mjs — do not edit");
	L.push("// banks: design/audio/manifest.json, asset ids: design/audio/assets.json (npm run cloud -- upload-audio)");
	L.push(
		"// a bank without an id plays nothing of ours: every event on it keeps its library take (DESIGN_RULES SND-01)",
	);
	L.push("");
	L.push(`export type AudioBank =${manifest.banks.map(b => `\n\t| "${b.name}"`).join("")};`);
	L.push("");
	L.push('/** "rbxassetid://...", or "" until the bank is uploaded (or while the upload is not this bank\'s WAV) */');
	L.push("export const AUDIO_BANK_IDS: Record<AudioBank, string> = {");
	for (const b of manifest.banks) L.push(`\t${b.name}: "${ids[b.name] ?? ""}",`);
	L.push("};");
	L.push("");
	L.push("/** one take: a window of its bank, in seconds */");
	L.push("export interface SynthTake {");
	L.push("\treadonly startAt: number;");
	L.push("\treadonly maxPlay: number;");
	L.push("}");
	L.push("");
	L.push("export interface SynthSound {");
	L.push("\treadonly bank: AudioBank;");
	L.push("\treadonly takes: ReadonlyArray<SynthTake>;");
	L.push("\t/** base volume in the mix (the take itself is loudness-normalised, design/audio/README.md) */");
	L.push("\treadonly volume: number;");
	L.push("\treadonly pitchMin: number;");
	L.push("\treadonly pitchMax: number;");
	L.push("\t/** a loop: the region of the bank that repeats (Sound.LoopRegion), to the sample */");
	L.push("\treadonly loopStart?: number;");
	L.push("\treadonly loopEnd?: number;");
	L.push("}");
	L.push("");
	L.push("/** our own take of each of these catalogue events (shared/data/sounds.ts resolves them) */");
	L.push("export const SYNTH_SOUNDS: Record<string, SynthSound> = {");
	for (const [name, s] of Object.entries(manifest.sounds)) {
		const takes = s.takes.map(t => `{ startAt: ${t.startAt}, maxPlay: ${t.maxPlay} }`).join(", ");
		const loop = s.loopStart !== undefined ? `, loopStart: ${s.loopStart}, loopEnd: ${s.loopEnd}` : "";
		L.push(
			`\t${name}: { bank: "${s.bank}", takes: [${takes}], volume: ${s.volume}, pitchMin: ${s.pitchMin}, pitchMax: ${s.pitchMax}${loop} },`,
		);
	}
	L.push("};");
	L.push("");
	return L.join("\n");
}

/** writes `text` to `path`, formatted by the project's own prettier (the files it writes are checked with it) */
async function writeFormatted(path, text) {
	let out = text;
	try {
		const prettier = await import("prettier");
		const options = (await prettier.resolveConfig(path)) ?? {};
		out = await prettier.format(text, { ...options, filepath: path });
	} catch (e) {
		console.log(`(prettier not available: ${e?.message ?? e}; ${relative(ROOT, path)} is written unformatted)`);
	}
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, out);
}

async function writeModule(manifest) {
	const assetsPath = join(AUDIO_DIR, "assets.json");
	const assets = existsSync(assetsPath) ? JSON.parse(readFileSync(assetsPath, "utf8")) : {};
	const ids = liveBankIds(manifest, assets);
	// the module lives under src/, where CI checks the formatting
	await writeFormatted(AUDIO_TS, moduleSource(manifest, ids));
	const live = Object.values(ids).filter(v => v !== "").length;
	console.log(`wrote ${relative(ROOT, AUDIO_TS)} (${live}/${manifest.banks.length} banks with an asset id)`);
}

// ---------------------------------------------------------------- the listening sheet

const esc = s => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** a small SVG of a take's envelope (max |x| per bucket), for the sheet */
function waveSvg(x, w = 160, h = 28) {
	const buckets = w;
	const per = Math.max(1, Math.floor(x.length / buckets));
	const pts = [];
	for (let b = 0; b < buckets; b++) {
		let m = 0;
		for (let i = b * per; i < Math.min(x.length, (b + 1) * per); i++) m = Math.max(m, Math.abs(x[i]));
		pts.push(m);
	}
	const top = pts.map((m, i) => `${i},${(h / 2 - (m * h) / 2).toFixed(1)}`).join(" ");
	const bot = pts
		.map((m, i) => `${i},${(h / 2 + (m * h) / 2).toFixed(1)}`)
		.reverse()
		.join(" ");
	return `<svg viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" aria-hidden="true"><polygon points="${top} ${bot}" /></svg>`;
}

function previewHtml(manifest, banks) {
	const rows = [];
	for (const bank of BANKS) {
		rows.push(`<h2>${esc(bank)} <small>${esc(manifest.banks.find(b => b.name === bank).file)}</small></h2>`);
		rows.push(
			"<table><thead><tr><th>Event</th><th>Takes</th><th>Loudness</th><th>Why it fits</th></tr></thead><tbody>",
		);
		for (const [name, s] of Object.entries(manifest.sounds)) {
			if (s.bank !== bank) continue;
			const buttons = s.takes
				.map((t, i) => {
					const x = banks[bank].subarray(
						Math.round((t.startAt + PRE) * SR),
						Math.round((t.startAt + t.maxPlay) * SR),
					);
					return `<button data-bank="${bank}" data-start="${t.startAt}" data-len="${t.maxPlay}" data-loop="${s.loopStart !== undefined}" title="play take ${i + 1}">${waveSvg(x)}<span>${i + 1}</span></button>`;
				})
				.join("");
			const m = s.metrics;
			const lufs = m.map(v => v.lufs.toFixed(1)).join(" / ");
			const tp = Math.max(...m.map(v => v.truePeak)).toFixed(1);
			rows.push(
				`<tr><td><code>${esc(name)}</code><br><small>${esc(s.category)} · vol ${s.volume}</small></td><td class="takes">${buttons}</td><td><small>${lufs} LUFS<br>peak ${tp} dBTP</small></td><td>${esc(s.why)}</td></tr>`,
			);
		}
		rows.push("</tbody></table>");
	}
	const audios = BANKS.map(b => {
		const file = manifest.banks.find(x => x.name === b).file;
		const rel = relative(dirname(PREVIEW), join(AUDIO_DIR, file)).split("\\").join("/");
		return `<audio id="bank-${b}" preload="auto" src="${rel}"></audio>`;
	}).join("\n");
	return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Project Z sounds</title>
<style>
:root { --bg: #14161a; --fg: #e8e6e1; --muted: #9a9a93; --line: #2c2f36; --accent: #e0b64a; --wave: #7fb3d5; }
@media (prefers-color-scheme: light) { :root { --bg: #f6f4ef; --fg: #1d1f24; --muted: #5d5f66; --line: #d9d6cd; --accent: #8a5a00; --wave: #2f6f9f; } }
body { background: var(--bg); color: var(--fg); font: 15px/1.45 system-ui, sans-serif; margin: 0 auto; padding: 16px; max-width: 1100px; }
h1 { font-size: 22px; margin: 8px 0; } h2 { font-size: 17px; margin: 28px 0 8px; border-bottom: 1px solid var(--line); padding-bottom: 4px; }
h2 small, td small { color: var(--muted); font-weight: normal; }
table { border-collapse: collapse; width: 100%; } td, th { text-align: left; vertical-align: top; padding: 6px 8px; border-bottom: 1px solid var(--line); }
th { color: var(--muted); font-weight: 600; font-size: 13px; }
.takes { white-space: nowrap; } button { background: none; border: 1px solid var(--line); border-radius: 6px; color: var(--fg); cursor: pointer; margin: 0 4px 4px 0; padding: 2px 4px; display: inline-flex; align-items: center; gap: 4px; }
button:hover, button.on { border-color: var(--accent); } svg polygon { fill: var(--wave); } svg { display: block; width: 110px; height: 22px; }
p.note { color: var(--muted); }
@media (max-width: 700px) { td:nth-child(4) { display: none; } svg { width: 70px; } }
</style>
</head>
<body>
<h1>Project Z — our own sound effects</h1>
<p class="note">Generated by <code>npm run audio:sfx</code> (tools/gen-sfx.mjs): ${SPEC.length} events, ${Object.values(manifest.sounds).reduce((a, s) => a + s.takes.length, 0)} takes in ${BANKS.length} banks, ${SR / 1000} kHz 16-bit mono. Every take is loudness-normalised to its category (momentary max, BS.1770) with a true peak at or under ${PEAK_CEILING} dBTP. Click a take to hear it; heartbeat takes loop until clicked again. Open this file from the repository (it plays <code>design/audio/banks/*.wav</code>).</p>
${rows.join("\n")}
${audios}
<script>
let stopAt = 0, playing = null, timer = 0, button = null;
function stop() { if (playing) { playing.pause(); playing = null; } if (button) button.classList.remove("on"); clearTimeout(timer); }
document.addEventListener("click", e => {
  const b = e.target.closest("button[data-bank]"); if (!b) return;
  const same = b === button; stop(); if (same) { button = null; return; }
  const a = document.getElementById("bank-" + b.dataset.bank); const start = +b.dataset.start, dur = +b.dataset.len;
  button = b; b.classList.add("on"); playing = a; a.currentTime = start; a.play();
  const tick = () => { if (playing !== a) return; if (a.currentTime >= start + dur) { if (b.dataset.loop === "true") { a.currentTime = start; } else { stop(); button = null; return; } } timer = setTimeout(tick, 5); };
  tick();
});
</script>
</body>
</html>
`;
}

function readmeMd(manifest) {
	const L = [];
	L.push("# Project Z — our own sound effects");
	L.push("");
	L.push(
		"Generated by `npm run audio:sfx` (`tools/gen-sfx.mjs`) — do not edit by hand; the rules are DESIGN_RULES **SND**.",
	);
	L.push("Listen before uploading: open `docs/audio/preview.html` from the repository (it plays the banks below).");
	L.push("");
	L.push("## How it gets into the game");
	L.push("");
	L.push("1. `npm run audio:sfx` renders every take and packs them into the five banks of `banks/` (one WAV each).");
	L.push("2. On the PC, with the `.env`: `npm run cloud -- upload-audio` uploads the banks that are new or changed");
	L.push(
		"   (Open Cloud Assets API, `assetType: Audio`, `audio/wav`), writes their ids and hashes to `assets.json` and",
	);
	L.push(
		"   regenerates `src/shared/data/audioAssets.ts`. `-- upload-audio --dry-run` lists them without reading any key.",
	);
	L.push("3. `npm run build`, commit `design/audio/assets.json` + `src/shared/data/audioAssets.ts`.");
	L.push("");
	L.push(
		"Until a bank has an id — or if the client cannot load it — every event on it keeps the library take it had",
	);
	L.push("before (SND-01, like ART-01 for the town's art).");
	L.push("");
	L.push("## Banks");
	L.push("");
	L.push("| Bank | File | Length | Takes | SHA-1 |");
	L.push("| ---- | ---- | ------ | ----- | ----- |");
	for (const b of manifest.banks) {
		const takes = Object.values(manifest.sounds)
			.filter(s => s.bank === b.name)
			.reduce((a, s) => a + s.takes.length, 0);
		L.push(`| \`${b.name}\` | \`${b.file}\` | ${b.seconds.toFixed(2)} s | ${takes} | \`${b.sha1.slice(0, 12)}\` |`);
	}
	L.push("");
	L.push("## Events");
	L.push("");
	L.push("Loudness is each take's momentary max (ITU-R BS.1770, 400 ms, LUFS); the true peak is 4× oversampled. The");
	L.push("mix level is the loudness plus the catalogue's base volume (in dB) before the Settings sliders.");
	L.push("");
	L.push("| Event | Bank | Takes | Loudness (LUFS) | Peak (dBTP) | Mix level | Why it fits |");
	L.push("| ----- | ---- | ----- | --------------- | ----------- | --------- | ----------- |");
	for (const [name, s] of Object.entries(manifest.sounds)) {
		const lufs = s.metrics.map(m => m.lufs.toFixed(1)).join(" / ");
		const tp = Math.max(...s.metrics.map(m => m.truePeak)).toFixed(1);
		const mixLevel = (Math.max(...s.metrics.map(m => m.lufs)) + gainToDb(s.volume)).toFixed(1);
		L.push(`| \`${name}\` | ${s.bank} | ${s.takes.length} | ${lufs} | ${tp} | ${mixLevel} | ${s.why} |`);
	}
	L.push("");
	L.push("## What stays on the library, and why");
	L.push("");
	L.push("Organic sound is what a synthesiser does worst and a recording does best, so these keep their official");
	L.push(
		"library takes (`design/audio-credits.md`): the horde's voices (groans, snarls, the group shout, the death),",
	);
	L.push(
		"the boss roar, the bite, the survivor's hurt and death, the doors, eating, the bandage, the kit's zipper, the",
	);
	L.push("pills, the flamethrower's jet and ignition, the motorcycle's engine and horn, the bicycle's bell, the");
	L.push("explosion, breaking glass, the night music and the day and dawn ambiences.");
	L.push("");
	return L.join("\n");
}

// ---------------------------------------------------------------- entry

function manifestOf(sounds, bankBytes) {
	return {
		generator: "tools/gen-sfx.mjs",
		sampleRate: SR,
		bits: 16,
		channels: 1,
		peakCeiling: PEAK_CEILING,
		targets: TARGETS,
		banks: BANKS.map(b => ({
			name: b,
			file: `banks/${b}.wav`,
			seconds: round3((bankBytes[b].length - 44) / 2 / SR),
			sha1: sha1(bankBytes[b]),
		})),
		sounds,
	};
}

async function main(args) {
	if (args.includes("--assets")) {
		const path = join(AUDIO_DIR, "manifest.json");
		if (!existsSync(path)) {
			console.error("ERRO: sem design/audio/manifest.json: rode `npm run audio:sfx` antes");
			process.exit(1);
		}
		await writeModule(JSON.parse(readFileSync(path, "utf8")));
		return;
	}
	const t0 = Date.now();
	const { banks, sounds } = renderAll();
	const bankBytes = {};
	for (const b of BANKS) bankBytes[b] = encodeWav(banks[b]);
	const manifest = manifestOf(sounds, bankBytes);
	if (args.includes("--check")) {
		let drift = 0;
		for (const b of BANKS) {
			const file = join(AUDIO_DIR, "banks", `${b}.wav`);
			if (!existsSync(file)) {
				console.log(`${b}: missing ${relative(ROOT, file)}`);
				drift++;
				continue;
			}
			const have = decodeWav(readFileSync(file)).samples;
			const want = decodeWav(bankBytes[b]).samples;
			let worst = have.length === want.length ? 0 : Infinity;
			for (let i = 0; i < Math.min(have.length, want.length); i++)
				worst = Math.max(worst, Math.abs(have[i] - want[i]));
			if (worst > 1) {
				console.log(
					`${b}: the committed bank differs from the renderer (${worst === Infinity ? "length" : `${worst} LSB`})`,
				);
				drift++;
			}
		}
		console.log(
			drift === 0
				? `the ${BANKS.length} banks match the renderer`
				: `${drift} bank(s) drifted: run npm run audio:sfx`,
		);
		process.exit(drift === 0 ? 0 : 1);
	}
	mkdirSync(join(AUDIO_DIR, "banks"), { recursive: true });
	for (const b of BANKS) writeFileSync(join(AUDIO_DIR, "banks", `${b}.wav`), bankBytes[b]);
	writeFileSync(join(AUDIO_DIR, "manifest.json"), `${JSON.stringify(manifest, undefined, "\t")}\n`);
	await writeFormatted(join(AUDIO_DIR, "README.md"), readmeMd(manifest));
	await writeFormatted(PREVIEW, previewHtml(manifest, banks));
	const split = args.indexOf("--split");
	if (split >= 0 && args[split + 1] !== undefined) {
		const dir = resolve(args[split + 1]);
		mkdirSync(dir, { recursive: true });
		for (const spec of SPEC) {
			for (let t = 0; t < (spec.takes ?? 1); t++)
				writeFileSync(join(dir, `${spec.name}-${t + 1}.wav`), encodeWav(renderTake(spec, t)));
		}
		console.log(`wrote every take to ${dir}`);
	}
	await writeModule(manifest);
	const takes = Object.values(sounds).reduce((a, s) => a + s.takes.length, 0);
	const bytes = Object.values(bankBytes).reduce((a, b) => a + b.length, 0);
	console.log(
		`${SPEC.length} events, ${takes} takes, ${BANKS.length} banks (${(bytes / 1024).toFixed(0)} kB) in ${Date.now() - t0} ms -> ${relative(ROOT, AUDIO_DIR)}`,
	);
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
	await main(process.argv.slice(2));
}
