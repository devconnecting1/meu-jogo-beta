/*
 * Where a survivor plays, the client's side (docs/MULTIPLAYER.md §7.4, docs/DESIGN_RULES.md MP-24): the Survivor
 * screen's Play solo (P0-2), the lobby card of the fresh-town offer (P0-1) and what a trip says while it travels.
 *
 * The client asks and shows; the SERVER decides everything (server/match/*): it reserves the town, keeps the access
 * code, picks the place, and refuses a request that cannot be honoured with a reason this file puts in words. A request
 * says only "solo" or yes / no to an offer the server made (shared/match/matchWire.ts): no day, no seed, no target.
 *
 * NEVER WITHOUT CONSENT: nothing here sends a request the player did not press -- Play solo asks first ("A town of
 * your own, on day 1"), the offer is a card with Stay and New town, and B / Backspace closes either WITHOUT answering
 * (client/ui/backStack.ts via popup.ts). The offer waits for the lobby: it never covers a run, a menu or another
 * question (it is shown when the lobby is on screen with no popup open), and it is shown once.
 *
 * No churn: the watch that waits for the lobby runs only while an offer waits to be shown, and a card or a question
 * is a popup, built when it opens and gone when it closes, like every question of the game.
 */
import { GameContext } from "shared/game/context";
import { langGet } from "shared/data/lang";
import { NET_FOLDER } from "shared/net/net";
import {
	MatchNotice,
	MatchRequest,
	REMOTE_MATCH,
	TripFailure,
	TripRefusal,
	readMatchNotice,
} from "shared/match/matchWire";
import { popup, toast } from "../ui/popup";
import { nl } from "../ui/widgets";

/** how long the client waits for the server's Match remote before it decides there is none (s) */
const REMOTE_WAIT_S = 30;
/**
 * A trip the server never answered (no failure, no refusal, and the player still here) stops blocking a new request
 * after this long (s): past the server's own give-up (server/match/travel.ts ARRIVE_TIMEOUT_S, 45 s) and its retries.
 */
const PENDING_S = 90;

/** one table (main.client.luau counts its locals; this module keeps its own few together) */
const state: {
	ctx?: GameContext;
	remote?: RemoteEvent;
	/** an offer the server made that has not been shown yet */
	offer?: { worldDay: number; bestDay: number };
	/** the watch that shows it once the lobby is on screen (only while `offer` waits) */
	watch?: RBXScriptConnection;
	/** a request sent and not yet answered by a failure or a refusal */
	pending: boolean;
	/** os.clock() when it was sent */
	pendingAt: number;
	/** the last request, for Try again */
	last?: MatchRequest;
} = { pending: false, pendingAt: 0 };

function tr(key: string): string {
	return langGet(key, state.ctx?.save.settings.langType ?? 0);
}

/** the request to the server; false when there is no server to ask (an older one, or none at all) */
function send(req: MatchRequest): boolean {
	const ctx = state.ctx;
	const remote = state.remote;
	if (ctx === undefined) return false;
	if (remote === undefined) {
		toast(ctx, tr("Play solo is not available on this server right now."), "error");
		return false;
	}
	// a Stay is an answer, not a trip: nothing to wait for
	if (req.k === "solo" || req.yes) {
		state.pending = true;
		state.pendingAt = os.clock();
		state.last = req;
	}
	remote.FireServer(req);
	return true;
}

/**
 * The Survivor screen's Play solo (client/ui/survivor.ts, through lobby.ts): the question first, then the server. A
 * trip already on its way is said, not asked twice.
 */
export function askPlaySolo(): void {
	const ctx = state.ctx;
	if (ctx === undefined) return;
	if (state.pending && os.clock() - state.pendingAt < PENDING_S) {
		toast(ctx, tr("Already on the way to your town..."));
		return;
	}
	const text = tr(
		"A town of your own, on day 1: nobody else can join it.#This life, your items and your coins come with you.",
	);
	popup(ctx, tr("Play solo"), nl(text), [
		{ text: tr("Cancel"), variant: "secondary" },
		{
			text: tr("Play solo"),
			variant: "default",
			onClick: (): void => {
				send({ k: "solo" });
			},
		},
	]);
}

/** P0-1's card: the town's day in the title, the choice below it; B closes it without an answer */
export function showOfferCard(worldDay: number): void {
	const ctx = state.ctx;
	if (ctx === undefined) return;
	const text = tr(
		"Its nights are far harder than anything you have survived yet.#Start fresh in a town of your own, on day 1? Nobody else can join it.#This life, your items and your coins come with you.",
	);
	popup(ctx, `${tr("Town")}  ·  ${tr("Day")} ${worldDay}`, nl(text), [
		{
			text: tr("Stay"),
			variant: "secondary",
			onClick: (): void => {
				send({ k: "offer", yes: false });
			},
		},
		{
			text: tr("New town"),
			variant: "default",
			onClick: (): void => {
				send({ k: "offer", yes: true });
			},
		},
	]);
}

