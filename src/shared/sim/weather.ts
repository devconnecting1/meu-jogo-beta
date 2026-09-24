/*
 * The weather (docs/DESIGN_RULES.md LUZ-05): which weather a day has, how thick its fog is at an hour, and when a
 * thunderstorm's lightning strikes and its thunder rolls. Pure maths, no state, no random numbers -- the same kind of
 * module as shared/sim/clock.ts, and read by the same three places: the server's clock (server/sim/waves.ts), which
 * DECIDES the day's weather and sends it on the wire (WorldEv.Clock's weather byte, shared/net/protocol.ts note 25);
 * the client's clock (client/systems/daynight.ts), which mirrors it; and the horde's senses
 * (shared/sim/ai/zombieBrain.ts via AiClock), which read what those clocks derive from it. Everything that depends on
 * the hour -- the fog of a morning, a lightning flash, a thunderclap -- is a function of (weather, world day, hour),
 * numbers every client already has from the Clock delta, so two screens and the server agree without a byte more.
 *
 * The five weathers, and why each exists:
 *   Clear     most days.
 *   Rain      the original's: 10 % of the days from day 5 on (`if day<=4 weather = 0`). Darker (the overlay ≥ 0.5), and
 *             the horde sees 55 % and hears 60 % as far (IA-01, IA-02).
 *   Storm     a rain day, from day 8, one in three: rain, a darker sky, and lightning -- a flash that lights the town
 *             for a moment (the night overlay lifts, for the horde's eyes as for yours) and a thunderclap that
 *             covers every other noise for THUNDER_MASK_S: the tactical window of the storm.
 *   DawnFog   from day 3: fog from 04:00, thick from 05:00 to 07:00, gone by 09:00.
 *   Fog       from day 6, rare: fog all day, thickest at dawn, lifting only around midnight.
 * Fog cuts sight for BOTH sides: the horde's eyes shrink (FOG_SIGHT_CUT) and the survivor's screen fogs over with
 * distance (client/view/weatherView.ts, FOG_CLEAR_R .. FOG_FULL_R). It never touches hearing.
 *
 * Determinism: a day's weather is a hash of (the town's seed, the day) -- integer maths that stays exact in a double,
 * so Luau on a phone and on the server and Node in the tests give the same answer. The admin can still set any weather
 * (server/admin/adminWorld.ts): what every client obeys is the byte the server sends, never its own roll.
 */
import { DESIGN } from "shared/engine/constants";
import { clockSpeed, darkAlphaAt, rainPossible } from "shared/sim/clock";

/** the day's weather (the Clock delta's byte: 0 and 1 kept the meaning of the old rain boolean) */
export const Weather = {
	Clear: 0,
	Rain: 1,
	Storm: 2,
	DawnFog: 3,
	Fog: 4,
} as const;
export type WeatherKind = (typeof Weather)[keyof typeof Weather];
/** the largest valid weather byte: the decoder refuses anything above it */
export const WEATHER_MAX = 4;

// ---------------------------------------------------------------- the roll

/** a rainy day from this day on is a storm one time in STORM_SHARE_DIV */
export const STORM_FROM_DAY = 8;
export const STORM_SHARE_DIV = 3;
/** fog at dawn: never on the first two days (the first mornings teach the town in clear air) */
export const DAWN_FOG_FROM_DAY = 3;
export const DAWN_FOG_PERCENT = 15;
/** fog all day: later, and rare */
export const FOG_FROM_DAY = 6;
export const FOG_PERCENT = 4;

const HASH_M = 2147483647;
/** salts of the independent rolls (any distinct integers) */
const SALT_DAY = 101;
const SALT_STORM = 211;
const SALT_STRIKE = 307;
const SALT_STRIKE_AT = 401;
const SALT_STRIKE_FAR = 503;

/** one MINSTD step: every product stays under 2^47, exact in a double (Luau and JS alike) */
function minstd(s: number): number {
	return (s * 48271) % HASH_M;
}

