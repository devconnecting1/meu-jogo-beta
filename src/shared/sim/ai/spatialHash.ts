/*
 * Uniform spatial hash of the horde (docs/MULTIPLAYER.md §3.4).
 *
 * The original pushes bodies apart with an O(n²) pass: 150 zombies are 11 175 pair tests every frame, and that
 * is what makes a big horde unaffordable. A 64 u grid — wider than two of the biggest bodies (23 u radius) —
 * means a body only ever tests the neighbours that could actually touch it, which is O(n) in practice.
 *
 * The same index answers "which zombies are near this point": the interest query of §4.3, the door that must
 * not close on a body, and the traps all want exactly that, and none of them should walk the whole list.
 *
 * Pure: indices and coordinates in, indices out. No world, no Instances.
 */

/** cell side in world units: wider than 2 × the biggest body, so a pair can only miss by being in range */
export const HASH_CELL = 64;
/** grid origin offset in cells: the town is ~700 × 520 cells, this keeps every key positive */
const ORIGIN = 4096;
/** stride of the key; comfortably wider than any town */
const STRIDE = 8192;

export class SpatialHash {
	readonly cell: number;
	private readonly buckets = new Map<number, Array<number>>();
	/** recycled bucket arrays: a rebuild every tick must not allocate 150 tables */
	private readonly pool: Array<Array<number>> = [];
	private used = 0;

	constructor(cell = HASH_CELL) {
		this.cell = cell;
	}

	private key(x: number, y: number): number {
		const gx = math.floor(x / this.cell) + ORIGIN;
		const gy = math.floor(y / this.cell) + ORIGIN;
		return gy * STRIDE + gx;
	}

	/** drop everything (call once per rebuild, before the inserts) */
	begin(): void {
		this.buckets.clear();
		this.used = 0;
	}

	insert(index: number, x: number, y: number): void {
		const key = this.key(x, y);
		let b = this.buckets.get(key);
		if (b === undefined) {
			if (this.used < this.pool.size()) {
				b = this.pool[this.used];
				b.clear();
			} else {
				b = new Array<number>();
				this.pool.push(b);
			}
			this.used += 1;
			this.buckets.set(key, b);
		}
		b.push(index);
	}

	/**
	 * Appends to `out` every index in the 3×3 block of cells around (x, y) — the only ones that can hold a
	 * body within one cell of the point. The caller still does the exact distance test.
	 */
	neighbours(x: number, y: number, out: Array<number>): Array<number> {
		const gx = math.floor(x / this.cell) + ORIGIN;
		const gy = math.floor(y / this.cell) + ORIGIN;
		for (let oy = -1; oy <= 1; oy++) {
			const row = (gy + oy) * STRIDE + gx;
			for (let ox = -1; ox <= 1; ox++) {
				const b = this.buckets.get(row + ox);
				if (b === undefined) continue;
				for (const i of b) out.push(i);
			}
		}
		return out;
	}

	/**
	 * Same, for a radius that may be wider than one cell: every index in the cells the circle touches.
	 * Indices may repeat only if the caller inserted them twice; each bucket is visited once.
	 */
	within(x: number, y: number, radius: number, out: Array<number>): Array<number> {
		const c = this.cell;
		const gx0 = math.floor((x - radius) / c) + ORIGIN;
		const gx1 = math.floor((x + radius) / c) + ORIGIN;
		const gy0 = math.floor((y - radius) / c) + ORIGIN;
		const gy1 = math.floor((y + radius) / c) + ORIGIN;
		for (let gy = gy0; gy <= gy1; gy++) {
			const row = gy * STRIDE;
			for (let gx = gx0; gx <= gx1; gx++) {
				const b = this.buckets.get(row + gx);
				if (b === undefined) continue;
				for (const i of b) out.push(i);
			}
		}
		return out;
	}
}
