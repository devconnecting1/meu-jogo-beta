/*
 * The four bosses on screen (docs/DESIGN_RULES.md ART-14, P0-3): the centipede, the rafflesia, the giant and the
 * hedgehog -- from their pixel-art sheets once uploaded, and until then the flat drawing they always had.
 *
 * The flat drawing lived in actorsView.ts `drawBosses`; it moved here VERBATIM (tools/test-world-art.mjs §10f compares
 * its draw calls with tools/golden/bosses-flat.json, recorded from the commit before the art), so that the menus' tools
 * and the tests can draw a boss without the network half of that file. Each boss falls back on its own: its sheet and
 * its Fill / Rim masks all have ids, or it is drawn flat (ART-01) -- and a sheet the client could not fetch is given up
 * for the session like a character's (client/view/worldArt.ts), because an invisible boss is worse than a flat one.
 *
 * The art (tools/boss-model.mjs, laid out by charSheets.ts): every boss is baked at the size it is HIT at, so a cell is
 * drawn at scale 1, upright on screen from the column of its heading (the characters' rule, charArt.ts). A hit is the
 * two masks over it (white Fill at the flash's strength, white Rim), as the flat drawing turned the body white with a
 * white stroke. What it costs: the giant, the hedgehog and the rafflesia one sprite and their round shadow; the
 * centipede one sprite a segment (the flat chain was a circle a segment, legs on every third, eyes and mandibles).
 */
import { BossState, BOSS1_SEGMENT_RADIUS, bossHitRadius } from "shared/game/entities";
import { Camera, ViewRect } from "shared/engine/camera";
import { COLORS, Z } from "shared/engine/colors";
import { Renderer, SpriteOpts } from "shared/engine/renderer";
import { clamp } from "shared/engine/vec2";
import { circleInView, mix, part, quantize, SIDES } from "./drawKit";
import { drawHumanoid } from "./humanoidView";
import { columnOf, drawCell } from "./charArt";
import {
	bossColumn,
	bossRow,
	CENTIPEDE_CELL,
	CENTIPEDE_POSE_HEAD,
	CENTIPEDE_POSE_SEGMENT,
	CENTIPEDE_POSE_TAIL,
	GIANT_CELL,
	GIANT_POSE_LUNGE,
	HEDGEHOG_CELL,
	RAFFLESIA_CELL,
	rafflesiaFrame,
	stepRow,
} from "./charSheets";
import { artId } from "./worldArt";
import { WORLD_TEXEL, WorldArtName } from "./worldArtAssets";

const WHITE = COLORS.white;
const BLACK = COLORS.shadow;
const BOSS_DARK = mix(COLORS.boss, BLACK, 0.4);

/*
 * The flat drawing's option tables, one scratch per call site (M4), exactly as actorsView.ts had them.
 */
const BOSS_SHADOW: SpriteOpts = { color: BLACK, alpha: 0.35, zIndex: Z.actorShadow };
const BOSS_LEG: SpriteOpts = { h: 7, color: BOSS_DARK, cornerRadius: 3, zIndex: Z.boss - 1 };
const BOSS_SEGMENT: SpriteOpts = { stroke: BOSS_DARK, strokeThickness: 2 };
const BOSS_EYE: SpriteOpts = { circle: true, color: COLORS.detect };
const BOSS_MANDIBLE: SpriteOpts = { h: 8, color: BOSS_DARK, cornerRadius: 3, zIndex: Z.boss + 1 };
const BOSS_TENTACLE: SpriteOpts = { w: 80, h: 16, color: BOSS_DARK, cornerRadius: 8, zIndex: Z.boss };
const BOSS_NEEDLE: SpriteOpts = { w: 30, h: 8, color: BOSS_DARK, zIndex: Z.boss };
const BOSS_BODY: SpriteOpts = { zIndex: Z.boss + 1 };
/** humanoid sprites are 36 × scale wide at the shoulders: scale = hit radius / 18 matches the hitbox */
const HUMANOID_HALF_WIDTH = 18;

/** the sheet of each boss type (1 centipede, 2 rafflesia, 3 giant, 4 hedgehog) and its masks */
const SHEETS: Record<number, readonly [WorldArtName, WorldArtName, WorldArtName]> = {
	1: ["bossCentipede", "bossCentipedeFill", "bossCentipedeRim"],
	2: ["bossRafflesia", "bossRafflesiaFill", "bossRafflesiaRim"],
	3: ["bossGiant", "bossGiantFill", "bossGiantRim"],
	4: ["bossHedgehog", "bossHedgehogFill", "bossHedgehogRim"],
};

/** is boss type `kind` drawn from its sheet? (its sheet and both masks have ids; otherwise it is flat, ART-01) */
export function bossArtLive(kind: number): boolean {
	const names = SHEETS[kind];
	if (names === undefined) return false;
	for (const name of names) if (artId(name) === undefined) return false;
	return true;
}

