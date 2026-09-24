/*
 * The Supporter subscription's server side (docs/DESIGN_RULES.md MON-07): the real services wired to the rules of
 * server/supporter/supporter.ts. A Script of its own, so the subscription touches nothing of the save, the economy or
 * the shop's ProcessReceipt in server/main.server.ts: it only asks the platform and marks the Player.
 *
 * With no subscription configured (shared/data/supporter.ts SUPPORTER_SUBSCRIPTION_ID = "") it connects nothing.
 */
import { GAME_NAME } from "shared/module";
import { SUPPORTER_SUBSCRIPTION_ID, supporterOffered } from "shared/data/supporter";
import * as Analytics from "./analytics/events";
import { SUPPORTER_REFRESH_S, SupporterStatusBook, setSupporterBook } from "./supporter/supporter";

function start(): void {
	if (!supporterOffered(SUPPORTER_SUBSCRIPTION_ID)) return;
	const Players = game.GetService("Players");
	const Marketplace = game.GetService("MarketplaceService");
	const book = new SupporterStatusBook<Player>(SUPPORTER_SUBSCRIPTION_ID, {
		status: (player, id) => Marketplace.GetUserSubscriptionStatusAsync(player, id),
		present: player => player.Parent === Players,
		delay: (s, fn) => {
			task.delay(s, fn);
		},
		changed: (player, active) => Analytics.supporterChanged(player, active),
		log: line => print(`[${GAME_NAME}] ${line}`),
	});
	setSupporterBook(book);
	const join = (player: Player): void => {
		task.spawn(() => book.check(player, "join"));
	};
	Players.PlayerAdded.Connect(join);
	// a player who joined before this Script connected
	for (const player of Players.GetPlayers()) join(player);
	Players.PlayerRemoving.Connect(player => book.forget(player));
	Players.UserSubscriptionStatusChanged.Connect((player, subscriptionId) => {
		task.spawn(() => book.statusChanged(player, subscriptionId));
	});
	// the prompt's close, where the server hears it (the client asks the platform itself; this only makes us ask again)
	pcall(() => {
		Marketplace.PromptSubscriptionPurchaseFinished.Connect((player, subscriptionId, didTry) => {
			book.promptFinished(player, subscriptionId, didTry);
		});
	});
	task.spawn(() => {
		for (;;) {
			task.wait(SUPPORTER_REFRESH_S);
			book.refreshAll(Players.GetPlayers(), fn => {
				task.spawn(fn);
			});
		}
	});
}

start();
