/*
 * Sound catalogue: logical name -> asset, base volume, pitch range, voice budget, bus.
 *
 * Rules (design/audio-credits.md has the licence table and the calibration):
 *  - Only audio the game may legally ship: engine content (`rbxasset://sounds/*`, shipped with the Roblox
 *    client) and assets from Roblox's own free library (Pro Sound Effects / APM Music, "courtesy of" the
 *    official catalogue, free for use inside experiences). Every id in here was loaded and checked in Studio.
 *  - `id: ""` is a legal, expected state: an empty slot plays NOTHING (silent fallback). Never fill a slot
 *    with audio of doubtful origin just to avoid the silence.
 *  - `volume` is the base level BEFORE the bus gain (the Settings sliders). Keep every one of them <= 0.6:
 *    the player must never be hit by a sudden loud sound.
 *
 * This file is data only: no Instances, no services. The client mixer (client/audio/audio.ts) reads it.
 */

/** mixer bus; each one is a SoundGroup driven by a Settings slider */
export type SoundBus = "sfx" | "ui" | "bgm";

/** what a sound is, for tuning and for the credits table */
export type SoundCategory = "weapon" | "impact" | "creature" | "world" | "ui" | "music" | "ambient";

export interface SoundDef {
	/**
	 * Full content string ("rbxassetid://123" or "rbxasset://sounds/x.wav"), or "" for an empty slot.
	 * An empty slot is silent: nothing is created, nothing is preloaded, no voice is taken.
	 */
	id: string;
	bus: SoundBus;
	category: SoundCategory;
	/** base volume before the bus gain (0..0.6) */
	volume: number;
	/** random PlaybackSpeed range per trigger, so repeats never sound robotic (min === max = no variation) */
	pitchMin: number;
	pitchMax: number;
	/** how many copies of THIS sound may overlap; the oldest one is stolen past the limit */
	voices: number;
	/** who survives when the global voice budget is full (higher wins) */
	priority: number;
	/** loops forever until stopped (music/ambience/heartbeat) */
	loop?: boolean;
	/** positioned in the 2D world (volume + stereo side by distance to the camera) */
	spatial?: boolean;
	/** skip this many seconds of the file (room tone before the take) */
	startAt?: number;
	/**
	 * Stop the voice after this many seconds. Some library takes hold SEVERAL shots in one file
	 * ("Multiple Shots" / "Various Shot Bursts"): a short window turns one of them into a single shot.
	 */
	maxPlay?: number;
}

// ---------------------------------------------------------------- assets (see design/audio-credits.md)

/** Roblox engine content: ships with the client, owned by Roblox, cannot be moderated away */
const ENGINE = "rbxasset://sounds/";

/** Roblox classic sound library (creator "Roblox", id 1, free) */
const RBX_SWOOSH = "rbxassetid://12222200";
const RBX_SWORD_SLASH = "rbxassetid://12222216";
const RBX_THUNDER = "rbxassetid://12222030";

/** Roblox official free library — Pro Sound Effects */
const PSE_PISTOL_A = "rbxassetid://9114716927";
const PSE_PISTOL_B = "rbxassetid://9114716907";
const PSE_PISTOL_C = "rbxassetid://9114716928";
const PSE_RIFLE = "rbxassetid://9113195119";
const PSE_SHOTGUN = "rbxassetid://9112912106";
const PSE_GROWL_A = "rbxassetid://9114628598";
const PSE_GROWL_B = "rbxassetid://9114628620";
const PSE_ROAR = "rbxassetid://9114628818";
const PSE_NIGHT_BED = "rbxassetid://9114244977";
const PSE_DAY_AMBIENCE = "rbxassetid://9112833822";
const PSE_DAWN_BIRDS = "rbxassetid://9116969481";
const PSE_FOOTSTEP_A = "rbxassetid://9114523345";
const PSE_FOOTSTEP_B = "rbxassetid://9114523358";