/**
 * The nonlinear step: s times (its low 16 bits + 1). MINSTD alone is LINEAR mod M -- two rolls of the same day with
 * different salts would sit a fixed offset apart (a storm roll that can never pass when the rain roll did); this breaks
 * that. The product stays under 2^47: exact. Never 0 (a 0 would stick).
 */
function square(s: number): number {
	const v = (s * ((s % 65536) + 1)) % HASH_M;
	return v === 0 ? 1 : v;
}

/** a non-negative integer below HASH_M (a seed may be any number; a fraction or a sign never changes the answer) */
function whole(v: number): number {
	return math.floor(math.abs(v)) % HASH_M;
}

/**
 * A number in [0, 1) that depends only on (a, b, c), identical on every machine: MINSTD steps and a nonlinear square,
 * integers under 2^53 all the way, no floating function (a `sin` hash rounds differently on another CPU, and a day
 * would rain on one screen only).
 */
export function weatherHash(a: number, b: number, c: number): number {
	let s = whole(a);
	if (s === 0) s = 1;
	s = square(minstd(s));
	s = (s + whole(b) * 16807) % HASH_M;
	if (s === 0) s = 1;
	s = minstd(square(minstd(s)));
	s = (s + whole(c) * 69621) % HASH_M;
	if (s === 0) s = 1;
	s = minstd(square(minstd(square(minstd(s)))));
	return (s - 1) / (HASH_M - 1);
}

/** the weather of world day `day` in the town born from `seed`: the server's roll (the client's only offline) */
export function weatherOfDay(seed: number, day: number): WeatherKind {
	if (!(day >= 1)) return Weather.Clear;
	const u = weatherHash(seed, day, SALT_DAY);
	let edge = 0;
	if (rainPossible(day)) {
		edge = DESIGN.WEATHER_PERCENT / 100;
		if (u < edge) {
			const storm = day >= STORM_FROM_DAY && weatherHash(seed, day, SALT_STORM) * STORM_SHARE_DIV < 1;
			return storm ? Weather.Storm : Weather.Rain;
		}
	}
	if (day >= FOG_FROM_DAY) {
		edge += FOG_PERCENT / 100;
		if (u < edge) return Weather.Fog;
	}
	if (day >= DAWN_FOG_FROM_DAY) {
		edge += DAWN_FOG_PERCENT / 100;
		if (u < edge) return Weather.DawnFog;
	}
	return Weather.Clear;
}

/** a weather byte the game knows (the wire's range check, the admin's) */
export function isWeather(v: number): v is WeatherKind {
	return (
		v === Weather.Clear || v === Weather.Rain || v === Weather.Storm || v === Weather.DawnFog || v === Weather.Fog
	);
}

/** it rains (a storm is rain too): the rain's darkness, eyes and ears */
export function weatherRains(kind: number): boolean {
	return kind === Weather.Rain || kind === Weather.Storm;
}

/** the name the admin panel and the audit use (the players read the HUD's icon and the announcement) */
export function weatherName(kind: number): string {
	if (kind === Weather.Rain) return "Rain";
	if (kind === Weather.Storm) return "Storm";
	if (kind === Weather.DawnFog) return "Dawn fog";
	if (kind === Weather.Fog) return "Fog";
	return "Clear";
}

/**
 * What the HUD's feed says when the weather of the day changes (lang.ts keys; "" for a clear day): what it is and what
 * it does, because the tactical part -- thunder covers noise, fog blinds both sides -- is nothing a player can guess.
 */
export function weatherAnnouncement(kind: number): string {
	if (kind === Weather.Rain) return "Rain: zombies see and hear less";
	if (kind === Weather.Storm) return "Thunderstorm: each thunderclap hides your noise";
	if (kind === Weather.DawnFog) return "Fog at dawn: you and the zombies see less";
	if (kind === Weather.Fog) return "Fog: you and the zombies see less";
	return "";
}

// ---------------------------------------------------------------- fog

