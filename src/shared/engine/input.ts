/**
 * Input abstraction: touch (mobile), mouse + keyboard (PC).
 * Mirrors Dead Town's scheme: left virtual stick, right aim/attack, action button.
 */
export class InputState {
	// movement (normalized -1..1 in screen space, camera-relative applied by player)
	moveX = 0;
	moveY = 0;
	moveMagnitude = 0;

	// aim: WORLD-space angle in radians from the player (0 = +x), refreshed every frame by refreshAim
	aimAngle = 0;
	/** "mouse" → refreshAim uses the live mouse cursor every frame; "touch" → driven by the aim stick */
	aimMode: "mouse" | "touch" = "mouse";

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
	/** 0-based weapon hotkey (keys 1–5) pressed this frame, -1 = none; combat switches weapon */
	weaponSlotPressed = -1;

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

	// touch joystick (left half)
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

	// touch aim stick (right half, above the fire zone)
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
		this.weaponSlotPressed = -1;
	}

	endFrame(): void {
		// clear one-shot handled flags if needed later
	}
}
