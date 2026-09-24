/*
 * Sound catalogue: logical name -> asset, base volume, pitch range, voice budget, bus.
 *
 * Rules (design/audio-credits.md has the licence table and the calibration):
 *  - Only audio the game may legally ship: engine content (`rbxasset://sounds/*`, shipped with the Roblox
 *    client) and assets from Roblox's own free library (Pro Sound Effects / APM Music, "courtesy of" the
 *    official catalogue, free for use inside experiences). Every id in here was checked: the first ones loaded in
 *    Studio, the P0-4 ones (horde voice, bite, doors, item use, flamethrower, motorcycle) through Roblox's public
 *    asset details (creator ProSoundEffects, IsPublicDomain) and downloaded and decoded from the asset delivery --
 *    which a private audio refuses (design/audio-credits.md, "Como cada id foi verificado").
 *  - `id: ""` is a legal, expected state: an empty slot plays NOTHING (silent fallback). Never fill a slot
 *    with audio of doubtful origin just to avoid the silence.
 *  - `volume` is the base level BEFORE the bus gain (the Settings sliders). Keep every one of them <= 0.6:
 *    the player must never be hit by a sudden loud sound.
 *  - OUR OWN SOUNDS (DESIGN_RULES SND-01): the UI, the pickups, the weapons, the impacts, the footsteps and the cues are
 *    also synthesised by tools/gen-sfx.mjs into five banks (design/audio/). An event with a take in a bank that has an
 *    asset id (the generated ./audioAssets.ts, `npm run cloud -- upload-audio`) plays OUR take -- a window of the bank
 *    -- with the volume and pitch range the generator gave it; without the id, or once the client failed to load that
 *    bank (`dropSoundAsset`), it plays the library take below exactly as before. The library entry is the fallback
 *    and keeps the event's role (bus, voices, priority, range, spatial) in both cases.
 *
 * This file is data only: no Instances, no services. The client mixer (client/audio/audio.ts) reads it.
 */
import { AUDIO_BANK_IDS, SYNTH_SOUNDS } from "./audioAssets";

/** mixer bus; each one is a SoundGroup driven by a Settings slider */
export type SoundBus = "sfx" | "ui" | "bgm";

