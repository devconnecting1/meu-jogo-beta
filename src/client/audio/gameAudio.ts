/*
 * Run audio: what the world sounds like.
 *
 * Where the events come from
 *  - `refs.fx` is read once per frame (fxAudio.drainFxAudio) for everything the channel still carries when
 *    the frame reaches the view. Today `GameLoop.playFx` clears the channel inside `update()`, so most
 *    combat events never reach a reader outside the loop.
 *  - So the rest is DERIVED from the very state those events describe, in the same before/after window
 *    main.client.ts already uses for achievements: a magazine that lost a round is a shot, a zombie whose
 *    hp fell is a hit, one that reached 0 is a death, a survivor whose hp fell was hurt. No system is
 *    touched, nothing is guessed: the numbers are the simulation's own.
 *  - The day this reads events instead, call `setFxAudioMode("full")` and the watcher below steps aside.
 *
 * Everything positional is played at its world position and spatialised by audio.ts against the camera.
 */
import { WeaponKind } from "shared/data/kinds";
import type { SoundName } from "shared/data/sounds";
import { currentWeapon } from "shared/game/player";
import { CLOCK_ANNOUNCEMENTS } from "shared/sim/clock";
import type { GameRefs } from "../systems/types";
import { audio, AUDIO_RANGE } from "./audio";
import { drainFxAudio, fxAudioMode } from "./fxAudio";
import { GameMusic } from "./music";

/** at most this many shot voices from one frame (a machine gun must not eat the whole pool) */
const MAX_SHOTS_PER_FRAME = 2;
/** seconds between two "a zombie noticed you" growls, however many noticed */
const ALERT_COOLDOWN = 1.2;
/** seconds between two melee swing sounds (the chainsaw holds its swing flag down) */
const SWING_COOLDOWN = 0.22;
/** random seconds between two ambient growls of the nearby horde */
const GROWL_MIN = 3;
const GROWL_MAX = 7;
/** a craft plays its own sound: ignore the inventory growth it causes for this long */
const CRAFT_MUTE = 0.25;

interface ZombieSnap {
	hp: number;
	x: number;
	y: number;
	detect: boolean;
}

/** which shot is heard for a weapon kind */
function shotSound(kind: WeaponKind): SoundName {
	if (kind === WeaponKind.Shotgun) return "shotShotgun";
	if (kind === WeaponKind.Sniper) return "shotSniper";
	if (kind === WeaponKind.MG) return "shotMg";
	if (kind === WeaponKind.Rifle) return "shotRifle";
	if (kind === WeaponKind.Bow) return "shotBow";
	if (kind === WeaponKind.Special) return "shotElectric";
	return "shotPistol";
}

/** total items held: a jump means something was picked up (loot, a search, a craft) */
function inventoryCount(refs: GameRefs): number {
	const s = refs.save;
	let n = s.ammoNormal + s.ammoShotgun + s.ammoMachinegun + s.ammoArrow + s.oil + s.electric;
	for (const v of s.invenUse) n += v;
	for (const v of s.invenEtc) n += v;
	return n;
}

export class GameAudio {
	readonly music = new GameMusic();

	private zombies = new Map<number, ZombieSnap>();
	private bosses = new Map<number, number>();
	private prevHp = 0;
	private prevAmmo = 0;
	private prevPointer = -1;
	private prevReloading = false;
	private prevSwing = false;
	private prevDead = false;
	private prevBlasts = 0;
	private prevItems = 0;
	private alertCd = 0;
	private swingCd = 0;
	private growlCd = GROWL_MIN;
	private craftMute = 0;
	private running = false;

	// ------------------------------------------------------------ run lifecycle

	/** a run is on screen: take the first snapshot so the first frame does not fire everything at once */
	startRun(refs: GameRefs): void {
		this.running = true;
		this.zombies.clear();
		this.bosses.clear();
		this.prevBlasts = refs.explosions?.size() ?? 0;
		this.prevItems = inventoryCount(refs);
		this.alertCd = 0;
		this.swingCd = 0;
		this.growlCd = GROWL_MIN;
		this.craftMute = 0;
		this.snapshot(refs);
	}

