/*
 * Local input → the 60 Hz stream of quantised commands the server consumes (docs/MULTIPLAYER.md §2.2).
 *
 * Three things live here, and nothing else:
 *
 *  1. **Fixed-step sampling.** The render loop runs at whatever FPS the player's Roblox is set to (30 to 240,
 *     §0.1), but a command is always worth exactly one server tick (1/60 s). So the frame time is accumulated
 *     and turned into 0, 1 or several commands — never into a longer or shorter step. Each command is built
 *     with protocol.makeCommand, i.e. quantised EXACTLY as the server will read it, and only then predicted
 *     on (§2.2: "o cliente quantiza o próprio input … e só então roda a predição").
 *  2. **Sampling dilation.** The self block of every snapshot reports the depth of the server's input queue
 *     (`bufDepth`, target 2). A client whose clock runs a hair fast fills the queue, one that runs slow
 *     starves it. Instead of skipping or doubling commands (which would be a visible hitch), the sampling
 *     rate is dilated by at most ±2 % — 58.8 to 61.2 Hz — which is the Overwatch method the doc cites. Every
 *     command still counts as 1/60 s on both sides, so determinism is untouched.
 *  3. **The unacked queue, the redundancy window and the local token bucket.** One packet per command carries
 *     the new command plus the two before it (§2.2: two losses in a row recover without a retransmission),
 *     and the bucket mirrors the server's 120/s + burst 40 limit so a frame hitch never trips it.
 *
 * Pure: no Roblox service, no Instance. The caller feeds raw input and the current time; that is also what
 * lets tools/test-predict.mjs drive this against a simulated server.
 */
import { InputCommand, InputPacket, makeCommand, packEdges } from "shared/net/protocol";
import {
	INPUT_BUFFER_MAX,
	INPUT_BUFFER_TARGET,
	INPUT_BURST,
	INPUT_DILATION,
	INPUT_HZ,
	INPUT_RATE,
	INPUT_REDUNDANCY,
	TICK_DT,
} from "shared/net/mpConfig";

/** one frame of raw local input, already in world space (the camera rotation is undone by the caller) */
export interface RawInput {
	/** wanted direction, any length; (0, 0) = standing */
	moveX: number;
	moveY: number;
	/** stick deflection 0..1 (1 for the keyboard); the wire carries it, the speed does not use it */
	magnitude: number;
	/** aim angle in radians, world frame */
	aim: number;
	/** HeldBit mask (attack, action, sniper aim) */
	held: number;
}

/**
 * Commands produced in a single frame are capped: after a stall (loading, alt-tab) the accumulated time is
 * dropped rather than fired as a burst the server would only throw away (its queue holds INPUT_BUFFER_MAX).
 */
export const MAX_COMMANDS_PER_FRAME = INPUT_BUFFER_MAX;
/** the unacked queue never grows past this (≈ 3 s at 60 Hz): a dead link must not eat memory */
export const MAX_PENDING = 200;
/** how strongly one command of queue error bends the sampling rate, before the ±INPUT_DILATION clamp */
const DILATION_GAIN = 0.02;
/** the dilation itself eases with this time constant, so the rate never jumps */
const DILATION_TAU_S = 1;

export interface CommandStats {
	/** current sampling rate in Hz (58.8 … 61.2) */
	sampleHz: number;
	/** last server queue depth reported by a self block */
	bufDepth: number;
	/** commands sampled since the stream was reset */
	sampled: number;
	/** packets the local token bucket refused (a frame hitch, or a sampling bug) */
	rateDropped: number;
	/** commands dropped because the accumulator was past MAX_COMMANDS_PER_FRAME */
	stallDropped: number;
	/** how many stalls those drops came from; each one skips `seq` forward to stay on the server's tick count */
	stalls: number;
	/** commands still waiting for an ack */
	pending: number;
}

