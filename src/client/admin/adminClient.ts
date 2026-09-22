import { ADMIN_ATTRIBUTE } from "shared/admin/config";
import type { AdminRequest, AdminResponse, PlayerRow } from "shared/admin/protocol";
import type { GameContext } from "shared/game/context";
import type { GameLoop } from "../gameLoop";
import { TEXT, THEME, space } from "../ui/theme";
import { Badge, Card, ToastKind, makeAnchored, makeLabel, showToast } from "../ui/widgets";
import { adminRequest, adminRequestAsync, logLocal, onAdminEvent, startAdminNet } from "./net";
import { AdminPanel } from "./panel";
import { PanelCtx, SectionId } from "./panelTypes";
import { startAdminListeners } from "./patches";
import { Placement } from "./placement";
import { worldPrefs } from "./sectionWorld";
import { LocalAdminWorld } from "./world";

/*
 * Admin mode entry point (wired by main.client.ts).
 * - every client: admin networking + save patches + announcements (patches.ts)
 * - admins only (the server sets the PZAdmin attribute after checking the UserId): the panel, the ADMIN badge, the
 *   debug overlay and the input bindings are created; nothing of it exists for other players
 * - F2 (or `) opens / closes the panel (neither key is taken by the Roblox CoreGui: it uses Esc, F9, F11, F12)
 */

const Players = game.GetService("Players");
const RunService = game.GetService("RunService");
const UserInputService = game.GetService("UserInputService");

const PANEL_KEYS = new Set<Enum.KeyCode>([Enum.KeyCode.F2, Enum.KeyCode.Backquote]);
const PLAYER_POLL = 2;
const STATS_REFRESH = 0.25;
const FREECAM_SPEED = 900;
/** a frame not rendered for this long means the game screen is gone: hide the overlays */
const RENDER_STALE = 0.25;

export interface AdminDeps {
	ctx: GameContext;
	loop: GameLoop;
	/** the save was reset by an admin: drop the run in memory and go to the lobby */
	endRun: () => void;
}

/** called by main.client around the game frame (cheap no-ops for non-admins) */
export interface AdminHooks {
	beforeUpdate(dt: number): void;
	afterUpdate(dt: number): void;
	afterRender(dt: number): void;
}

interface AdminMode extends AdminHooks {
	destroy(): void;
}

