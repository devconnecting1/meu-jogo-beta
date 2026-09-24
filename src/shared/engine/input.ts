/**
 * Input abstraction: touch (mobile), mouse + keyboard (PC), gamepad.
 * Mirrors Dead Town's scheme: left virtual stick, right aim/attack pad, contextual buttons.
 *
 * This module is the SINGLE source of truth for the touch layout: `computeTouchLayout` turns the player's
 * saved preferences + the viewport into pixel geometry, which `client/bootstrap.ts` uses to decide what a
 * finger does and `client/ui/hud.ts` uses to draw the very same controls. They can never drift apart.
 *
 * It stays pure (no Instances, no services) so it also runs in the sim tests (tools/test-sim.mjs).
 * Nothing here changes the 60 Hz command format of docs/MULTIPLAYER.md §2.2: the survivor still produces one
 * move direction, one magnitude, one aim angle and the button bits — only the way a thumb reaches them changes.
 */

// ---------------------------------------------------------------- state

export class InputState {
	// movement (normalized -1..1 in screen space, camera-relative applied by player)
	moveX = 0;
	moveY = 0;
	moveMagnitude = 0;

	// aim: WORLD-space angle in radians from the player (0 = +x), refreshed every frame by refreshAim
	aimAngle = 0;
	/** "mouse" → refreshAim uses the live mouse cursor every frame; "touch" → driven by the aim pad */
	aimMode: "mouse" | "touch" = "mouse";
	/** how far the aim pad / right thumbstick is pushed, 0..1 (the HUD draws the knob with it) */
	aimMagnitude = 0;

	attackHeld = false;
	attackPressed = false;
	attackReleased = false;
	/**
	 * true → combat ignores the attack button until it is released
	 * (set by the build system when a click confirms/cancels a placement).
	 */
	attackBlocked = false;

	actionPressed = false;
	reloadPressed = false;
	backpackPressed = false;
	pausePressed = false;
	/** the pad's Back / Select this frame: opens or closes the match scoreboard (MP-23) */
	scoreboardPressed = false;
	/** Q is held: the scoreboard shows while it is (MP-23; Tab is the Roblox player list's, UI-02) */
	keyScoreboard = false;
	/** 0-based weapon hotkey (keys 1–5) pressed this frame, -1 = none; combat switches weapon */
	weaponSlotPressed = -1;
	/**
	 * The pad's D-pad this frame: -1 (left) the previous weapon, +1 (right) the next, 0 = none -- of the list keys 1–5
	 * pick from, drawn (client/systems/combat.ts `cycleWeapon`). The pad has no number keys.
	 */
	weaponCycle = 0;
	/**
	 * A quick-use plate pressed this frame (DESIGN_RULES ITM-07): 0 HEAL (H, the D-pad's up), 1 EAT (F, the D-pad's
	 * down), -1 none. The HUD's plates write it too, by click or tap (client/ui/hudQuick.ts): one path, like the hotbar.
	 */
	quickUsePressed = -1;

	/**
	 * DESIGN_RULES UI-06: the SURVIVOR is out of play this frame -- a screen is open over the run (Bag, menu,
	 * end of run) or they are dead. It is never the world that stops: the loop keeps simulating, drawing and
	 * sending commands, and every reader of this state (client/net/localInput.ts `readRawInput`, the game
	 * loop's interact / build / aim) treats a held survivor as one standing still with empty hands. Written
	 * once per frame, by `setHeld`, before the world is stepped.
	 */
	held = false;

	// raw keys
	keyW = false;
	keyA = false;
	keyS = false;
	keyD = false;
	keyShift = false;
	keyE = false;
	keyR = false;
	keyTab = false;
	keyEsc = false;

	// touch joystick (move side)
	joystickActive = false;
	joystickBaseX = 0;
	joystickBaseY = 0;
	joystickX = 0;
	joystickY = 0;
	joystickRadius = 60;

	// right side aim drag (legacy fields, kept for compatibility — mirrors aimStickActive)
	aimDragActive = false;
	aimDragLastX = 0;
	aimDragLastY = 0;

	// touch aim pad (action side): also the fire control
	aimStickActive = false;
	aimStickBaseX = 0;
	aimStickBaseY = 0;
	aimStickX = 0;
	aimStickY = 0;

