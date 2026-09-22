import { COLORS, Z } from "shared/engine/colors";
import { Camera } from "shared/engine/camera";
import { Renderer } from "shared/engine/renderer";
import { InputState } from "shared/engine/input";
import { CRAFT_RECIPES, CraftRecipe } from "shared/data/crafts";
import { PLAYER_RADIUS, ZOMBIE_RADIUS } from "shared/game/physics";
import { SolidKind, addSolid, querySolids } from "shared/game/world";
import { addItem } from "./items";
import { GameRefs } from "./types";

export interface PlaceableDef {
	tag: string;
	kind: SolidKind;
	w: number;
	h: number;
	hp: number;
	destructible: boolean;
	rotatable: boolean;
	powered?: boolean;
}

function p(
	tag: string,
	kind: SolidKind,
	w: number,
	h: number,
	hp: number,
	destructible = true,
	rotatable = false,
	powered?: boolean,
): PlaceableDef {
	return { tag, kind, w, h, hp, destructible, rotatable, powered };
}

export const PLACEABLES: Record<number, PlaceableDef> = {
	0: p("craftdesk", "structure", 96, 72, 200),
	1: p("craftdesk_pro", "structure", 112, 80, 400),
	2: p("turret", "structure", 64, 64, 400),
	3: p("turret_drone", "structure", 48, 48, 300),
	4: p("lamp", "structure", 48, 48, 400, true, false, false),
	5: p("lamp_drone", "structure", 40, 40, 300, true, false, false),
	6: p("battery", "structure", 40, 40, 300),
	7: p("generator", "structure", 72, 72, 500),
	8: p("generator", "structure", 80, 80, 500),
	9: p("generator", "structure", 72, 72, 500),
	10: p("barricade", "barricade", 128, 32, 700, true, true),
	11: p("door", "door", 96, 24, 500, true, true),
	12: p("iron_barricade", "iron_barricade", 128, 32, 1700, true, true),
	13: p("iron_door", "iron_door", 96, 24, 1500, true, true),
	14: p("campfire", "structure", 64, 64, 400, true, false, true),
	15: p("brazier", "structure", 64, 64, 400, true, false, true),
	16: p("electric_turret", "structure", 64, 64, 400),
	17: p("trap", "structure", 64, 64, 100),
	18: p("gps", "structure", 48, 48, 100),
	19: p("cooker", "structure", 56, 48, 300),
	20: p("furnace", "structure", 56, 48, 300),
	21: p("vehicle", "structure", 64, 40, 100),
	22: p("vehicle", "structure", 72, 44, 120),
	39: p("craftdesk", "structure", 96, 72, 240),
	40: p("craftdesk_pro", "structure", 112, 80, 480),
};

export interface Ghost {
	x: number;
	y: number;
	w: number;
	h: number;
	valid: boolean;
}

/** closest-point (rect×circle) overlap test */
function rectCircleOverlap(
	rx: number,
	ry: number,
	rw: number,
	rh: number,
	cx: number,
	cy: number,
	cr: number,
): boolean {
	const qx = math.clamp(cx, rx, rx + rw);
	const qy = math.clamp(cy, ry, ry + rh);
	const dx = cx - qx;
	const dy = cy - qy;
	return dx * dx + dy * dy < cr * cr;
}

/** the craftKind-1 recipe that produced `resultIndex`, preferring the one recorded at craft time */
function recipeFor(refs: GameRefs, resultIndex: number): CraftRecipe | undefined {
	const pendingId = refs.pendingRecipe;
	if (pendingId !== undefined) {
		const r = CRAFT_RECIPES[pendingId];
		if (r !== undefined && r.craftKind === 1 && r.resultIndex === resultIndex) return r;
	}
	for (const r of CRAFT_RECIPES) {
		if (r.craftKind === 1 && r.resultIndex === resultIndex) return r;
	}
	return undefined;
}

export class BuildSystem {
	private ghostX = 0;
	private ghostY = 0;
	private ghostW = 0;
	private ghostH = 0;
	private ghostValid = false;
	private rot = 0;
	private active = false;

	private defFor(id: number): PlaceableDef | undefined {
		return PLACEABLES[id];
	}

	rotate(): void {
		this.rot = (this.rot + 1) % 4;
	}

