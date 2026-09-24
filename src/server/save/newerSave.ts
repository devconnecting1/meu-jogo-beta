/*
 * A save written by a NEWER build than this server's (reviews of 97cd734, H1, and of b0174ed, M-1). SERVER ONLY.
 *
 * After a publish, servers of the old build may still be running (a publish that does not restart them leaves them up
 * until they empty, and a friend's join or a private server still reaches one). Old code reads a newer save with what
 * it knows and writes it back without the rest: every field it does not know is gone (v7: the titles past the first
 * three and their counters, in the save AND in ProjectZ_Titles), and every array is cut to its own tables -- a weapon,
 * a costume or a title added since is dropped, and the weapon in hand with it -- whether or not the publish bumped
 * SAVE_VERSION.
 *
 * From this build on a server never does that. A stored save is newer than this build when it says a later
 * SAVE_VERSION, or when, at this very version, one of its arrays is longer than this build's table
 * (shared/game/save.ts `longerThanTables`). Such a save is not loaded: the load's UpdateAsync cancels its own write (not
 * even the session lock is taken), the session is marked released and read-only for good -- no autosave, no event
 * save, no leave write, no shutdown write, no title record -- and the player is told to rejoin, which finds a server of
 * the new build (server/main.server.ts `refuseNewerSave`).
 *
 * Builds older than this one cannot be taught the rule: EVERY publish restarts every server ("Restart servers", or
 * "Shut down all servers"), docs/CREATOR_HUB.md "Publicar". The lobby's Servers list never
 * shows nor joins a server of another build either (server/match/serverList.ts).
 */
import { langTypeOfLocale, outOfDateKickMessage } from "shared/data/rules";
import { SAVE_VERSION, longerThanTables, storedVersion } from "shared/game/save";

/**
 * Why a stored save (already decoded) is NEWER than this build -- "v9", or "titles 26 > 25" -- or undefined when this
 * build may load and write it
 */
export function newerThanBuild(decoded: unknown): string | undefined {
	const v = storedVersion(decoded);
	if (v > SAVE_VERSION) return `v${v}`;
	return v === SAVE_VERSION ? longerThanTables(decoded) : undefined;
}

/** the player is let go with the reason, in their account's language (lang.ts, shared/data/rules.ts) */
export function kickOutOfDate(player: Player): void {
	const message = outOfDateKickMessage(langTypeOfLocale(player.LocaleId));
	pcall(() => player.Kick(message));
}