	beginFrame(): void {
		if (!this.attackHeld) this.attackBlocked = false;
		this.attackPressed = false;
		this.attackReleased = false;
		this.actionPressed = false;
		this.reloadPressed = false;
		this.backpackPressed = false;
		this.pausePressed = false;
		this.scoreboardPressed = false;
		this.weaponSlotPressed = -1;
		this.weaponCycle = 0;
		this.quickUsePressed = -1;
	}

	/**
	 * Starts a frame with the survivor held or not (UI-06, see `held`). Held, this frame's presses are dropped:
	 * a click, an E, an R or a weapon key made while a menu has the focus belong to the menu. An attack button
	 * still down stays BLOCKED until it is released, so closing the Bag with the button held never fires a shot.
	 * The raw key state (W/A/S/D, the stick, the held buttons) is left alone -- `readRawInput` ignores it while
	 * held, and a key still down when the menu closes walks again at once.
	 *
	 * The toggles that open and close the menus (`backpackPressed`, `pausePressed`) are NOT dropped: they are
	 * read before this runs, and they are the one thing a held survivor still asks for.
	 */
	setHeld(on: boolean): void {
		this.held = on;
		if (!on) return;
		this.attackPressed = false;
		this.attackReleased = false;
		this.actionPressed = false;
		this.reloadPressed = false;
		this.weaponSlotPressed = -1;
		this.weaponCycle = 0;
		// the Bag has its own Use; a dead survivor eats nothing (UI-06, ITM-07)
		this.quickUsePressed = -1;
		if (this.attackHeld) this.attackBlocked = true;
	}

	endFrame(): void {
		// clear one-shot handled flags if needed later
	}
}

// ---------------------------------------------------------------- touch layout

/**
 * The persisted touch preferences, as a plain shape: `shared/engine` must not depend on the save schema.
 * `client/bootstrap.ts` fills it from `save.settings`.
 */
export interface TouchPrefs {
	/** 0..1, size of the move stick (0.5 = 100%) */
	leftSize: number;
	/** 0..1, how high the move stick sits (0.5 = default) */
	leftPos: number;
	/** true → the stick appears under the thumb (floating); false → it stays at its home */
	leftRelative: boolean;
	/** 0..1, size of the aim/fire pad and of the contextual buttons */
	rightSize: number;
	/** 0..1, how high the aim/fire pad sits */
	rightPos: number;
	/** left-handed: the move stick and the aim pad swap sides */
	mirror: boolean;
}

export function defaultTouchPrefs(): TouchPrefs {
	return { leftSize: 0.5, leftPos: 0.5, leftRelative: true, rightSize: 0.5, rightPos: 0.5, mirror: false };
}

/** a round touch target: centre + radius, all in screen pixels */
export interface TouchButton {
	x: number;
	y: number;
	r: number;
}

/** a virtual stick: where it rests, how far it travels and how much of that travel is dead */
export interface TouchStick {
	/** resting centre (also where a fixed stick is grabbed), px */
	homeX: number;
	homeY: number;
	/** travel of the knob from the base centre, px (full deflection) */
	radius: number;
	/** no input below this deflection, px */
	dead: number;
	/** drawn base radius, px */
	baseR: number;
	/** drawn knob radius, px */
	knobR: number;
	/** a finger this close to `home` grabs a FIXED stick (ignored when the stick floats) */
	grabR: number;
}

export type ScreenShape = "classic" | "phone" | "wide" | "tablet";

export interface TouchLayout {
	viewW: number;
	viewH: number;
	/** px covered by the Roblox top bar: nothing is placed above it (DESIGN_RULES UI-02) */
	inset: number;
	/** px per touch-design unit on this device (before the size preference) */
	scale: number;
	/** the smallest side any touch target is allowed to have, px */
	minTarget: number;
	shape: ScreenShape;
	/** the move stick is on the right (left-handed) */
	mirrored: boolean;
	/** the move stick appears under the thumb instead of staying at its home */
	floating: boolean;
	/** x that splits the move half from the aim half, px */
	splitX: number;
	move: TouchStick;
	aim: TouchStick;
	/** interact ("USE"), next to the aim thumb */
	use: TouchButton;
	/** reload, above the aim pad */
	reload: TouchButton;
	/** backpack and pause: the top-right corner, never under the Roblox bar */
	bag: TouchButton;
	pause: TouchButton;
}

