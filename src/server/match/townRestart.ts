/*
 * "Restart town" (docs/DESIGN_RULES.md MP-26, docs/MULTIPLAYER.md §4.9): WHO may ask a server for a new town, and how
 * often. SERVER ONLY, pure.
 *
 * The owner of a private (VIP) server keeps its town across sessions (server/save/privateTown.ts); this is their way to
 * start over without waiting for everybody to die (MP-22). It is the same end of the world -- a new seed on day 1, the
 * survivors down given a new life, everybody standing moved into the new town with their own, every client told, the
 * record kept, and the private-town store written with the new seed and day (server/main.server.ts `onWorldWiped`) --
 * started by a person instead of by rule 6.
 *
 *   WHO   the private server's owner (`PrivateServerOwnerId`, never a client's word), on THEIR server only; and the
 *         game's admins (shared/admin/config.ts), anywhere -- the owner's own tool for the owner's own town, and the
 *         developer's for testing (Studio has no private servers). Nobody else: not on a public server, not on a
 *         reserved one (Play solo, whose owner id is 0), not a friend on the owner's server.
 *   HOW   through the TownRequest remote (server/match/townServices.ts), whose token bucket every request passes first;
 *         then at most one restart per RESTART_COOLDOWN_S for the whole server (a town cannot be flipped every few
 *         seconds under the people in it), and never while a reset is under way (mpHost `restartTown` says "busy").
 *   AUDIT every request that reaches here -- allowed or refused -- goes to the admin audit log by UserId
 *         (server/admin/adminServer.ts `townAudit`); a refused one stays in memory and the server output only, so a
 *         client spamming the remote cannot fill the stored log.
 */
import { isAdminUserId } from "shared/admin/config";

/** one restart per this many seconds, per server */
export const RESTART_COOLDOWN_S = 120;

export type RestartRight = "owner" | "admin";

/**
 * May `userId` restart this server's town: "owner" (the private server's owner, on it), "admin", or undefined. The
 * server's identity is DataModel's (`PrivateServerId`, `PrivateServerOwnerId`); a reserved server has an id and no owner.
 */
export function restartRightOf(
	userId: number,
	privateServerId: string,
	ownerId: number,
	admin: (userId: number) => boolean = isAdminUserId,
): RestartRight | undefined {
	if (admin(userId)) return "admin";
	if (privateServerId !== "" && ownerId !== 0 && userId === ownerId) return "owner";
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
