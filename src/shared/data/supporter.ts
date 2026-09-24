/*
 * "Last Town Supporter": the game's one subscription (docs/DESIGN_RULES.md MON-07, docs/MONETIZATION.md §3), a Roblox
 * Experience Subscription paid monthly in Robux. It sells a THANK-YOU you can see, and nothing a night could feel:
 *
 *   - the Supporter mark: a pixel heart beside your name, on your nameplate, for everybody (never a title, never in
 *     the Titles list, never counted with them: titles are earned by playing, MON-05);
 *   - your melee swing trail in the Supporter rose, for everybody (MON-02: a trail is a channel that reads at 32 px).
 *
 * Never: coins, XP, loot, damage, health, speed, a Rebirth, a skipped wait, a title or an achievement (MON-01, BEM-03).
 * While the subscription is active the perks show; when it lapses they are simply off -- nothing was stored, so nothing
 * is taken back, and nothing else about the survivor changes. No monthly gift is promised (MON-03: we do not promise a
 * cadence we cannot honour); if one is ever given, what was given is kept for good.
 *
 * WHO IS A SUPPORTER is the SERVER's word alone: server/supporter/supporter.ts asks MarketplaceService
 * `GetUserSubscriptionStatusAsync` on join, again when Players `UserSubscriptionStatusChanged` says the status moved,
 * and every SUPPORTER_REFRESH_S; it keeps the answer and marks the Player with the attribute SUPPORTER_ATTRIBUTE, which
 * replicates to every client (a client's own attribute never leaves it). The client only reads that attribute
 * (client/systems/supporterClient.ts) and asks the platform for the purchase prompt; nothing a client says is believed.
 *
 * The id comes from the Creator Hub (Monetization > Subscriptions: "EXP-" and digits; docs/CREATOR_HUB.md
 * "Assinatura Supporter"). Empty = the subscription does not exist yet: the server asks nothing, marks nobody, and the
 * wardrobe shows no Supporter tab.
 */

/** the subscription's id from the Creator Hub ("EXP-1234567890"); "" = not created yet, everything hidden */
export const SUPPORTER_SUBSCRIPTION_ID = "";

/**
 * The Player attribute the server sets while that player's subscription is active (true) -- a `pz_*` name, like every
 * attribute the server and the clients share; never renamed (docs/CREATOR_HUB.md "Nomes de armazenamento").
 */
export const SUPPORTER_ATTRIBUTE = "pz_supporter";

/** how often the server asks again for everybody in the server (seconds): a lapse mid-session shows within this */
export const SUPPORTER_REFRESH_S = 600;

/** is `v` a subscription id as the Creator Hub writes it: "EXP-" and 1 to 30 digits */
export function isSubscriptionId(v: unknown): v is string {
	if (!typeIs(v, "string")) return false;
	const n = v.size();
	if (n < 5 || n > 34 || v.sub(1, 4) !== "EXP-") return false;
	for (let i = 5; i <= n; i++) {
		const c = v.sub(i, i);
		if (c < "0" || c > "9") return false;
	}
	return true;
}

/** is the subscription on offer in this build (a real id configured)? */
export function supporterOffered(id: string = SUPPORTER_SUBSCRIPTION_ID): boolean {
	return isSubscriptionId(id);
}
