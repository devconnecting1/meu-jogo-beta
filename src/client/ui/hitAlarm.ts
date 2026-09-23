/*
 * DESIGN_RULES UI-06, the warning half: "the screen flashes when the survivor takes damage with a menu open".
 *
 * No menu pauses the world (the town is the server's and shared; solo follows the same rule so there is only
 * one). The Bag covers most of a 16:9 screen, and a player who set Roblox's Background Transparency to opaque
 * sees no world behind any menu at all -- so what is visible around a panel cannot be the whole answer. The
 * answer that works whatever the panel covers is a flash drawn ABOVE every menu the moment a hit lands
 * (client/ui/dangerFlash.ts draws it; this file decides when).
 *
 * Pure on purpose (no Instances, no services): tools/test-menus.mjs runs it under Node against the HP series a
 * real server simulation produces while the Bag is open.
 *
 * What counts as a hit: HP falling by at least `MIN_DROP` between two frames. A bite is 10 before armour; the
 * slow drains (hunger at 0,6 HP/s, poison at 1,8 HP/s) move less than a tenth of that per frame, even at the
 * 20 Hz a server sends the survivor's HP -- a menu that flashed for every drop of poison would flash for ever,
 * and a warning that never stops is a warning nobody reads. Armour that absorbs a bite whole is not damage.
 *
 * How often: a new flash starts at most every `GAP_S`, i.e. fewer than 3 flashes a second, which is the WCAG 2.3.1
 * general and red-flash threshold -- seven zombies biting in turn must not turn the screen into a strobe.
 */

export const HIT_ALARM = {
	/** HP lost between two frames that makes a hit (a bite is 10 before armour) */
	MIN_DROP: 1,
	/** seconds a flash takes to fade out */
	FADE_S: 0.45,
	/** a new flash starts at most this often: 1 / 0,4 = 2,5 flashes a second, under the 3/s of WCAG 2.3.1 */
	GAP_S: 0.4,
};

export class HitAlarm {
	/** HP seen on the previous frame (undefined until the first frame) */
	private lastHp: number | undefined;
	/** seconds left of the flash on screen */
	private left = 0;
	/** seconds since the last flash started */
	private since = math.huge;
	/** flashes started since this alarm was made (diagnostics and tests) */
	flashes = 0;

	/**
	 * One frame. `watching` = a screen is open over the run and the survivor is alive, which is the only time
	 * this flash is the one that warns (with nothing open, the HUD's own damage vignette does it, under the
	 * menus). HP is tracked on every frame, watched or not, so a hit taken just BEFORE the Bag opened is never
	 * reported as one taken inside it. Returns the flash strength, 1 when a hit has just landed down to 0.
	 */
	step(dt: number, watching: boolean, hp: number): number {
		const d = math.max(0, dt);
		this.since += d;
		this.left = math.max(0, this.left - d);
		const last = this.lastHp;
		this.lastHp = hp;
		if (!watching) {
			this.left = 0;
			return 0;
		}
		if (last !== undefined && last - hp >= HIT_ALARM.MIN_DROP && this.since >= HIT_ALARM.GAP_S) {
			this.left = HIT_ALARM.FADE_S;
			this.since = 0;
			this.flashes += 1;
		}
		return this.left / HIT_ALARM.FADE_S;
	}

	/** a new run: forget the last HP and any flash in progress */
	reset(): void {
		this.lastHp = undefined;
		this.left = 0;
		this.since = math.huge;
	}
}
