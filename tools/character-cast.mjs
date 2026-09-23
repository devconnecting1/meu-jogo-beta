/*
 * A fixed cast of characters, drawn through the functions the client calls (survivorView.drawSurvivor,
 * humanoidView.drawZombie -- or, on a checkout from before the characters' art, the flat humanoid exactly as
 * actorsView.ts drew it -- and cosmeticsView.drawPet): every outfit with every grip and state, every zombie type in
 * its poses, every pet standing and on the move. tools/test-world-art.mjs §8 draws it to check the fallback against
 * tools/golden/characters-flat.json (recorded from the commit before the art) and the art against its sheets.
 *
 *   import { characterCast, castDrawer } from "./character-cast.mjs";
 *   const draw = castDrawer(require, SRC, sunFn);        // (st, member, x, y) => void, st = { r, cam }
 *   for (const [i, m] of characterCast(require, SRC).entries()) draw(st, m, x(i), y(i));
 */
import { join } from "node:path";

/** the weapons the cast holds: every grip (knife, axe, chainsaw, bat, pistol, rifle, shotgun, MG, sniper, bows, flamer) */
const CAST_WEAPONS = [0, 2, 5, 6, 10, 13, 16, 18, 20, 22, 23, 25];

export function characterCast(require, SRC) {
	const { WEAPONS } = require(join(SRC, "shared/data/weapons.ts"));
	const { WeaponKind } = require(join(SRC, "shared/data/kinds.ts"));
	const cast = [];
	for (let outfit = 0; outfit < 4; outfit++) {
		CAST_WEAPONS.forEach((w, i) => {
			const angle = (i * 0.83 + outfit) % (Math.PI * 2);
			cast.push({ kind: "survivor", outfit, weapon: w, angle, phase: i, amp: i % 2 });
			if (WEAPONS[w].kind === WeaponKind.Melee)
				cast.push({ kind: "survivor", outfit, weapon: w, angle, swing: 0.4 });
		});
		cast.push({ kind: "survivor", outfit, weapon: 0, angle: 1, flash: 0.7 });
		cast.push({ kind: "survivor", outfit, weapon: 10, angle: 2, poisoned: true });
		cast.push({ kind: "survivor", outfit, weapon: 0, angle: 3, downed: true, phase: 1.3, amp: 1 });
	}
	for (let type = 1; type <= 5; type++) {
		for (let i = 0; i < 4; i++) cast.push({ kind: "zombie", type, angle: i * 1.7, phase: i * 1.1 });
	}
	cast.push({ kind: "zombie", type: 1, big: true, angle: 0.4, flash: 1 });
	cast.push({ kind: "zombie", type: 2, angle: 1.4, windup: 8 });
	cast.push({ kind: "zombie", type: 3, angle: 2.4, blink: true });
	cast.push({ kind: "zombie", type: 4, angle: 3.4, rush: true, phase: 2 });
	cast.push({ kind: "zombie", type: 5, angle: 4.4, air: true });
	for (let look = 1; look <= 6; look++) {
		cast.push({ kind: "pet", look, angle: look, moving: 0 });
		cast.push({ kind: "pet", look, angle: -look, moving: 1, phase: 1.2, lift: look <= 3 ? 1 : 0 });
	}
	return cast;
}

/** a function drawing one member of a cast at (x, y) on a stage { r, cam }, with the shadows of `sun` */
export function castDrawer(require, SRC, sun) {
	const { COLORS, Z } = require(join(SRC, "shared/engine/colors.ts"));
	const { WEAPONS, meleeReach } = require(join(SRC, "shared/data/weapons.ts"));
	const SV = require(join(SRC, "client/view/survivorView.ts"));
	const HV = require(join(SRC, "client/view/humanoidView.ts"));
	const CV = require(join(SRC, "client/view/cosmeticsView.ts"));
	const PF = require(join(SRC, "client/view/petFollow.ts"));
	return (st, m, x, y) => {
		if (m.kind === "survivor") {
			const look = SV.createLook();
			look.x = x;
			look.y = y;
			look.angle = m.angle;
			look.outfit = m.outfit;
			look.weapon = WEAPONS[m.weapon];
			look.swingReach = meleeReach(look.weapon);
			look.feetPhase = m.phase ?? 0;
			look.feetAmp = m.amp ?? 0;
			look.flash = m.flash ?? 0;
			look.poisoned = m.poisoned === true;
			look.downed = m.downed === true;
			look.swinging = m.swing !== undefined;
			look.swingAngle = m.angle + (m.swing ?? 0);
			look.clock = 0.25;
			const so = sun(x, y, 10);
			look.shadowX = so.x;
			look.shadowY = so.y;
			const trail = SV.createSwingTrail();
			if (look.swinging) {
				// mid-sweep: the blade already on its way (a fresh sweep is drawn at its start)
				trail.drawn = true;
				trail.rel = -10;
			}
			SV.drawSurvivor(st.r, st.cam, look, trail);
		} else if (m.kind === "zombie") {
			const rad = (m.type === 3 || m.type === 4 ? 17 : 16) * (m.big === true ? 1.4 : 1);
			const lift = m.air === true ? 20 : 0;
			const sc = (rad / 18) * (1 + lift / 100);
			const flash = m.flash ?? 0;
			const phase = m.phase ?? 0.8;
			const windup = m.windup ?? 0;
			if (HV.drawZombie !== undefined) {
				HV.drawZombie(
					st.r,
					st.cam,
					x,
					y - lift,
					m.angle,
					sc,
					m.type,
					flash,
					1,
					phase,
					Z.zombie,
					windup,
					lift > 0,
					m.rush === true,
					m.blink === true,
				);
			} else {
				// before the characters' art: the flat humanoid exactly as client/view/actorsView.ts drew it
				let color = HV.zombieColor(m.type);
				let outline;
				if (m.blink === true) {
					color = color.Lerp(COLORS.uiRed, 0.8);
					outline = COLORS.uiYellow;
				}
				HV.drawHumanoid(
					st.r,
					st.cam,
					x,
					y - lift,
					m.angle,
					sc,
					color,
					flash,
					1,
					phase,
					Z.zombie,
					windup,
					outline,
				);
			}
		} else {
			const f = PF.createPetFollower();
			f.x = x;
			f.y = y;
			f.angle = m.angle;
			f.started = true;
			f.moving = m.moving;
			f.phase = m.phase ?? 0;
			f.lift = m.lift ?? 0;
			CV.drawPet(st.r, st.cam, f, m.look, 0.3, sun);
		}
	};
}