function enableAdmin(deps: AdminDeps): AdminMode {
	const { ctx, loop } = deps;
	const player = Players.LocalPlayer;
	const conns: Array<RBXScriptConnection> = [];

	const gui = new Instance("ScreenGui");
	gui.Name = "PZAdmin";
	gui.ResetOnSpawn = false;
	gui.IgnoreGuiInset = true;
	gui.DisplayOrder = 150;
	gui.ZIndexBehavior = Enum.ZIndexBehavior.Sibling;
	gui.Parent = ctx.playerGui;

	// debug overlays: inside the game root, above the night (Dark = 80) and below the HUD (90) / menus (100)
	const overlayLayer = new Instance("Frame");
	overlayLayer.Name = "AdminOverlay";
	overlayLayer.Size = UDim2.fromScale(1, 1);
	overlayLayer.BackgroundTransparency = 1;
	overlayLayer.BorderSizePixel = 0;
	overlayLayer.Active = false;
	overlayLayer.ZIndex = 86;
	overlayLayer.Parent = ctx.root;

	const world = new LocalAdminWorld(ctx, loop, overlayLayer);
	// a world tool changed the run: tell the server once per run (it stops crediting coins / achievements / records)
	let assistedRunRev = -1;
	world.onAssist = what => {
		const runRev = ctx.save.runRev;
		if (runRev === assistedRunRev) return;
		assistedRunRev = runRev;
		adminRequestAsync({ kind: "assist" }, res => {
			if (res.ok) notify(`Assisted run (${what}): no coins, achievements or records from it`, "info");
		});
	};
	const placement = new Placement(ctx, world, gui);
	let panel: AdminPanel | undefined;
	let statsOn = false;

	/** toasts in the admin layer, so they also show above the admin dialogs */
	const notify = (text: string, kind: ToastKind = "info"): void => showToast(gui, text, kind);

	let polling = false;
	const p: PanelCtx = {
		ctx,
		world,
		placement,
		layer: gui,
		selfUserId: player.UserId,
		target: player.UserId,
		players: [],
		request(req: AdminRequest, successText?: string): AdminResponse {
			const res = adminRequest(req);
			if (!res.ok) notify(res.error ?? "Request failed", "error");
			else if (successText !== undefined) notify(successText, "success");
			return res;
		},
		notify(text: string, kind?: ToastKind): void {
			notify(text, kind);
		},
		goTo(id: SectionId): void {
			panel?.goTo(id);
		},
		refreshPlayers(): void {
			if (polling) return;
			polling = true;
			adminRequestAsync({ kind: "players" }, res => {
				polling = false;
				if (!res.ok || !typeIs(res.data, "table")) return;
				p.players = res.data as Array<PlayerRow>;
				panel?.playersChanged();
			});
		},
		setStatsCard(on: boolean): void {
			statsOn = on;
			statsBox.Visible = on;
		},
		statsCard(): boolean {
			return statsOn;
		},
	};

	panel = new AdminPanel(
		p,
		gui,
		`${player.Name} · UserId ${player.UserId} · F2 or \` toggles · world tools act on your own world`,
	);

	// ADMIN badge (bottom-left, discreet)
	const badgeText = "ADMIN · F2";
	const badgeBox = makeAnchored(gui, "AdminBadge", 0, 1, 110, 24, 14, 14, false);
	Badge(badgeBox, "Badge", badgeText, { x: 0, y: 0, w: 110, h: 24, variant: "secondary" });

	// stats card (Debug → Stats card), right-middle
	const statsW = 240;
	const statsH = 168;
	const statsBox = makeAnchored(gui, "AdminStats", 1, 0.5, statsW, statsH, 14, 0, false);
	statsBox.Visible = false;
	const statsCard = Card(statsBox, "Card", { x: 0, y: 0, w: statsW, h: statsH, variant: "hud", pad: space(3) });
	makeLabel(
		statsCard,
		"Title",
		"Debug stats",
		space(3),
		space(2),
		statsW - space(6),
		20,
		TEXT.sm,
		THEME.cardForeground,
		{
			font: "label",
			align: "left",
		},
	);
	const statsText = makeLabel(
		statsCard,
		"Lines",
		"",
		space(3),
		30,
		statsW - space(6),
		statsH - 38,
		TEXT.xs,
		THEME.cardForeground,
		{
			mono: true,
			weight: Enum.FontWeight.Regular,
			align: "left",
			valign: "top",
		},
	);

	let pollAt = 0;
	let statsAt = 0;
	let lastRender = -math.huge;
	let swallowAction = false;

	conns.push(
		UserInputService.InputBegan.Connect((input, gpe) => {
			if (input.UserInputType === Enum.UserInputType.Keyboard) {
				if (gpe || !PANEL_KEYS.has(input.KeyCode)) return;
				if (placement.active()) placement.cancel();
				else panel?.toggle();
				return;
			}
			if (gpe) return;
			if (input.UserInputType === Enum.UserInputType.MouseButton1) {
				const shift =
					UserInputService.IsKeyDown(Enum.KeyCode.LeftShift) ||
					UserInputService.IsKeyDown(Enum.KeyCode.RightShift);
				const ctrl =
					UserInputService.IsKeyDown(Enum.KeyCode.LeftControl) ||
					UserInputService.IsKeyDown(Enum.KeyCode.RightControl);
				if (placement.active()) {
					ctx.input.attackBlocked = true;
					placement.place(shift);
				} else if (ctrl && worldPrefs.ctrlTeleport && world.ready()) {
					ctx.input.attackBlocked = true;
					const m = UserInputService.GetMouseLocation();
					const at = world.screenToWorld(m.X, m.Y);
					const res = world.teleport(at.x, at.y);
					if (res.ok) logLocal("teleport", `ctrl+click to (${math.floor(at.x)}, ${math.floor(at.y)})`);
					else notify(res.message, "error");
				}
			} else if (input.UserInputType === Enum.UserInputType.MouseButton2) {
				if (placement.active()) {
					placement.cancel();
					swallowAction = true;
				}
			}
		}),
	);
	conns.push(
		UserInputService.InputChanged.Connect((input, gpe) => {
			if (gpe || input.UserInputType !== Enum.UserInputType.MouseWheel || !world.freeCam()) return;
			world.setZoom(world.zoom() * math.pow(1.1, input.Position.Z));
		}),
	);
	const stopWatchEvents = onAdminEvent(ev => {
		if (ev.kind === "watch" && typeIs(ev.row, "table")) panel?.watch(ev.row as PlayerRow);
	});

	// UI tick (also in the lobby, where the game frame does not run)
	conns.push(
		RunService.Heartbeat.Connect(dt => {
			const now = os.clock();
			const inGame = now - lastRender < RENDER_STALE;
			if (!inGame) {
				world.hideOverlay();
				if (placement.active()) placement.cancel();
				if (ctx.phase === "lobby" && world.freeCam()) world.setFreeCam(false);
			}
			if (panel !== undefined && panel.isOpen()) {
				panel.update(dt);
				if (now - pollAt >= PLAYER_POLL) {
					pollAt = now;
					p.refreshPlayers();
				}
			}
			if (statsOn && now - statsAt >= STATS_REFRESH) {
				statsAt = now;
				if (inGame) {
					const s = world.stats();
					statsText.Text = [
						`FPS          ${math.floor(s.fps + 0.5)}`,
						`zombies      ${s.zombies}  bosses ${s.bosses}`,
						`items        ${s.items}  bullets ${s.bullets}`,
						`solids/view  ${s.solidsInView}`,
						`sprites      ${s.sprites}`,
						`GameGui inst ${s.guiInstances}`,
						`zoom         ${string.format("%.2f", world.zoom())}${world.freeCam() ? " (free)" : ""}`,
					].join("\n");
				} else {
					statsText.Text = "No run on screen.";
				}
			}
		}),
	);

	print(`[PZ-ADMIN] panel enabled for ${player.Name} (${player.UserId}); press F2`);

	return {
		destroy(): void {
			for (const c of conns) c.Disconnect();
			stopWatchEvents();
			placement.cancel();
			world.reset();
			panel?.close();
			panel = undefined;
			gui.Destroy();
			overlayLayer.Destroy();
		},
		beforeUpdate(): void {
			// the free camera is a view tool: clicking the map there never shoots
			if (world.freeCam()) ctx.input.attackBlocked = true;
			if (swallowAction) {
				// the right click that cancelled a placement is not also an "action" (E) for the survivor
				swallowAction = false;
				ctx.input.actionPressed = false;
			}
			world.beforeUpdate();
		},
		afterUpdate(): void {
			world.afterUpdate();
		},
		afterRender(dt: number): void {
			lastRender = os.clock();
			if (world.freeCam() && ctx.phase === "playing" && UserInputService.GetFocusedTextBox() === undefined) {
				let dx = 0;
				let dy = 0;
				const down = (k: Enum.KeyCode): boolean => UserInputService.IsKeyDown(k);
				if (down(Enum.KeyCode.W) || down(Enum.KeyCode.Up)) dy -= 1;
				if (down(Enum.KeyCode.S) || down(Enum.KeyCode.Down)) dy += 1;
				if (down(Enum.KeyCode.A) || down(Enum.KeyCode.Left)) dx -= 1;
				if (down(Enum.KeyCode.D) || down(Enum.KeyCode.Right)) dx += 1;
				if (dx !== 0 || dy !== 0) {
					const fast = down(Enum.KeyCode.LeftShift) ? 3 : 1;
					const k = (FREECAM_SPEED * fast * dt) / math.max(world.zoom(), 0.1) / math.sqrt(dx * dx + dy * dy);
					world.moveFreeCam(dx * k, dy * k);
				}
			}
			placement.frame();
			world.afterRender(dt);
		},
	};
}

