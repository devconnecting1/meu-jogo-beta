export interface Vec2 {
	x: number;
	y: number;
}

export function v2(x = 0, y = 0): Vec2 {
	return { x, y };
}

export function v2clone(a: Vec2): Vec2 {
	return { x: a.x, y: a.y };
}

export function v2set(out: Vec2, x: number, y: number): Vec2 {
	out.x = x;
	out.y = y;
	return out;
}

export function v2add(out: Vec2, a: Vec2, b: Vec2): Vec2 {
	out.x = a.x + b.x;
	out.y = a.y + b.y;
	return out;
}

export function v2sub(out: Vec2, a: Vec2, b: Vec2): Vec2 {
	out.x = a.x - b.x;
	out.y = a.y - b.y;
	return out;
}

export function v2scale(out: Vec2, a: Vec2, s: number): Vec2 {
	out.x = a.x * s;
	out.y = a.y * s;
	return out;
}

export function v2len(a: Vec2): number {
	return math.sqrt(a.x * a.x + a.y * a.y);
}

export function v2dist(a: Vec2, b: Vec2): number {
	const dx = a.x - b.x;
	const dy = a.y - b.y;
	return math.sqrt(dx * dx + dy * dy);
}

export function v2distSq(a: Vec2, b: Vec2): number {
	const dx = a.x - b.x;
	const dy = a.y - b.y;
	return dx * dx + dy * dy;
}

export function v2norm(out: Vec2, a: Vec2): Vec2 {
	const l = v2len(a);
	if (l > 1e-8) {
		out.x = a.x / l;
		out.y = a.y / l;
	} else {
		out.x = 0;
		out.y = 0;
	}
	return out;
}

export function v2fromAngle(out: Vec2, rad: number, len = 1): Vec2 {
	out.x = math.cos(rad) * len;
	out.y = math.sin(rad) * len;
	return out;
}

export function angleTo(from: Vec2, to: Vec2): number {
	return math.atan2(to.y - from.y, to.x - from.x);
}

export function clamp(v: number, min: number, max: number): number {
	return v < min ? min : v > max ? max : v;
}

export function lerp(a: number, b: number, t: number): number {
	return a + (b - a) * t;
}

export function degToRad(d: number): number {
	return d * (math.pi / 180);
}

export function radToDeg(r: number): number {
	return r * (180 / math.pi);
}

export function angleDiff(a: number, b: number): number {
	let d = (b - a) % (math.pi * 2);
	if (d > math.pi) {
		d -= math.pi * 2;
	}
	if (d < -math.pi) {
		d += math.pi * 2;
	}
	return d;
}

export function angleLerp(a: number, b: number, t: number): number {
	return a + angleDiff(a, b) * t;
}