	/** back to the menus / game over: the run stops being heard */
	stopRun(): void {
		this.running = false;
		this.music.stop();
		audio.stopAll();
	}

	// ------------------------------------------------------------ per frame

	/** before GameLoop.update: remember what the simulation is about to change */
	beforeUpdate(refs: GameRefs): void {
		if (!this.running) return;
		this.snapshot(refs);
	}

	/** after GameLoop.update: everything that changed becomes a sound */
	afterUpdate(refs: GameRefs, dt: number): void {
		if (!this.running) return;
		this.alertCd = math.max(0, this.alertCd - dt);
		this.swingCd = math.max(0, this.swingCd - dt);
		this.craftMute = math.max(0, this.craftMute - dt);
		this.playerSounds(refs);
		this.weaponSounds(refs);
		this.zombieSounds(refs);
		this.bossSounds(refs);
		this.worldSounds(refs);
		this.ambientGrowl(refs, dt);
	}

	/**
	 * Every frame, simulated or not: keeps the listener on the camera, plays whatever is left in `refs.fx`
	 * and drives the music. Call it right before GameLoop.render().
	 */
	frame(refs: GameRefs, camX: number, camY: number): void {
		audio.setListener(camX, camY);
		drainFxAudio(refs.fx);
		if (!this.running) return;
		const p = refs.player;
		const dn = refs.daynight;
		this.music.update({
			isNight: dn.isNight,
			dayTime: dn.dayTime,
			hpRatio: p.hpMax > 0 ? p.hp / p.hpMax : 0,
			dead: p.dead,
		});
	}

	// ------------------------------------------------------------ hooks main.client owns

	/** every HUD message of the run passes here (refs.onMessage): the clock announcements are stingers */
	onMessage(text: string): void {
		if (!this.running) return;
		for (let i = 0; i < CLOCK_ANNOUNCEMENTS.size(); i++) {
			const a = CLOCK_ANNOUNCEMENTS[i];
			if (a.text !== text) continue;
			if (a.morning) this.music.dawnStinger();
			else this.music.waveStinger(i + 1);
			return;
		}
	}

	/** the survivor pulled the trigger with nothing left */
	emptyMagazine(refs: GameRefs): void {
		if (!this.running) return;
		audio.play("emptyClick", { x: refs.player.x, y: refs.player.y });
	}

	/** a recipe was crafted (the backpack calls it); coins are covered by the toast hook in uiAudio */
	crafted(): void {
		this.craftMute = CRAFT_MUTE;
		audio.play("craftDone");
	}

	// ------------------------------------------------------------ internals

	private snapshot(refs: GameRefs): void {
		const p = refs.player;
		const rt = p.weapon;
		this.prevHp = p.hp;
		this.prevAmmo = rt.ammoCount;
		this.prevPointer = rt.pointer;
		this.prevReloading = rt.reloading;
		this.prevSwing = p.swingerActive;
		this.prevDead = p.dead;
		this.zombies.clear();
		for (const z of refs.zombies) {
			if (z.hp > 0) this.zombies.set(z.id, { hp: z.hp, x: z.x, y: z.y, detect: z.detect });
		}
		this.bosses.clear();
		for (const b of refs.bosses) {
			if (!b.dead) this.bosses.set(b.id, b.hp);
		}
	}

	private playerSounds(refs: GameRefs): void {
		const p = refs.player;
		if (p.dead && !this.prevDead) {
			audio.play("playerDeath");
			return;
		}
		if (!p.dead && p.hp < this.prevHp - 0.01) audio.play("playerHurt");
	}