/**
 * Starts the admin layer. Every client gets the patch / announcement listeners; the panel is only built when the
 * server has marked this player as an admin (and torn down if the mark goes away).
 */
export function startAdmin(deps: AdminDeps): AdminHooks {
	startAdminNet();
	startAdminListeners(deps);
	const player = Players.LocalPlayer;
	let mode: AdminMode | undefined;
	const sync = (): void => {
		const on = player.GetAttribute(ADMIN_ATTRIBUTE) === true;
		if (on && mode === undefined) {
			mode = enableAdmin(deps);
		} else if (!on && mode !== undefined) {
			mode.destroy();
			mode = undefined;
		}
	};
	player.GetAttributeChangedSignal(ADMIN_ATTRIBUTE).Connect(sync);
	sync();
	// an error in an admin tool must never stop the game frame (reported at most every 5 s)
	let lastError = -math.huge;
	const guard = (hook: string, fn: () => void): void => {
		const [ok, err] = pcall(fn);
		if (!ok && os.clock() - lastError >= 5) {
			lastError = os.clock();
			warn(`[PZ-ADMIN] ${hook} failed: ${tostring(err)}`);
		}
	};
	return {
		beforeUpdate(dt: number): void {
			if (mode !== undefined) guard("beforeUpdate", () => mode?.beforeUpdate(dt));
		},
		afterUpdate(dt: number): void {
			if (mode !== undefined) guard("afterUpdate", () => mode?.afterUpdate(dt));
		},
		afterRender(dt: number): void {
			if (mode !== undefined) guard("afterRender", () => mode?.afterRender(dt));
		},
	};
}
