import type { GameContext } from "shared/game/context";
import { ItemGroup, itemMax } from "shared/admin/ops";
import type { AdminRequest, AdminResponse } from "shared/admin/protocol";
import {
	ADMIN_WORLD_LIMITS,
	AdminWorldData,
	AdminWorldOp,
	AdminWorldState,
	SpawnKind,
	StructureKind,
} from "shared/admin/worldOps";
import type { ToastKind } from "../ui/popup";
import type { GameLoop } from "../gameLoop";
import { serverOwnsWorld } from "../net/authority";
import { adminRequest, adminRequestAsync } from "./net";
import { ActionResult, LocalAdminWorld } from "./world";

/*
 * The admin panel's world, where the SERVER owns it (MP_PHASE 2, docs/MULTIPLAYER.md §10, F6-6B).
 *
 * LocalAdminWorld edits this client's copy of the world. That was the whole game while every client simulated its
 * own; from MP_PHASE 2 the copy is a mirror of the server's, and every edit of it was overwritten a tick later -- while
 * the panel toasted success, wrote an audit line and marked the run assisted (the admin audit of 2026-09-24, BUG-2).
 * God mode was the dangerous one: the HUD drew a full bar while the server killed the body.
 *
 * So every tool that changes the world is a request here (`{ kind: "world", op }`, shared/admin/worldOps.ts), and the
 * ActionResult the panel toasts IS the server's answer: success only on its OK, its reason otherwise, and `audited`
 * so nothing is logged twice. The switches (god, noclip, infinite ammo, free camera) show what the server says it
 * holds -- the value asked for only while the request is on its way. What stays local is what is only drawn: the free
 * camera's view (the server moves this admin's interest to it, §10), the zoom, the overlays, the placement preview.
 * Offline (no server world) every call falls through to LocalAdminWorld, exactly as before.
 *
 * The requests YIELD (a RemoteFunction round trip): the panel calls them from click handlers, which may. The two that
 * run every frame -- the clock slider and the free camera -- are paced and sent without waiting.
 */

/** the clock slider sends at most this often while it is dragged (the last value always goes) */
const CLOCK_SEND_S = 0.5;
/** the free camera is refreshed this often even standing still (the server lets it lapse after 4 s) */
const CAM_KEEPALIVE_S = 1;
/** a camera move smaller than this is not worth a request */
const CAM_MOVE_EPS = 8;

type Switch = "god" | "noclip" | "ammo";

function isState(v: unknown): v is AdminWorldState {
	if (!typeIs(v, "table")) return false;
	const s = v as Record<string, unknown>;
	return (
		typeIs(s.god, "boolean") &&
		typeIs(s.noclip, "boolean") &&
		typeIs(s.ammo, "boolean") &&
		typeIs(s.freecam, "boolean")
	);
}

export class AdminWorldHost extends LocalAdminWorld {
	/** a refusal or an error that arrives without a click to answer it (the slider, the free camera) */
	notify: (text: string, kind: ToastKind) => void = () => {};
	/** the server marked the admin's own run assisted (§9.3): the panel says so, once per run */
	onServerAssist: () => void = () => {};

	private state: AdminWorldState = { god: false, noclip: false, ammo: false, freecam: false };
	private readonly pending = new Map<Switch, boolean>();
	private clockWant?: number;
	private clockQueued = false;
	private clockAt = -math.huge;
	private camAt = -math.huge;
	private camX = 0;
	private camY = 0;
	private camBusy = false;
	private camWarned = false;

	constructor(
		ctx: GameContext,
		loop: GameLoop,
		overlayParent: GuiObject,
		private readonly selfUserId: number,
	) {
		super(ctx, loop, overlayParent);
	}

	serverWorld(): boolean {
		return serverOwnsWorld();
	}

	/** what the server said about this admin (the switches), from any answer that carries it */
	private adopt(res: AdminResponse): void {
		if (!typeIs(res.data, "table")) return;
		const data = res.data as Partial<AdminWorldData>;
		if (isState(data.state)) this.state = data.state;
		if (data.assisted === true) this.onServerAssist();
		// the body's own noclip is predicted from this switch (client/gameLoop.ts), so it follows the server's word
		this.loop.admin.noclip = this.state.noclip;
	}

	private request(op: AdminWorldOp): AdminRequest {
		return { kind: "world", ...op } as AdminRequest;
	}

