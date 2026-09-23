/*
 * What a survivor just said, floating over their head.
 *
 * Roblox's own bubble chat cannot do this here. It anchors to the character model, and this game has no
 * character: no Humanoid, no head, not one Part in the Workspace. A survivor is a handful of Frames drawn by
 * client/view/survivorView.ts. So a bubble follows the nameplate's pattern instead (client/ui/nameplate.ts):
 * a Frame in the layer that covers the viewport, above the night light map and below the HUD, moved every
 * frame by `cam.worldToScreen`. It stacks UPWARD from the head while the nameplate hangs under the body, so
 * the two never meet however much anyone says.
 *
 * What is drawn is the text the channel DELIVERED (`Status = Success`), never what was typed. The delivered
 * string is the filtered one — the only version Roblox allows anyone to show, and the only one the server
 * vouches for. Who hears whom was already decided on the server (server/chat/proximityChat.ts); a line that
 * reaches this file has earned its place on screen, and this file never second-guesses it.
 *
 * Nothing is built inside a frame: a bubble is built when its line arrives, which is its own event, and the
 * frame loop only moves and fades what already exists.
 */
import { Camera, ViewRect } from "shared/engine/camera";
import { ChatBody, dropCount, lineFade } from "shared/chat/chatRules";
import { GAME_NAME } from "shared/module";
import { RADIUS, TEXT, THEME, TRANSPARENCY, fontOf, space } from "../ui/theme";
import { addStroke, onLayoutChange, uiScale } from "../ui/widgets";
import { RemotePlayerView } from "../net/netTypes";
import { circleInView } from "./drawKit";
import { SURVIVOR_R } from "./survivorView";

const TextChatService = game.GetService("TextChatService");
const Players = game.GetService("Players");

/** how long to wait for the default channels before giving up (seconds); they exist moments after joining */
const CHANNEL_WAIT = 30;

/**
 * World units from the survivor's centre to the bottom of the stack. The same 14 the nameplate uses on the
 * other side of the body, so a survivor reads symmetrically: what they are is written below, what they said
 * is written above.
 */
const HEAD_GAP = 14;
/**
 * Widest a bubble gets before the text wraps, in design px of the 1120 x 630 layout. About a seventh of the
 * screen: wide enough for a sentence to wrap into two or three lines, narrow enough that two survivors
 * talking side by side do not cover the street between them.
 */
const MAX_W = 168;
/**
 * Characters kept from one line. Roblox allows 200, which at this width would be eight rows of text hiding a
 * quarter of the map; the bubble is the glance and the chat window is still the full record.
 */
const MAX_CHARS = 90;
/** the nameplate's name size: a bubble is the same voice, so it is the same type */
const BUBBLE_TEXT = TEXT.sm - 1;
/** margin around the body when culling: the stack reaches far above the hitbox */
const CULL_MARGIN = 220;
/**
 * A survivor whose body has not been seen for this long loses their bubbles. Half a second is longer than any
 * gap the interpolation can leave (the mid ring refreshes at 10 Hz, §4.3) and short enough that a line never
 * outlives the survivor who said it in a way anyone notices — leaving the world, or dying, takes the words
 * with the mouth.
 */
const ANCHOR_GRACE_S = 0.5;
/** transparency step below which a write is not worth making (client/view/allyPlate.ts does the same) */
const ALPHA_STEP = 1 / 24;

/** one line on screen */
interface Bubble {
	frame: Frame;
	label: TextLabel;
	stroke: UIStroke;
	/** os.clock() when the line was delivered */
	born: number;
	/** last fade written, so a bubble nobody is looking at costs nothing */
	lastFade: number;
}

/** one survivor's stack of lines */
interface Speaker {
	/** anchored at the head by its bottom edge, so the stack grows upward */
	host: Frame;
	/** oldest first — the order shared/chat/chatRules.ts is written for */
	lines: Array<Bubble>;
	/** LayoutOrder counter: newer lines sit lower, closest to the head */
	order: number;
	shown: boolean;
	lastX: number;
	lastY: number;
	/** os.clock() of the last frame this survivor had a body */
	seen: number;
}

function quantise(a: number): number {
	return math.round(a / ALPHA_STEP) * ALPHA_STEP;
}

/** cut on a character boundary, never inside a "ç" or an emoji, and say that something was cut */
function clip(text: string): string {
	const [n] = utf8.len(text);
	if (!typeIs(n, "number") || n <= MAX_CHARS) return text;
	const cut = utf8.offset(text, MAX_CHARS + 1);
	return cut !== undefined ? `${text.sub(1, cut - 1)}…` : text;
}

export class ChatBubbles {
	private readonly speakers = new Map<number, Speaker>();
	private readonly parent: GuiObject;
	private readonly zIndex: number;
	/**
	 * The local survivor's id. This view reads it itself — unlike the nameplate, which takes whoever it names
	 * — because it is already the one client's chat feed: there is exactly one LocalPlayer behind it.
	 */
	private readonly selfId: number;
	/** birth clocks handed to `dropCount`, refilled in place instead of allocating per line */
	private readonly scratch = new Array<number>();
	private conn?: RBXScriptConnection;
	private closed = false;

