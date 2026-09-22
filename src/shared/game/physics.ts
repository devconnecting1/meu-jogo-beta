import { Solid, WorldData, rectHitsSolid } from "./world";

export interface MoveResult {
	x: number;
	y: number;
	/** first solid that blocked the move, if any */
	hit?: Solid;
}

/**
 * Move a circular actor by (dx, dy) against the world's solids, sliding along walls.
 * Used for the player (gameLoop) and zombies (zombieAI).
 */
export function moveActor(world: WorldData, x: number, y: number, radius: number, dx: number, dy: number): MoveResult {
	let hit: Solid | undefined;
	let nx = x + dx;
	const hx = rectHitsSolid(world, nx, y, radius * 2, radius * 2);
	if (hx) {
		nx = x;
		hit = hx;
	}
	let ny = y + dy;
	const hy = rectHitsSolid(world, nx, ny, radius * 2, radius * 2);
	if (hy) {
		ny = y;
		hit = hit ?? hy;
	}
	return { x: nx, y: ny, hit };
}
