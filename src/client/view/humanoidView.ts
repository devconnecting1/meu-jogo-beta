/*
 * The top-down humanoid every zombie (and the giant boss) is drawn as: two animated feet, the body, two arms reaching
 * forward and the head -- and the colour of each zombie type.
 *
 * It lived in actorsView.ts, next to the mirror of the server's horde. It is on its own so the menus' town flyover
 * (client/view/townFlyover.ts, DESIGN_RULES UI-10) can draw its few idle walkers with the very same body, without
 * pulling in the network layer the mirror needs.
 */
import { Camera } from "shared/engine/camera";
import { COLORS } from "shared/engine/colors";
import { Renderer } from "shared/engine/renderer";
import { clamp } from "shared/engine/vec2";
import { part, SIDES } from "./drawKit";

const WHITE = COLORS.white;
const BLACK = COLORS.shadow;

/** body colour of a zombie type (1 walker ... 5) */
export function zombieColor(t: number): Color3 {
	if (t === 2) return COLORS.zombie2;
	if (t === 3) return COLORS.zombie3;
	if (t === 4) return COLORS.zombie4;
	if (t === 5) return COLORS.zombie5;
	return COLORS.zombie1;
}

/**
 * Top-down humanoid (zombies, boss 3): 2 animated feet, body, 2 arms reaching forward, head.
 * All offsets are in world space: forward f = (cos a, sin a), lateral l = (-f.y, f.x).
 */
export function drawHumanoid(
	r: Renderer,
	cam: Camera,
	x: number,
	y: number,
	a: number,
	sc: number,
	color: Color3,
	flash: number,
	alpha: number,
	phase: number,
	z: number,
	windup = 0,
	outline?: Color3,
): void {
	const body = flash > 0 ? color.Lerp(WHITE, 0.75 * flash) : color;
	const dark = color.Lerp(BLACK, 0.3);
	const edge = outline ?? (flash > 0 ? WHITE : dark);
	const step = math.sin(phase) * 8 * sc;
	for (const side of SIDES) {
		const along = step * side;
		part(r, cam, x, y, a, along, side * 9 * sc, {
			w: 12 * sc,
			h: 9 * sc,
			color: COLORS.zombieFeet,
			alpha,
			cornerRadius: 3 * sc,
			zIndex: z,
		});
		// arms reach straight ahead, swaying a little with the gait
		part(r, cam, x, y, a, 22 * sc - along * 0.25, side * 12 * sc, {
			w: 24 * sc,
			h: 7 * sc,
			color: flash > 0 ? body : dark,
			alpha,
			cornerRadius: 3 * sc,
			zIndex: z + 1,
		});
	}
	part(r, cam, x, y, a, 0, 0, {
		w: 26 * sc,
		h: 36 * sc,
		color: body,
		alpha,
		cornerRadius: 9 * sc,
		stroke: edge,
		strokeThickness: flash > 0 || outline !== undefined ? 3 : 1.5,
		strokeAlpha: alpha,
		zIndex: z + 2,
	});
	// head; a spitter winding up (windup 0..10) pulls it back and swells its acid sac
	const k = clamp(windup / 10, 0, 1);
	const headFwd = (3 - 9 * k) * sc;
	let headColor = flash > 0 ? body : color.Lerp(BLACK, 0.12);
	if (k > 0) headColor = headColor.Lerp(COLORS.acid, 0.7 * k);
	r.drawCircle(cam, x + math.cos(a) * headFwd, y + math.sin(a) * headFwd, 20 * sc * (1 + 0.4 * k), {
		color: headColor,
		alpha,
		stroke: k > 0 ? COLORS.bloodZombie : undefined,
		strokeThickness: 2,
		strokeAlpha: alpha * k,
		zIndex: z + 3,
	});
}
