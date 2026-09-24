import { ADMIN_ATTRIBUTE } from "shared/admin/config";
import type { AdminRequest, AdminResponse, PlayerRow } from "shared/admin/protocol";
import { langGet } from "shared/data/lang";
import type { GameContext } from "shared/game/context";
import type { GameLoop } from "../gameLoop";
import { InputDevice, inputDevice, onInputDeviceChanged } from "../ui/device";
import { TEXT, THEME, space } from "../ui/theme";
import { Button, Card, ToastKind, makeAnchored, makeLabel, showToast } from "../ui/widgets";
import { adminRequest, adminRequestAsync, logLocal, onAdminEvent, startAdminNet } from "./net";
import { AdminPanel } from "./panel";
import { PanelCtx, SectionId } from "./panelTypes";
import { startAdminListeners } from "./patches";
import { Placement } from "./placement";
import { worldPrefs } from "./sectionWorld";
import { AdminWorldHost } from "./serverWorld";

/*
 * Admin mode entry point (wired by main.client.ts).
 * - every client: admin networking + save patches + announcements (patches.ts)
 * - admins only (the server sets the PZAdmin attribute after checking the UserId): the panel, the ADMIN button, the
 *   debug overlay and the input bindings are created; nothing of it exists for other players
 * - opening the panel, on every device an admin may hold: F2 (or `) on a keyboard (neither key is taken by the
 *   Roblox CoreGui: it uses Esc, F9, F11, F12), R3 (the right stick's click, which the game uses for nothing) on a
 *   pad, and the ADMIN button itself -- a click, or a tap on a phone, where it grows to a thumb's size and moves to
 *   the top-left corner, away from the stick. B / Backspace close it like any screen (client/ui/backStack.ts)
 * - world tools go to the server when it owns the world (client/admin/serverWorld.ts, docs/MULTIPLAYER.md §10)
 */

const Players = game.GetService("Players");
const RunService = game.GetService("RunService");
const UserInputService = game.GetService("UserInputService");

const PANEL_KEYS = new Set<Enum.KeyCode>([Enum.KeyCode.F2, Enum.KeyCode.Backquote]);
/** the pad's way to the panel: the right stick's click (the game binds nothing to it, client/bootstrap.ts) */
const PANEL_PAD_KEY = Enum.KeyCode.ButtonR3;
/** the ADMIN button: a small plate at the bottom-left with a mouse; a thumb's target (>= 44 px on a phone) on touch */
const BADGE_W = 110;
const BADGE_H = 28;
const BADGE_TOUCH_W = 132;
const BADGE_TOUCH_H = 76;
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
	// the device safe area, like the HUD's and the menus' (client/bootstrap.ts): the frame the kit lays out in
	gui.ScreenInsets = Enum.ScreenInsets.DeviceSafeInsets;
	gui.DisplayOrder = 150;
	gui.ZIndexBehavior = Enum.ZIndexBehavior.Sibling;
	// the panel is full of names and typed text, and is English on purpose (UI-03): none of it is captured for
	// automatic translation (compliance F9) -- the ScreenGui AND every label in it, as the announcement banner does,
	// rather than rely on the property reaching descendants
	gui.AutoLocalize = false;
	conns.push(
		gui.DescendantAdded.Connect(d => {
			if (d.IsA("GuiBase2d")) d.AutoLocalize = false;
		}),
	);
	gui.Parent = ctx.playerGui;

	// debug overlays: inside the world's root (the whole screen, like the world), above the night (Dark = 80); the HUD and
	// the menus are ScreenGuis of their own above it (client/bootstrap.ts)
	const overlayLayer = new Instance("Frame");
	overlayLayer.Name = "AdminOverlay";
	overlayLayer.Size = UDim2.fromScale(1, 1);
	overlayLayer.BackgroundTransparency = 1;
	overlayLayer.BorderSizePixel = 0;
	overlayLayer.Active = false;
	overlayLayer.ZIndex = 86;
	overlayLayer.Parent = ctx.root;

	const world = new AdminWorldHost(ctx, loop, overlayLayer, player.UserId);
	// a world tool changed the run of a world this client simulates: tell the server once per run (it stops crediting
	// coins / achievements / records). Where the server owns the world it marks the run itself and says so
	let assistedRunRev = -1;
	world.onAssist = what => {
		const runRev = ctx.save.runRev;
		if (runRev === assistedRunRev) return;
		assistedRunRev = runRev;
		adminRequestAsync({ kind: "assist" }, res => {
			if (res.ok) notify(`Assisted run (${what}): no coins, achievements or records from it`, "info");
		});
	};
	world.onServerAssist = () => {
		const runRev = ctx.save.runRev;
		if (runRev === assistedRunRev) return;
		assistedRunRev = runRev;
		notify("Assisted run: no coins, achievements or records from it", "info");
	};
	world.notify = (text, kind) => notify(text, kind);
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
		`${player.Name} · UserId ${player.UserId} · F2, \` or R3 toggles · world tools act on the town you play in`,
	);

	/** opens or closes the panel; `pad`: opened from a gamepad, which then needs a control selected to navigate */
	const togglePanel = (pad: boolean): void => {
		if (placement.active()) {
			placement.cancel();
			return;
		}
		panel?.toggle();
		if (panel !== undefined && panel.isOpen()) {
			world.syncState();
			if (pad) panel.focusFirst();
		}
	};

	// the ADMIN button: a discreet plate at the bottom-left, a thumb-sized one at the top-left on a touch screen (the
	// left half of a phone is the movement stick's; the top-left corner under the Roblox bar is the least in its way)
	let badgeBox: Frame | undefined;
	const buildBadge = (device: InputDevice): void => {
		badgeBox?.Destroy();
		const touch = device === "touch";
		const w = touch ? BADGE_TOUCH_W : BADGE_W;
		const h = touch ? BADGE_TOUCH_H : BADGE_H;
		const key = device === "gamepad" ? "R3" : "F2";
		const box = makeAnchored(gui, "AdminBadge", 0, touch ? 0 : 1, w, h, 14, 14, touch);
		Button(
			box,
			"Badge",
			touch
				? langGet("ADMIN", ctx.save.settings.langType)
				: `${langGet("ADMIN", ctx.save.settings.langType)} · ${key}`,
			{
				x: 0,
				y: 0,
				w,
				h,
				size: "sm",
				variant: "secondary",
				onClick: () => togglePanel(device === "gamepad"),
			},
		);
		badgeBox = box;
	};
	buildBadge(inputDevice());
	const deviceConn = onInputDeviceChanged(device => buildBadge(device));
	if (deviceConn !== undefined) conns.push(deviceConn);

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
				togglePanel(false);
				return;
			}
			if (input.KeyCode === PANEL_PAD_KEY) {
				togglePanel(true);
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
					// (a server teleport YIELDS: this handler runs in a thread of its own)
					const res = world.teleport(at.x, at.y);
					const where = `ctrl+click to (${math.floor(at.x)}, ${math.floor(at.y)})`;
					if (!res.ok) notify(res.message, "error");
					else if (!res.audited) logLocal("teleport", where);
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
