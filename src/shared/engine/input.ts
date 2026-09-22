/**
 * Input abstraction: touch (mobile), mouse + keyboard (PC).
 * Mirrors Dead Town's scheme: left virtual stick, right aim/attack, action button.
 */
export class InputState {
	// movement (normalized -1..1 in screen space, camera-relative applied by player)
	moveX = 0;
	moveY = 0;
	moveMagnitude = 0;

	// aim (screen-space angle in radians, 0 = right)
	aimAngle = 0;

	attackHeld = false;
	attackPressed = false;
	attackReleased = false;

	actionPressed = false;
	reloadPressed = false;
	backpackPressed = false;
	pausePressed = false;

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

	// right side aim drag
	aimDragActive = false;
	aimDragLastX = 0;
	aimDragLastY = 0;

	beginFrame(): void {
		this.attackPressed = false;
		this.attackReleased = false;
		this.actionPressed = false;
		this.reloadPressed = false;
		this.backpackPressed = false;
		this.pausePressed = false;
	}

	endFrame(): void {
		// clear one-shot handled flags if needed later
	}
}
