/*
 * The rules of proximity chat, and nothing else: no service, no Instance, no Player, no Frame.
 *
 * Two ends carry them out — server/chat/proximityChat.ts decides who a line reaches, client/view/chatBubbles.ts
 * decides how long it floats over a survivor's head — and neither owns a number the other can contradict. That
 * is also why this file knows nothing about Roblox: tools/test-chat.mjs drives it directly, in Node, so the two
 * rules that are easy to get quietly wrong (who hears whom, how many lines a head carries) are pinned by CI.
 */
import { INTEREST_MID, MP_PHASE } from "shared/net/mpConfig";

// ---------------------------------------------------------------- earshot (server/chat/proximityChat.ts)

/**
 * How far a survivor is heard: the mid interest ring (docs/MULTIPLAYER.md §4.3), which is exactly as far as
 * the server replicates another survivor at all. Beyond it there is no body on your screen to hang a bubble
 * on, so a wider range could only ever produce a voice from nowhere — and a narrower one would mean watching
 * someone's mouth move in silence. The rule a player can state without reading this file: if you can see
 * them, you can hear them.
 */
export const CHAT_RANGE = INTEREST_MID;
const CHAT_RANGE_SQ = CHAT_RANGE * CHAT_RANGE;

/** a survivor's body in the world. The server reads it from its own entity — never from the client (§8.3) */
export interface ChatBody {
	x: number;
	y: number;
}

/** the squared distance is enough: nothing here needs the metre, only the comparison */
export function withinChatRange(speaker: ChatBody, listener: ChatBody): boolean {
	const dx = speaker.x - listener.x;
	const dy = speaker.y - listener.y;
	return dx * dx + dy * dy <= CHAT_RANGE_SQ;
}

/**
 * Whether one line reaches one listener.
 *
 * `undefined` means "no body in the world". A player only has a position between EnterWorld and LeaveWorld
 * (§7.1, §7.2), so whoever is sitting in the lobby, the shop or the credits neither speaks into the street
 * nor overhears it — there is no mouth and no ear to place.
 *
 * With MP_PHASE = 0 nobody has an authoritative position at all (every client simulates its own world), so
 * there is nothing to measure and every line goes to everyone, exactly as the chat does today. `phase` is a
 * parameter only so tools/test-chat.mjs can drive both worlds; callers pass the real switch.
 */
export function shouldDeliver(
	speaker: ChatBody | undefined,
	listener: ChatBody | undefined,
	phase = MP_PHASE,
): boolean {
	if (phase < 1) return true;
	if (speaker === undefined || listener === undefined) return false;
	return withinChatRange(speaker, listener);
}

// ---------------------------------------------------------------- the chat bar (client/chatInput.ts)

/**
 * May this player type into the chat? Only with a body in the world (MP-18): a line typed in the lobby reaches
 * nobody, but Roblox always shows the sender their own line, so the bar that seemed to work was a lie. Off it goes
 * where nobody can hear; with MP_PHASE = 0 everyone hears everyone, so it stays on.
 */
export function chatInputEnabled(inWorld: boolean, phase = MP_PHASE): boolean {
	return phase < 1 || inWorld;
}

// ---------------------------------------------------------------- whispers (server/chat/proximityChat.ts)

/**
 * Roblox's default /whisper (/w) command, in TextChatService.TextChatCommands. It is switched OFF (MP-17): a
 * whisper is a private channel over any distance, so it would carry a voice past earshot and out of the lobby,
 * where MP-18 says nobody speaks. Disabled, "/w name hi" is no longer intercepted and is simply said out loud.
 */
export const WHISPER_COMMAND = "RBXWhisperCommand";
/** the default whisper channels are "RBXWhisper:<UserId1>_<UserId2>" */
const WHISPER_PREFIX = "RBXWhisper:";

/** a whisper channel, by its name: one that still appears (a stale client, an engine change) delivers nothing */
export function isWhisperChannel(name: string): boolean {
	return name.sub(1, WHISPER_PREFIX.size()) === WHISPER_PREFIX;
}

// ---------------------------------------------------------------- bubbles (client/view/chatBubbles.ts)

/**
 * Lines floating over one survivor at once. Three is what stacks over a head at this camera without climbing
 * into the HUD, and about as much as anyone reads while a horde closes in. The fourth line pushes the oldest
 * one out at once instead of queueing behind it: what somebody just said is never the thing waiting its turn.
 */
export const MAX_LINES = 3;
/**
 * Seconds a line stays on screen, fade included. Roblox's own bubble chat holds 15 s, which is written for a
 * 3D game where you walk up to someone and stand there; here a survivor crosses a whole street in that time
 * and would drag a wall of stale text behind them. Seven seconds is enough to read a wrapped two-line message
 * twice over, and short enough that the screen is clear again before the next wave arrives.
 */
export const LINE_LIFE_S = 7;
/** the last stretch of that life is a fade, so a line leaves the screen instead of blinking off it */
export const LINE_FADE_S = 0.4;

/**
 * How many of the oldest lines a survivor has to drop before saying a new one: every line already past its
 * life, plus one more while the stack is still full. `born` holds each line's birth clock, oldest first.
 */
export function dropCount(born: ReadonlyArray<number>, now: number): number {
	let drop = 0;
	while (drop < born.size() && now - born[drop] >= LINE_LIFE_S) drop += 1;
	while (born.size() - drop >= MAX_LINES) drop += 1;
	return drop;
}

/** how faded a line of age `age` is: 0 = fully drawn, 1 = gone. It only fades over its last LINE_FADE_S. */
export function lineFade(age: number): number {
	const left = LINE_LIFE_S - age;
	if (left >= LINE_FADE_S) return 0;
	if (left <= 0) return 1;
	return 1 - left / LINE_FADE_S;
}
