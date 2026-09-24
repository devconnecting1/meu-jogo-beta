import { langGet } from "shared/data/lang";
import { createPlayer } from "shared/game/player";
import { difficultyOfDay, ownsWeapon, PlayerSaveData, sanitizeStoredSave } from "shared/game/save";
import type { GameContext } from "shared/game/context";
import { applyAdminOps, readAdminOps } from "shared/admin/ops";
import { ADMIN_LIMITS } from "shared/admin/protocol";
import { switchWeapon } from "../systems/combat";
import type { GameLoop } from "../gameLoop";
import { TEXT, THEME, TRANSPARENCY, space } from "../ui/theme";
import { Card, makeAnchored, makeLabel, tween } from "../ui/widgets";
import { toast } from "../ui/popup";
import { rebaseAchievementNotices } from "../ui/achievementNotice";
import * as saveNet from "../systems/saveClient";
import { onAdminEvent, sendPatchAck } from "./net";

/*
 * Runs on EVERY player's client (not only admins): applies admin save patches to ctx.save and to the running game at
 * once (no trip to the lobby), confirms them to the server, and shows server announcements.
 * No panel instance is created here; the announcement banner only exists while an announcement is on screen.
 */

export interface PatchDeps {
	ctx: GameContext;
	loop: GameLoop;
	/** the save was reset: drop the run in memory and go back to the lobby */
	endRun: () => void;
}

const BANNER_W = 640;
const BANNER_H = 74;
const BANNER_TIME = 8;

function copyInto(target: PlayerSaveData, source: PlayerSaveData): void {
	const t = target as unknown as Record<string, unknown>;
	for (const [k, v] of pairs(source as unknown as Record<string, unknown>)) t[k] = v;
}

/** the run in memory follows the new save: max HP (skill 0), an equipped weapon that is still owned, the day */
function refreshRun(deps: PatchDeps): void {
	const refs = deps.loop.getRefs();
	const save = deps.ctx.save;
	if (refs.save !== save) return; // the run in memory belongs to another save object
	const p = refs.player;
	const hpMax = createPlayer(save, p.x, p.y).hpMax;
	p.hpMax = hpMax;
	p.hp = math.min(p.hp, hpMax);
	if (!ownsWeapon(save, p.weapon.pointer)) switchWeapon(refs, 0);
	const dn = refs.daynight;
	if (dn.day !== save.day) {
		dn.day = save.day;
		dn.difficulty = difficultyOfDay(save.day);
	}
}

/** patches that arrived before this client adopted the server's save (LoadAck): applied right after it */
const deferred = new Map<number, Record<string, unknown>>();
/** revs already applied: the server re-sends a patch while it waits for the confirmation (idempotent) */
const applied = new Set<number>();

function applyPatch(deps: PatchDeps, ev: Record<string, unknown>, deferredPatch = false): void {
	const rev = ev.rev;
	const runRev = ev.runRev;
	if (!typeIs(rev, "number") || !typeIs(runRev, "number")) return;
	if (applied.has(rev)) {
		// a re-send: the confirmation was probably lost
		sendPatchAck(rev);
		return;
	}
	if (!saveNet.sessionReady()) {
		// ctx.save is still the offline fallback: the LoadAck adopted later may predate the edit
		deferred.set(rev, ev);
		return;
	}
	const save = deps.ctx.save;
	if (deferredPatch && save.runRev >= runRev) {
		// the save adopted meanwhile already contains this edit (its LoadAck was sent after it)
		applied.add(rev);
		sendPatchAck(rev);
		return;
	}
	// every player reads these (not only admins): through lang.ts, and naming no one -- the admin's username is theirs
	const tr = (key: string): string => langGet(key, deps.ctx.save.settings.langType);
	if (ev.reset !== undefined) {
		copyInto(save, sanitizeStoredSave(ev.reset));
		save.runRev = math.max(save.runRev, runRev);
		// rewritten in place: the achievement toast takes it as its baseline (CON-04), or re-earning one is never told
		rebaseAchievementNotices();
		applied.add(rev);
		sendPatchAck(rev);
		deps.endRun();
		toast(deps.ctx, tr("Your progress was reset by an administrator"), "error");
		return;
	}
	const ops = readAdminOps(ev.ops, ADMIN_LIMITS.OPS_PER_REQUEST);
	// not applied = not confirmed: the server keeps refusing reports that could undo the edit
	if (ops === undefined) {
		warn("[PZ-ADMIN] malformed admin patch ignored");
		return;
	}
	applyAdminOps(save, ops);
	// an admin's edit is not an achievement earned: the toast takes the edited save as its baseline (CON-04)
	rebaseAchievementNotices();
	// reports captured before this point carry the old runRev and are refused by the server
	save.runRev = math.max(save.runRev, runRev);
	refreshRun(deps);
	applied.add(rev);
	sendPatchAck(rev);
	toast(deps.ctx, tr("Your progress was updated by an administrator"), "success");
}