export class CommandStream {
	private seq = 0;
	private acc = 0;
	private dilation = 1;
	private dilationWant = 1;
	private depth = INPUT_BUFFER_TARGET;
	/** unacked commands, ascending seq (consecutive: the redundancy window needs that) */
	private readonly pending = new Array<InputCommand>();
	// one-shot edges accumulated since the last command was built (the render frame may be shorter)
	private eAttackPress = 0;
	private eAttackRelease = 0;
	private eActionPress = 0;
	private eReload = 0;
	// local token bucket (§2.2)
	private tokens = INPUT_BURST;
	private bucketAt = 0;
	private sampled = 0;
	private rateDropped = 0;
	private stallDropped = 0;
	private stalls = 0;

	/** new session: forget the queue and start the sequence at `startSeq` */
	reset(startSeq = 0): void {
		this.seq = startSeq;
		this.acc = 0;
		this.dilation = 1;
		this.dilationWant = 1;
		this.depth = INPUT_BUFFER_TARGET;
		this.pending.clear();
		this.eAttackPress = 0;
		this.eAttackRelease = 0;
		this.eActionPress = 0;
		this.eReload = 0;
		this.tokens = INPUT_BURST;
		this.bucketAt = 0;
		this.sampled = 0;
		this.rateDropped = 0;
		this.stallDropped = 0;
		this.stalls = 0;
	}

	/**
	 * The one-shot input flags of ONE render frame. They are counted (0..3 per command, §2.2) and drained by
	 * the next command, so a press is never lost at 240 FPS nor counted twice at 30 FPS.
	 */
	addEdges(attackPress: boolean, attackRelease: boolean, actionPress: boolean, reload: boolean): void {
		if (attackPress) this.eAttackPress += 1;
		if (attackRelease) this.eAttackRelease += 1;
		if (actionPress) this.eActionPress += 1;
		if (reload) this.eReload += 1;
	}

	/** `bufDepth` of the last self block: steers the ±2 % dilation towards INPUT_BUFFER_TARGET */
	noteBufDepth(depth: number): void {
		if (depth < 0 || depth > INPUT_BUFFER_MAX * 4) return;
		this.depth = depth;
		const want = 1 + (INPUT_BUFFER_TARGET - depth) * DILATION_GAIN;
		this.dilationWant = math.clamp(want, 1 - INPUT_DILATION, 1 + INPUT_DILATION);
	}

	/** seconds between two commands right now (1/60 s dilated by at most ±2 %) */
	step(): number {
		return 1 / (INPUT_HZ * this.dilation);
	}

	sampleHz(): number {
		return INPUT_HZ * this.dilation;
	}

	/** how far into the current command interval the frame is, 0..1 — the view's render lead (§5.2) */
	phase(): number {
		const s = this.step();
		return s > 0 ? math.clamp(this.acc / s, 0, 1) : 0;
	}

	/**
	 * Turns this frame into 0..MAX_COMMANDS_PER_FRAME commands, appends them to the unacked queue and to
	 * `out` (in order) for the caller to predict on. Each one is quantised exactly as the wire carries it.
	 */
	sample(dt: number, raw: RawInput, out: Array<InputCommand>): void {
		this.dilation += (this.dilationWant - this.dilation) * math.min(1, math.max(0, dt) / DILATION_TAU_S);
		this.acc += math.max(0, dt);
		const step = this.step();
		let made = 0;
		while (this.acc >= step) {
			if (made >= MAX_COMMANDS_PER_FRAME) {
				this.skipBacklog(step);
				break;
			}
			this.acc -= step;
			out.push(this.build(raw));
			made += 1;
		}
	}

