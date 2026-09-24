/*
 * A fixed cast of bosses (docs/DESIGN_RULES.md ART-13), drawn through the function the client calls: the centipede
 * as a whole chain (head and 50 segments, coiled into a curve), the rafflesia at several beats of its vines, the
 * giant and the hedgehog facing every way, each also mid hit flash. tools/test-world-art.mjs §10 draws it to check the
 * flat fallback against tools/golden/bosses-flat.json (recorded from the commit before the bosses' art) and the art
 * against its sheets; tools/render-characters.mjs draws the line-ups of each boss.
 *
 *   import { bossCast, bossDrawer } from "./boss-cast.mjs";
 *   const draw = bossDrawer(require, SRC, sunFn);        // (st, member, x, y) => void, st = { r, cam }
 *
 * On a checkout from before the bosses' art (no client/view/bossView.ts) the drawer goes through ActorsView.drawBosses
 * with a one-boss list: exactly what that frame drew.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";

/** the centipede's chain (actorsView BOSS1_SEGMENTS, BOSS1_SPACING) */
const SEGMENTS = 50;
const SPACING = 30;

/** a centipede's body: head at (x, y) heading `angle`, the chain trailing behind it in a gentle S */
export function centipedeBody(x, y, angle, bend = 0.9) {
	const bodyX = [];
	const bodyY = [];
	let px = x;
	let py = y;
	let a = angle + Math.PI;
	for (let i = 0; i < SEGMENTS; i++) {
		bodyX.push(px);
		bodyY.push(py);
		a += Math.sin(i * 0.22) * 0.09 * bend;
		px += Math.cos(a) * SPACING;
		py += Math.sin(a) * SPACING;
	}
	return { bodyX, bodyY };
}

export function bossCast() {
	const cast = [];
	for (let i = 0; i < 4; i++) cast.push({ type: 3, angle: i * 1.7, moveCycle: i * 95, flash: 0 });
	cast.push({ type: 3, angle: 0.6, moveCycle: 40, flash: 1 });
	for (let i = 0; i < 4; i++) cast.push({ type: 4, angle: i * 1.55 + 0.3, flash: 0 });
	cast.push({ type: 4, angle: 2.2, flash: 0.6 });
	for (let i = 0; i < 3; i++) cast.push({ type: 2, angle: i * 2, clock: i * 0.61, flash: 0 });
	cast.push({ type: 2, angle: 1, clock: 0.3, flash: 1 });
	cast.push({ type: 1, angle: 0.3, clock: 0.2, flash: 0 });
	cast.push({ type: 1, angle: 2.4, clock: 0.45, flash: 0.8 });
	return cast;
}

/** the space a member needs around its point (the chain of a centipede goes far behind its head) */
export function bossSpan(m) {
	return m.type === 1 ? 1500 : m.type === 2 ? 300 : 180;
}

/** a function drawing one boss of a cast at (x, y) on a stage { r, cam }, with the shadows of `sun` */
export function bossDrawer(require, SRC, sun) {
	const BV = existsSync(join(SRC, "client/view/bossView.ts")) ? require(join(SRC, "client/view/bossView.ts")) : undefined;
	if (BV === undefined) {
		// the old path draws through actorsView.ts, whose mirror half imports the network layer (and through it the
		// client's bootstrap): a drawing needs none of it, so it gets an inert stand-in
		const net = require.resolve(join(SRC, "client/net/netClient.ts"));
		const stub = { remoteBosses: () => [], remoteZombies: () => [], takeZombieDeaths: () => {} };
		require.cache[net] = { id: net, filename: net, loaded: true, exports: stub, children: [], paths: [] };
	}
	const AV = BV === undefined ? require(join(SRC, "client/view/actorsView.ts")) : undefined;
	const view = AV !== undefined ? new AV.ActorsView() : undefined;
	const all = { minX: -1e9, minY: -1e9, maxX: 1e9, maxY: 1e9 };
	return (st, m, x, y) => {
		const b = {
			id: 1,
			type: m.type,
			x,
			y,
			hp: 1,
			hpMax: 1,
			hpRecover: 0,
			damage: 0,
			exp: 0,
			moveSpeed: 0,
			angle: m.angle,
			attackCd: 0,
			dead: false,
			hitFlash: m.flash ?? 0,
			moveCycle: m.moveCycle ?? 0,
		};
		if (m.type === 1) {
			const body = centipedeBody(x, y, m.angle);
			b.bodyX = body.bodyX;
			b.bodyY = body.bodyY;
			b.bodyNumber = SEGMENTS;
		}
		const clock = m.clock ?? 0.25;
		if (BV !== undefined) BV.drawBoss(st.r, st.cam, all, b, clock, sun);
		else view.drawBosses(st.r, st.cam, all, { bosses: [b] }, { shadow: sun, clock });
	};
}
