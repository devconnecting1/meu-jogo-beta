import { COLORS, Z } from "shared/engine/colors";
import { Camera } from "shared/engine/camera";
import { Renderer } from "shared/engine/renderer";
import { InputState } from "shared/engine/input";
import { addSolid } from "shared/game/world";
import { ghostRectSticky, PLACEABLES, placedSolid, placementValid, placeRecipe } from "shared/sim/placement";
import { addItem } from "shared/sim/inventory";
import { GameRefs } from "./types";

/*
 * Build mode of the local survivor: the ghost, its rotation, confirm / cancel and drawing. WHAT can be placed and
 * WHERE is pure and shared (shared/sim/placement.ts, docs/MULTIPLAYER.md §11.2); this is the client's input and view.
 */

export { PLACEABLES } from "shared/sim/placement";
export type { PlaceableDef } from "shared/sim/placement";

export interface Ghost {
	x: number;
	y: number;
	w: number;
	h: number;
	valid: boolean;
}

export class BuildSystem {
	private ghostX = 0;
	private ghostY = 0;
	private ghostW = 0;
	private ghostH = 0;
	private ghostValid = false;
	/** false until the first frame of build mode, so the ghost does not stick to a stale cell */
	private hasGhost = false;
	private rot = 0;
	private active = false;

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
		const def = PLACEABLES[refs.pendingPlace];
		if (def === undefined) {
			refs.pendingPlace = -1;
			this.active = false;
			return;
		}
		const p = refs.player;
		// sticky, not raw: the drawn position now carries the server's per-frame correction, and a plain grid
		// snap on top of that makes the ghost flicker between two cells forever
		const g = ghostRectSticky(
			def,
			p.x,
			p.y,
			p.angle,
			this.rot,
			this.hasGhost ? this.ghostX : undefined,
			this.hasGhost ? this.ghostY : undefined,
		);
		this.ghostX = g.x;
		this.ghostY = g.y;
		this.ghostW = g.w;
		this.ghostH = g.h;
		this.hasGhost = true;
		this.ghostValid = placementValid(refs.world, g, refs.players, refs.zombies);
	}

	private confirm(refs: GameRefs): void {
		if (!this.ghostValid) return;
		const def = PLACEABLES[refs.pendingPlace];
		if (def === undefined) return;
		const r = { x: this.ghostX, y: this.ghostY, w: this.ghostW, h: this.ghostH };
		addSolid(refs.world, placedSolid(def, r, this.rot));
		refs.pendingPlace = -1;
		refs.pendingRecipe = undefined;
		this.active = false;
	}

	private cancel(refs: GameRefs): void {
		const id = refs.pendingPlace;
		if (id >= 0) {
			const r = placeRecipe(id, refs.pendingRecipe);
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
