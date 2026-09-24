/*
 * Admin / developer panel: who is an admin.
 *
 * SECURITY: authorization is decided ONLY on the server, by UserId (usernames can change, ids never do).
 * The client never tells the server "I am an admin": every admin remote re-checks the caller's UserId
 * against this list before doing anything. The server marks admins with the ADMIN_ATTRIBUTE attribute so
 * their client knows it may build the panel; a player who forces that attribute locally only gets a panel
 * whose every server request is refused -- the world tools included, which are server requests wherever the server
 * owns the world (docs/MULTIPLAYER.md §10) -- and one who calls the remote in a loop is kicked for flooding it.
 */

/** UserIds allowed to use the admin panel */
export const ADMIN_USER_IDS: ReadonlyArray<number> = [8424325451];

/** display names of the ids above (informative only — never used for authorization) */
export const ADMIN_LABELS: ReadonlyMap<number, string> = new Map([[8424325451, "Luvitlua"]]);

/** Player attribute set by the server on confirmed admins (the client builds the panel only when present) */
export const ADMIN_ATTRIBUTE = "PZAdmin";

export function isAdminUserId(userId: number): boolean {
	return ADMIN_USER_IDS.includes(userId);
}
