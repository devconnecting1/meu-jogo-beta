/*
 * "Delivered: First Night Kit" -- said when the packs are IN the backpack (MON-03), not when a run is built.
 *
 * From WORLD_SERVER_PHASE the SERVER opens the packs, and only into a living body (server/sim/backpack.ts
 * `beforeCommand`): one bought on the death screen waits for daybreak or a Rebirth instead of falling into a run the
 * New game wipes. The client used to say "Delivered" the moment it built a run, dead or alive, and wrote `packsOpened`
 * into its own copy, which no wallet ever lowered again (`applyWallet` only raises it): a survivor who died, bought a
 * pack and pressed New game (or chose to wait for daybreak) read "Delivered" and saw the pack gone from the shop while
 * the server still held it. Now the client changes nothing and says nothing until the server's wallet raises
 * `packsOpened` (server/main.server.ts `walletSignature` pushes it), and then says exactly what was opened -- at
 * daybreak, after a Rebirth, or a moment after entering alive.
 *
 * Below that phase (or with no server at all) the client still owns the backpack and opens the packs itself, as before.
 * Like client/ui/achievementNotice.ts, a save that is REPLACED (a LoadAck) is a new baseline, never announced.
 */
import { GameContext } from "shared/game/context";
import { pendingPacks, PlayerSaveData } from "shared/game/save";
import { SHOP_PACKS } from "shared/data/shop";
import { langGet } from "shared/data/lang";
import { addItem } from "shared/sim/inventory";
import { onActivate, onWalletChanged, requestSave } from "../systems/saveClient";
import { toast } from "./popup";

/** [pack id, how many of it] */
export type OpenedPacks = Array<[number, number]>;

/** the toast's memory: how many of each pack this copy already had opened */
export interface PackTracker {
	/** the save as it is now is the baseline: nothing it already holds is news */
	rebase: () => void;
	/** the packs opened since the last look, in the shop's order; a save swapped meanwhile is a baseline */
	newlyOpened: () => OpenedPacks;
}

function openedOf(save: PlayerSaveData): Array<number> {
	const out = new Array<number>();
	for (const p of SHOP_PACKS) out.push(save.packsOpened[p.id] ?? 0);
	return out;
}

/** pure (no Instances): tools/test-items.mjs drives it with the real server's wallets */
export function packTracker(current: () => PlayerSaveData): PackTracker {
	let seenSave = current();
	let seen = openedOf(seenSave);
	return {
		rebase: () => {
			seenSave = current();
			seen = openedOf(seenSave);
		},
		newlyOpened: () => {
			const save = current();
			const now = openedOf(save);
			const out: OpenedPacks = [];
			if (save === seenSave) {
				for (let i = 0; i < SHOP_PACKS.size(); i++) {
					const n = now[i] - (seen[i] ?? 0);
					if (n > 0) out.push([SHOP_PACKS[i].id, n]);
				}
			}
			seenSave = save;
			seen = now;
			return out;
		},
	};
}

/** "Delivered: First Night Kit, Pantry Crate ×2" */
export function deliveredText(opened: OpenedPacks, langType: number): string {
	const names = new Array<string>();
	for (const [id, n] of opened) {
		const pack = SHOP_PACKS.find(p => p.id === id);
		if (pack === undefined) continue;
		const name = langGet(pack.name, langType);
		names.push(n > 1 ? `${name} ×${n}` : name);
	}
	return `${langGet("Delivered", langType)}: ${names.join(", ")}`;
}

let active: PackTracker | undefined;

/**
 * A run is being built (a new world, a resumed run, the town built again). `serverDelivers` (client/net/backpackSync.ts
 * `owned`): the server opens the packs, into a living body, and its wallet says when (`startPackNotices`) -- nothing
 * changes here and nothing is said, dead or alive. Otherwise this client opens them into its own copy, says so and
 * reports it.
 */
export function deliverPacks(ctx: GameContext, serverDelivers: boolean): void {
	if (serverDelivers) return;
	const save = ctx.save;
	const opened: OpenedPacks = [];
	for (const p of SHOP_PACKS) {
		const n = pendingPacks(save, p.id);
		if (n <= 0) continue;
		for (const item of p.items) {
			if (item.index >= 0) addItem(save, item.kind, item.index, item.count * n);
		}
		save.packsOpened[p.id] = save.packsBought[p.id];
		opened.push([p.id, n]);
	}
	// said here: the wallet that echoes it later is not news
	active?.rebase();
	if (opened.size() > 0) {
		toast(ctx, deliveredText(opened, save.settings.langType), "success");
		requestSave("packs");
	}
}

/** listens to the server's wallets for the rest of the session (call once, at boot) */
export function startPackNotices(ctx: GameContext): void {
	const tracker = packTracker(() => ctx.save);
	active = tracker;
	// a LoadAck adopted as ctx.save is the new baseline, taken the moment it is adopted (client/ui/achievementNotice.ts)
	onActivate(() => tracker.rebase());
	onWalletChanged(() => {
		const opened = tracker.newlyOpened();
		if (opened.size() > 0) toast(ctx, deliveredText(opened, ctx.save.settings.langType), "success");
	});
}