/** dawn fog: rises from this hour, is full from DAWN_FOG_FULL to DAWN_FOG_THIN, and is gone at DAWN_FOG_END */
export const DAWN_FOG_RISE = 4;
export const DAWN_FOG_FULL = 5;
export const DAWN_FOG_THIN = 7;
export const DAWN_FOG_END = 9;
/** a day of fog: this thick all day, the dawn's full fog on top of it; it lifts in the hour either side of midnight */
export const FOG_DAY_BASE = 0.7;
/** fraction of the horde's eyesight the thickest fog takes away (520 u by day -> 260 u) */
export const FOG_SIGHT_CUT = 0.5;

/** smoothstep of t in [0, 1] */
function smooth(t: number): number {
	const x = math.clamp(t, 0, 1);
	return x * x * (3 - 2 * x);
}

function dawnFog(t: number): number {
	if (t <= DAWN_FOG_RISE || t >= DAWN_FOG_END) return 0;
	if (t < DAWN_FOG_FULL) return smooth((t - DAWN_FOG_RISE) / (DAWN_FOG_FULL - DAWN_FOG_RISE));
	if (t <= DAWN_FOG_THIN) return 1;
	return 1 - smooth((t - DAWN_FOG_THIN) / (DAWN_FOG_END - DAWN_FOG_THIN));
}

/**
 * How thick the fog is (0 none, 1 the thickest) at `dayTime` on a day of weather `kind`. Continuous in the hour, and 0
 * at midnight for every weather, so the day's weather changing at 00:00 never makes the fog jump.
 */
export function fogDensityAt(kind: number, dayTime: number): number {
	if (kind === Weather.DawnFog) return dawnFog(dayTime);
	if (kind !== Weather.Fog) return 0;
	const edge = smooth(dayTime) * smooth(24 - dayTime);
	return (FOG_DAY_BASE + (1 - FOG_DAY_BASE) * dawnFog(dayTime)) * edge;
}

/** what is left of the horde's eyesight in fog of density `fog` */
export function fogSight(fog: number): number {
	return 1 - FOG_SIGHT_CUT * math.clamp(fog, 0, 1);
}

/**
 * The survivor's screen in fog (client/view/weatherView.ts): clear up to FOG_CLEAR_R, fogging over to FOG_FULL_R, where
 * the fog is FOG_SCREEN_MAX × density opaque. The clear core is the thickest fog's zombie eyesight minus a margin: what
 * sees you, you see; what cannot, fades out a street away. The awareness marks sit above the fog (LEG-03, IA-05).
 */
export const FOG_CLEAR_R = 220;
export const FOG_FULL_R = 640;
export const FOG_SCREEN_MAX = 0.72;

/** the fog's opacity on screen at `dist` world units from the survivor, in fog of density `fog` (the drawn map's rule) */
export function fogScreenAt(fog: number, dist: number): number {
	if (fog <= 0 || dist <= FOG_CLEAR_R) return 0;
	return FOG_SCREEN_MAX * math.clamp(fog, 0, 1) * smooth((dist - FOG_CLEAR_R) / (FOG_FULL_R - FOG_CLEAR_R));
}

// ---------------------------------------------------------------- the storm: lightning and thunder

/** a storm day is cut into slots of this many game hours; a slot has at most one strike */
export const STRIKE_SLOT_H = 0.9;
/** the strike falls in this part of its slot, so two strikes are never closer than 0.54 h (10.7 s at night speed) */
const STRIKE_FROM = 0.1;
const STRIKE_TO = 0.5;
/** the share of slots with a strike (~18 a storm day, one every ~33 s) */
export const STRIKE_CHANCE = 0.7;
/** slots 0..STRIKE_SLOTS-1: the last strike of a day ends before 23:00, so no flash or clap crosses midnight */
export const STRIKE_SLOTS = 26;
/** the flash takes up to this share of the darkness away (a night of 0.85 lifts to 0.34 at a close strike) */
export const FLASH_LIFT = 0.6;
/** a close strike's flash: two flickers in its first 0.24 s, then a fade; everything is over after FLASH_S */
export const FLASH_S = 0.9;
/**
 * Reduce Motion (and photosensitivity): the flash becomes ONE slow swell of at most this share of the lift -- no
 * flicker at all, rising over FLASH_GENTLE_RISE_S and falling over FLASH_GENTLE_FALL_S.
 */