	/**
	 * A stall (alt-tab, a long hitch, a breakpoint) left more simulated time in the accumulator than the server's
	 * queue could ever hold, so the backlog is dropped instead of fired as a burst it would only throw away.
	 *
	 * Dropping N commands means ADVANCING `seq` BY N. The sequence is not a counter of packets sent — it is this
	 * client's copy of the server's tick numbering (§2.2: one command is worth exactly one tick). While the client
	 * was away the server filled those ticks and moved its own `lastSeq` on, so a client that resumed at the old
	 * number would have every single command from then on read as late, and the survivor would stand still for
	 * good. (The server also re-anchors itself after ~250 ms of filled ticks, but that is the safety net; keeping
	 * the numbering aligned here is what makes the recovery immediate and costs nothing.)
	 *
	 * The unacked queue goes with it: the redundancy window has to carry consecutive seqs, and everything in it
	 * belongs to ticks the server has already filled and will refuse. The next reconciliation finds no history for
	 * the ack and rebuilds from the server's position, which is exactly right after a stall.
	 */
	private skipBacklog(step: number): void {
		const skipped = math.floor(this.acc / step);
		this.acc = 0;
		if (skipped <= 0) return;
		this.stallDropped += skipped;
		this.stalls += 1;
		this.seq = (this.seq + skipped) % 65536;
		this.pending.clear();
	}

	/** builds one command from `raw` plus the edges seen since the previous one, and queues it */
	private build(raw: RawInput): InputCommand {
		const edges = packEdges(this.eAttackPress, this.eAttackRelease, this.eActionPress, this.eReload);
		this.eAttackPress = 0;
		this.eAttackRelease = 0;
		this.eActionPress = 0;
		this.eReload = 0;
		this.seq = (this.seq + 1) % 65536;
		const mag = math.clamp(raw.magnitude, 0, 1);
		const len = math.sqrt(raw.moveX * raw.moveX + raw.moveY * raw.moveY);
		// makeCommand takes the direction's length as the magnitude: feed it a vector of exactly `mag`
		const scale = len > 1e-6 ? mag / len : 0;
		const cmd = makeCommand(this.seq, raw.moveX * scale, raw.moveY * scale, raw.aim, raw.held, edges);
		this.pending.push(cmd);
		while (this.pending.size() > MAX_PENDING) this.pending.remove(0);
		this.sampled += 1;
		return cmd;
	}

	/** the packet for the newest command: it plus the 2 before it, newest first (§2.2) */
	packet(viewTick: number, viewFrac: number): InputPacket | undefined {
		const n = this.pending.size();
		if (n === 0) return undefined;
		const cmds = new Array<InputCommand>();
		for (let i = 0; i < INPUT_REDUNDANCY && i < n; i++) cmds.push(this.pending[n - 1 - i]);
		return { viewTick, viewFrac, cmds };
	}

	/**
	 * Local rate limit, mirroring the server's token bucket (§2.2: 120 packets/s, burst 40). `now` is any
	 * monotonic clock in seconds. Returns false when this packet must be skipped.
	 */
	trySend(now: number): boolean {
		if (this.bucketAt === 0) this.bucketAt = now;
		const elapsed = math.max(0, now - this.bucketAt);
		this.bucketAt = now;
		this.tokens = math.min(INPUT_BURST, this.tokens + elapsed * INPUT_RATE);
		if (this.tokens < 1) {
			this.rateDropped += 1;
			return false;
		}
		this.tokens -= 1;
		return true;
	}

	/** the server consumed everything up to `ackSeq` (modular u16): drop it from the queue */
	ack(ackSeq: number): void {
		const list = this.pending;
		while (list.size() > 0) {
			const d = (((ackSeq - list[0].seq) % 65536) + 65536) % 65536;
			// d < 32768 means ackSeq is at or after list[0]: the server already simulated that command
			if (d >= 32768) break;
			list.remove(0);
		}
	}

	/** the commands the server has not acked yet, oldest first — what a reconciliation replays */
	unacked(): ReadonlyArray<InputCommand> {
		return this.pending;
	}

	/** the newest command, for the view's render lead */
	newest(): InputCommand | undefined {
		const n = this.pending.size();
		return n > 0 ? this.pending[n - 1] : undefined;
	}

	stats(): CommandStats {
		return {
			sampleHz: this.sampleHz(),
			bufDepth: this.depth,
			sampled: this.sampled,
			rateDropped: this.rateDropped,
			stallDropped: this.stallDropped,
			stalls: this.stalls,
			pending: this.pending.size(),
		};
	}
}

/** one command is always worth exactly this much simulated time, whatever the sampling rate (§2.2) */
export const COMMAND_DT = TICK_DT;