	/** one world tool on the server, and ITS answer (YIELDS) */
	private send(op: AdminWorldOp): ActionResult {
		const res = adminRequest(this.request(op));
		this.adopt(res);
		if (!res.ok) return { ok: false, message: res.error ?? "Refused by the server", audited: true };
		return { ok: true, message: res.message ?? "Done", audited: true };
	}

	/** asks the server what it holds for this admin (the panel's first look, after a reconnect) */
	syncState(): void {
		if (!this.serverWorld()) return;
		adminRequestAsync(this.request({ op: "state" }), res => {
			if (res.ok) this.adopt(res);
		});
	}

	// ------------------------------------------------------------ spawning

	spawnZombies(kind: SpawnKind, count: number, x: number, y: number, chase: boolean): ActionResult {
		if (!this.serverWorld()) return super.spawnZombies(kind, count, x, y, chase);
		if (!this.ready()) return { ok: false, message: "Start a run first" };
		const n = math.clamp(math.floor(count), 1, ADMIN_WORLD_LIMITS.SPAWN_PER_REQUEST);
		return this.send({ op: "spawn", spawn: kind, count: n, x, y, chase });
	}

	spawnItem(group: ItemGroup, index: number, count: number, x: number, y: number): ActionResult {
		if (!this.serverWorld()) return super.spawnItem(group, index, count, x, y);
		if (!this.ready()) return { ok: false, message: "Start a run first" };
		const n = math.clamp(math.floor(count), 1, itemMax(group));
		return this.send({ op: "spawnItem", group, index, count: n, x, y });
	}

	spawnStructure(kind: StructureKind, x: number, y: number): ActionResult {
		if (!this.serverWorld()) return super.spawnStructure(kind, x, y);
		if (!this.ready()) return { ok: false, message: "Start a run first" };
		return this.send({ op: "spawnStructure", structure: kind, x, y });
	}

	// ------------------------------------------------------------ time & weather

	setClock(hour: number): void {
		if (!this.serverWorld()) {
			super.setClock(hour);
			return;
		}
		this.clockWant = hour;
		if (this.clockQueued) return;
		this.clockQueued = true;
		task.delay(math.max(0, this.clockAt + CLOCK_SEND_S - os.clock()), () => this.flushClock());
	}

	private flushClock(): void {
		this.clockQueued = false;
		const hour = this.clockWant;
		if (hour === undefined) return;
		this.clockWant = undefined;
		this.clockAt = os.clock();
		const res = this.send({ op: "clock", hour: math.clamp(hour, 0, 23.99) });
		if (!res.ok) this.notify(res.message, "error");
	}

	skipToNight(): ActionResult {
		return this.serverWorld() ? this.send({ op: "night" }) : super.skipToNight();
	}

	skipToDawn(): ActionResult {
		return this.serverWorld() ? this.send({ op: "dawn" }) : super.skipToDawn();
	}

	forceWave(): ActionResult {
		return this.serverWorld() ? this.send({ op: "wave" }) : super.forceWave();
	}

	setRain(on: boolean): ActionResult {
		return this.serverWorld() ? this.send({ op: "rain", on }) : super.setRain(on);
	}

	// ------------------------------------------------------------ population

	killAll(): ActionResult {
		return this.serverWorld() ? this.send({ op: "killAll", radius: 0, x: 0, y: 0 }) : super.killAll();
	}

	clearCorpses(): ActionResult {
		// the server clears its acid and tells every client (this one included) to drop its blood and bodies
		return this.serverWorld() ? this.send({ op: "clearFx" }) : super.clearCorpses();
	}

	// ------------------------------------------------------------ the survivor

	heal(): ActionResult {
		if (!this.serverWorld()) return super.heal();
		if (!this.ready()) return { ok: false, message: "Start a run first" };
		return this.send({ op: "heal", userId: this.selfUserId });
	}

	private toggle(key: Switch, on: boolean): ActionResult {
		this.pending.set(key, on);
		const res = this.send({ op: key, on });
		this.pending.delete(key);
		return res;
	}

	private switchOf(key: Switch): boolean {
		return this.pending.get(key) ?? this.state[key];
	}

	setGod(on: boolean): ActionResult {
		return this.serverWorld() ? this.toggle("god", on) : super.setGod(on);
	}

	god(): boolean {
		return this.serverWorld() ? this.switchOf("god") : super.god();
	}

	setInfiniteAmmo(on: boolean): ActionResult {
		return this.serverWorld() ? this.toggle("ammo", on) : super.setInfiniteAmmo(on);
	}