/*
 * Touch-design units (px on a 414-pt-tall phone, i.e. scale 1). Everything else is derived from these, so a
 * single number here changes the whole scheme consistently in the HUD and in the hit testing.
 */
/** Apple HIG / Material floor for a touch target — every button below is at least this wide. */
export const MIN_TOUCH_PX = 44;
const STICK_BASE_R = 62;
const STICK_TRAVEL = 56;
/** 20% of the travel: enough to absorb thumb tremor, small enough that the survivor never feels lag */
const STICK_DEAD = 11;
const STICK_KNOB_R = 26;
const AIM_PAD_R = 58;
const AIM_TRAVEL = 52;
/** the aim pad barely has a dead zone: a 6 px flick must already turn the survivor */
const AIM_DEAD = 6;
const AIM_KNOB_R = 24;
const BUTTON_R = 27;
const BUTTON_GAP = 12;
const MARGIN = 22;

function clamp(v: number, lo: number, hi: number): number {
	return v < lo ? lo : v > hi ? hi : v;
}

/** a 0..1 setting as a multiplier: 0 → 0.75, 0.5 → 1, 1 → 1.25 */
function sizeFactor(v: number): number {
	return 0.75 + 0.5 * clamp(v, 0, 1);
}

/** a 0..1 setting as a signed offset: 0 → -1 (lower / outwards), 0.5 → 0, 1 → +1 (higher / inwards) */
function posFactor(v: number): number {
	return clamp(v, 0, 1) * 2 - 1;
}

/** which of the four shapes this viewport is; the layout leans on it for margins and size */
export function screenShape(viewW: number, viewH: number): ScreenShape {
	const short = math.min(viewW, viewH);
	const ratio = viewW / math.max(viewH, 1);
	if (short >= 700) return "tablet";
	if (ratio >= 1.9) return "wide";
	if (ratio <= 1.45) return "classic";
	return "phone";
}

/**
 * Pixel geometry of the touch controls for this viewport and these preferences.
 *
 * Sizing: `scale` grows with the screen's short side (a 414-pt phone = 1, a 1080p monitor = 2.4), so the
 * controls keep roughly the same physical size on every device instead of shrinking on a phone and getting
 * lost on a tablet. Every button is then floored at MIN_TOUCH_PX so the smallest size setting on the
 * smallest phone is still reachable with a thumb.
 *
 * Shapes: 20:9 phones (`wide`) get a wider side margin, because their rounded corners and camera cut-outs eat
 * the extreme edges; 4:3 (`classic`) has vertical room to spare, so the controls sit a little lower and
 * bigger; tablets get bigger margins because the hands rest further from the glass.
 */