export const FLASH_GENTLE_PEAK = 0.3;
export const FLASH_GENTLE_RISE_S = 0.5;
export const FLASH_GENTLE_FALL_S = 1.5;
/** the flash is quantised to this many levels: a light map rebuilt a few times per strike, not every frame */
const FLASH_LEVELS = 16;
/** seconds from the flash to the thunder: 0.3 s for a strike next door, 2.4 s for one ~800 m away */
export const THUNDER_DELAY_MIN = 0.3;
export const THUNDER_DELAY_MAX = 2.4;
/** how long a thunderclap covers other noises, and what a noise carries meanwhile (a pistol's 800 u -> 320 u) */
export const THUNDER_MASK_S = 3;
export const THUNDER_HEARING = 0.4;
/** a storm is darker than a rain: the overlay never under this by day (still lit for the horde: 1 - 0.58 ≥ 0.4) */
export const STORM_DARK = 0.58;

/** the strike found by `strikeIn`: its hour, how close it fell (1 next door, 0.5 far) and the thunder's delay */
let strikeHour = 0;
let strikePower = 0;
let strikeDelay = 0;

/** does slot `slot` of world day `day` have a strike? When it does, `strikeHour/Power/Delay` describe it */
function strikeIn(day: number, slot: number): boolean {
	if (slot < 0 || slot >= STRIKE_SLOTS) return false;
	if (weatherHash(day, slot, SALT_STRIKE) >= STRIKE_CHANCE) return false;
	const at = weatherHash(day, slot, SALT_STRIKE_AT);
	const far = weatherHash(day, slot, SALT_STRIKE_FAR);
	strikeHour = (slot + STRIKE_FROM + (STRIKE_TO - STRIKE_FROM) * at) * STRIKE_SLOT_H;
	strikePower = 1 - 0.5 * far;
	strikeDelay = THUNDER_DELAY_MIN + (THUNDER_DELAY_MAX - THUNDER_DELAY_MIN) * far;
	return true;
}

/** real seconds from the strike to `dayTime` (the clock's speed at the strike: a flash is over long before it changes) */
function secondsAfterStrike(dayTime: number): number {
	return (dayTime - strikeHour) / clockSpeed(strikeHour);
}

/** the flash of one strike `s` seconds after it, 0..1: two flickers and a fade (a far strike: dimmer, one flicker) */
function flashShape(s: number, power: number): number {
	if (s < 0 || s >= FLASH_S) return 0;
	// the first flicker, a dip, the second flicker (a close strike's; a far one's is a glow), then the fade
	if (s < 0.06) return power;
	if (s < 0.14) return 0.25 * power;
	if (s < 0.24) return (power > 0.7 ? 0.8 : 0.3) * power;
	const k = 1 - (s - 0.24) / (FLASH_S - 0.24);
	return 0.5 * k * k * power;
}

/** the Reduce Motion flash: one smooth swell, never a flicker */
function gentleShape(s: number, power: number): number {
	if (s < 0 || s >= FLASH_GENTLE_RISE_S + FLASH_GENTLE_FALL_S) return 0;
	const v =
		s < FLASH_GENTLE_RISE_S
			? smooth(s / FLASH_GENTLE_RISE_S)
			: 1 - smooth((s - FLASH_GENTLE_RISE_S) / FLASH_GENTLE_FALL_S);
	return v * power * FLASH_GENTLE_PEAK;
}

/**
 * The lightning at `dayTime` of world day `day` (0 dark, 1 a close strike's first flicker), for a day of weather
 * `kind`. `gentle` gives the Reduce Motion shape (a slow swell of at most FLASH_GENTLE_PEAK) -- for the screen only: the
 * horde lives by the real flash (the server's darkness).
 */
