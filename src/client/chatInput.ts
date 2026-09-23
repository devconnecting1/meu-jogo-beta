import { langGet } from "shared/data/lang";
import { chatInputEnabled, WHISPER_COMMAND } from "shared/chat/chatRules";

/*
 * The chat bar follows the body (MP-18, compliance F11).
 *
 * Proximity chat delivers a line only between two survivors in the town (server/chat/proximityChat.ts). In the lobby,
 * the shop or the credits there is no body, so a line typed there reaches nobody -- and Roblox always shows the
 * sender their own line, so the player believed they had been heard. Two ways out were weighed:
 *   - leave the bar on and post a system line "nobody hears you here" after each message: the line still looks sent,
 *     the hint arrives after the mistake, and it repeats for every message;
 *   - turn the bar OFF where nobody can hear (chosen): nothing pretends to be sent. The chat window stays (history,
 *     and the Roblox menu's report and block stay reachable), and the first time the bar goes off one system line
 *     says why and how to talk: enter the city.
 * The bar is on in the town, alive or waiting for daybreak (a dead body still has a place, and still hears).
 *
 * Whispers are off (MP-17): the server switches the /whisper command off; the client does the same, so the bar never
 * opens a whisper tab the server would not deliver.
 */

const TextChatService = game.GetService("TextChatService");

/** the one system line, shown once per session: attempts while the channel is still being created */
const HINT_TRIES = 5;
const HINT_RETRY_S = 3;
/** the bar's configuration may not exist in the very first frames */
const BAR_TRIES = 10;
const BAR_RETRY_S = 1;

let lastOn: boolean | undefined;
let hinted = false;

/**
 * The bar's switch is a child of TextChatService the engine creates (TextChatService.ChatInputBarConfiguration in
 * Luau). The lobby comes up in the first frames, possibly before it exists: then this tries again, with whatever the
 * phase says by then.
 */
function applyBar(triesLeft: number): void {
	const bar = TextChatService.FindFirstChildOfClass("ChatInputBarConfiguration");
	if (bar !== undefined) {
		if (lastOn !== undefined) bar.Enabled = lastOn;
		return;
	}
	if (triesLeft > 1) task.delay(BAR_RETRY_S, () => pcall(applyBar, triesLeft - 1));
}

function whispersOff(): void {
	const commands = TextChatService.FindFirstChild("TextChatCommands");
	const whisper = commands?.FindFirstChild(WHISPER_COMMAND);
	if (whisper !== undefined && whisper.IsA("TextChatCommand")) whisper.Enabled = false;
}

function tryHint(text: string, triesLeft: number): void {
	if (hinted || lastOn !== false) return;
	const channels = TextChatService.FindFirstChild("TextChannels");
	const channel = channels?.FindFirstChild("RBXSystem") ?? channels?.FindFirstChild("RBXGeneral");
	if (channel !== undefined && channel.IsA("TextChannel")) {
		hinted = true;
		pcall(() => channel.DisplaySystemMessage(text));
		return;
	}
	if (triesLeft > 1) task.delay(HINT_RETRY_S, () => tryHint(text, triesLeft - 1));
}

/** called on every phase change (client/bootstrap.ts setPhase): `inWorld` = the survivor has a body in the town */
export function syncChatInput(inWorld: boolean, langType: number): void {
	const on = chatInputEnabled(inWorld);
	if (on === lastOn) return;
	lastOn = on;
	pcall(applyBar, BAR_TRIES);
	pcall(whispersOff);
	if (!on) {
		const hint = langGet("Chat reaches the survivors near you in town. Enter the city to talk.", langType);
		tryHint(hint, HINT_TRIES);
	}
}