export function computeTouchLayout(prefs: TouchPrefs, viewW: number, viewH: number, inset: number): TouchLayout {
	const shape = screenShape(viewW, viewH);
	const short = math.min(viewW, viewH);
	const base = clamp(short / 414, 0.85, 2.4);
	const scale = shape === "classic" ? base * 1.05 : shape === "tablet" ? base * 0.95 : base;

	const sideExtra = shape === "wide" ? viewW * 0.035 : 0;
	const marginX = MARGIN * scale + sideExtra + (shape === "tablet" ? MARGIN * scale * 0.5 : 0);
	const marginY = MARGIN * scale * (shape === "classic" ? 0.8 : 1) + (shape === "tablet" ? MARGIN * scale * 0.5 : 0);

	const minR = MIN_TOUCH_PX / 2;
	let leftK = scale * sizeFactor(prefs.leftSize);
	let rightK = scale * sizeFactor(prefs.rightSize);

	/*
	 * Fit pass. On a short or narrow screen the largest size setting would put the two thumb clusters on top
	 * of each other (the sweep in Studio caught exactly that on a 390-wide portrait phone). Rather than
	 * refuse the setting, both sides shrink by the same factor until the widest row — stick, pad and USE
	 * reaching in from it — and the tallest column — the corner buttons, RELOAD and the pad — both fit.
	 * Nothing here can push a BUTTON under MIN_TOUCH_PX: that floor is applied after, below.
	 */
	{
		const gp = BUTTON_GAP * scale;
		const ap = AIM_PAD_R * rightK;
		const br = BUTTON_R * rightK;
		const ar = ap + gp + br;
		const needW = 2 * STICK_BASE_R * leftK + ap + 0.94 * ar + br + gp;
		const needH = br * 3 + gp + ar + ap;
		const fit = math.min(
			1,
			(viewW - marginX * 2) / math.max(needW, 1),
			(viewH - inset - marginY * 2) / math.max(needH, 1),
		);
		if (fit < 1) {
			leftK *= fit;
			rightK *= fit;
		}
	}

	const moveBaseR = math.max(STICK_BASE_R * leftK, minR);
	const aimPadR = math.max(AIM_PAD_R * rightK, minR);
	const btnR = math.max(BUTTON_R * rightK, minR);
	const gap = BUTTON_GAP * scale;
	/** how far above the aim pad its two buttons ride */
	const arc = aimPadR + gap + btnR;
	/** centre line of the BAG / PAUSE pair in the top corner */
	const topY = inset + marginY + btnR;

	// vertical trim of each side, clamped so a control never leaves the screen or climbs into another one
	const liftRange = math.min(150 * scale, viewH * 0.22);
	const lift = (v: number, r: number, ceiling: number): number => {
		const low = viewH - marginY - r;
		// `ceiling` can be below the bottom stop on a very short screen: the bottom always wins
		const high = math.min(math.max(inset + marginY + r, ceiling), low);
		return clamp(low - posFactor(v) * liftRange, high, low);
	};
	// Raising the aim pad must never push RELOAD into the BAG / PAUSE row (found by the layout sweep below
	// in Studio): RELOAD rides `arc` above the pad, and needs a full button plus a gap clear of that row.
	const aimCeiling = topY + btnR * 2 + gap + arc;

	const mirrored = prefs.mirror;
	const moveSideX = (r: number): number => (mirrored ? viewW - marginX - r : marginX + r);
	const aimSideX = (r: number): number => (mirrored ? marginX + r : viewW - marginX - r);
	/** +1 when the action side points to the screen centre going right */
	const aimInward = mirrored ? 1 : -1;

	const move: TouchStick = {
		homeX: moveSideX(moveBaseR),
		homeY: lift(prefs.leftPos, moveBaseR, 0),
		radius: math.max(STICK_TRAVEL * leftK, minR),
		dead: STICK_DEAD * leftK,
		baseR: moveBaseR,
		knobR: math.max(STICK_KNOB_R * leftK, MIN_TOUCH_PX / 3),
		// a fixed stick is grabbed a little outside its base, so a thumb landing on the rim still counts
		grabR: moveBaseR * 1.55,
	};
	const aim: TouchStick = {
		homeX: aimSideX(aimPadR),
		homeY: lift(prefs.rightPos, aimPadR, aimCeiling),
		radius: math.max(AIM_TRAVEL * rightK, minR),
		dead: AIM_DEAD * rightK,
		baseR: aimPadR,
		knobR: math.max(AIM_KNOB_R * rightK, MIN_TOUCH_PX / 3),
		grabR: aimPadR * 1.55,
	};

	// the two in-combat buttons ride on an arc around the aim pad: RELOAD straight up, USE up and inwards,
	// both one full button clear of the pad so a thumb on the pad never brushes them
	const reload: TouchButton = { x: aim.homeX, y: math.max(aim.homeY - arc, topY + btnR * 2 + gap), r: btnR };
	const use: TouchButton = {
		x: aim.homeX + aimInward * arc * 0.94,
		y: math.max(aim.homeY - arc * 0.52, topY + btnR * 2 + gap),
		r: btnR,
	};
	// backpack + pause live in the top-right corner, clear of both thumbs (the vitals are in the HUD's bottom
	// console, which client/ui/hudConsole.ts fits between the thumbs from these same numbers)
	const bag: TouchButton = { x: viewW - marginX - btnR, y: topY, r: btnR };
	const pause: TouchButton = { x: bag.x - btnR * 2 - gap, y: topY, r: btnR };

	return {
		viewW,
		viewH,
		inset,
		scale,
		minTarget: MIN_TOUCH_PX,
		shape,
		mirrored,
		floating: prefs.leftRelative,
		splitX: viewW * 0.5,
		move,
		aim,
		use,
		reload,
		bag,
		pause,
	};
}

/** true when a touch at (x, y) belongs to the move half of the screen */
export function onMoveSide(layout: TouchLayout, x: number): boolean {
	return layout.mirrored ? x >= layout.splitX : x < layout.splitX;
}