export function stormFlashAt(kind: number, day: number, dayTime: number, gentle = false): number {
	if (kind !== Weather.Storm) return 0;
	const slot = math.floor(dayTime / STRIKE_SLOT_H);
	let best = 0;
	for (let k = slot - 1; k <= slot; k++) {
		if (!strikeIn(day, k)) continue;
		const s = secondsAfterStrike(dayTime);
		const v = gentle ? gentleShape(s, strikePower) : flashShape(s, strikePower);
		if (v > best) best = v;
	}
	if (gentle) return best;
	return math.floor(best * FLASH_LEVELS + 0.5) / FLASH_LEVELS;
}

/**
 * What a noise carries at `dayTime`, before the rain: THUNDER_HEARING while a thunderclap rolls (THUNDER_MASK_S from its
 * onset, the strike's flash plus its delay), else 1. The ramp back is the last half second, so the window's end is not
 * a cliff for a zombie standing on the edge of a ring.
 */
export function thunderMaskAt(kind: number, day: number, dayTime: number): number {
	if (kind !== Weather.Storm) return 1;
	const slot = math.floor(dayTime / STRIKE_SLOT_H);
	let mask = 1;
	for (let k = slot - 1; k <= slot; k++) {
		if (!strikeIn(day, k)) continue;
		const s = secondsAfterStrike(dayTime) - strikeDelay;
		if (s < 0 || s >= THUNDER_MASK_S) continue;
		const tail = THUNDER_MASK_S - s;
		const m = tail < 0.5 ? THUNDER_HEARING + (1 - THUNDER_HEARING) * (1 - tail / 0.5) : THUNDER_HEARING;
		if (m < mask) mask = m;
	}
	return mask;
}

/**
 * The loudest thunderclap whose onset falls in (from, to] of the same day (0 = none): the sound's trigger, read by the
 * client's audio (client/audio/gameAudio.ts) on the hours its own clock passes. 1 = next door, 0.5 = far.
 */
export function thunderBetween(kind: number, day: number, from: number, to: number): number {
	if (kind !== Weather.Storm || !(to > from)) return 0;
	let best = 0;
	for (let k = math.floor(from / STRIKE_SLOT_H) - 1; k <= math.floor(to / STRIKE_SLOT_H); k++) {
		if (!strikeIn(day, k)) continue;
		const onset = strikeHour + strikeDelay * clockSpeed(strikeHour);
		if (onset > from && onset <= to && strikePower > best) best = strikePower;
	}
	return best;
}

/** one strike of a storm day, for tools and tests: its hour, power and thunder delay (s) */
export interface StrikeInfo {
	hour: number;
	power: number;
	delay: number;
}

/** every strike of world day `day` if it is a storm day, in order (tests and the admin's readout; allocates) */
export function strikesOfDay(day: number): Array<StrikeInfo> {
	const out = new Array<StrikeInfo>();
	for (let k = 0; k < STRIKE_SLOTS; k++) {
		if (strikeIn(day, k)) out.push({ hour: strikeHour, power: strikePower, delay: strikeDelay });
	}
	return out;
}

// ---------------------------------------------------------------- the darkness a weather makes

/**
 * The world's darkness for a day of weather `kind` at `dayTime`: the clock's night and rain (`darkAlphaAt`), a storm's
 * darker sky, and the lightning lifting it (`flash`, 0..1: pass `stormFlashAt`, or its gentle shape for a screen with
 * Reduce Motion). The server's horde and the client's light map read this very number (LUZ-05).
 */
export function weatherDark(kind: number, dayTime: number, nocturnal: boolean, flash: number): number {
	let dark = darkAlphaAt(dayTime, weatherRains(kind), nocturnal);
	if (kind === Weather.Storm && dark < STORM_DARK) dark = STORM_DARK;
	return dark * (1 - FLASH_LIFT * math.clamp(flash, 0, 1));
}