let bannerSerial = 0;

/** announcement banner (popover) at the top centre, above the game UI */
function showAnnouncement(ctx: GameContext, text: string, from: string): void {
	const gui = ctx.playerGui;
	let screen = gui.FindFirstChild("PZAnnouncements");
	if (screen === undefined || !screen.IsA("ScreenGui")) {
		const s = new Instance("ScreenGui");
		s.Name = "PZAnnouncements";
		s.ResetOnSpawn = false;
		s.IgnoreGuiInset = true;
		// the device safe area, like the HUD's and the menus' (client/bootstrap.ts): the frame the kit lays out in
		s.ScreenInsets = Enum.ScreenInsets.DeviceSafeInsets;
		s.DisplayOrder = 140;
		s.ZIndexBehavior = Enum.ZIndexBehavior.Sibling;
		// an admin's filtered text and a display name: never captured for automatic translation (compliance F9)
		s.AutoLocalize = false;
		s.Parent = gui;
		screen = s;
	}
	screen.FindFirstChild("Announcement")?.Destroy();
	const serial = ++bannerSerial;
	const box = makeAnchored(screen, "Announcement", 0.5, 0, BANNER_W, BANNER_H, 0, 12, true);
	const card = Card(box, "Card", {
		x: 0,
		y: 0,
		w: BANNER_W,
		h: BANNER_H,
		variant: "popover",
		transparency: TRANSPARENCY.hud,
		border: THEME.ring,
		zIndex: 10,
	});
	const head = makeLabel(
		card,
		"From",
		`ANNOUNCEMENT · ${from}`,
		space(4),
		space(2),
		BANNER_W - space(8),
		18,
		TEXT.xs,
		THEME.mutedForeground,
		{
			font: "label",
			align: "left",
			zIndex: 11,
		},
	);
	const body = makeLabel(
		card,
		"Text",
		text,
		space(4),
		26,
		BANNER_W - space(8),
		BANNER_H - 32,
		TEXT.base,
		THEME.popoverForeground,
		{
			font: "label",
			align: "left",
			zIndex: 11,
		},
	);
	// a display name and an admin's (filtered) text: never captured for automatic translation (compliance F9)
	head.AutoLocalize = false;
	body.AutoLocalize = false;
	task.delay(BANNER_TIME, () => {
		if (serial !== bannerSerial || box.Parent === undefined) return;
		tween(card, 0.3, { BackgroundTransparency: 1 });
		for (const d of card.GetDescendants()) {
			if (d.IsA("TextLabel")) tween(d, 0.3, { TextTransparency: 1 });
			else if (d.IsA("UIStroke")) tween(d, 0.3, { Transparency: 1 });
		}
		task.wait(0.35);
		box.Destroy();
	});
}

export function startAdminListeners(deps: PatchDeps): void {
	// a LoadAck was adopted (at boot, or later on the way back to the lobby): patches that waited for it apply now
	saveNet.onActivate(() => {
		if (!saveNet.sessionReady() || deferred.size() === 0) return;
		const list: Array<Record<string, unknown>> = [];
		for (const [, ev] of deferred) list.push(ev);
		deferred.clear();
		list.sort((a, b) => (a.rev as number) < (b.rev as number));
		for (const ev of list) applyPatch(deps, ev, true);
	});
	onAdminEvent(ev => {
		if (ev.kind === "patch") {
			applyPatch(deps, ev);
		} else if (ev.kind === "announce") {
			if (typeIs(ev.text, "string") && typeIs(ev.from, "string")) showAnnouncement(deps.ctx, ev.text, ev.from);
		}
	});
}