	infiniteAmmo(): boolean {
		return this.serverWorld() ? this.switchOf("ammo") : super.infiniteAmmo();
	}

	setNoclip(on: boolean): ActionResult {
		return this.serverWorld() ? this.toggle("noclip", on) : super.setNoclip(on);
	}

	noclip(): boolean {
		return this.serverWorld() ? this.switchOf("noclip") : super.noclip();
	}

	teleport(x: number, y: number): ActionResult {
		if (!this.serverWorld()) return super.teleport(x, y);
		if (!this.ready()) return { ok: false, message: "Start a run first" };
		const res = adminRequest(this.request({ op: "teleport", x, y }));
		this.adopt(res);
		if (!res.ok) return { ok: false, message: res.error ?? "Refused by the server", audited: true };
		// the body moves on the server; the prediction snaps to it with the next snapshot, the camera goes now
		const data = typeIs(res.data, "table") ? (res.data as Partial<AdminWorldData>) : undefined;
		if (data !== undefined && typeIs(data.x, "number") && typeIs(data.y, "number") && !this.ctx.cam.detached) {
			this.ctx.cam.x = data.x;
			this.ctx.cam.y = data.y;
		}
		return { ok: true, message: res.message ?? "Teleported", audited: true };
	}

	// ------------------------------------------------------------ view

	setFreeCam(on: boolean): void {
		if (!this.serverWorld()) {
			super.setFreeCam(on);
			return;
		}
		const was = this.freeOn;
		this.freeOn = on;
		this.ctx.cam.setDetached(on);
		// the survivor stands still while the camera flies (no movement in its commands) -- and, unlike a world of its
		// own, it is NOT invulnerable: the server's body stays where it is and can still be bitten
		this.loop.admin.frozen = on;
		if (!on) {
			const p = this.refs().player;
			this.ctx.cam.x = p.x;
			this.ctx.cam.y = p.y;
		}
		if (on !== was) this.sendCam(on);
	}

	/** tells the server where this admin looks (it sends what is around that point, §10); never waits */
	private sendCam(on: boolean): void {
		const cam = this.ctx.cam;
		this.camAt = os.clock();
		this.camX = cam.x;
		this.camY = cam.y;
		if (on) this.camBusy = true;
		adminRequestAsync(this.request({ op: "freecam", on, x: cam.x, y: cam.y }), res => {
			if (on) this.camBusy = false;
			this.adopt(res);
			if (res.ok || !on || this.camWarned) return;
			// once per session: the camera still flies, but the server keeps sending what is around the body
			this.camWarned = true;
			this.notify(`Free camera: ${res.error ?? "refused"} (only what is near your survivor is sent)`, "error");
		});
	}

	afterRender(dt: number): void {
		super.afterRender(dt);
		if (!this.freeOn || this.camBusy || !this.serverWorld()) return;
		const cam = this.ctx.cam;
		const now = os.clock();
		const moved = math.abs(cam.x - this.camX) + math.abs(cam.y - this.camY) > CAM_MOVE_EPS;
		if ((moved && now - this.camAt >= 1 / ADMIN_WORLD_LIMITS.FREECAM_HZ) || now - this.camAt >= CAM_KEEPALIVE_S) {
			this.sendCam(true);
		}
	}

	hasFlowField(): boolean {
		// the horde (and its field) is the server's: this client has nothing to draw
		return !this.serverWorld() && super.hasFlowField();
	}

	// ------------------------------------------------------------ frame hooks

	protected syncGod(): void {
		// the server's god travels in the snapshot's modFlags (client/net/prediction.ts): never overwritten here
		if (!this.serverWorld()) super.syncGod();
	}

	beforeUpdate(): void {
		if (!this.serverWorld()) {
			super.beforeUpdate();
			return;
		}
		this.loop.admin.noclip = this.noclip();
	}

	afterUpdate(): void {
		// god mode's top-up and infinite ammo's refund are the server's now: nothing to fake on this screen
		if (!this.serverWorld()) super.afterUpdate();
	}

	reset(): void {
		if (!this.serverWorld()) {
			super.reset();
			return;
		}
		// the local half at once; the server's switches are turned off without waiting (this runs on teardown)
		if (this.freeOn) this.setFreeCam(false);
		for (const key of ["god", "noclip", "ammo"] as Array<Switch>) {
			if (this.state[key]) adminRequestAsync(this.request({ op: key, on: false }));
		}
		this.resetView();
	}
}
