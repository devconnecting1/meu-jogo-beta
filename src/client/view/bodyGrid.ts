/*
 * The standing bodies of one frame, bucketed by position, for the questions "is anybody within r of this point?" the
 * frame asks many times: a tree canopy turns see-through while a body stands under it (gameLoop.updateCanopy, L6).
 *
 * That test used to walk the whole horde for every tree around the view: O(trees × zombies), a few thousand distance
 * checks a frame in a night fight. Filled once a frame (O(bodies)), the grid answers from the cells under the circle
 * only. The answer is the linear walk's exactly: same bodies, same strict `< r²` test.
 *
 * Nothing is allocated once warm: the cells' arrays are cleared and kept, the key map is cleared in place.
 */

/** world units per cell: about a canopy's diameter, so a tree asks 1-4 cells */
const CELL = 256;
/** cell coordinates are offset so the key stays positive a little outside the town, and packed as cx · SPAN + cy */
const OFFSET = 1024;
const SPAN = 4096;

export class BodyGrid {
	/** key → the flat x, y pairs of the bodies in that cell */
	private readonly cells = new Map<number, Array<number>>();
	/** every array handed to a cell, reused frame after frame */
	private readonly arrays = new Array<Array<number>>();
	private used = 0;
	/** bodies added since the last `clear` */
	private count = 0;

	clear(): void {
		for (let i = 0; i < this.used; i++) this.arrays[i].clear();
		this.used = 0;
		this.cells.clear();
		this.count = 0;
	}

	size(): number {
		return this.count;
	}

	add(x: number, y: number): void {
		const key = keyOf(math.floor(x / CELL), math.floor(y / CELL));
		let cell = this.cells.get(key);
		if (cell === undefined) {
			cell = this.arrays[this.used];
			if (cell === undefined) {
				cell = new Array<number>();
				this.arrays.push(cell);
			}
			this.used += 1;
			this.cells.set(key, cell);
		}
		cell.push(x);
		cell.push(y);
		this.count += 1;
	}

	/** is any body strictly within `r` of (x, y)? */
	anyWithin(x: number, y: number, r: number): boolean {
		if (this.count === 0) return false;
		const r2 = r * r;
		const cx0 = math.floor((x - r) / CELL);
		const cx1 = math.floor((x + r) / CELL);
		const cy0 = math.floor((y - r) / CELL);
		const cy1 = math.floor((y + r) / CELL);
		for (let cx = cx0; cx <= cx1; cx++) {
			for (let cy = cy0; cy <= cy1; cy++) {
				const cell = this.cells.get(keyOf(cx, cy));
				if (cell === undefined) continue;
				for (let i = 0; i < cell.size(); i += 2) {
					const dx = cell[i] - x;
					const dy = cell[i + 1] - y;
					if (dx * dx + dy * dy < r2) return true;
				}
			}
		}
		return false;
	}

	/**
	 * Is any body's centre strictly inside the rect [x0, x1] x [y0, y1]? (A gas station's canopy and price sign turn
	 * see-through while a body is under them, as a crown does: the caller pads the rect by a body's radius.)
	 */
	anyInRect(x0: number, y0: number, x1: number, y1: number): boolean {
		if (this.count === 0) return false;
		const cx0 = math.floor(x0 / CELL);
		const cx1 = math.floor(x1 / CELL);
		const cy0 = math.floor(y0 / CELL);
		const cy1 = math.floor(y1 / CELL);
		for (let cx = cx0; cx <= cx1; cx++) {
			for (let cy = cy0; cy <= cy1; cy++) {
				const cell = this.cells.get(keyOf(cx, cy));
				if (cell === undefined) continue;
				for (let i = 0; i < cell.size(); i += 2) {
					const x = cell[i];
					const y = cell[i + 1];
					if (x > x0 && x < x1 && y > y0 && y < y1) return true;
				}
			}
		}
		return false;
	}
}

function keyOf(cx: number, cy: number): number {
	return (cx + OFFSET) * SPAN + (cy + OFFSET);
}