	private weaponSounds(refs: GameRefs): void {
		const p = refs.player;
		const rt = p.weapon;
		if (rt.pointer !== this.prevPointer) {
			audio.play("weaponSwitch", { x: p.x, y: p.y });
			return;
		}
		if (rt.reloading && !this.prevReloading) {
			audio.play("reloadStart", { x: p.x, y: p.y });
		} else if (!rt.reloading && this.prevReloading && rt.ammoCount > this.prevAmmo) {
			audio.play("reloadEnd", { x: p.x, y: p.y });
		}
		const w = currentWeapon(p);
		if (w.kind === WeaponKind.Melee) {
			if (p.swingerActive && !this.prevSwing && this.swingCd <= 0) {
				this.swingCd = SWING_COOLDOWN;
				audio.play("meleeSwing", { x: p.x, y: p.y });
			}
			return;
		}
		if (fxAudioMode() === "full") return; // the tracer events carry the shots instead
		if (rt.reloading || this.prevReloading || rt.ammoCount >= this.prevAmmo) return;
		const shots = math.min(this.prevAmmo - rt.ammoCount, MAX_SHOTS_PER_FRAME);
		const name = shotSound(w.kind);
		for (let i = 0; i < shots; i++) audio.play(name, { x: p.x, y: p.y });
	}

	private zombieSounds(refs: GameRefs): void {
		const full = fxAudioMode() === "full";
		for (const z of refs.zombies) {
			const was = this.zombies.get(z.id);
			if (was === undefined) continue;
			if (z.hp <= 0) {
				audio.play("zombieDeath", { x: z.x, y: z.y });
				continue;
			}
			// in "full" mode the blood events already carry every hit
			if (!full && z.hp < was.hp - 0.01) audio.play("hitFlesh", { x: z.x, y: z.y });
			if (z.detect && !was.detect && this.alertCd <= 0) {
				this.alertCd = ALERT_COOLDOWN;
				audio.play("zombieAlert", { x: z.x, y: z.y });
			}
		}
	}

	private bossSounds(refs: GameRefs): void {
		const full = fxAudioMode() === "full";
		for (const b of refs.bosses) {
			const was = this.bosses.get(b.id);
			if (was === undefined) {
				// a boss that was not in the snapshot just entered the fight
				if (!b.dead) audio.play("bossRoar", { x: b.x, y: b.y });
				continue;
			}
			if (b.dead) {
				audio.play("bossRoar", { x: b.x, y: b.y, scale: 0.8 });
				continue;
			}
			if (!full && b.hp < was - 0.01) audio.play("hitFlesh", { x: b.x, y: b.y, scale: 0.7 });
		}
	}

	private worldSounds(refs: GameRefs): void {
		const blasts = refs.explosions;
		const count = blasts?.size() ?? 0;
		if (blasts !== undefined && count > this.prevBlasts) {
			const e = blasts[count - 1];
			audio.play("explosion", { x: e.x, y: e.y });
		}
		this.prevBlasts = count;

		const items = inventoryCount(refs);
		if (items > this.prevItems && this.craftMute <= 0) audio.play("pickupItem");
		this.prevItems = items;
	}

	/** the horde has to be heard before it is seen: one nearby zombie growls every few seconds */
	private ambientGrowl(refs: GameRefs, dt: number): void {
		this.growlCd -= dt;
		if (this.growlCd > 0) return;
		this.growlCd = GROWL_MIN + math.random() * (GROWL_MAX - GROWL_MIN);
		const p = refs.player;
		if (p.dead) return;
		const near: Array<number> = [];
		for (let i = 0; i < refs.zombies.size(); i++) {
			const z = refs.zombies[i];
			if (z.hp <= 0) continue;
			const dx = z.x - p.x;
			const dy = z.y - p.y;
			if (dx * dx + dy * dy <= AUDIO_RANGE * AUDIO_RANGE) near.push(i);
		}
		if (near.size() === 0) return;
		const z = refs.zombies[near[math.random(0, near.size() - 1)]];
		audio.play("zombieGrowl", { x: z.x, y: z.y });
	}
}

/** the client's single run-audio watcher */
export const gameAudio = new GameAudio();
