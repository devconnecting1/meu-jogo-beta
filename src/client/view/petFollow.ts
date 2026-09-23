/*
 * How a pet follows its survivor (MON-04). Pure arithmetic: no Instances, no services, no clock of its own — the
 * caller hands it the owner's DRAWN position and the frame's dt, so tools/test-cosmetics.mjs runs this very code.
 *
 * What a pet is, and what it is not:
 *   - it is a VIEW. It exists only in each client, built from where that client draws the owner (the predicted
 *     body for yourself, the interpolated one for an ally). The server has never heard of it: it is not an entity,
 *     it does not collide, it cannot be hit, zombies do not see it, and it changes nothing that happens in a night
 *     (MON-01). That is also why it is allowed not to collide (COL-01): like MP-02 for survivors, a companion that
 *     could block a door would be a griefing tool, and one that could body-block a zombie would be capability.
 *   - it follows on a soft leash: past HEEL it trots after the owner with a speed that grows with the slack, eased
 *     so it lags a little behind every change of direction (the "atraso suave"), and it STOPS when the owner stops
 *     — it settles at the heel instead of orbiting or creeping.
 *   - two clients may draw the same pet a few units apart (each follows its own drawing of the owner). Nobody can
 *     tell, and keeping it client-only is what makes it free on the wire.
 *
 * Birds use the same leash with a longer reach and a faster, floatier catch-up, and they LAND: `lift` goes to 1
 * while the bird is travelling and back to 0 a moment after it has arrived, which the view turns into height,
 * a shadow that separates from the body, and wings that beat or fold.
 *
 * Nothing here allocates: one `PetFollower` per survivor, updated in place every frame.
 */

/** where a pet stops, from the owner's centre: survivor radius 18 + a body length of air (1 m ≈ 55 u) */
export const PET_HEEL = 46;
/** a bird keeps a little more room: it lands beside you, not on your feet */
export const BIRD_HEEL = 56;
/** closer than this and the pet steps out of the way (the owner walked into it) */
export const PET_MIN_DIST = 30;
/** farther than this and the pet is simply placed back at the heel (a respawn, a revive, a car) */
export const PET_TELEPORT = 600;
/** leash stiffness: desired speed per unit of slack (1/s) */
const DOG_GAIN = 4.5;
const BIRD_GAIN = 3.2;
/** top speed, u/s: comfortably above a sprinting survivor (~200 u/s with Trot and adrenaline) */
const DOG_MAX_SPEED = 360;
const BIRD_MAX_SPEED = 420;
/** how fast the velocity follows the desired one, per frame at 60 fps: the smooth lag */
const DOG_ACCEL = 0.12;
const BIRD_ACCEL = 0.07;
/** below this speed (u/s) with nothing to catch up on, the pet is standing */
const STOP_SPEED = 6;
/** the gait advances by distance travelled: one full stride cycle every ~34 u */
const STRIDE_PER_UNIT = (math.pi * 2) / 34;
/** wing beats per second while a bird is in the air */
const FLAP_HZ = 7;
/** a bird that has arrived waits this long before it lands (it hovers through a short pause) */
const LAND_DELAY = 0.35;
/** how fast `lift` rises and falls, per frame at 60 fps */
const LIFT_EASE = 0.1;
/** turn rate, per frame at 60 fps */
const TURN_EASE = 0.2;
/** frames longer than this are clamped: a hitch must not fling the pet across the street */
const MAX_DT = 0.1;
/**
 * The leash is integrated in steps of at most this long, whatever the frame rate: a spring stepped once per frame
 * settles in a different place at 30 fps than at 144 (tools/test-cosmetics.mjs measured 10 u), and the same walk
 * should leave the same pet in the same spot on every screen. At most 12 steps of a few multiplications a frame.
 */
const SUBSTEP = 1 / 120;

export interface PetFollower {
	/** ground position (world units); a flying bird is drawn `lift` above it */
	x: number;
	y: number;
	vx: number;
	vy: number;
	/** facing (radians) */
	angle: number;
	/** 0 on the ground … 1 in the air (birds only; always 0 for a dog) */
	lift: number;
	/** gait phase for a dog, wing-beat phase for a bird (radians) */
	phase: number;
	/** 0 standing … 1 moving, eased: the view scales the leg swing by it */
	moving: number;
	/** seconds since the pet last had somewhere to go */
	still: number;
	/** false until the first update: the pet appears at the heel instead of sliding in from (0, 0) */
	started: boolean;
}

export function createPetFollower(): PetFollower {
	return { x: 0, y: 0, vx: 0, vy: 0, angle: 0, lift: 0, phase: 0, moving: 0, still: 0, started: false };
}

/** frame-rate independent `lerp(a, b, perFrame)` tuned at 60 fps (the same curve as drawKit.ease) */
function ease(perFrame: number, dt: number): number {
	return 1 - math.pow(1 - perFrame, dt * 60);
}

