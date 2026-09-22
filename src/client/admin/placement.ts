import type { GameContext } from "shared/game/context";
import type { ItemGroup } from "shared/admin/ops";
import { TEXT, THEME, TRANSPARENCY, space } from "../ui/theme";
import { Card, makeAnchored, makeLabel } from "../ui/widgets";
import { toast } from "../ui/popup";
import type { PlacementPreview } from "./overlay";
import type { ActionResult, AdminWorld, SpawnKind, StructureKind, WorldPoint } from "./world";
import { logLocal } from "./net";

/*
 * "Click to place" mode of the admin panel: a ghost with the real footprint follows the cursor (snapped to the
 * nearest free point, never inside a solid), left click places, Shift+click keeps the mode for more, right click or
 * the panel key (F2 / `) cancels. Everything goes through AdminWorld.
 */

const UserInputService = game.GetService("UserInputService");

/** the preview searches a smaller area than a real spawn (it runs every frame) */
const PREVIEW_SEARCH = 160;

export type PlacementSpec =
	| { kind: "zombie"; spawn: SpawnKind; count: number; chase: boolean; label: string }
	| { kind: "item"; group: ItemGroup; index: number; count: number; label: string }
	| { kind: "structure"; structure: StructureKind; label: string }
	| { kind: "teleport"; label: string };

function fmtPoint(p: WorldPoint): string {
	return `(${math.floor(p.x)}, ${math.floor(p.y)})`;
}

export class Placement {
	private spec?: PlacementSpec;
	private pill?: Frame;
	/** the next game-side action press (right click) belongs to the placement, not to the survivor */
	swallowAction = false;

	constructor(
		private readonly ctx: GameContext,
		private readonly world: AdminWorld,
		private readonly gui: ScreenGui,
	) {}

	active(): boolean {
		return this.spec !== undefined;
	}

	begin(spec: PlacementSpec): void {
		if (!this.world.ready()) {
			toast(this.ctx, "Start a run first: world tools act on your own world", "error");
			return;
		}
		this.spec = spec;
		this.showPill(spec);
	}

	cancel(): void {
		this.spec = undefined;
		this.world.setPreview(undefined);
		this.pill?.Destroy();
		this.pill = undefined;
	}

	private showPill(spec: PlacementSpec): void {
		this.pill?.Destroy();
		const w = 620;
		const h = 52;
		const box = makeAnchored(this.gui, "PlacementPill", 0.5, 0, w, h, 0, 84, true);
		box.ZIndex = 50;
		const card = Card(box, "Card", {
			x: 0,
			y: 0,
			w,
			h,
			variant: "popover",
			transparency: TRANSPARENCY.hud,
			border: THEME.ring,
			zIndex: 50,
		});
		makeLabel(
			card,
			"Title",
			`Placing: ${spec.label}`,
			space(4),
			4,
			w - space(8),
			24,
			TEXT.sm,
			THEME.popoverForeground,
			{
				font: "label",
				align: "left",
				zIndex: 51,
			},
		);
		makeLabel(
			card,
			"Hint",
			"Click the map · Shift+click keeps placing · right-click or F2 cancels",
			space(4),
			26,
			w - space(8),
			20,
			TEXT.xs,
			THEME.mutedForeground,
			{ align: "left", zIndex: 51 },
		);
		this.pill = box;
	}

	private cursorWorld(): WorldPoint {
		const m = UserInputService.GetMouseLocation();
		return this.world.screenToWorld(m.X, m.Y);
	}

	/** where the current spec would go for the cursor at `c`, and whether it can */
	private resolve(c: WorldPoint): PlacementPreview | undefined {
		const spec = this.spec;
		if (spec === undefined) return undefined;
		const player = this.world.playerPosition();
		const inRange = (p: WorldPoint, range: number): boolean =>
			math.abs(p.x - player.x) <= range && math.abs(p.y - player.y) <= range;
		if (spec.kind === "structure") {
			const [w, h] = this.world.structureSize(spec.structure);
			return {
				shape: "rect",
				x: c.x,
				y: c.y,
				cursorX: c.x,
				cursorY: c.y,
				r: 0,
				w,
				h,
				count: 1,
				valid: this.world.canPlaceStructure(spec.structure, c.x, c.y),
			};
		}
		let r = 18;
		let count = 1;
		let range = math.huge;
		if (spec.kind === "zombie") {
			r = this.world.spawnRadius(spec.spawn);
			count = spec.count;
			// bosses are not recycled by the spawner; zombies too far from the survivor are
			if (spec.spawn.sub(1, 4) !== "boss") range = this.world.spawnRange("zombie");
		} else if (spec.kind === "item") {
			r = 10;
			range = this.world.spawnRange("item");
		}
		const at = this.world.freePoint(c.x, c.y, r + 2, PREVIEW_SEARCH);
		const p = at ?? c;
		return {
			shape: "circle",
			x: p.x,
			y: p.y,
			cursorX: c.x,
			cursorY: c.y,
			r,
			w: 0,
			h: 0,
			count,
			valid: at !== undefined && inRange(p, range),
		};
	}

	/** every frame while the admin panel exists */
	frame(): void {
		if (this.spec === undefined) return;
		if (!this.world.ready()) {
			this.cancel();
			return;
		}
		this.world.setPreview(this.resolve(this.cursorWorld()));
	}

	/** left click on the map (not on a GUI) while placing */
	place(shift: boolean): void {
		const spec = this.spec;
		if (spec === undefined) return;
		const c = this.cursorWorld();
		let res: ActionResult;
		let what: string;
		if (spec.kind === "zombie") {
			res = this.world.spawnZombies(spec.spawn, spec.count, c.x, c.y, spec.chase);
			what = `spawn ${spec.label} ×${spec.count} ${spec.chase ? "chasing" : "wandering"} at ${fmtPoint(c)}`;
		} else if (spec.kind === "item") {
			res = this.world.spawnItem(spec.group, spec.index, spec.count, c.x, c.y);
			what = `item ${spec.label} ×${spec.count} at ${fmtPoint(c)}`;
		} else if (spec.kind === "structure") {
			res = this.world.spawnStructure(spec.structure, c.x, c.y);
			what = `structure ${spec.label} at ${fmtPoint(c)}`;
		} else {
			res = this.world.teleport(c.x, c.y);
			what = `teleport to ${fmtPoint(c)}`;
		}
		if (res.ok) logLocal(spec.kind === "teleport" ? "teleport" : "spawn", what);
		toast(this.ctx, res.message, res.ok ? "success" : "error");
		// a teleport is one-shot; spawns stay armed with Shift
		if (!shift || spec.kind === "teleport") {
			if (res.ok) this.cancel();
		}
	}
}
