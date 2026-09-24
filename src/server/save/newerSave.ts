/*
 * A save written by a NEWER build than this server's (review of 97cd734, H1). SERVER ONLY.
 *
 * After a publish that bumps SAVE_VERSION, servers of the old build may still be running (a publish that does not
 * restart them leaves them up until they empty, and a friend's join still reaches one). Old code reads a newer save
 * with what it knows and writes it back without the rest: every field it does not know is gone, and with it what that
 * field carried (v7: the titles past the first three and their counters, in the save AND in ProjectZ_Titles).
 *
 * From this build on a server never does that. A stored save newer than its own SAVE_VERSION is not loaded: the load's
 * UpdateAsync cancels its own write (not even the session lock is taken), the session is marked released and
 * read-only for good -- no autosave, no event save, no leave write, no shutdown write, no title record -- and the
 * player is told to rejoin, which finds a server of the new build (server/main.server.ts `refuseNewerSave`).
 *
 * Builds older than this one cannot be taught the rule: a release that bumps SAVE_VERSION is published with a restart
 * of every server ("Restart servers", or "Shut down all servers"), docs/CREATOR_HUB.md "Publicar uma versão que muda
 * o save". The lobby's Servers list never shows nor joins a server of another build either (server/match/serverList.ts).
 */
import { langTypeOfLocale, outOfDateKickMessage } from "shared/data/rules";
import { SAVE_VERSION, storedVersion } from "shared/game/save";

/** the version of a stored save (already decoded) when it is NEWER than the one this build writes; else undefined */
export function newerSaveVersion(decoded: unknown): number | undefined {
	const v = storedVersion(decoded);
	return v > SAVE_VERSION ? v : undefined;
}

/** the player is let go with the reason, in their account's language (lang.ts, shared/data/rules.ts) */
export function kickOutOfDate(player: Player): void {
	const message = outOfDateKickMessage(langTypeOfLocale(player.LocaleId));
	pcall(() => player.Kick(message));
}