function wrapAngle(a: number): number {
	let d = a % (math.pi * 2);
	if (d > math.pi) d -= math.pi * 2;
	else if (d < -math.pi) d += math.pi * 2;
	return d;
}

/**
 * Puts the pet at the owner's heel, behind and to the left of where they face, standing still. Used on the first
 * frame, and whenever the owner is suddenly far away (respawn, revive, a vehicle).
 */
export function placeAtHeel(f: PetFollower, ownerX: number, ownerY: number, ownerAngle: number, flies: boolean): void {
	const heel = flies ? BIRD_HEEL : PET_HEEL;
	const back = ownerAngle + math.pi * 0.75;
	f.x = ownerX + math.cos(back) * heel;
	f.y = ownerY + math.sin(back) * heel;
	f.vx = 0;
	f.vy = 0;
	f.angle = math.atan2(ownerY - f.y, ownerX - f.x);
	f.lift = 0;
	f.moving = 0;
	f.still = LAND_DELAY;
	f.started = true;
}

/**
 * One frame of following. `ownerX/ownerY` is where the owner is DRAWN this frame, `ownerAngle` where they face
 * (only used to place the pet the first time), `flies` picks the bird tuning.
 */
export function stepPetFollower(
	f: PetFollower,
	ownerX: number,
	ownerY: number,
	ownerAngle: number,
	dt: number,
	flies: boolean,
): void {
	const total = math.clamp(dt, 0, MAX_DT);
	if (!f.started) {
		placeAtHeel(f, ownerX, ownerY, ownerAngle, flies);
		return;
	}
	const ox = ownerX - f.x;
	const oy = ownerY - f.y;
	if (ox * ox + oy * oy > PET_TELEPORT * PET_TELEPORT) {
		placeAtHeel(f, ownerX, ownerY, ownerAngle, flies);
		return;
	}
	const n = math.max(1, math.ceil(total / SUBSTEP - 1e-9));
	const step = total / n;
	for (let i = 0; i < n; i++) integrate(f, ownerX, ownerY, step, flies);
}

/** one fixed sub-step of the leash (see SUBSTEP) */
function integrate(f: PetFollower, ownerX: number, ownerY: number, step: number, flies: boolean): void {
	let dx = ownerX - f.x;
	let dy = ownerY - f.y;
	let dist = math.sqrt(dx * dx + dy * dy);
	if (dist < 1e-3) {
		// exactly on the owner (a teleport landed on it): pick a side so the direction below is defined
		dx = -1;
		dy = 0;
		dist = 1e-3;
	}
	const ux = dx / dist;
	const uy = dy / dist;
	const heel = flies ? BIRD_HEEL : PET_HEEL;
	const gain = flies ? BIRD_GAIN : DOG_GAIN;
	const maxSpeed = flies ? BIRD_MAX_SPEED : DOG_MAX_SPEED;
	// the leash: pulled towards the owner past the heel, pushed out of the way when too close, slack in between
	let want = 0;
	if (dist > heel) want = math.min(maxSpeed, (dist - heel) * gain);
	else if (dist < PET_MIN_DIST) want = -(PET_MIN_DIST - dist) * gain;
	const wantX = ux * want;
	const wantY = uy * want;
	const k = ease(flies ? BIRD_ACCEL : DOG_ACCEL, step);
	f.vx += (wantX - f.vx) * k;
	f.vy += (wantY - f.vy) * k;
	let speed = math.sqrt(f.vx * f.vx + f.vy * f.vy);
	if (want === 0 && speed < STOP_SPEED) {
		// arrived: stand still instead of creeping the last fraction of a unit for seconds
		f.vx = 0;
		f.vy = 0;
		speed = 0;
	}
	f.x += f.vx * step;
	f.y += f.vy * step;
	const going = speed > STOP_SPEED;
	f.still = going ? 0 : f.still + step;
	f.moving += ((going ? 1 : 0) - f.moving) * ease(0.2, step);
	// face where it is going; standing, turn to look at the owner
	const face = going ? math.atan2(f.vy, f.vx) : math.atan2(ownerY - f.y, ownerX - f.x);
	f.angle = f.angle + wrapAngle(face - f.angle) * ease(TURN_EASE, step);
	if (flies) {
		const airborne = going || f.still < LAND_DELAY;
		f.lift += ((airborne ? 1 : 0) - f.lift) * ease(LIFT_EASE, step);
		if (f.lift < 0.01 && !airborne) f.lift = 0;
		// the wings beat in time, not in distance: a hovering bird still flaps
		if (f.lift > 0) f.phase = (f.phase + step * FLAP_HZ * math.pi * 2) % (math.pi * 2);
	} else {
		f.lift = 0;
		f.phase = (f.phase + speed * step * STRIDE_PER_UNIT) % (math.pi * 2);
	}
}
