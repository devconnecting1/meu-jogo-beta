/*
 * The bicycle and the motorcycle, drawn (docs/DESIGN_RULES.md VEI-05, ART-01, ART-02).
 *
 * Seen from above, nose along the heading, on the footprint the simulation uses (VEHICLES length × width, the same
 * rect a parked one occupies): a bicycle is two thin tyres, a frame, the pedals, a saddle and the bars; a motorcycle
 * two fat tyres, the tank over the engine, the exhaust down its right side, the seat, the bars and the headlight.
 * Both put their bars where a rider's hands go (survivorView RIDE_GRIP_*), so the survivor drawn on top -- through
 * the very `drawSurvivor` everyone goes through, with `look.riding` -- holds them.
 *
 * One function draws both a parked vehicle (client/view/worldView.ts hands its solids over) and a ridden one
 * (client/gameLoop.ts for you, client/view/playersView.ts for the others): a vehicle looks the same whoever sits on
 * it. Fixed sprite counts per kind and nothing allocated but the option tables every view builds: no Instance after
 * the renderer's pool warmed up.
 */
import { COLORS, Z } from "shared/engine/colors";
import { Camera } from "shared/engine/camera";
import { Renderer } from "shared/engine/renderer";
import { clamp } from "shared/engine/vec2";
import { vehicleDef, VehicleKind } from "shared/data/buildings";
import { Solid } from "shared/game/world";
import { parkedHeading, vehicleBroken, vehicleKindOfSolid } from "shared/sim/vehicle";
import { part } from "./drawKit";

const BLACK = COLORS.shadow;
const BARS = COLORS.weapon;

/**
 * A vehicle of `kind` centred at (x, y) and pointing along `heading`. `z` is the layer of its body (a parked one
 * sits with the constructions, a ridden one just under its rider); its shadow goes where the survivors' do.
 */
export function drawVehicle(
	r: Renderer,
	cam: Camera,
	kind: number,
	x: number,
	y: number,
	heading: number,
	shadowX: number,
	shadowY: number,
	z: number,
): void {
	const def = vehicleDef(kind);
	if (def === undefined) return;
	const a = heading;
	const shadowZ = z <= Z.structure ? Z.shadow : Z.actorShadow;
	part(r, cam, x + shadowX, y + shadowY, a, 0, 0, {
		w: def.length - 2,
		h: def.width * 0.65,
		color: BLACK,
		alpha: 0.28,
		cornerRadius: def.width * 0.3,
		zIndex: shadowZ,
	});
	if (kind === VehicleKind.Motorcycle) drawMotorcycle(r, cam, x, y, a, z);
	else drawBicycle(r, cam, x, y, a, z);
}

/** the flat bicycle: 72 × 28 (the bars are its widest part), saddle behind the middle, bars at the grips */
function drawBicycle(r: Renderer, cam: Camera, x: number, y: number, a: number, z: number): void {
	for (const f of WHEELS_BIKE) {
		part(r, cam, x, y, a, f, 0, { w: 22, h: 5, color: COLORS.tyre, cornerRadius: 2, zIndex: z });
	}
	part(r, cam, x, y, a, 0, 0, { w: 44, h: 4, color: COLORS.bikeFrame, zIndex: z + 1 });
	part(r, cam, x, y, a, 0, 0, { w: 5, h: 16, color: COLORS.vehicleMetal, zIndex: z + 1 });
	part(r, cam, x, y, a, -10, 0, { w: 11, h: 7, color: COLORS.vehicleSeat, cornerRadius: 3, zIndex: z + 2 });
	part(r, cam, x, y, a, 17, 0, { w: 4, h: 28, color: BARS, zIndex: z + 2 });
}

/** the flat motorcycle: 88 × 32, the exhaust on its right, the lamp on its nose */
function drawMotorcycle(r: Renderer, cam: Camera, x: number, y: number, a: number, z: number): void {
	part(r, cam, x, y, a, -30, 0, { w: 26, h: 9, color: COLORS.tyre, cornerRadius: 4, zIndex: z });
	part(r, cam, x, y, a, 31, 0, { w: 24, h: 8, color: COLORS.tyre, cornerRadius: 4, zIndex: z });
	part(r, cam, x, y, a, 2, 0, { w: 18, h: 26, color: COLORS.vehicleMetal, cornerRadius: 3, zIndex: z });
	part(r, cam, x, y, a, -16, 13, { w: 30, h: 4, color: COLORS.vehicleMetal, cornerRadius: 2, zIndex: z });
	part(r, cam, x, y, a, 2, 0, {
		w: 50,
		h: 16,
		color: COLORS.motoPaint,
		cornerRadius: 6,
		stroke: COLORS.motoPaint.Lerp(BLACK, 0.5),
		strokeThickness: 1,
		zIndex: z + 1,
	});
	part(r, cam, x, y, a, -10, 0, { w: 26, h: 13, color: COLORS.vehicleSeat, cornerRadius: 5, zIndex: z + 2 });
	part(r, cam, x, y, a, 17, 0, { w: 4, h: 32, color: BARS, zIndex: z + 2 });
	part(r, cam, x, y, a, 42, 0, { w: 4, h: 10, color: COLORS.carLight, zIndex: z + 2 });
}

const WHEELS_BIKE = [-24, 24];

/**
 * A parked vehicle (a solid tagged "vehicle", VEI-05): on its quarter turn, with the constructions' layer, and a
 * condition bar once it is damaged -- red and under a quarter when it is broken (E repairs it with steel).
 */
export function drawParkedVehicle(r: Renderer, cam: Camera, s: Solid, shadowX: number, shadowY: number): void {
	const cx = s.x + s.w / 2;
	const cy = s.y + s.h / 2;
	drawVehicle(r, cam, vehicleKindOfSolid(s), cx, cy, parkedHeading(s), shadowX, shadowY, Z.structure);
	if (s.hpMax <= 0 || s.hp >= s.hpMax) return;
	const k = clamp(s.hp / s.hpMax, 0, 1);
	const bw = 44;
	const by = s.y - 10;
	r.drawRect(cam, cx, by, { w: bw, h: 6, color: BLACK, alpha: 0.6, zIndex: Z.actorFx });
	r.drawRect(cam, cx - (bw * (1 - k)) / 2, by, {
		w: math.max(1, bw * k),
		h: 4,
		color: vehicleBroken(s) ? COLORS.uiRed : COLORS.uiRed.Lerp(COLORS.uiGreen, k),
		zIndex: Z.actorFx + 1,
	});
}