// ---------------------------------------------------------------- aim assist

/** something the assist may snap to: a body centre and its radius, in world units */
export interface AimTarget {
	x: number;
	y: number;
	r: number;
}

/**
 * Aim assist, thumb edition (docs/DESIGN_RULES.md P2 "better than the original").
 *
 * A thumb on glass is worth about ±5° of precision; a mouse is worth a tenth of that. Rather than make
 * touch players miss, the aim is bent a little towards a target THEY ALREADY CHOSE:
 *
 * - only a target inside `CONE` (14°) of the current aim counts — the assist can never acquire something the
 *   player is not already pointing at, and it never sweeps across the screen;
 * - it fades to nothing at the edge of the cone (`smoothstep`), so aiming deliberately past a zombie (to lead
 *   a runner, or to hit the one behind) is never fought;
 * - it fades to nothing past `RANGE` (700 u ≈ 12,7 m), i.e. it never helps a sniper;
 * - `STRENGTH` 0.5 with the two falloffs caps the bend at **1.6°** (measured: 1.60° at a 4° error, 1.57° at 8°,
 *   0.09° at 13°, 0° at 15° or past 700 u). At 300 u that is about 8 u of correction, a quarter of a zombie's
 *   width (32 u). It turns a near miss into a hit; it cannot turn a wild shot into one.
 * - and the bend is additionally capped at the half-angle the target's own body subtends, so the assist can
 *   never aim PAST the thing it is helping with.
 *
 * Why it is fair: the game is co-op only (MP-01), so the assist can never be used against another player; it
 * never pulls the trigger; it is off for the mouse (a precise device does not need it and would feel it fight
 * back); and it changes nothing downstream — the survivor still sends one aim angle in the ordinary 60 Hz
 * command (§2.2), so the server resolves the shot exactly as it would from any other device.
 */
export const AIM_ASSIST = {
	/** half-angle of the acquisition cone, radians (14°) */
	CONE: math.rad(14),
	/** full help up to here (world units) */
	NEAR: 420,
	/** no help at all past here */
	RANGE: 700,
	/** fraction of the angular error that is corrected at the centre of the cone */
	STRENGTH: 0.5,
} as const;

/** shortest signed difference between two angles, in (-π, π] */
export function angleDelta(from: number, to: number): number {
	const tau = math.pi * 2;
	let d = (to - from) % tau;
	if (d > math.pi) d -= tau;
	if (d < -math.pi) d += tau;
	return d;
}

function smoothstep(t: number): number {
	const x = clamp(t, 0, 1);
	return x * x * (3 - 2 * x);
}

/**
 * Bends `angle` (radians, world frame) a little towards the best target near it. Pure: same inputs, same
 * output, no services — the value can be fed straight into the 60 Hz command.
 */
export function applyAimAssist(angle: number, px: number, py: number, targets: Array<AimTarget>): number {
	let bestDelta = 0;
	let bestDist = 0;
	let bestR = 0;
	let bestScore = math.huge;
	let found = false;
	for (const t of targets) {
		const dx = t.x - px;
		const dy = t.y - py;
		const dist = math.sqrt(dx * dx + dy * dy);
		if (dist < 1 || dist > AIM_ASSIST.RANGE) continue;
		const delta = angleDelta(angle, math.atan2(dy, dx));
		const adelta = math.abs(delta);
		if (adelta > AIM_ASSIST.CONE) continue;
		// nearest to the crosshair wins, with distance as a light tie-break
		const score = adelta + dist / (AIM_ASSIST.RANGE * 40);
		if (score < bestScore) {
			bestScore = score;
			bestDelta = delta;
			bestDist = dist;
			bestR = t.r;
			found = true;
		}
	}
	if (!found) return angle;
	// fades out at the edge of the cone and with distance...
	const edge = 1 - smoothstep(math.abs(bestDelta) / AIM_ASSIST.CONE);
	const far = 1 - smoothstep((bestDist - AIM_ASSIST.NEAR) / math.max(AIM_ASSIST.RANGE - AIM_ASSIST.NEAR, 1));
	// ...and can never push the aim outside the body it is helping with (half-angle the target subtends)
	const cap = math.atan2(math.max(bestR, 1), bestDist);
	const bend = clamp(bestDelta * AIM_ASSIST.STRENGTH * edge * far, -cap, cap);
	return angle + bend;
}
