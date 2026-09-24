/*
 * FxEvent -> sound.
 *
 * `refs.fx` is the simulation's cosmetic channel (docs/MULTIPLAYER.md §4.1). The view already turns those
 * events into particles, camera shake and HUD messages; this module turns the same events into sound, so
 * audio needs no new plumbing in the systems.
 *
 * The channel has ONE reader: client/view/fxView.ts `applySim` calls `playFxEvent(e)` for every event, in both of
 * GameLoop's `playFx` (update and render), right before it clears the list. Nothing else may read `refs.fx` for sound:
 * the run watcher used to drain it too, before render, and every event pushed between update and render (a door, an
 * admin tool) was heard twice (DESIGN_RULES SND-04).
 *
 * Two modes for what the channel carries:
 *  - "leftover" (default): only `sound` and `debris` are played from the channel; shots, flesh hits, deaths and the
 *    player's own damage come from the state watcher in gameAudio.ts, which sees all of them.
 *  - "full": every event is played from the channel and gameAudio stops deriving them.
 *
 * `message` is never played here: HUD messages always reach the client through `refs.onMessage`, which is
 * where gameAudio listens for the wave / dawn stingers. Playing them here too would double every stinger.
 */
import type { FxEvent } from "shared/sim/types";
import type { SoundName } from "shared/data/sounds";
import { WeaponKind } from "shared/data/kinds";
import { WEAPONS } from "shared/data/weapons";
import { ProjKind } from "shared/net/protocol";
import { audio } from "./audio";

/** weapons.ts id of the flamethrower: its sound is a held jet, not a shot per round */
export const FLAMETHROWER_ID = 25;

/** which shot is heard for a weapon kind */
export function shotSound(kind: WeaponKind): SoundName {
	if (kind === WeaponKind.Shotgun) return "shotShotgun";
	if (kind === WeaponKind.Sniper) return "shotSniper";
	if (kind === WeaponKind.MG) return "shotMg";
	if (kind === WeaponKind.Rifle) return "shotRifle";
	if (kind === WeaponKind.Bow) return "shotBow";
	if (kind === WeaponKind.Special) return "shotElectric";
	return "shotPistol";
}

/**
 * Somebody else's shot (§4.2 `Shot`, their slot), heard from their body: before P0-4 an ally's gun was silent on every
 * other screen. The weapon on the wire picks the sound, as the magazine does for ours.
 */
export function remoteShotSound(weaponId: number, x: number, y: number): void {
	const w = WEAPONS[weaponId];
	if (w === undefined || w.kind === WeaponKind.Melee || weaponId === FLAMETHROWER_ID) return;
	audio.play(shotSound(w.kind), { x, y });
}

/** where each survivor's flamethrower last spat a flame (slot → position and os.clock()): gameAudio holds the jet */
const flames = new Map<number, { x: number; y: number; at: number }>();

/** the flames spat by other survivors (their slot), for client/audio/gameAudio.ts to hold as jets */
export function remoteFlames(): ReadonlyMap<number, { x: number; y: number; at: number }> {
	return flames;
}

/** somebody else's projectile left their hands (§4.2 `ProjSpawn`): an arrow's release, a flamethrower's jet */
export function remoteProjectileSound(kind: number, owner: number, x: number, y: number): void {
	if (kind === ProjKind.Arrow) {
		audio.play("shotBow", { x, y });
		return;
	}
	if (kind !== ProjKind.Fire) return;
	const f = flames.get(owner);
	if (f === undefined) {
		flames.set(owner, { x, y, at: os.clock() });
	} else {
		f.x = x;
		f.y = y;
		f.at = os.clock();
	}
}

export type FxAudioMode = "leftover" | "full";

let mode: FxAudioMode = "leftover";

/** the local survivor's slot in refs.players (F0: always 0) */
let localSlot = 0;

export function setFxAudioMode(value: FxAudioMode): void {
	mode = value;
}

export function fxAudioMode(): FxAudioMode {
	return mode;
}

export function setFxAudioLocalSlot(slot: number): void {
	localSlot = slot;
}

/** what a debris burst is made of -> which impact is heard */
function debrisSound(material: string): SoundName | undefined {
	if (material === "tree" || material === "structure") return "debrisWood";
	if (material === "car" || material === "boss" || material === "impact") return "debrisMetal";
	if (material === "exploder") return "explosion";
	return undefined;
}

/**
 * Plays one cosmetic event. Safe to call for every event of `refs.fx`: entries with an empty slot in the
 * catalogue and events that belong to another survivor are ignored.
 */
export function playFxEvent(e: FxEvent): void {
	if (e.kind === "sound") {
		// a sound the simulation decided (the server's, through the wire, or this client's own world): the bite, a
		// door, a usable, a horn -- always played, whatever the mode, because nothing else derives it (P0-4)
		audio.play(e.sound, { x: e.x, y: e.y });
		return;
	}
	if (e.kind === "debris") {
		const name = debrisSound(e.material);
		// a bigger burst is a heavier impact, but never louder than the burst that earns it
		if (name !== undefined) audio.play(name, { x: e.x, y: e.y, scale: math.clamp(e.count / 6, 0.4, 1) });
		return;
	}
	if (mode !== "full") return;
	if (e.kind === "blood") {
		if (e.source === "player") audio.play("playerHurt");
		else audio.play("hitFlesh", { x: e.x, y: e.y, scale: math.clamp(e.count / 8, 0.5, 1) });
		return;
	}
	if (e.kind === "tracer") {
		// "bullet" / "boss" lines carry no weapon kind: the shot itself is played by the weapon watcher
		if (e.tracer === "electric") audio.play("shotElectric", { x: e.x1, y: e.y1 });
		return;
	}
	if (e.kind === "shake") {
		// shake is purely visual; a blast that deserves a sound already pushes its own debris/blood
		if (e.player !== localSlot) return;
	}
}