/** a window of the file: where it starts and how long it plays, in seconds OF THE FILE (whatever the pitch) */
export interface SoundTake {
	readonly startAt: number;
	readonly maxPlay: number;
}

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
	/**
	 * World units at which THIS sound is silent, when it should not carry as far as the rest (default:
	 * AUDIO_RANGE). A footstep is not a gunshot: it has to die within a street, and the engine has to be the
	 * one to do it -- a second curve applied by the caller on top of the engine's attenuates twice, which is
	 * how footsteps ended up at 0.44 where they should have been at 0.59.
	 */
	range?: number;
	/** positioned in the 2D world (volume + stereo side by distance to the camera) */
	spatial?: boolean;
	/** skip this many seconds of the file (room tone before the take) */
	startAt?: number;
	/**
	 * Play this many seconds OF THE FILE, then stop. Some library takes hold SEVERAL shots in one file
	 * ("Multiple Shots" / "Various Shot Bursts"): a short window turns one of them into a single shot. It is file time:
	 * at PlaybackSpeed 0.6 the window lasts 1/0.6 as long in real time (the mixer sets Sound.PlaybackRegion, and its own
	 * deadline divides by the speed) -- a real-time cut would chop a pitched-down groan and let a pitched-up one run
	 * into the next phrase of the same file.
	 */
	maxPlay?: number;
	/**
	 * Round-robin windows of the file (our own banks: several takes of one event): each trigger plays one of them,
	 * never the one it played last. Overrides startAt / maxPlay.
	 */
	takes?: ReadonlyArray<SoundTake>;
	/** each trigger's volume is scaled by 1 - random * volJitter (0..1): repeats never land at the same level */
	volJitter?: number;
	/**
	 * The same sound again sooner than this (seconds) is the same event heard twice -- eight pellets, ten deaths in one
	 * blast, two allies' steps in one frame -- and is dropped: identical samples started together only add up to a
	 * louder, phasier copy. Default MIN_GAP (client/audio/audio.ts).
	 */
	minGap?: number;
	/** where the asset comes from: the official library (the default) or our own synthesised bank */
	source?: "library" | "synth";
	/**
	 * A held loop (client/audio/audio.ts `holdLoop`: an engine, a flamethrower) repeats only this window of the file,
	 * in seconds (Sound.LoopRegion): a library take is a whole recording -- start, idle, revs, off -- and the steady
	 * stretch is the only part that loops.
	 */
	loopStart?: number;
	loopEnd?: number;
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
const PSE_ROAR = "rbxassetid://9114628818";
/** the horde's voice (P0-4): human takes of the library's "Voices" categories, not the robot of before */
const PSE_TRACHEOTOMY = "rbxassetid://9120231499";
const PSE_GROSS_BREATH = "rbxassetid://9114663862";
const PSE_GOBLIN_GRUNT = "rbxassetid://9114625030";
const PSE_GOBLIN_ROAR = "rbxassetid://9114624779";
const PSE_MONSTER_SNARL = "rbxassetid://9116968474";
const PSE_CREATURE_ATTACK = "rbxassetid://9113989593";
const PSE_BUG_CHOMP = "rbxassetid://9114574294";
/** doors, the survivor's hands, the flamethrower, the motorcycle */
const PSE_DOOR_CREAK = "rbxassetid://9120839599";
const PSE_DOOR_SHUT = "rbxassetid://9120839870";
const PSE_IRON_CREAK = "rbxassetid://9116841392";
const PSE_IRON_SLAM = "rbxassetid://9116835170";
const PSE_APPLE_CHEW = "rbxassetid://9113138343";
const PSE_CLOTH_RIP = "rbxassetid://9113827650";
const PSE_BAG_ZIPPER = "rbxassetid://9113260699";
const PSE_RATTLE = "rbxassetid://9114074235";
const PSE_TORCH_FLAME = "rbxassetid://9120192302";
const PSE_FIRE_BURST = "rbxassetid://9117988736";
const PSE_KART_EXHAUST = "rbxassetid://9112787824";
const PSE_MOTO_HORN = "rbxassetid://9120383448";
const PSE_BIKE_BELL = "rbxassetid://9125390319";
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
		volJitter: 0.12,
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
		volJitter: 0.12,
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
		volJitter: 0.12,
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
		volJitter: 0.12,
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
		volJitter: 0.12,
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
		volJitter: 0.1,
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
		volJitter: 0.15,
		minGap: 0.05,
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
		volJitter: 0.1,
		minGap: 0.08,
	},
	// --- the horde's voice (P0-4). Four idle groans and two snarls, each a window of a HUMAN take of the library's
	//     voice categories (a tracheotomy voice's gurgling grunts, a creature's wet breathing, a performer's growl):
	//     the "Goliath" robot voice of before is gone. client/audio/gameAudio.ts picks them without repeating the last,
	//     bends the pitch by the zombie's type and meters them through one budget, so a horde of 60 is a few voices
	//     and never a wall of them. Every one of them is spatial: the groan says WHERE the horde is.
	/** a gurgling grunt with a laboured breath (Tracheotomy Voice 1, 1.08-3.13 s) */
	zombieGroanA: {
		id: PSE_TRACHEOTOMY,
		bus: "sfx",
		category: "creature",
		volume: 0.26,
		pitchMin: 0.88,
		pitchMax: 1,
		voices: 2,
		priority: 3,
		spatial: true,
		startAt: 1.08,
		maxPlay: 2.05,
		volJitter: 0.15,
	},
	/** the same voice's short choke (3.46-4.36 s) */
	zombieGroanB: {
		id: PSE_TRACHEOTOMY,
		bus: "sfx",
		category: "creature",
		volume: 0.24,
		pitchMin: 0.9,
		pitchMax: 1.02,
		voices: 2,
		priority: 3,
		spatial: true,
		startAt: 3.46,
		maxPlay: 0.9,
		volJitter: 0.15,
	},
	/** wet, heavy breathing through the nose: the idle zombie that is only standing there */
	zombieGroanC: {
		id: PSE_GROSS_BREATH,
		bus: "sfx",
		category: "creature",
		volume: 0.22,
		pitchMin: 0.8,
		pitchMax: 0.92,
		voices: 2,
		priority: 3,
		spatial: true,
		startAt: 0.15,
		maxPlay: 1.95,
		volJitter: 0.15,
	},
	/** a low grunt (Goblin Growl 9, a human-made growl), pitched down to a groan */
	zombieGroanD: {
		id: PSE_GOBLIN_GRUNT,
		bus: "sfx",
		category: "creature",
		volume: 0.2,
		pitchMin: 0.72,
		pitchMax: 0.82,
		voices: 2,
		priority: 3,
		spatial: true,
		maxPlay: 1.1,
		volJitter: 0.15,
	},
	/** a zombie that just saw the survivor: a snarl (Monster Vocals 12) */
	zombieAggroA: {
		id: PSE_MONSTER_SNARL,
		bus: "sfx",
		category: "creature",
		volume: 0.3,
		pitchMin: 0.86,
		pitchMax: 1,
		voices: 2,
		priority: 4,
		spatial: true,
		startAt: 0.3,
		maxPlay: 1.05,
	},
	/** the other one: a rising growl (Goblin Growl 6) */
	zombieAggroB: {
		id: PSE_GOBLIN_ROAR,
		bus: "sfx",
		category: "creature",
		volume: 0.28,
		pitchMin: 0.82,
		pitchMax: 0.94,
		voices: 2,
		priority: 4,
		spatial: true,
		startAt: 0.12,
		maxPlay: 1.65,
	},
	/** a group turning on you at once (IA-03's shout): one scream for all of them (Creature Vocals 1, 2.28-4.03 s) */
	zombieShout: {
		id: PSE_CREATURE_ATTACK,
		bus: "sfx",
		category: "creature",
		volume: 0.32,
		pitchMin: 0.9,
		pitchMax: 1,
		voices: 1,
		priority: 5,
		spatial: true,
		startAt: 2.28,
		maxPlay: 1.75,
	},
	/**
	 * The bite (LEG-04): the server says it landed (FxType.Sound, shared/net/fxWire.ts WIRE_SOUNDS), at the survivor it
	 * landed on -- yours or an ally's. A wet crunch (Giant Bug Chomps 3, 0.2-0.9 s), the most important sound of the game.
	 */
	bite: {
		id: PSE_BUG_CHOMP,
		bus: "sfx",
		category: "creature",
		volume: 0.42,
		pitchMin: 0.9,
		pitchMax: 1.08,
		voices: 2,
		priority: 8,
		spatial: true,
		startAt: 0.2,
		maxPlay: 0.7,
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
		minGap: 0.12,
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
		volJitter: 0.15,
		minGap: 0.06,
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
		volJitter: 0.15,
		minGap: 0.06,
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
		volJitter: 0.15,
		minGap: 0.06,
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
		minGap: 0.08,
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
	// --- what was picked up, by kind (client/systems/pickups.ts `lastPickupKind`): ammo, food and materials each have
	//     their own sound in our bank; until it has an id they fall back on the pickup click, pitched apart
	pickupAmmo: {
		id: `${ENGINE}clickfast.wav`,
		bus: "sfx",
		category: "world",
		volume: 0.26,
		pitchMin: 1.15,
		pitchMax: 1.25,
		voices: 2,
		priority: 4,
		minGap: 0.08,
	},
	pickupFood: {
		id: `${ENGINE}clickfast.wav`,
		bus: "sfx",
		category: "world",
		volume: 0.26,
		pitchMin: 0.82,
		pitchMax: 0.9,
		voices: 2,
		priority: 4,
		minGap: 0.08,
	},
	pickupMaterial: {
		id: `${ENGINE}clickfast.wav`,
		bus: "sfx",
		category: "world",
		volume: 0.26,
		pitchMin: 0.7,
		pitchMax: 0.76,
		voices: 2,
		priority: 4,
		minGap: 0.08,
	},
	/** the survivor levelled up (main.client.ts, with the "Level UP" message) */
	levelUp: {
		id: `${ENGINE}victory.wav`,
		bus: "ui",
		category: "ui",
		volume: 0.3,
		pitchMin: 1.12,
		pitchMax: 1.12,
		voices: 1,
		priority: 7,
	},
	/** a construction set down (client/systems/build.ts), and one refused where the ghost is red */
	buildPlace: {
		id: `${ENGINE}snap.wav`,
		bus: "sfx",
		category: "world",
		volume: 0.3,
		pitchMin: 0.72,
		pitchMax: 0.8,
		voices: 1,
		priority: 5,
	},
	buildDeny: {
		id: `${ENGINE}bass.wav`,
		bus: "ui",
		category: "ui",
		volume: 0.26,
		pitchMin: 1.2,
		pitchMax: 1.25,
		voices: 1,
		priority: 6,
		minGap: 0.25,
	},

	// --- doors (EDI-13: the doors a survivor builds, and the doors of the map), played where the server says the door
	//     turned (FxType.Sound). The takes are quiet foley, hence the higher base volumes; a door does not carry past a
	//     street (range).
	doorOpen: {
		id: PSE_DOOR_CREAK,
		bus: "sfx",
		category: "world",
		volume: 0.5,
		pitchMin: 0.94,
		pitchMax: 1.06,
		voices: 2,
		priority: 4,
		spatial: true,
		range: 1100,
		startAt: 0.55,
		maxPlay: 1.3,
	},
	doorClose: {
		id: PSE_DOOR_SHUT,
		bus: "sfx",
		category: "world",
		volume: 0.5,
		pitchMin: 0.94,
		pitchMax: 1.06,
		voices: 2,
		priority: 4,
		spatial: true,
		range: 1100,
		startAt: 0.95,
		maxPlay: 0.8,
	},
	ironDoorOpen: {
		id: PSE_IRON_CREAK,
		bus: "sfx",
		category: "world",
		volume: 0.5,
		pitchMin: 0.92,
		pitchMax: 1.02,
		voices: 2,
		priority: 4,
		spatial: true,
		range: 1100,
		startAt: 0.68,
		maxPlay: 0.9,
	},
	ironDoorClose: {
		id: PSE_IRON_SLAM,
		bus: "sfx",
		category: "world",
		volume: 0.3,
		pitchMin: 0.92,
		pitchMax: 1.02,
		voices: 2,
		priority: 4,
		spatial: true,
		range: 1100,
		maxPlay: 1,
	},

	// --- using a usable (USABLES): the server accepted it (FxType.Sound at the survivor). Heard by whoever stands
	//     near: a meal or a bandage is not a secret, and the range keeps it within a room.
	useEat: {
		id: PSE_APPLE_CHEW,
		bus: "sfx",
		category: "world",
		volume: 0.36,
		pitchMin: 0.92,
		pitchMax: 1.08,
		voices: 1,
		priority: 5,
		spatial: true,
		range: 700,
		maxPlay: 1.45,
	},
	useBandage: {
		id: PSE_CLOTH_RIP,
		bus: "sfx",
		category: "world",
		volume: 0.34,
		pitchMin: 0.94,
		pitchMax: 1.06,
		voices: 1,
		priority: 5,
		spatial: true,
		range: 700,
		maxPlay: 0.6,
	},
	/** the first aid kit: its bag unzipped */
	useMedkit: {
		id: PSE_BAG_ZIPPER,
		bus: "sfx",
		category: "world",
		volume: 0.3,
		pitchMin: 0.95,
		pitchMax: 1.05,
		voices: 1,
		priority: 5,
		spatial: true,
		range: 700,
		maxPlay: 0.8,
	},
	/** pain killer, sedative: the pills rattling (a dice rattle stands in for the bottle: no pill take in the library) */
	usePills: {
		id: PSE_RATTLE,
		bus: "sfx",
		category: "world",
		volume: 0.5,
		pitchMin: 1.05,
		pitchMax: 1.15,
		voices: 1,
		priority: 5,
		spatial: true,
		range: 700,
		startAt: 0.3,
		maxPlay: 1.2,
	},
	/**
	 * The adrenaline injection. EMPTY in the library on purpose: the official libraries have no syringe or injection
	 * take ("syringe", "injection", "needle" find pressure blasts and robots), and no upload of doubtful origin is
	 * allowed (design/audio-credits.md, pendency D). OUR bank has one (tools/gen-sfx.mjs `useInject`: a snap, a hiss,
	 * a tink): silent until the "impacts" bank is uploaded, heard from then on.
	 */
	useInject: {
		id: "",
		bus: "sfx",
		category: "world",
		volume: 0.34,
		pitchMin: 1,
		pitchMax: 1,
		voices: 1,
		priority: 5,
		spatial: true,
		range: 700,
	},

	// --- the flamethrower (weapons.ts id 25): a steady jet held while it fires (a looped window of a torch's flame,
	//     pitched down to a roar) and a burst when it lights. The stun gun keeps shotElectric.
	flameLoop: {
		id: PSE_TORCH_FLAME,
		bus: "sfx",
		category: "weapon",
		volume: 0.55,
		pitchMin: 0.55,
		pitchMax: 0.55,
		voices: 1,
		priority: 6,
		spatial: true,
		loop: true,
		loopStart: 1.5,
		loopEnd: 8.5,
	},
	flameIgnite: {
		id: PSE_FIRE_BURST,
		bus: "sfx",
		category: "weapon",
		volume: 0.36,
		pitchMin: 0.85,
		pitchMax: 1,
		voices: 2,
		priority: 6,
		spatial: true,
	},

	// --- the motorcycle (VEI-05): the engine is a held loop -- the idle of a twin-cylinder four-stroke (Go Kart Exhaust
	//     Constant 1, 28.5-42.5 s) whose pitch and level follow the speed (gameAudio.ts) -- and the horn; the bicycle
	//     has its bell. The horn and the bell are the server's (FxType.Sound), like the noise the horde hears.
	engineMoto: {
		id: PSE_KART_EXHAUST,
		bus: "sfx",
		category: "world",
		volume: 0.42,
		pitchMin: 1,
		pitchMax: 1,
		voices: 1,
		priority: 7,
		spatial: true,
		loop: true,
		loopStart: 28.5,
		loopEnd: 42.5,
	},
	hornMoto: {
		id: PSE_MOTO_HORN,
		bus: "sfx",
		category: "world",
		volume: 0.4,
		pitchMin: 0.98,
		pitchMax: 1.02,
		voices: 2,
		priority: 7,
		spatial: true,
		maxPlay: 0.5,
	},
	bellBike: {
		id: PSE_BIKE_BELL,
		bus: "sfx",
		category: "world",
		volume: 0.34,
		pitchMin: 0.98,
		pitchMax: 1.04,
		voices: 2,
		priority: 6,
		spatial: true,
		range: 1100,
		startAt: 0.22,
		maxPlay: 0.6,
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
		range: 900,
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
		volJitter: 0.2,
	},
	footstepB: {
		range: 900,
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
		volJitter: 0.2,
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
	/**
	 * A storm's thunderclap (LUZ-05, client/audio/gameAudio.ts): heard where the flash was (everywhere: it is the sky),
	 * its delay after the flash the strike's distance and its level how close it fell. While it rolls it covers every
	 * other noise for the horde (shared/sim/weather.ts THUNDER_MASK_S): the storm's tactical window. The library take is
	 * the classic library's thunder the night stingers use; ours is synthesised (tools/gen-sfx.mjs `thunder`).
	 */
	thunder: {
		id: RBX_THUNDER,
		bus: "sfx",
		category: "world",
		volume: 0.42,
		pitchMin: 0.92,
		pitchMax: 1.05,
		voices: 2,
		priority: 7,
		minGap: 2,
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

/** bank asset ids this client could not load (preload): their events are back on the library for the session */
const droppedIds = new Set<string>();

/**
 * What `name` plays now: our own take when its bank has an id this client did not give up on, the library entry
 * otherwise. The role (bus, voices, priority, range, spatial, minGap) is always the library entry's.
 */
function resolve(name: SoundName): SoundDef {
	const lib = CATALOGUE[name];
	const synth = SYNTH_SOUNDS[name];
	if (synth === undefined) return lib;
	const id = AUDIO_BANK_IDS[synth.bank];
	if (id === undefined || id === "" || droppedIds.has(id)) return lib;
	const looped = synth.loopStart !== undefined && synth.loopEnd !== undefined;
	return {
		...lib,
		id,
		source: "synth",
		volume: synth.volume,
		pitchMin: synth.pitchMin,
		pitchMax: synth.pitchMax,
		// a bank is many sounds: a one-shot plays one of its windows, a loop repeats its own region
		startAt: undefined,
		maxPlay: undefined,
		takes: looped ? undefined : synth.takes,
		loopStart: looped ? synth.loopStart : undefined,
		loopEnd: looped ? synth.loopEnd : undefined,
	};
}

/**
 * The resolved catalogue, one entry per name the first time it is asked for (nothing iterates the table at load),
 * forgotten only when a bank is dropped: never an allocation per trigger.
 */
const RESOLVED = new Map<SoundName, SoundDef>();

/** the definition of `name` as it plays now (ours or the library's), or undefined when the slot does not exist */
export function soundDef(name: SoundName): SoundDef | undefined {
	let def = RESOLVED.get(name);
	if (def === undefined) {
		if (CATALOGUE[name] === undefined) return undefined;
		def = resolve(name);
		RESOLVED.set(name, def);
	}
	return def;
}

/** the library entry of `name`, whatever plays now (the fallback; tests and the credits) */
export function librarySoundDef(name: SoundName): SoundDef | undefined {
	return CATALOGUE[name];
}

let names: Array<SoundName> | undefined;

/** every event of the catalogue (built on first use) */
export function soundNames(): ReadonlyArray<SoundName> {
	if (names === undefined) {
		const out: Array<SoundName> = [];
		for (const [name] of pairs(SOUNDS)) out.push(name as SoundName);
		names = out;
	}
	return names;
}

/**
 * The client could not load `id` (client/audio/audio.ts preloadSounds). If it is one of our banks, every event on it
 * goes back to its library take for the rest of the session -- a sound that does not load must not become a silence
 * (SND-01, as ART-01 does for a texture). Answers whether anything changed.
 */
export function dropSoundAsset(id: string): boolean {
	if (id === "" || droppedIds.has(id)) return false;
	let bank = false;
	for (const [, bankId] of pairs(AUDIO_BANK_IDS)) {
		if (bankId === id) bank = true;
	}
	if (!bank) return false;
	droppedIds.add(id);
	RESOLVED.clear();
	return true;
}

/** resolves every entry again on its next use (tests that hand the banks ids; a reloaded ./audioAssets) */
export function refreshSounds(): void {
	RESOLVED.clear();
}

/** an empty slot (id "") is silent on purpose: no asset was found that the game may legally use */
export function isSilentSlot(def: SoundDef): boolean {
	return def.id === "";
}

/** every distinct asset the catalogue plays now (for ContentProvider:PreloadAsync at boot) */
export function soundAssetIds(): Array<string> {
	const seen = new Set<string>();
	const ids: Array<string> = [];
	for (const name of soundNames()) {
		const def = soundDef(name);
		if (def === undefined || def.id === "" || seen.has(def.id)) continue;
		seen.add(def.id);
		ids.push(def.id);
	}
	return ids;
}
