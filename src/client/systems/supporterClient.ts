/*
 * Who wears the Supporter mark, as the SERVER says it (docs/DESIGN_RULES.md MON-07). The server asks the platform and
 * marks each subscriber's Player with SUPPORTER_ATTRIBUTE (server/supporter/supporter.ts); an attribute the server sets
 * replicates to every client, one this client sets itself reaches nobody else. This module only mirrors that
 * attribute into a set of UserIds, so the nameplates and the swing trails ask one Set per frame
 * (`isSupporterUser`), never a Players lookup.
 *
 * It starts itself on first use (every Player in Players, then each that joins); nothing is created per frame. With no
 * subscription configured nobody is ever marked, and every answer is false.
 *
 * And the purchase: `promptSupporter` asks the platform for its own purchase prompt (MarketplaceService
 * `PromptSubscriptionPurchase`, which the client may call). The price, the payment and the renewal are the
 * platform's; whether it went through is the server's to find out (it asks again when the status changes).
 */
import { SUPPORTER_ATTRIBUTE, SUPPORTER_SUBSCRIPTION_ID, supporterOffered } from "shared/data/supporter";

const marked = new Set<number>();
const listeners = new Array<() => void>();
let started = false;

/** is the subscription on offer in this build? (an id configured: the wardrobe's Supporter tab exists only then) */
export function supporterOnOffer(): boolean {
	return supporterOffered(SUPPORTER_SUBSCRIPTION_ID);
}

function read(player: Player): void {
	const on = player.GetAttribute(SUPPORTER_ATTRIBUTE) === true;
	const had = marked.has(player.UserId);
	if (on === had) return;
	if (on) marked.add(player.UserId);
	else marked.delete(player.UserId);
	for (const fn of listeners) fn();
}

function watch(player: Player): void {
	// a harness's stand-in Player may have no attributes at all: then it is simply never marked
	pcall(() => {
		read(player);
		player.GetAttributeChangedSignal(SUPPORTER_ATTRIBUTE).Connect(() => read(player));
	});
}

/**
 * The mirror comes alive the first time anything asks (no boot wiring to keep in sync). With no subscription on offer
 * nobody can be marked, so nothing is connected at all.
 */
function ensureStarted(): void {
	if (started || !supporterOnOffer()) return;
	started = true;
	pcall(() => {
		const Players = game.GetService("Players");
		for (const p of Players.GetPlayers()) watch(p);
		Players.PlayerAdded.Connect(watch);
		Players.PlayerRemoving.Connect(p => {
			if (marked.delete(p.UserId)) for (const fn of listeners) fn();
		});
	});
}

/** does the server say this UserId is a Supporter right now? */
export function isSupporterUser(userId: number): boolean {
	ensureStarted();
	return marked.has(userId);
}

/** is the local player a Supporter, by the server's word? */
export function localIsSupporter(): boolean {
	const me = game.GetService("Players").LocalPlayer;
	return me !== undefined && isSupporterUser(me.UserId);
}

/** `fn` hears every change of who is marked (the wardrobe's Supporter page repaints); returns the unsubscribe */
export function onSupporterChanged(fn: () => void): () => void {
	ensureStarted();
	listeners.push(fn);
	return () => {
		const i = listeners.indexOf(fn);
		if (i >= 0) listeners.remove(i);
	};
}

/** the platform's own purchase prompt for the subscription; false when there is nothing to offer */
export function promptSupporter(): boolean {
	if (!supporterOnOffer()) return false;
	const me = game.GetService("Players").LocalPlayer;
	if (me === undefined) return false;
	const [ok] = pcall(() =>
		game.GetService("MarketplaceService").PromptSubscriptionPurchase(me, SUPPORTER_SUBSCRIPTION_ID),
	);
	return ok;
}
