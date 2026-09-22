export function rnd(): number {
	return math.random();
}

export function rndRange(min: number, max: number): number {
	return min + math.random() * (max - min);
}

export function rndInt(min: number, max: number): number {
	return math.floor(min + math.random() * (max - min + 1));
}

export function chance(percent: number): boolean {
	return math.random() * 100 < percent;
}

export function choose<T>(arr: Array<T>): T {
	return arr[rndInt(0, arr.size() - 1)];
}

export function damageCal(n: number): number {
	const half = n / 2;
	return math.floor(half + math.random() * (half * 2));
}

export function rndAngle(): number {
	return math.random() * math.pi * 2;
}
