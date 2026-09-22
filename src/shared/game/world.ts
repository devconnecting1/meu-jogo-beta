import { COLORS, Z } from "shared/engine/colors";
import { DESIGN } from "shared/engine/constants";
import { chance, rnd, rndInt, rndRange } from "shared/engine/rng";
import { Vec2, v2, v2dist } from "shared/engine/vec2";

export type SolidKind =
	| "wall_h"
	| "wall_v"
	| "building"
	| "tree"
	| "car"
	| "barricade"
	| "iron_barricade"
	| "door"
	| "iron_door"
	| "structure";

export interface Solid {
	id: number;
	kind: SolidKind;
	x: number;
	y: number;
	w: number;
	h: number;
	hp: number;
	hpMax: number;
	/** building only */
	buildingType?: number;
	roofColor?: Color3;
	roofAlpha?: number;
	open?: boolean;
	/** loot slots */
	lootSlots?: number;
	lootItems?: Array<{ kind: number; id: number; count: number }>;
	lootTimer?: number;
	powered?: boolean;
	rot?: number;
	destructible: boolean;
	tags: string;
}

export interface GroundItem {
	id: number;
	kind: number;
	itemId: number;
	count: number;
	x: number;
	y: number;
	vx: number;
	vy: number;
	life: number;
}

export interface WorldData {
	solids: Array<Solid>;
	items: Array<GroundItem>;
	width: number;
	height: number;
	roads: Array<{ x: number; y: number; w: number; h: number }>;
	bossAnchors: Array<{ day: number; x: number; y: number; type: number; nextDay: number }>;
	nextId: number;
}

function rectOverlap(
	ax: number,
	ay: number,
	aw: number,
	ah: number,
	bx: number,
	by: number,
	bw: number,
	bh: number,
): boolean {
	return ax < bx + bw && ax + aw > bx && ay < by + bh && ay + ah > by;
}

export function createWorld(width: number, height: number): WorldData {
	return {
		solids: [],
		items: [],
		width,
		height,
		roads: [],
		bossAnchors: [
			{ day: DESIGN.BOSS1_DAY, x: DESIGN.BOSS1_X, y: DESIGN.BOSS1_Y, type: 1, nextDay: DESIGN.BOSS1_DAY },
			{ day: DESIGN.BOSS2_DAY, x: DESIGN.BOSS2_X, y: DESIGN.BOSS2_Y, type: 2, nextDay: DESIGN.BOSS2_DAY },
			{ day: DESIGN.BOSS3_DAY, x: DESIGN.BOSS3_X, y: DESIGN.BOSS3_Y, type: 3, nextDay: DESIGN.BOSS3_DAY },
			{ day: DESIGN.BOSS4_DAY, x: DESIGN.BOSS4_X, y: DESIGN.BOSS4_Y, type: 4, nextDay: DESIGN.BOSS4_DAY },
		],
		nextId: 1,
	};
}

export function addSolid(w: WorldData, s: Omit<Solid, "id">): Solid {
	const solid: Solid = { ...s, id: w.nextId++ };
	w.solids.push(solid);
	return solid;
}

export function pointInSolid(w: WorldData, x: number, y: number, pad = 0): Solid | undefined {
	for (const s of w.solids) {
		if (x >= s.x - pad && x <= s.x + s.w + pad && y >= s.y - pad && y <= s.y + s.h + pad) {
			return s;
		}
	}
	return undefined;
}

export function rectHitsSolid(w: WorldData, x: number, y: number, rw: number, rh: number): Solid | undefined {
	const left = x - rw / 2;
	const top = y - rh / 2;
	for (const s of w.solids) {
		if (s.kind === "door" && s.open) continue;
		if (rectOverlap(left, top, rw, rh, s.x, s.y, s.w, s.h)) {
			return s;
		}
	}
	return undefined;
}

const BUILDING_COLORS = [COLORS.roofRed, COLORS.roofBlue, COLORS.roofGray, COLORS.roofGreen];

