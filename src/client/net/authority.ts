/*
 * Who owns the interactive world and the backpack, as THIS client's systems see it (docs/MULTIPLAYER.md §4.8, §6.3).
 *
 * From WORLD_SERVER_PHASE the server owns the items, the loot, the doors, the constructions and the backpack. The
 * client's systems (client/systems/interaction.ts, build.ts, craftSystem.ts, combat.ts) then stop making their own
 * and only predict: the E press, the build edges and the reload ride the input command, and a backpack verb is sent
 * as an intent. Which of the two a system does is asked HERE.
 *
 * A leaf module on purpose — no imports — so those systems do not depend on the network code: the Roblox glue
 * (client/net/backpackSync.ts) installs the answer at boot, and wherever it is not installed (single player, the
 * Node suites that run a system on its own) the answer is "no" and the local game runs exactly as it always did.
 */

export interface WorldAuthority {
	/** the server owns the world and the backpack: WORLD_SERVER_PHASE, and a server that runs the MP host */
	owned: () => boolean;
	/** predicts one backpack verb on this client's copy and sends it; false (nothing sent) when it would do nothing */
	send: (kind: number, arg: number) => boolean;
	/** a build edge (place, cancel) rides the next command: the local cursor holds until the server consumed it */
	buildEdge: () => void;
	/** a predicted reload spent this client's copy of the reserve: an older bag must not hand the rounds back */
	reserveSpent: () => void;
	/**
	 * Is a verb that puts a construction on the cursor -- the Build tab's Place, a construction's craft (ITM-09) -- still
	 * waiting for the server's answer? Until it comes, the cursor drawn here may be one the server refused.
	 */
	cursorPending?: () => boolean;
}

let current: WorldAuthority | undefined;

/** client/net/backpackSync.ts, once at boot */
export function setWorldAuthority(authority: WorldAuthority | undefined): void {
	current = authority;
}

/** does the server own the world and the backpack right now? (false offline, and wherever nothing is installed) */
export function serverOwnsWorld(): boolean {
	return current !== undefined && current.owned();
}

/** one backpack verb to the server (shared/net/intentWire.ts `IntentKind`); false when nothing went out */
export function sendBagVerb(kind: number, arg: number): boolean {
	return current !== undefined && current.send(kind, arg);
}

export function noteBuildEdge(): void {
	current?.buildEdge();
}

export function noteReserveSpent(): void {
	current?.reserveSpent();
}

/**
 * The build cursor drawn here is a prediction the server has not answered yet (false offline): client/systems/build.ts
 * sends no click and no E for it until the answer comes (the security review of 0a7561e, 6).
 */
export function buildUnconfirmed(): boolean {
	return current !== undefined && current.owned() && current.cursorPending?.() === true;
}
