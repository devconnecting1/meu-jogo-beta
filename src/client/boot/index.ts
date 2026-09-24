/*
 * What the client does ahead of time so the player never waits for it (the owner, 2026-09-23: "would caching make the
 * game better?"). One import for client/main.client.ts, which is close to Luau's 200-locals budget:
 *
 *   preloadPlan   the one ordered ContentProvider:PreloadAsync plan: the lobby's textures, the signs and characters,
 *                 then the sounds
 *   warmup        idle-time building of the screens the player opens next: the Bag in a run, the Survivor page in the
 *                 lobby
 *   townCache     the lobby's town handed to the match instead of generated again (used by GameLoop and the flyover)
 */
export { startPreload } from "./preloadPlan";
export { warmLobby, warmRun } from "./warmup";
