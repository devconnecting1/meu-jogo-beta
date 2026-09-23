/*
 * DataStore names, and the one rule that keeps a playtest out of production (docs/MULTIPLAYER.md §6.4).
 *
 * Every store this game opens had a FIXED name. With "Enable Studio Access to API Services" on — which the
 * admin panel asks for and the save path needs to be exercised at all — a Studio playtest opened the very
 * same documents as the live game: pressing Play wrote the tester's throwaway run over a real player's save,
 * and `UpdateAsync` took the production session lock while it did (LOCK_STALE = 300 s of a real player being
 * told "someone else is playing"). Nothing in the code said so; the only defence was remembering not to press
 * Play while logged in as somebody who matters.
 *
 * So: in Studio every store name gets a suffix, and Studio and production stop sharing documents. This is a
 * prerequisite for the v2 → v3 migration (§6.4 "Testar com uma cópia de save real"): a migration you cannot
 * rehearse without risking the save you are rehearsing FOR is not a migration, it is a bet.
 *
 * The suffix covers ALL of them, including the read-only v1 legacy store, because a v1 document read in
 * Studio is migrated into v2 and becomes a write. To rehearse a migration against real data, read the live
 * document with `npm run cloud -- save <userId>` and write that copy into the Studio store (by hand or with
 * Open Cloud), instead of pointing Studio at production. `npm run test:save` rehearses the same migration in
 * Node against the production save SHAPE, with no store at all.
 *
 * The live (non-Studio) names are unchanged: `ProjectZ_Save_v2` stays the v3 store too (§6.4 keeps the same
 * document `{data, lock}`), so no live save moves.
 */
const RunService = game.GetService("RunService");

/** appended to every store name while running inside Studio, so a playtest cannot touch production */
export const STUDIO_SUFFIX = "_studio";

/** true while this server is a Studio playtest (Play, Run or Start Server) */
export function isStudio(): boolean {
	return RunService.IsStudio();
}

/** the live name, or the same name with STUDIO_SUFFIX while in Studio */
export function storeName(base: string): string {
	return RunService.IsStudio() ? base + STUDIO_SUFFIX : base;
}

/**
 * v2/v3 documents (`{ data, lock }`). A server still running the v1 code expects a raw string here and would
 * overwrite anything else with a blank save, which is why v2 got its own store and v3 does not need another
 * one: `sanitizeStoredSave` drops unknown keys, so v2 code reading a v3 document only loses the new fields.
 */
export const SAVE_STORE = storeName("ProjectZ_Save_v2");
/** v1 store (raw JSON strings, written by the client-trusting server): read once to migrate a first session */
export const LEGACY_STORE = storeName("ProjectZ_Save_v1");
/** admin audit log (server/admin/adminServer.ts) */
export const ADMIN_LOG_STORE = storeName("ProjectZ_AdminLog");
/** the worlds that ended, how many days each lasted (MP-22, server/save/worldLog.ts) */
export const WORLD_LOG_STORE = storeName("ProjectZ_Worlds");
/**
 * MON-05: the titles and the kill count each player EARNED, kept outside the save so a server rolled back to v4
 * code (which rewrites the save without them) cannot erase them (server/save/titleRecord.ts). Keyed by UserId.
 */
export const TITLE_STORE = storeName("ProjectZ_Titles");