/** Roblox official free library — APM Music */
const APM_HEART_1 = "rbxassetid://9043365727";
const APM_HEART_2 = "rbxassetid://9043365842";
const APM_HEART_3 = "rbxassetid://9043365993";

// ---------------------------------------------------------------- catalogue

export const SOUNDS = {
	// --- guns: one shot per trigger. The magazine empties fast, so the voice budget is tight and the
	//     pitch wanders a little; without that a full magazine sounds like a machine.
	shotPistol: {
		id: PSE_PISTOL_A,
		bus: "sfx",
		category: "weapon",
		volume: 0.45,
		pitchMin: 0.95,
		pitchMax: 1.06,
		voices: 4,
		priority: 6,
		spatial: true,
		maxPlay: 0.9,
	},
	shotRifle: {
		id: PSE_PISTOL_B,
		bus: "sfx",
		category: "weapon",
		volume: 0.44,
		pitchMin: 0.84,
		pitchMax: 0.92,
		voices: 4,
		priority: 6,
		spatial: true,
		maxPlay: 0.9,
	},
	/** machine guns fire in long strings: quieter, fewer voices, so a burst does not wall off everything else */
	shotMg: {
		id: PSE_PISTOL_C,
		bus: "sfx",
		category: "weapon",
		volume: 0.32,
		pitchMin: 1.04,
		pitchMax: 1.14,
		voices: 3,
		priority: 5,
		spatial: true,
		maxPlay: 0.45,
	},
	/** "12 Gauge Shotgun 1" holds several blasts: maxPlay cuts it down to one */
	shotShotgun: {
		id: PSE_SHOTGUN,
		bus: "sfx",
		category: "weapon",
		volume: 0.5,
		pitchMin: 0.93,
		pitchMax: 1.03,
		voices: 3,
		priority: 7,
		spatial: true,
		maxPlay: 0.6,
	},
	shotSniper: {
		id: PSE_RIFLE,
		bus: "sfx",
		category: "weapon",
		volume: 0.5,
		pitchMin: 0.74,
		pitchMax: 0.8,
		voices: 2,
		priority: 7,
		spatial: true,
		maxPlay: 0.35,
	},
	/** arrow release: a dry whoosh, not a bang (bows are the quiet weapon of the daytime stealth) */
	shotBow: {
		id: RBX_SWOOSH,
		bus: "sfx",
		category: "weapon",
		volume: 0.3,
		pitchMin: 0.85,
		pitchMax: 1,
		voices: 3,
		priority: 4,
		spatial: true,
	},
	/** stun gun / chain lightning (LEG-02: yellow = electricity) */
	shotElectric: {
		id: `${ENGINE}electronicpingshort.wav`,
		bus: "sfx",
		category: "weapon",
		volume: 0.28,
		pitchMin: 0.7,
		pitchMax: 0.85,
		voices: 3,
		priority: 5,
		spatial: true,
	},
	meleeSwing: {
		id: RBX_SWORD_SLASH,
		bus: "sfx",
		category: "weapon",
		volume: 0.26,
		pitchMin: 0.9,
		pitchMax: 1.12,
		voices: 3,
		priority: 4,
		spatial: true,
	},
	meleeHit: {
		id: `${ENGINE}hit.wav`,
		bus: "sfx",
		category: "impact",
		volume: 0.3,
		pitchMin: 0.9,
		pitchMax: 1.1,
		voices: 3,
		priority: 5,
		spatial: true,
	},
	reloadStart: {
		id: `${ENGINE}metal.ogg`,
		bus: "sfx",
		category: "weapon",
		volume: 0.28,
		pitchMin: 1.15,
		pitchMax: 1.25,
		voices: 1,
		priority: 6,
		spatial: true,
	},
	reloadEnd: {
		id: `${ENGINE}snap.wav`,
		bus: "sfx",
		category: "weapon",
		volume: 0.3,
		pitchMin: 0.95,
		pitchMax: 1.05,
		voices: 1,
		priority: 6,
		spatial: true,
	},
	weaponSwitch: {
		id: `${ENGINE}unsheath.wav`,
		bus: "sfx",
		category: "weapon",
		volume: 0.22,
		pitchMin: 0.95,
		pitchMax: 1.05,
		voices: 1,
		priority: 4,
		spatial: true,
	},
	/** the dry click of an empty magazine (pairs with the "No ammo" HUD message) */
	emptyClick: {
		id: `${ENGINE}switch.wav`,
		bus: "sfx",
		category: "weapon",
		volume: 0.28,
		pitchMin: 1.25,
		pitchMax: 1.35,
		voices: 1,
		priority: 5,
		spatial: true,
	},

	// --- flesh, bodies, blasts
	hitFlesh: {
		id: `${ENGINE}splat.wav`,
		bus: "sfx",
		category: "impact",
		volume: 0.3,
		pitchMin: 0.85,
		pitchMax: 1.15,
		voices: 4,
		priority: 5,
		spatial: true,
	},
	zombieDeath: {
		id: `${ENGINE}uuhhh.mp3`,
		bus: "sfx",
		category: "creature",
		volume: 0.34,
		pitchMin: 0.6,
		pitchMax: 0.78,
		voices: 3,
		priority: 6,
		spatial: true,
	},
	/** idle growl of a zombie near the survivor: the horde has to be heard before it is seen */
	zombieGrowl: {
		id: PSE_GROWL_A,
		bus: "sfx",
		category: "creature",
		volume: 0.2,
		pitchMin: 0.78,
		pitchMax: 0.98,
		voices: 2,
		priority: 3,
		spatial: true,
		maxPlay: 1.6,
	},
	/** a zombie that just noticed the survivor */
	zombieAlert: {
		id: PSE_GROWL_B,
		bus: "sfx",
		category: "creature",
		volume: 0.26,
		pitchMin: 0.85,
		pitchMax: 1.05,
		voices: 2,
		priority: 4,
		spatial: true,
		maxPlay: 1.4,
	},
	bossRoar: {
		id: PSE_ROAR,
		bus: "sfx",
		category: "creature",
		volume: 0.45,
		pitchMin: 0.58,
		pitchMax: 0.68,
		voices: 1,
		priority: 9,
		spatial: true,
	},
	playerHurt: {
		id: `${ENGINE}uuhhh.mp3`,
		bus: "sfx",
		category: "creature",
		volume: 0.38,
		pitchMin: 1.05,
		pitchMax: 1.2,
		voices: 1,
		priority: 8,
	},
	playerDeath: {
		id: `${ENGINE}uuhhh.mp3`,
		bus: "sfx",
		category: "creature",
		volume: 0.45,
		pitchMin: 0.5,
		pitchMax: 0.55,
		voices: 1,
		priority: 10,
	},
	explosion: {
		id: `${ENGINE}impact_explosion_03.mp3`,
		bus: "sfx",
		category: "impact",
		volume: 0.55,
		pitchMin: 0.9,
		pitchMax: 1.1,
		voices: 2,
		priority: 9,
		spatial: true,
	},

	// --- world impacts (debris bursts)
	debrisWood: {
		id: `${ENGINE}collide.wav`,
		bus: "sfx",
		category: "impact",
		volume: 0.24,
		pitchMin: 0.9,
		pitchMax: 1.15,
		voices: 2,
		priority: 3,
		spatial: true,
	},
	debrisMetal: {
		id: `${ENGINE}metal.ogg`,
		bus: "sfx",
		category: "impact",
		volume: 0.24,
		pitchMin: 0.85,
		pitchMax: 1.15,
		voices: 2,
		priority: 3,
		spatial: true,
	},
	debrisGlass: {
		id: `${ENGINE}glassbreak.wav`,
		bus: "sfx",
		category: "impact",
		volume: 0.26,
		pitchMin: 0.95,
		pitchMax: 1.1,
		voices: 2,
		priority: 4,
		spatial: true,
	},

	// --- inventory
	pickupItem: {
		id: `${ENGINE}clickfast.wav`,
		bus: "sfx",
		category: "world",
		volume: 0.26,
		pitchMin: 0.95,
		pitchMax: 1.1,
		voices: 2,
		priority: 4,
	},
	pickupCoin: {
		id: `${ENGINE}electronicpingshort.wav`,
		bus: "sfx",
		category: "world",
		volume: 0.28,
		pitchMin: 1.05,
		pitchMax: 1.15,
		voices: 2,
		priority: 4,
	},
	craftDone: {
		id: `${ENGINE}switch3.wav`,
		bus: "sfx",
		category: "world",
		volume: 0.28,
		pitchMin: 0.95,
		pitchMax: 1.05,
		voices: 1,
		priority: 4,
	},

	// --- footsteps: the most repeated sound in the game (a survivor plants a foot about twice a second, and
	//     up to six of them are walking). So it is the quietest thing in the catalogue and the first to be
	//     dropped: priority 1 loses every voice dispute, and 3 voices each means a crowd can never take more
	//     than 6 of the 30. Two takes alternate, because ONE id repeated at that rate sounds like a metronome
	//     however far the pitch wanders.
	//     Both takes are "Foot Stomp ... Multiple": the file holds MORE THAN ONE stomp, like the shotgun
	//     (design/audio-credits.md, pendency A). maxPlay 0.22 s keeps the first one and nothing else — at two
	//     steps per second a second thump inside the same step would read as a limp.
	footstepA: {
		id: PSE_FOOTSTEP_A,
		bus: "sfx",
		category: "world",
		volume: 0.16,
		pitchMin: 0.92,
		pitchMax: 1.08,
		voices: 3,
		priority: 1,
		spatial: true,
		maxPlay: 0.22,
	},
	footstepB: {
		id: PSE_FOOTSTEP_B,
		bus: "sfx",
		category: "world",
		volume: 0.15,
		pitchMin: 0.9,
		pitchMax: 1.04,
		voices: 3,
		priority: 1,
		spatial: true,
		maxPlay: 0.22,
	},
	// --- UI (short, discreet, never a surprise)
	uiClick: {
		id: `${ENGINE}button.wav`,
		bus: "ui",
		category: "ui",
		volume: 0.3,
		pitchMin: 0.98,
		pitchMax: 1.04,
		voices: 2,
		priority: 5,
	},
	uiHover: {
		id: `${ENGINE}switch.wav`,
		bus: "ui",
		category: "ui",
		volume: 0.11,
		pitchMin: 1.2,
		pitchMax: 1.3,
		voices: 1,
		priority: 2,
	},
	uiOpen: {
		id: `${ENGINE}switch3.wav`,
		bus: "ui",
		category: "ui",
		volume: 0.24,
		pitchMin: 1,
		pitchMax: 1.06,
		voices: 1,
		priority: 5,
	},
	uiClose: {
		id: `${ENGINE}switch3.wav`,
		bus: "ui",
		category: "ui",
		volume: 0.22,
		pitchMin: 0.82,
		pitchMax: 0.88,
		voices: 1,
		priority: 5,
	},
	uiBuy: {
		id: `${ENGINE}victory.wav`,
		bus: "ui",
		category: "ui",
		volume: 0.32,
		pitchMin: 1,
		pitchMax: 1,
		voices: 1,
		priority: 7,
	},
	uiError: {
		id: `${ENGINE}bass.wav`,
		bus: "ui",
		category: "ui",
		volume: 0.3,
		pitchMin: 0.95,
		pitchMax: 1,
		voices: 1,
		priority: 7,
	},

	// --- music, ambience and stingers
	/** night bed: comes in with the dark, goes out at dawn (short crossfade) */
	bgmNight: {
		id: PSE_NIGHT_BED,
		bus: "bgm",
		category: "music",
		volume: 0.45,
		pitchMin: 1,
		pitchMax: 1,
		voices: 1,
		priority: 10,
		loop: true,
	},
	/**
	 * Daytime ambience: a small American town a few days into the outbreak — birds, air, NO traffic
	 * (DESIGN_RULES §1). By day there is no music, only this.
	 */
	ambDay: {
		id: PSE_DAY_AMBIENCE,
		bus: "bgm",
		category: "ambient",
		volume: 0.34,
		pitchMin: 1,
		pitchMax: 1,
		voices: 1,
		priority: 10,
		loop: true,
	},
	/** extra bird layer for the first hours after dawn */
	ambDawn: {
		id: PSE_DAWN_BIRDS,
		bus: "bgm",
		category: "ambient",
		volume: 0.22,
		pitchMin: 1,
		pitchMax: 1,
		voices: 1,
		priority: 10,
		loop: true,
	},
	heartbeat1: {
		id: APM_HEART_1,
		bus: "bgm",
		category: "music",
		volume: 0.36,
		pitchMin: 1,
		pitchMax: 1,
		voices: 1,
		priority: 10,
		loop: true,
	},
	heartbeat2: {
		id: APM_HEART_2,
		bus: "bgm",
		category: "music",
		volume: 0.44,
		pitchMin: 1.18,
		pitchMax: 1.18,
		voices: 1,
		priority: 10,
		loop: true,
	},
	heartbeat3: {
		id: APM_HEART_3,
		bus: "bgm",
		category: "music",
		volume: 0.5,
		pitchMin: 1.4,
		pitchMax: 1.4,
		voices: 1,
		priority: 10,
		loop: true,
	},
	/** wave 1 (19h), wave 2 (22h), wave 3 (1h): same take, lower and heavier every time */
	stingerWave1: {
		id: RBX_THUNDER,
		bus: "bgm",
		category: "music",
		volume: 0.3,
		pitchMin: 1,
		pitchMax: 1,
		voices: 1,
		priority: 10,
	},
	stingerWave2: {
		id: RBX_THUNDER,
		bus: "bgm",
		category: "music",
		volume: 0.33,
		pitchMin: 0.9,
		pitchMax: 0.9,
		voices: 1,
		priority: 10,
	},
	stingerWave3: {
		id: RBX_THUNDER,
		bus: "bgm",
		category: "music",
		volume: 0.36,
		pitchMin: 0.78,
		pitchMax: 0.78,
		voices: 1,
		priority: 10,
	},
	/** you made it to 7:00 */
	stingerDawn: {
		id: `${ENGINE}victory.wav`,
		bus: "bgm",
		category: "music",
		volume: 0.24,
		pitchMin: 1,
		pitchMax: 1,
		voices: 1,
		priority: 10,
	},
} satisfies Record<string, SoundDef>;

export type SoundName = keyof typeof SOUNDS;

/**
 * `satisfies` above keeps the keys exact (so SoundName is the real list), but it also narrows every entry
 * to its own literal shape, where the optional fields simply do not exist. This view widens them back to
 * SoundDef so the mixer can read `loop` / `spatial` / `maxPlay` off any entry.
 */
const CATALOGUE = SOUNDS as Record<SoundName, SoundDef>;

/** the definition of `name`, or undefined when the slot does not exist */
export function soundDef(name: SoundName): SoundDef | undefined {
	return CATALOGUE[name];
}

/** an empty slot (id "") is silent on purpose: no asset was found that the game may legally use */
export function isSilentSlot(def: SoundDef): boolean {
	return def.id === "";
}

/** every distinct asset the catalogue references (for ContentProvider:PreloadAsync at boot) */
export function soundAssetIds(): Array<string> {
	const seen = new Set<string>();
	const ids: Array<string> = [];
	for (const [, entry] of pairs(SOUNDS)) {
		const def = entry as SoundDef;
		if (def.id === "" || seen.has(def.id)) continue;
		seen.add(def.id);
		ids.push(def.id);
	}
	return ids;
}
