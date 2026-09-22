import type { GameContext } from "shared/game/context";
import type { AdminRequest, AdminResponse, PlayerRow } from "shared/admin/protocol";
import type { ToastKind } from "../ui/popup";
import { THEME } from "../ui/theme";
import { makeFrame } from "../ui/widgets";
import type { Placement } from "./placement";
import type { AdminWorld } from "./world";

/** design size of a section's content area (right of the Sidebar) */
export const CONTENT_W = 442;
export const CONTENT_H = 450;

export type SectionId = "players" | "progress" | "spawn" | "world" | "camera" | "debug" | "server";

export const SECTIONS: Array<{ id: SectionId; label: string }> = [
	{ id: "players", label: "Players" },
	{ id: "progress", label: "Progress & items" },
	{ id: "spawn", label: "Spawn" },
	{ id: "world", label: "World" },
	{ id: "camera", label: "Camera" },
	{ id: "debug", label: "Debug" },
	{ id: "server", label: "Server" },
];

/** what every section gets from the panel */
export interface PanelCtx {
	ctx: GameContext;
	/** the only door to the game world (see world.ts) */
	world: AdminWorld;
	placement: Placement;
	/** where dialogs go (the admin ScreenGui) */
	layer: ScreenGui;
	selfUserId: number;
	/** sends an admin request (YIELDS); failures are toasted with the server's reason */
	request(req: AdminRequest, successText?: string): AdminResponse;
	notify(text: string, kind?: ToastKind): void;
	/** UserId edited by the Progress section (Players → "Edit progress" sets it) */
	target: number;
	goTo(id: SectionId): void;
	/** last player list received from the server */
	players: Array<PlayerRow>;
	/** asks the server for the player list again (async) */
	refreshPlayers(): void;
	/** stats card on/off (Debug section) */
	setStatsCard(on: boolean): void;
	statsCard(): boolean;
}

export interface SectionHandle {
	/** every frame while the section is shown */
	update?(dt: number): void;
	/** the player list changed */
	onPlayers?(): void;
	/** live data of a watched player */
	onWatch?(row: PlayerRow): void;
	destroy?(): void;
}

export type SectionBuilder = (p: PanelCtx, content: Frame) => SectionHandle;

/** transparent container in design units (a region of a section) */
export function region(parent: Instance, name: string, x: number, y: number, w: number, h: number): Frame {
	return makeFrame(parent, name, x, y, w, h, THEME.background, { transparency: 1 });
}

/** removes the rows of a kit ScrollList (keeps its UIListLayout / UIPadding) */
export function clearRows(list: ScrollingFrame): void {
	for (const child of list.GetChildren()) {
		if (child.IsA("GuiObject")) child.Destroy();
	}
}

const HttpService = game.GetService("HttpService");

/** cheap change detection for rebuilt UI (skip the rebuild when the data did not change) */
export function signature(v: unknown): string {
	const [ok, s] = pcall(() => HttpService.JSONEncode(v));
	return ok ? (s as string) : tostring(os.clock());
}

/** "12 s ago" / "3 min ago" / "never" */
export function agoText(seconds: number): string {
	if (seconds < 0) return "never";
	if (seconds < 90) return `${seconds} s ago`;
	if (seconds < 5400) return `${math.floor(seconds / 60)} min ago`;
	return `${math.floor(seconds / 3600)} h ago`;
}

export function durationText(seconds: number): string {
	if (seconds < 60) return `${seconds} s`;
	if (seconds < 3600) return `${math.floor(seconds / 60)} min`;
	return `${math.floor(seconds / 3600)} h ${math.floor((seconds % 3600) / 60)} min`;
}

/** "Name (@user)" of a row, or the UserId when the player is gone */
export function rowLabel(row: PlayerRow): string {
	return row.displayName !== row.name ? `${row.displayName} (@${row.name})` : row.name;
}

/** the session / save state of a row, in words */
export function sessionText(row: PlayerRow): string {
	if (!row.loaded) return "loading save";
	if (row.readOnly) return "read-only (save not loaded)";
	if (!row.persist) return "not persisted (memory only)";
	return row.dirty ? "persisted · unsaved changes" : "persisted · saved";
}