	constructor(parent: GuiObject, zIndex: number) {
		this.parent = parent;
		this.zIndex = zIndex;
		this.selfId = Players.LocalPlayer.UserId;
		// the channel appears a moment after joining, and WaitForChild yields: never on the render thread
		task.spawn(() => {
			const channels = TextChatService.WaitForChild("TextChannels", CHANNEL_WAIT);
			const general = channels?.WaitForChild("RBXGeneral", CHANNEL_WAIT);
			if (this.closed) return;
			if (general === undefined || !general.IsA("TextChannel")) {
				warn(`[${GAME_NAME}] chat bubbles: RBXGeneral not found, nothing will float over anyone`);
				return;
			}
			// the same channel the server filtered by distance, so what floats is exactly what was delivered
			this.conn = general.MessageReceived.Connect(m => this.onMessage(m));
		});
	}

	/**
	 * Every frame, right after the nameplates. `own` is the local survivor's centre, or undefined when they
	 * have no body (dead) — the one case where you stop seeing your own line, because there is nothing left
	 * to hang it on.
	 */
	update(cam: Camera, v: ViewRect, allies: ReadonlyArray<RemotePlayerView>, own: ChatBody | undefined): void {
		// the common case by far: nobody is talking, and a silent game pays nothing for the feature
		if (this.speakers.size() === 0) return;
		// a line ages in real seconds: chat is outside the world's clock, and a paused game must not freeze it
		const now = os.clock();
		if (own !== undefined) this.place(this.speakers.get(this.selfId), cam, v, own.x, own.y, now);
		for (const rp of allies) {
			// hp <= 0: the survivor is gone, and so is anything they were still saying
			if (rp.hp > 0) this.place(this.speakers.get(rp.userId), cam, v, rp.x, rp.y, now);
		}
		this.sweep(now);
	}

	/** leaving the game screen: you left the world, so every line goes with the bodies that carried it */
	hide(): void {
		for (const [, sp] of this.speakers) sp.host.Destroy();
		this.speakers.clear();
	}

	destroy(): void {
		this.closed = true;
		this.conn?.Disconnect();
		this.conn = undefined;
		this.hide();
	}

	// ------------------------------------------------------------------ incoming lines

	private onMessage(message: TextChatMessage): void {
		// the sending client sees its OWN raw line first (Status = Sending) and the server's processed one
		// after; only the delivered one is the filtered text, and only it passed the proximity rule
		if (message.Status !== Enum.TextChatMessageStatus.Success) return;
		const source = message.TextSource;
		// a system line has no speaker, so it has no body to float over; it stays in the chat window
		if (source === undefined) return;
		const text = message.Text;
		if (text === "") return;
		this.say(source.UserId, clip(text));
	}

	private say(userId: number, text: string): void {
		const now = os.clock();
		const sp = this.speakerOf(userId, now);
		const born = this.scratch;
		born.clear();
		for (const b of sp.lines) born.push(b.born);
		for (let drop = dropCount(born, now); drop > 0; drop -= 1) {
			const old = sp.lines.remove(0);
			old?.frame.Destroy();
		}
		const bubble = this.newBubble(sp);
		bubble.born = now;
		bubble.label.Text = text;
		sp.lines.push(bubble);
	}

	// ------------------------------------------------------------------ per frame

	/** put one survivor's stack over their head, or hide it when they are off screen */
	private place(sp: Speaker | undefined, cam: Camera, v: ViewRect, x: number, y: number, now: number): void {
		if (sp === undefined) return;
		sp.seen = now;
		// off screen: keep the instances, show nothing — a bubble on the edge would point at empty asphalt
		if (!circleInView(x, y, SURVIVOR_R + CULL_MARGIN, v)) {
			if (sp.shown) {
				sp.shown = false;
				sp.host.Visible = false;
			}
			return;
		}
		if (!sp.shown) {
			sp.shown = true;
			sp.host.Visible = true;
		}
		const at = cam.worldToScreen(x, y - SURVIVOR_R - HEAD_GAP);
		const sx = math.round(at.x);
		const sy = math.round(at.y);
		if (sx !== sp.lastX || sy !== sp.lastY) {
			sp.lastX = sx;
			sp.lastY = sy;
			sp.host.Position = UDim2.fromOffset(sx, sy);
		}
	}

	/** retire what has run out: expired lines, then the survivors who have nothing left to say (or no body) */
	private sweep(now: number): void {
		const gone = new Array<number>();
		for (const [userId, sp] of this.speakers) {
			if (now - sp.seen > ANCHOR_GRACE_S) {
				gone.push(userId);
				continue;
			}
			this.fade(sp, now);
			if (sp.lines.size() === 0) gone.push(userId);
		}
		for (const userId of gone) {
			this.speakers.get(userId)?.host.Destroy();
			this.speakers.delete(userId);
		}
	}

