/*
 * The town the SERVER runs, as this client knows it (docs/DESIGN_RULES.md MP-26, UI-10; docs/MULTIPLAYER.md §4.9).
 *
 * The owner, 2026-09-24: "the map must be made when the player enters the match (if they entered alone/first), and
 * that map must show on the home screen, so the map generation doesn't keep changing all the time … if the player
 * joins a public server with players, the home screen shows THAT server's map … generated exclusively by the server,
 * as a seed". So there is ONE authority: the server picks its town's seed (at boot, and again only when the world ends,
 * MP-22) and publishes it as a replicated Workspace attribute; this client never picks, guesses or proposes one.
 *
 *   knownTownSeed()     the seed of the server's town, or undefined while the client has not heard it. The Workspace
 *                       attribute first (replicated STATE, current by construction), else the last InitBegin /
 *                       WorldReset (an event: it can overtake the attribute by a moment, never outlive it). Offline
 *                       (MP_PHASE 0) the client's own town, DESIGN.TOWN_SEED, as it always was.
 *   startServerTown()   once, at boot: the moment the seed is known the town is generated a slice per frame behind the
 *                       logo (client/boot/townCache.ts), and every change of it -- the first one heard, or MP-22's new
 *                       town -- goes to the flyover on screen behind any menu (client/view/townFlyover.ts
 *                       `followTown`: the page colour lifts on it, or it is cross-faded to). The match does not listen
 *                       here: it builds the seed it enters with and rebuilds on the InitBegin / WorldReset that say
 *                       otherwise (client/main.client.ts onTown).
 *
 * What the lobby shows is therefore exactly what the match gets: the same seed, and the very same generated copy
 * (townCache hands it over: zero regeneration). Before the seed is known the menus stand on the page colour -- a
 * guessed town that then swaps is what this replaced.
 */
import { DESIGN } from "shared/engine/constants";
import { MP_PHASE, TOWN_SEED_MAX, WORLD_SEED_ATTRIBUTE } from "shared/net/mpConfig";
import { netOnTown } from "../net/netClient";
import { followTown } from "../view/townFlyover";
import * as TownCache from "./townCache";

const Workspace = game.GetService("Workspace");

/** the seed of the last InitBegin / WorldReset this client read */
let heard: number | undefined;
/** the last seed passed on (so a repeat of it -- every InitBegin of an entry -- does nothing) */
let told: number | undefined;
let started = false;

function isTownSeed(v: unknown): v is number {
	return typeIs(v, "number") && v % 1 === 0 && v >= 1 && v <= TOWN_SEED_MAX;
}

/** the seed of the server's town, or undefined while this client has not heard it (never a guess) */
export function knownTownSeed(): number | undefined {
	if (MP_PHASE < 1) return DESIGN.TOWN_SEED;
	const attr = Workspace.GetAttribute(WORLD_SEED_ATTRIBUTE);
	if (isTownSeed(attr)) return attr;
	return heard;
}

function changed(): void {
	const seed = knownTownSeed();
	if (seed === undefined || seed === told) return;
	const first = told === undefined;
	told = seed;
	// the first seed heard: its town is generated right away, a slice per frame, so the lobby has it when it opens
	if (first) TownCache.requestTown(seed);
	// a menu on screen shows it (the page colour lifts on it; MP-22's new town is cross-faded to)
	followTown(seed);
}

/** once, at boot (client/main.client.ts): the town is asked for the moment its seed is known, and followed after */
export function startServerTown(): void {
	if (started) return;
	started = true;
	if (MP_PHASE >= 1) {
		Workspace.GetAttributeChangedSignal(WORLD_SEED_ATTRIBUTE).Connect(changed);
		netOnTown(notice => {
			if (!isTownSeed(notice.seed)) return;
			heard = notice.seed;
			changed();
		});
	}
	changed();
}
