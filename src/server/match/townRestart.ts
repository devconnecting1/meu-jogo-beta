/*
 * "Restart town" (docs/DESIGN_RULES.md MP-26, docs/MULTIPLAYER.md §4.10): WHO may ask a server for a new town, and how
 * often. SERVER ONLY, pure.
 *
 * The owner of a private (VIP) server keeps its town across sessions (server/save/privateTown.ts); this is their way to
 * start over without waiting for everybody to die (MP-22). It is a WHOLE MP-22 world end (the orchestrator's decision on
 * the review of 0b44458, M1 + M2): a new seed on day 1, and EVERY survivor of the town -- standing or down -- starts a new
 * life in it (server/sim/life.ts `survivorsNow`). Nothing is paid for it: no coins, no title, no record; the survivors
 * keep what a New game keeps (level, skills, coins, packs, costumes, MP-20). So it can never be a way to farm the easy
 * first days with a life that goes on, nor end only the lives of the friends who happened to be down. The private-town
 * store gets the new seed and day at once (server/main.server.ts `onWorldWiped`).
 *
 *   WHO   ONLY ON A PRIVATE SERVER WITH AN OWNER (`PrivateServerId` ≠ "", `PrivateServerOwnerId` ≠ 0 -- DataModel's,
 *         never a client's word): its owner, or one of the game's admins (shared/admin/config.ts) who is on it (review
 *         of 0b44458, M3). Nobody on a public server -- admins included, a public town is everybody's -- nor on a
 *         reserved one (Play solo, owner 0), nor a friend on the owner's server.
 *   HOW   through the TownRequest remote (server/match/townServices.ts): the host's flood accounting and the per-player
 *         token bucket first; then at most one restart per RESTART_COOLDOWN_S for the whole server (a town cannot be
 *         flipped every few seconds under the people in it), and never while a world end is under way (mpHost
 *         `restartTown` says "busy").
 *   AUDIT server/admin/adminServer.ts `townAudit` (M4, L2, L3): an ADMIN's restart is an admin action, stored like
 *         every other; the owner's own restart and every refusal stay in the server's memory and output only (never the
 *         stored audit keys), a refusal once per UserId per window. The record of the town that ended stays in this
 *         server's memory too -- never the shared list of MP-22's worlds.
 */
import { isAdminUserId } from "shared/admin/config";

/** one restart per this many seconds, per server */
export const RESTART_COOLDOWN_S = 120;

export type RestartRight = "owner" | "admin";

/**
 * May `userId` restart this server's town: "owner" (the private server's owner), "admin" (an admin on this private
 * server), or undefined -- always undefined anywhere but a private server with an owner. The server's identity is
 * DataModel's (`PrivateServerId`, `PrivateServerOwnerId`); a reserved server has an id and no owner.
 */
export function restartRightOf(
	userId: number,
	privateServerId: string,
	ownerId: number,
	admin: (userId: number) => boolean = isAdminUserId,
): RestartRight | undefined {
	if (privateServerId === "" || ownerId === 0) return undefined;
	if (userId === ownerId) return "owner";
	if (admin(userId)) return "admin";
	return undefined;
}

/** the server's restart cooldown */
export class RestartGate {
	private lastAt = -math.huge;

	/** seconds until the next restart may start (0: now) */
	waitFor(now: number): number {
		return math.max(0, RESTART_COOLDOWN_S - (now - this.lastAt));
	}

	/** a restart started now */
	started(now: number): void {
		this.lastAt = now;
	}
}