	handleInput(refs: GameRefs, input: InputState): boolean {
		if (refs.pendingPlace < 0) {
			this.active = false;
			return false;
		}
		if (!this.active) {
			this.active = true;
			this.rot = 0;
		}
		if (input.reloadPressed) {
			this.rotate();
		}
		if (input.actionPressed) {
			this.cancel(refs);
			input.attackBlocked = true;
			return true;
		}
		if (input.attackPressed) {
			this.confirm(refs);
			input.attackBlocked = true;
			return true;
		}
		return true;
	}

	update(refs: GameRefs): void {
		if (refs.pendingPlace < 0) {
			this.active = false;
			return;
		}
		const def = this.defFor(refs.pendingPlace);
		if (def === undefined) {
			refs.pendingPlace = -1;
			this.active = false;
			return;
		}
		const p = refs.player;
		const aim = p.angle;
		const cx = p.x + math.cos(aim) * 96;
		const cy = p.y + math.sin(aim) * 96;
		let w = def.w;
		let h = def.h;
		if (def.rotatable && (this.rot === 1 || this.rot === 3)) {
			w = def.h;
			h = def.w;
		}
		const gx = math.floor((cx - w / 2) / 128 + 0.5) * 128;
		const gy = math.floor((cy - h / 2) / 128 + 0.5) * 128;
		this.ghostX = gx;
		this.ghostY = gy;
		this.ghostW = w;
		this.ghostH = h;
		let valid = gx >= 0 && gy >= 0 && gx + w < refs.world.width && gy + h < refs.world.height;
		if (valid) {
			for (const s of querySolids(refs.world, gx, gy, gx + w, gy + h)) {
				if (s.passable === true) continue;
				if (gx < s.x + s.w && gx + w > s.x && gy < s.y + s.h && gy + h > s.y) {
					valid = false;
					break;
				}
			}
		}
		if (valid && rectCircleOverlap(gx, gy, w, h, p.x, p.y, PLAYER_RADIUS)) {
			valid = false;
		}
		if (valid) {
			for (const z of refs.zombies) {
				if (z.hp <= 0) continue;
				const zr = ZOMBIE_RADIUS * (z.scale ?? 1);
				if (rectCircleOverlap(gx, gy, w, h, z.x, z.y, zr)) {
					valid = false;
					break;
				}
			}
		}
		this.ghostValid = valid;
	}

	private confirm(refs: GameRefs): void {
		if (!this.ghostValid) return;
		const id = refs.pendingPlace;
		const def = this.defFor(id);
		if (def === undefined) return;
		addSolid(refs.world, {
			kind: def.kind,
			x: this.ghostX,
			y: this.ghostY,
			w: this.ghostW,
			h: this.ghostH,
			hp: def.hp,
			hpMax: def.hp,
			destructible: def.destructible,
			tags: def.tag,
			rot: this.rot,
			open: def.kind === "door" || def.kind === "iron_door" ? false : undefined,
			powered: def.powered,
		});
		refs.pendingPlace = -1;
		refs.pendingRecipe = undefined;
		this.active = false;
	}

	private cancel(refs: GameRefs): void {
		const id = refs.pendingPlace;
		if (id >= 0) {
			const r = recipeFor(refs, id);
			if (r !== undefined) {
				for (const ing of r.ingredients) {
					addItem(refs.save, ing.kind, ing.index, ing.count);
				}
			}
		}
		refs.pendingPlace = -1;
		refs.pendingRecipe = undefined;
		this.active = false;
	}

	draw(renderer: Renderer, cam: Camera): void {
		if (!this.active || this.ghostW <= 0) return;
		const color = this.ghostValid ? COLORS.uiGreen : COLORS.uiRed;
		renderer.drawRect(cam, this.ghostX + this.ghostW / 2, this.ghostY + this.ghostH / 2, {
			w: this.ghostW,
			h: this.ghostH,
			color,
			alpha: 0.45,
			zIndex: Z.outline,
		});
	}

	getGhost(): Ghost | undefined {
		if (!this.active || this.ghostW <= 0) return undefined;
		return { x: this.ghostX, y: this.ghostY, w: this.ghostW, h: this.ghostH, valid: this.ghostValid };
	}
}
