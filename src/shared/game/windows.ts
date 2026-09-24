/*
 * Window glass (docs/DESIGN_RULES.md EDI-18, EDI-10; docs/MULTIPLAYER.md §4.5, protocol.ts note 22).
 *
 * A building's window is one static solid in its wall's gap (kind "window", tags "window", shared/game/interiors.ts
 * plans it, world.ts `planInteriors` lays it). It is in one of two states, and the SOLID is the state -- the same
 * object physics, the flow fields, the drawing and the wire read:
 *
 *   INTACT   the pane is in the frame: `passable` unset, so it stops bodies and bullets (world.ts `isBlocking`), and
 *            not the eyes (perception.ts `blocksSight` lets any "window" by) nor the light (the light map has no
 *            walls). `hp` is the blows it still takes (GLASS_HITS at most), `hpMax` the glass it was generated with.
 *   BROKEN   the open frame of EDI-10: `passable` and `open` set, `hp` 0 -- climbed through at VAULT_SLOW, and the
 *            horde's field prices the sill at WINDOW_COST. `hpMax` 0 marks one that was born broken (the town is a few
 *            days into the outbreak, APO-01): it comes from the seed, so it never travels on the wire.
 *
 * BOARDED is not a state of the window: it is EDI-13's barricade or built door in the gap (shared/sim/placement.ts
 * `snapToOpening`), a construction with its own hit points, over glass or over an open frame alike.
 *
 * Glass only ever breaks: nothing puts a pane back, so the state is one bit that moves one way, and a newcomer is told
 * only about the windows broken since the town was generated (server/net/replication.ts `welcomeWorld`). Breaking
 * goes through `breakWindow` and nowhere else: it keeps the per-tick budget and fires the world's hook, which is
 * how the server's outbox hears every break -- a zombie's (shared/sim/ai/zombieBrain.ts), a shot's, a blade's or an E
 * press's (server/sim/windows.ts) -- without any of them having to remember to tell it.
 *
 * Pure: no Instances, no services.
 */
import type { Solid, WorldData } from "./world";

/**
 * Blows a pane takes: a walker's third lands ~2 s after its first (each blow stuns it STUN_TIME, as a barricade
 * does), a crowd at one window breaks it sooner, a charger's rush breaks it at once. Short enough that glass only
 * buys a moment; long enough to be heard (every blow is a noise ring, shared/sim/ai/noise.ts GLASS_BANG).
 */
export const GLASS_HITS = 3;

/**
 * The most panes the server lets break in one tick, whatever broke them (E, a blade, a shot, the horde, a blast).
 * A safety valve, not a budget anybody meets: a pane is one global DoorSet (§4.5), a noise ring and a dirty flow-field
 * tile, and a town holds ~370 intact ones. Past it a break simply waits: the glass holds one more blow.
 */
export const WINDOW_BREAKS_PER_TICK = 4;

/** E breaks a pane within this of its edge (a door's reach, interactQuery DOOR_REACH): the glass is right there */
export const WINDOW_REACH = 30;

export function isWindow(s: Solid): boolean {
	return s.kind === "window";
}

/** glass in the frame: it stops a body and a bullet (and a zombie's blows can break it) */
export function windowIntact(s: Solid): boolean {
	return s.kind === "window" && s.passable !== true && s.removed !== true;
}

/** the open frame (EDI-10): climbed through, the field's VAULT sill */
export function windowBroken(s: Solid): boolean {
	return s.kind === "window" && s.passable === true;
}

/** was this window generated with glass? (hpMax 0: born broken, a few days into the outbreak) */
export function hadGlass(s: Solid): boolean {
	return s.kind === "window" && s.hpMax > 0;
}

/**
 * Lays the pane in or takes it out, with nothing else: the generator, and the client's mirror (a DoorSet, a reset to the
 * generated town before a WorldInit). Every BREAK in a simulation goes through `breakWindow`.
 */
export function setWindowGlass(s: Solid, intact: boolean): void {
	s.passable = intact ? undefined : true;
	s.open = !intact;
	s.hp = intact ? math.max(1, s.hpMax) : 0;
}

/**
 * Breaks the pane of window `s` in world `w`: false when there is none (already broken, not a window) or the tick's
 * budget is spent (`WorldData.windowBudget`, the server's WINDOW_BREAKS_PER_TICK; a client world has none). On a break
 * the world's hook hears it (`WorldData.onWindowBroken`: the server queues the global DoorSet there).
 *
 * This is only the state. The rest of a pane giving way -- the noise the horde hears, the glass on the floor, the flow
 * field -- is zombieBrain `shatterWindow`, which calls this.
 */
export function breakWindow(w: WorldData, s: Solid): boolean {
	if (!windowIntact(s)) return false;
	const budget = w.windowBudget;
	if (budget !== undefined) {
		if (budget <= 0) return false;
		w.windowBudget = budget - 1;
	}
	setWindowGlass(s, false);
	if (w.onWindowBroken !== undefined) w.onWindowBroken(w, s);
	return true;
}

/**
 * The share of a building type's windows the generator leaves broken (a few days after the outbreak, APO-01):
 * storefronts and the gas station's shop were looted first (their windows are the street's shop fronts), the school
 * and the hospital were evacuated in a hurry and overrun, the campus less so, and most families locked their houses
 * and left. Over a town (houses hold ~56% of the windows) that is ~28%: the owner's 20-35%.
 */
export function brokenShare(buildingType: number): number {
	if (buildingType === 1 || buildingType === 2) return 0.18;
	if (buildingType === 3 || buildingType === 4) return 0.3;
	if (buildingType >= 12 && buildingType <= 15) return 0.25;
	// the gas station (5) and the shops (6..11)
	return 0.45;
}

/**
 * Which way through window `s` is "in" for a body at (x, y): the unit normal of its wall, pointing from the body's side
 * to the other. Answers into `out` (no table per call).
 */
export function acrossWindow(s: Solid, x: number, y: number, out: { x: number; y: number }): void {
	if (s.w >= s.h) {
		out.x = 0;
		out.y = y < s.y + s.h / 2 ? 1 : -1;
	} else {
		out.x = x < s.x + s.w / 2 ? 1 : -1;
		out.y = 0;
	}
}