/** the giant's surge (bossBrain `updateChargerBoss`: speed = a sine of the move cycle's first half) */
const LUNGE_FROM = 35;
const LUNGE_TO = 145;
/** the hedgehog trundles: strides a second (the wire carries no phase for it) */
const HEDGEHOG_STRIDE = 5;
/** the centipede's legs ripple down the body; its fangs work open and shut */
const LEG_RIPPLE = 12;
const FANG_BEAT = 5;

/** one cell of a boss sheet, then its hit flash (the masks), all upright on screen */
function bossCell(
	r: Renderer,
	cam: Camera,
	kind: number,
	cell: number,
	col: number,
	row: number,
	x: number,
	y: number,
	z: number,
	flash: number,
): void {
	const names = SHEETS[kind];
	drawCell(r, cam, artId(names[0]) ?? "", cell, col, row, x, y, 1, z, 1, WHITE);
	if (flash <= 0) return;
	// a hit: towards white by 70 % of the flash, with the white outline (the flat drawing's body and stroke)
	drawCell(r, cam, artId(names[1]) ?? "", cell, col, row, x, y, 1, z, 0.7 * quantize(flash), WHITE);
	drawCell(r, cam, artId(names[2]) ?? "", cell, col, row, x, y, 1, z, 1, WHITE);
}

/** a boss from its sheet (the caller checked `bossArtLive`) */
function drawBossArt(
	r: Renderer,
	cam: Camera,
	v: ViewRect,
	b: BossState,
	clock: number,
	shadow: (x: number, y: number, len: number) => { x: number; y: number },
	flash: number,
): void {
	if (b.type === 1) {
		const bodyX = b.bodyX;
		const bodyY = b.bodyY;
		if (bodyX === undefined || bodyY === undefined) return;
		const n = bodyX.size();
		const reach = (CENTIPEDE_CELL * WORLD_TEXEL) / 2;
		// tail first, head last: each plate lies over the one behind it, like the flat chain
		for (let i = n - 1; i >= 0; i--) {
			if (!circleInView(bodyX[i], bodyY[i], reach, v)) continue;
			const j0 = math.max(0, i - 1);
			const j1 = math.min(n - 1, i + 1);
			const a = j0 === j1 ? b.angle : math.atan2(bodyY[j0] - bodyY[j1], bodyX[j0] - bodyX[j1]);
			const dir = columnOf(cam, i === 0 && n > 1 ? math.atan2(bodyY[0] - bodyY[1], bodyX[0] - bodyX[1]) : a);
			let pose: number;
			if (i === 0) pose = CENTIPEDE_POSE_HEAD + (math.sin(clock * FANG_BEAT) > 0.35 ? 1 : 0);
			else if (i === n - 1) pose = CENTIPEDE_POSE_TAIL;
			else pose = CENTIPEDE_POSE_SEGMENT + stepRow(math.sin(clock * LEG_RIPPLE + i));
			const z = i === 0 ? Z.boss + 2 : Z.boss;
			bossCell(r, cam, 1, CENTIPEDE_CELL, bossColumn(dir), bossRow(pose, dir), bodyX[i], bodyY[i], z, flash);
		}
		return;
	}
	const size = bossHitRadius(b) * 2;
	const cellW = b.type === 2 ? RAFFLESIA_CELL : b.type === 3 ? GIANT_CELL : HEDGEHOG_CELL;
	if (!circleInView(b.x, b.y, (cellW * WORLD_TEXEL) / 2, v)) return;
	// the round shadow every boss had, under the art as under the flat body
	const so = shadow(b.x, b.y, 14);
	r.drawCircle(cam, b.x + so.x, b.y + so.y, size * 1.05, BOSS_SHADOW);
	if (b.type === 2) {
		bossCell(r, cam, 2, RAFFLESIA_CELL, rafflesiaFrame(clock), 0, b.x, b.y, Z.boss + 1, flash);
		return;
	}
	const dir = columnOf(cam, b.angle);
	let pose: number;
	if (b.type === 3) {
		const cycle = b.moveCycle ?? 0;
		pose = cycle >= LUNGE_FROM && cycle <= LUNGE_TO ? GIANT_POSE_LUNGE : stepRow(math.sin(math.rad(cycle)));
	} else {
		pose = stepRow(math.sin(clock * HEDGEHOG_STRIDE + b.id));
	}
	bossCell(r, cam, b.type, cellW, bossColumn(dir), bossRow(pose, dir), b.x, b.y, Z.boss + 1, flash);
}

/**
 * One boss: its pixel art when its sheet is live, otherwise the flat drawing of before, call for call. `clock` is the
 * loop's animation clock (legs, vines, the flat tentacles), `shadow` where the shadow of something at (x, y) falls.
 */