	/** oldest first, so everything that has to go is at the front of the stack */
	private fade(sp: Speaker, now: number): void {
		const lines = sp.lines;
		while (lines.size() > 0 && lineFade(now - lines[0].born) >= 1) {
			lines.remove(0)?.frame.Destroy();
		}
		for (const b of lines) {
			const f = quantise(lineFade(now - b.born));
			if (f === b.lastFade) continue;
			b.lastFade = f;
			b.frame.BackgroundTransparency = TRANSPARENCY.nameplate + (1 - TRANSPARENCY.nameplate) * f;
			b.stroke.Transparency = f;
			b.label.TextTransparency = f;
		}
	}

	// ------------------------------------------------------------------ instances

	private speakerOf(userId: number, now: number): Speaker {
		let sp = this.speakers.get(userId);
		if (sp !== undefined) return sp;
		const host = new Instance("Frame");
		host.Name = `Chat_${userId}`;
		host.AnchorPoint = new Vector2(0.5, 1);
		host.AutomaticSize = Enum.AutomaticSize.XY;
		host.Size = UDim2.fromOffset(0, 0);
		host.BackgroundTransparency = 1;
		host.BorderSizePixel = 0;
		host.ZIndex = this.zIndex;
		// a bubble is something to read, never something to click: it must not eat a shot at what is behind it
		host.Active = false;
		// hidden until a frame finds the body it belongs to (someone in the lobby has none)
		host.Visible = false;
		const layout = new Instance("UIListLayout");
		layout.FillDirection = Enum.FillDirection.Vertical;
		layout.HorizontalAlignment = Enum.HorizontalAlignment.Center;
		layout.SortOrder = Enum.SortOrder.LayoutOrder;
		layout.Parent = host;
		onLayoutChange(host, () => {
			layout.Padding = new UDim(0, math.max(1, math.round(space(0.5) * uiScale())));
		});
		host.Parent = this.parent;
		sp = {
			host,
			lines: new Array<Bubble>(),
			order: 0,
			shown: false,
			lastX: math.huge,
			lastY: math.huge,
			seen: now,
		};
		this.speakers.set(userId, sp);
		return sp;
	}

	private newBubble(sp: Speaker): Bubble {
		const z = this.zIndex;
		const frame = new Instance("Frame");
		frame.Name = "Line";
		frame.LayoutOrder = ++sp.order;
		frame.AutomaticSize = Enum.AutomaticSize.XY;
		frame.Size = UDim2.fromOffset(0, 0);
		frame.BackgroundColor3 = THEME.popover;
		frame.BackgroundTransparency = TRANSPARENCY.nameplate;
		frame.BorderSizePixel = 0;
		frame.ZIndex = z;
		frame.Active = false;
		const corner = new Instance("UICorner");
		corner.Parent = frame;
		const stroke = addStroke(frame, THEME.border);
		const pad = new Instance("UIPadding");
		pad.Parent = frame;
		const layout = new Instance("UIListLayout");
		layout.FillDirection = Enum.FillDirection.Vertical;
		layout.HorizontalAlignment = Enum.HorizontalAlignment.Center;
		layout.Parent = frame;

		const label = new Instance("TextLabel");
		label.Name = "Text";
		label.AutomaticSize = Enum.AutomaticSize.XY;
		label.Size = UDim2.fromOffset(0, 0);
		label.BackgroundColor3 = THEME.background;
		label.BackgroundTransparency = 1;
		label.BorderSizePixel = 0;
		label.TextColor3 = THEME.popoverForeground;
		label.TextXAlignment = Enum.TextXAlignment.Center;
		label.TextWrapped = true;
		label.FontFace = fontOf("sans", Enum.FontWeight.Medium);
		// player text is never markup: RichText off means a typed "<b>" reads as a typed "<b>"
		label.RichText = false;
		label.AutoLocalize = false;
		label.Text = "";
		label.ZIndex = z;
		// the wrap width: AutomaticSize grows the label to the text, the constraint decides where it folds
		const cap = new Instance("UISizeConstraint");
		cap.Parent = label;
		label.Parent = frame;

		// AutomaticSize needs real TextSize / offsets, so everything in design px is recomputed on a resize
		onLayoutChange(frame, () => {
			const s = uiScale();
			const px = (v: number): number => math.max(1, math.round(v * s));
			corner.CornerRadius = new UDim(0, px(RADIUS.lg));
			pad.PaddingLeft = new UDim(0, px(space(2)));
			pad.PaddingRight = new UDim(0, px(space(2)));
			pad.PaddingTop = new UDim(0, px(space(1)));
			pad.PaddingBottom = new UDim(0, px(space(1)));
			label.TextSize = px(BUBBLE_TEXT);
			cap.MaxSize = new Vector2(px(MAX_W), math.huge);
		});

		frame.Parent = sp.host;
		return { frame, label, stroke, born: 0, lastFade: 0 };
	}
}