/** Procedural town: grid of blocks with roads, buildings, trees, props. */
export function generateTown(seed = 0): WorldData {
	const w = createWorld(DESIGN.WORLD_W, DESIGN.WORLD_H);
	const g = DESIGN.GRID;
	const block = 12 * g;
	const roadW = 3 * g;

	// main roads every block
	for (let bx = block; bx < w.width - block; bx += block) {
		w.roads.push({ x: bx - roadW / 2, y: 0, w: roadW, h: w.height });
	}
	for (let by = block; by < w.height - block; by += block) {
		w.roads.push({ x: 0, y: by - roadW / 2, w: w.width, h: roadW });
	}

	const buildingTypes = [
		{ type: 1, w: 428, h: 552, slots: 3, name: "house" },
		{ type: 1, w: 684, h: 556, slots: 2, name: "house" },
		{ type: 2, w: 808, h: 684, slots: 3, name: "house" },
		{ type: 2, w: 1068, h: 1068, slots: 3, name: "house" },
		{ type: 5, w: 684, h: 556, slots: 2, name: "gas" },
		{ type: 6, w: 684, h: 556, slots: 2, name: "pharmacy" },
		{ type: 7, w: 1064, h: 1068, slots: 4, name: "market" },
		{ type: 8, w: 684, h: 556, slots: 2, name: "market" },
		{ type: 9, w: 684, h: 556, slots: 2, name: "gunshop" },
		{ type: 10, w: 684, h: 556, slots: 2, name: "cloth" },
		{ type: 11, w: 1064, h: 1068, slots: 4, name: "restaurant" },
		{ type: 3, w: 1064, h: 1068, slots: 4, name: "school" },
		{ type: 4, w: 1064, h: 1068, slots: 4, name: "hospital" },
	];

	let seedN = seed !== 0 ? seed : rndInt(1, 999999);
	const rand = () => {
		seedN = (seedN * 1103515245 + 12345) % 2147483648;
		return seedN / 2147483648;
	};

	for (let bx = 0; bx < w.width; bx += block) {
		for (let by = 0; by < w.height; by += block) {
			if (bx < block * 0.6 || by < block * 0.6) continue;
			if (bx > w.width - block * 1.2 || by > w.height - block * 1.2) continue;

			const innerX = bx + roadW;
			const innerY = by + roadW;
			const innerW = block - roadW * 2;
			const innerH = block - roadW * 2;

			const r = rand();
			if (r < 0.12) {
				// park block: trees
				for (let i = 0; i < 14; i++) {
					const tx = innerX + 40 + rand() * (innerW - 80);
					const ty = innerY + 40 + rand() * (innerH - 80);
					const tw = 40 + rand() * 40;
					addSolid(w, {
						kind: "tree",
						x: tx,
						y: ty,
						w: tw,
						h: tw,
						hp: 100,
						hpMax: 100,
						destructible: true,
						tags: "tree",
					});
				}
				continue;
			}

			// place 1-3 buildings
			const count = 1 + math.floor(rand() * 3);
			for (let i = 0; i < count; i++) {
				const bi = math.floor(rand() * buildingTypes.size());
				const b = buildingTypes[bi];
				const px = innerX + 30 + rand() * math.max(10, innerW - b.w - 60);
				const py = innerY + 30 + rand() * math.max(10, innerH - b.h - 60);
				if (px + b.w > w.width - 200 || py + b.h > w.height - 200) continue;
				let blocked = false;
				for (const s of w.solids) {
					if (rectOverlap(px, py, b.w, b.h, s.x - 40, s.y - 40, s.w + 80, s.h + 80)) {
						blocked = true;
						break;
					}
				}
				if (blocked) continue;
				addSolid(w, {
					kind: "building",
					x: px,
					y: py,
					w: b.w,
					h: b.h,
					hp: 99999,
					hpMax: 99999,
					destructible: false,
					tags: b.name,
					buildingType: b.type,
					roofColor: BUILDING_COLORS[math.floor(rand() * BUILDING_COLORS.size())],
					roofAlpha: 1,
					lootSlots: b.slots,
					lootItems: [],
					lootTimer: 0,
				});
			}

			// cars on roads edge + trash
			if (rand() < 0.5) {
				const cx = innerX + rand() * innerW;
				const cy = by + roadW / 2 + rand() * roadW * 0.4;
				addSolid(w, {
					kind: "car",
					x: cx,
					y: cy,
					w: 120,
					h: 60,
					hp: 300,
					hpMax: 300,
					destructible: true,
					tags: "car",
				});
			}
			if (rand() < 0.6) {
				const tx = innerX + rand() * innerW;
				const ty = innerY + rand() * innerH;
				addSolid(w, {
					kind: "car",
					x: tx,
					y: ty,
					w: 40,
					h: 48,
					hp: 1,
					hpMax: 1,
					destructible: true,
					tags: "trash",
				});
			}
		}
	}

	// map border walls
	const t = 600;
	addSolid(w, {
		kind: "wall_h",
		x: 0,
		y: 0,
		w: w.width,
		h: t,
		hp: 999999,
		hpMax: 999999,
		destructible: false,
		tags: "border",
	});
	addSolid(w, {
		kind: "wall_h",
		x: 0,
		y: w.height - t,
		w: w.width,
		h: t,
		hp: 999999,
		hpMax: 999999,
		destructible: false,
		tags: "border",
	});
	addSolid(w, {
		kind: "wall_v",
		x: 0,
		y: 0,
		w: t,
		h: w.height,
		hp: 999999,
		hpMax: 999999,
		destructible: false,
		tags: "border",
	});
	addSolid(w, {
		kind: "wall_v",
		x: w.width - t,
		y: 0,
		w: t,
		h: w.height,
		hp: 999999,
		hpMax: 999999,
		destructible: false,
		tags: "border",
	});

	return w;
}