export function drawBoss(
	r: Renderer,
	cam: Camera,
	v: ViewRect,
	b: BossState,
	clock: number,
	shadow: (x: number, y: number, len: number) => { x: number; y: number },
): void {
	const flash = clamp(b.hitFlash ?? 0, 0, 1);
	if (bossArtLive(b.type)) {
		drawBossArt(r, cam, v, b, clock, shadow, flash);
		return;
	}
	// memoised blends (drawKit.mix): the same Color3 every frame, the flash on its 1/40 grid
	const color = flash > 0 ? mix(COLORS.boss, WHITE, 0.7 * quantize(flash)) : COLORS.boss;
	const dark = BOSS_DARK;
	if (b.type === 1) {
		const bodyX = b.bodyX;
		const bodyY = b.bodyY;
		if (bodyX === undefined || bodyY === undefined) return;
		// centipede: every segment is drawn at its hit radius, the head at bossHitRadius
		const n = bodyX.size();
		const seg = BOSS1_SEGMENT_RADIUS * 2;
		const head = bossHitRadius(b) * 2;
		for (let i = bodyX.size() - 1; i >= 0; i--) {
			const size = i === 0 ? head : seg;
			if (!circleInView(bodyX[i], bodyY[i], size, v)) continue;
			if (i > 0 && i % 3 === 0) {
				// legs on every third segment, across the local body direction
				const j0 = math.max(0, i - 1);
				const j1 = math.min(n - 1, i + 1);
				const da = math.atan2(bodyY[j0] - bodyY[j1], bodyX[j0] - bodyX[j1]);
				const swing = math.sin(clock * 12 + i) * 0.35;
				BOSS_LEG.w = seg * 0.5;
				for (const side of SIDES) {
					part(r, cam, bodyX[i], bodyY[i], da + side * (math.pi / 2 + swing), seg * 0.55, 0, BOSS_LEG);
				}
			}
			BOSS_SEGMENT.color = i === 0 || i % 2 === 0 ? color : mix(color, BLACK, 0.2);
			BOSS_SEGMENT.zIndex = Z.boss + (i === 0 ? 2 : 0);
			r.drawCircle(cam, bodyX[i], bodyY[i], size, BOSS_SEGMENT);
		}
		if (n > 1) {
			const ha = math.atan2(bodyY[0] - bodyY[1], bodyX[0] - bodyX[1]);
			for (const side of SIDES) {
				BOSS_EYE.w = head * 0.12;
				BOSS_EYE.h = head * 0.12;
				BOSS_EYE.zIndex = Z.boss + 3;
				part(r, cam, bodyX[0], bodyY[0], ha, head * 0.22, side * head * 0.2, BOSS_EYE);
				// mandibles
				BOSS_MANDIBLE.w = head * 0.3;
				part(r, cam, bodyX[0], bodyY[0], ha + side * 0.35, head * 0.55, 0, BOSS_MANDIBLE);
			}
		}
		return;
	}
	// types 2-4: drawn at their hit radius so what you see is what you hit
	const size = bossHitRadius(b) * 2;
	if (!circleInView(b.x, b.y, size + 60, v)) return;
	const so = shadow(b.x, b.y, 14);
	r.drawCircle(cam, b.x + so.x, b.y + so.y, size * 1.05, BOSS_SHADOW);
	if (b.type === 3) {
		drawHumanoid(
			r,
			cam,
			b.x,
			b.y,
			b.angle,
			size / 2 / HUMANOID_HALF_WIDTH,
			color,
			flash,
			1,
			math.rad(b.moveCycle ?? 0),
			Z.boss,
		);
		return;
	}
	if (b.type === 2) {
		// tentacles slowly sweeping around the stationary body
		for (let i = 0; i < 6; i++) {
			const ta = clock * 0.6 + (i * math.pi) / 3;
			part(r, cam, b.x, b.y, ta, size * 0.62, 0, BOSS_TENTACLE);
		}
	} else {
		// needles
		for (let i = 0; i < 8; i++) {
			part(r, cam, b.x, b.y, b.angle + (i * math.pi) / 4, size * 0.55, 0, BOSS_NEEDLE);
		}
	}
	BOSS_BODY.color = color;
	BOSS_BODY.stroke = flash > 0 ? WHITE : dark;
	BOSS_BODY.strokeThickness = flash > 0 ? 4 : 2;
	r.drawCircle(cam, b.x, b.y, size, BOSS_BODY);
	for (const side of SIDES) {
		BOSS_EYE.w = size * 0.12;
		BOSS_EYE.h = size * 0.12;
		BOSS_EYE.zIndex = Z.boss + 2;
		part(r, cam, b.x, b.y, b.angle, size * 0.3, side * size * 0.16, BOSS_EYE);
	}
}
