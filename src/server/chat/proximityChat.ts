/*
 * Who hears a chat line (docs/MULTIPLAYER.md §4.3, §9.1). SERVER ONLY.
 *
 * Roblox hands us exactly the hook this needs: `TextChannel.ShouldDeliverCallback` runs ON THE SERVER, once per
 * recipient, and a line it refuses never leaves the server. Filtering the other way round — replicate every
 * message and hide the far ones in the client — is the wallhack row of §9.1 with words instead of zombies: a
 * modified client would read both the text and, from who got which line, roughly where everyone is standing.
 * MP-00 says the server decides everything that matters, and who heard you is one of those things.
 *
 * The rule itself lives in shared/chat/chatRules.ts, with no service and no Player, so tools/test-chat.mjs can
 * drive it. This file is only the wiring: find the channel, turn a TextSource into a body, answer.
 *
 * There is nothing to do about the message TEXT here. The channel filters it per recipient by itself, and the
 * filtered string is what reaches the client (client/view/chatBubbles.ts draws that and only that).
 */
import { GAME_NAME } from "shared/module";
import { ChatBody, shouldDeliver } from "shared/chat/chatRules";
import { waitForChildRobust } from "shared/chat/channelWait";

export interface ProximityChatOptions {
	/**
	 * The authoritative body of a connected player, or undefined when they have none.
	 *
	 * server/main.server.ts reads it from the running MP host, the only thing on the server that knows where
	 * anyone actually is. This module never asks the client and never looks for a Character: the game is drawn
	 * in a ScreenGui and there is no character model, which is also why Roblox's own bubble chat cannot be used.
	 */
	bodyOf: (player: Player) => ChatBody | undefined;
}

/**
 * How long to wait for the default channels before giving up (seconds). They are created by TextChatService
 * itself a moment after the server starts, so this is a stuck-boot guard, not a normal wait.
 */
const CHANNEL_WAIT = 30;

/**
 * Installs the delivery rule on the general channel. Returns at once: the channel is waited for in its own
 * thread, because main.server.ts must not block the save/economy boot behind a service that is still warming up.
 */
export function startProximityChat(options: ProximityChatOptions): void {
	const TextChatService = game.GetService("TextChatService");
	const Players = game.GetService("Players");

	task.spawn(() => {
		const channels = waitForChildRobust(TextChatService, "TextChannels", CHANNEL_WAIT);
		const general = channels !== undefined ? waitForChildRobust(channels, "RBXGeneral", CHANNEL_WAIT) : undefined;
		if (general === undefined || !general.IsA("TextChannel")) {
			// no general channel after a genuinely robust wait: the place is on the legacy chat, or default
			// channels are turned off. Chat still works, it is simply not filtered by distance — say so instead
			// of failing silently.
			warn(`[${GAME_NAME}] proximity chat: RBXGeneral not found, chat is not range-limited`);
			return;
		}
		general.ShouldDeliverCallback = (message, listener) => {
			const from = message.TextSource;
			// a TextSource whose Player has already left the server has no body either, and the rule says no
			const speaker = from !== undefined ? Players.GetPlayerByUserId(from.UserId) : undefined;
			const to = Players.GetPlayerByUserId(listener.UserId);
			return shouldDeliver(
				speaker !== undefined ? options.bodyOf(speaker) : undefined,
				to !== undefined ? options.bodyOf(to) : undefined,
			);
		};
	});
}