/** the lobby is on screen with nothing over it: the moment an offer may be shown */
function lobbyFree(ctx: GameContext): boolean {
	return ctx.phase === "lobby" && ctx.uiLayer.FindFirstChild("PopupOverlay") === undefined;
}

function armOfferWatch(): void {
	if (state.watch !== undefined) return;
	state.watch = game.GetService("RunService").Heartbeat.Connect(() => {
		const ctx = state.ctx;
		const offer = state.offer;
		if (ctx === undefined || offer === undefined) {
			state.watch?.Disconnect();
			state.watch = undefined;
			return;
		}
		if (!lobbyFree(ctx)) return;
		state.offer = undefined;
		state.watch?.Disconnect();
		state.watch = undefined;
		showOfferCard(offer.worldDay);
	});
}

function refused(ctx: GameContext, why: TripRefusal): void {
	if (why === "studio") {
		popup(
			ctx,
			tr("Play solo"),
			nl(
				tr(
					"Studio cannot teleport: Play solo works in the published game.#You stay on this local test server.",
				),
			),
			[{ text: tr("Close"), variant: "secondary" }],
		);
		return;
	}
	let text = tr("Play solo is not available on this server right now.");
	if (why === "rate") text = tr("Wait a moment before trying again.");
	else if (why === "busy") text = tr("Already on the way to your town...");
	else if (why === "dead") text = tr("Choose Rebirth, the wait or New game first.");
	else if (why === "inWorld") text = tr("Go back to the lobby first.");
	else if (why === "solo") text = tr("This is already a town of your own.");
	else if (why === "loading") text = tr("Loading your progress...");
	else if (why === "noOffer") text = tr("That offer has lapsed.");
	toast(ctx, text, why === "unavailable" ? "error" : "info");
}

function failed(ctx: GameContext, why: TripFailure | undefined): void {
	if (why === "cancelled") {
		toast(ctx, tr("You entered the city: the teleport was called off."));
		return;
	}
	let text = tr("The teleport did not go through.#You are still here: try again in a moment.");
	if (why === "reserve") {
		text = tr("No town of your own could be opened right now.#You are still here: try again in a moment.");
	} else if (why === "full" || why === "denied") {
		text = tr("Roblox refused the teleport.#You are still here: try again in a moment.");
	}
	const again = state.last;
	popup(ctx, tr("Play solo"), nl(text), [
		{ text: tr("Close"), variant: "secondary" },
		{
			text: tr("Try again"),
			variant: "default",
			onClick: (): void => {
				if (again !== undefined) send(again);
			},
		},
	]);
}

/** a notice from the server (the Match remote), already read by shared/match/matchWire.ts `readMatchNotice` */
export function onMatchNotice(notice: MatchNotice | undefined): void {
	const ctx = state.ctx;
	if (ctx === undefined || notice === undefined) return;
	if (notice.k === "offer") {
		state.offer = { worldDay: notice.worldDay, bestDay: notice.bestDay };
		armOfferWatch();
		return;
	}
	if (notice.k === "refused") {
		state.pending = false;
		refused(ctx, notice.why);
		return;
	}
	if (notice.s === "start") {
		toast(ctx, tr("Heading to a town of your own..."));
	} else if (notice.s === "going") {
		toast(ctx, tr("Teleporting..."));
	} else if (notice.s === "retry") {
		toast(ctx, tr("The teleport stumbled. Trying again..."));
	} else {
		state.pending = false;
		failed(ctx, notice.why);
	}
}

/** the remote to talk through (the server's, found by `startMatchClient`; a test hands in its own) */
export function useMatchRemote(remote: RemoteEvent): RBXScriptConnection {
	state.remote = remote;
	return remote.OnClientEvent.Connect((raw: unknown) => onMatchNotice(readMatchNotice(raw)));
}

/** once, at boot (client/main.client.ts): finds the server's Match remote without holding anything up */
export function startMatchClient(ctx: GameContext): void {
	state.ctx = ctx;
	task.spawn(() => {
		const folder = game.GetService("ReplicatedStorage").WaitForChild(NET_FOLDER, REMOTE_WAIT_S);
		const remote = folder?.WaitForChild(REMOTE_MATCH, REMOTE_WAIT_S);
		if (remote !== undefined && remote.IsA("RemoteEvent")) useMatchRemote(remote);
	});
}