export function spawnGroundItem(
	w: WorldData,
	kind: number,
	itemId: number,
	count: number,
	x: number,
	y: number,
	vx = 0,
	vy = 0,
): void {
	w.items.push({
		id: w.nextId++,
		kind,
		itemId,
		count,
		x,
		y,
		vx,
		vy,
		life: 120,
	});
}

export function updateGroundItems(w: WorldData, dt: number): void {
	for (let i = w.items.size() - 1; i >= 0; i--) {
		const it = w.items[i];
		it.x += it.vx * dt;
		it.y += it.vy * dt;
		it.vx *= 0.9;
		it.vy *= 0.9;
		if (it.vx * it.vx + it.vy * it.vy < 1) {
			it.vx = 0;
			it.vy = 0;
		}
		if (it.x < 0 || it.y < 0 || it.x > w.width || it.y > w.height) {
			w.items.remove(i);
		}
	}
}

export function nearestInteractables(
	w: WorldData,
	x: number,
	y: number,
	radius: number,
): { solid?: Solid; item?: GroundItem } {
	let bestD = radius;
	let solid: Solid | undefined;
	for (const s of w.solids) {
		const cx = s.x + s.w / 2;
		const cy = s.y + s.h / 2;
		const d = math.max(math.abs(cx - x) - s.w / 2, math.abs(cy - y) - s.h / 2);
		if (d < bestD) {
			bestD = d;
			solid = s;
		}
	}
	let item: GroundItem | undefined;
	let bestI = DESIGN.ITEM_GET_DISTANCE + 20;
	for (const it of w.items) {
		const d = v2dist(v2(x, y), v2(it.x, it.y));
		if (d < bestI) {
			bestI = d;
			item = it;
		}
	}
	return { solid, item };
}

export function isOnRoad(w: WorldData, x: number, y: number): boolean {
	for (const r of w.roads) {
		if (x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h) return true;
	}
	return false;
}

export function randomOpenPoint(w: WorldData, minX: number, minY: number, maxX: number, maxY: number): Vec2 {
	for (let tries = 0; tries < 40; tries++) {
		const x = rndRange(minX, maxX);
		const y = rndRange(minY, maxY);
		if (!pointInSolid(w, x, y, 40)) {
			return v2(x, y);
		}
	}
	return v2((minX + maxX) / 2, (minY + maxY) / 2);
}

export function randomRingPoint(cx: number, cy: number, minR: number, maxR: number): Vec2 {
	const a = rnd() * math.pi * 2;
	const r = minR + rnd() * (maxR - minR);
	return v2(cx + math.cos(a) * r, cy + math.sin(a) * r);
}

export { chance, Z };
