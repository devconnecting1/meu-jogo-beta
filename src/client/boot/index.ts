/*
 * What the client does ahead of time so the player never waits for it (the owner, 2026-09-23: "would caching make the
 * game better?"). One import for client/main.client.ts, which is close to Luau's 200-locals budget:
 *
 *   preloadPlan   the one ordered ContentProvider:PreloadAsync plan: the lobby's textures, the signs and characters,
 *                 then the sounds
 *   warmup        idle-time building of the screens the player opens next: the Bag in a run, the Survivor page in the
 *                 lobby
 *   townCache     the lobby's town handed to the match instead of generated again (used by GameLoop and the flyover),
 *                 generated a slice per frame
 *   serverTown    the town the SERVER runs (its seed, heard the moment the client joins): asked for at once, and
 *                 followed by the flyover behind the menus (MP-26)
 */
export { startPreload } from "./preloadPlan";
export { warmLobby, warmRun } from "./warmup";
export { knownTownSeed, startServerTown, townEndText } from "./serverTown";
