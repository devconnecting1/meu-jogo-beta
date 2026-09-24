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
 *  3. **The unacked queue, the redundancy window and the local token bucket.** One packet per COMMAND — not
 *     per frame — carries the new command plus the two before it (§2.2: two losses in a row recover without a
 *     retransmission), so every command leaves at least once and in up to three packets whatever the frame
 *     rate (see `flush`). The bucket mirrors the server's 120/s + burst 40 limit so a frame hitch never trips it.
 *
 * What a frame rate may never cost is a command, and above all a TAP: a lost step is corrected by the
 * reconciliation, a lost shot, reload or E is simply gone. tools/test-input-buffer.mjs follows every tap from the
 * frame that made it to the `takeCommand` that simulated it, at 15 and 20 FPS and across isolated 70 / 150 ms
 * frames, and requires all of them to arrive exactly once.
 *
 * Pure: no Roblox service, no Instance. The caller feeds raw input and the current time; that is also what
 * lets tools/test-predict.mjs drive this against the real server queue (server/sim/players.ts).
 */
import { wrapU16 } from "shared/net/codec";
import { HeldBit, InputCommand, InputPacket, makeCommand, packEdges } from "shared/net/protocol";
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
 * dropped rather than fired as a burst the server would only throw away (its queue holds INPUT_BUFFER_MAX, so a
 * burst of exactly that many is all newest-kept: the queue overflows its OLDER commands, never the frame's own).
 * 4 is also exactly one frame at 15 FPS, the lowest rate that still keeps up with the server's clock.
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
	/** command intervals of TIME dropped because the accumulator was past MAX_COMMANDS_PER_FRAME (no seq is used) */
	stallDropped: number;
	/** how many stalls those drops came from */
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
	/** commands built since the last `flush`: the newest of `pending`, each still owed its own packet */
	private unsent = 0;
	// one-shot edges accumulated since the last command was built (the render frame may be shorter)
	private eAttackPress = 0;
	private eAttackRelease = 0;
	private eActionPress = 0;
	private eReload = 0;
	/** an E press of those was meant for a window's glass (EDI-18): the command carrying them says so, HeldBit.Glass */
	private eGlass = false;
	// local token bucket (§2.2)
	private tokens = INPUT_BURST;
	private bucketAt = 0;
	private sampled = 0;
	private rateDropped = 0;
	private stallDropped = 0;
	private stalls = 0;

	/**
	 * New session: forget the queue, the edges and the dilation. The NUMBERING carries on where it was, unless
	 * `startSeq` pins it (the tools do, to start from a known seq).
	 *
	 * Carrying on is what makes the server's forward-only re-anchor safe (server/sim/players.ts `enqueue`). A new
	 * run arrives with LeaveWorld + EnterWorld, and the server builds a NEW ServerPlayer that bootstraps on the
	 * first command it sees -- but an in-flight packet of the old run may be that first command. A numbering that
	 * restarted at 0 would then sit far BEHIND the one the body was anchored on, and a window that is never
	 * re-anchored backwards would refuse it for good. Carried on, every command of the new run is newer than every
	 * command of the old one, whichever lands first.
	 */
	reset(startSeq?: number): void {
		if (startSeq !== undefined) this.seq = wrapU16(startSeq);
		this.acc = 0;
		this.dilation = 1;
		this.dilationWant = 1;
		this.depth = INPUT_BUFFER_TARGET;
		this.pending.clear();
		this.unsent = 0;
		this.eAttackPress = 0;
		this.eAttackRelease = 0;
		this.eActionPress = 0;
		this.eReload = 0;
		this.eGlass = false;
		this.tokens = INPUT_BURST;
		this.bucketAt = 0;
		this.sampled = 0;
		this.rateDropped = 0;
		this.stallDropped = 0;
		this.stalls = 0;
	}

	/**
	 * The one-shot input flags of ONE render frame. They are counted (0..3 per command, §2.2) and drained by
	 * the next command built, so a press is never lost at 240 FPS nor counted twice at 30 FPS.
	 *
	 * When a frame builds several commands (15-30 FPS, or the frame that ends a hitch) the taps ride its NEWEST
	 * one. `flush` sends every command, so any of them would reach the wire; the newest is the one that best
	 * survives the wire. The oldest command of a 4-command frame travels in three packets that all leave in that
	 * same instant, and the frame's fourth packet ({c4, c3, c2}) does not carry it -- let that packet overtake the
	 * other three by a tick while the server's queue is dry (exactly the state a hitch leaves it in) and the server
	 * jumps over c1 for good. The newest command has one copy in this frame and two in the next frames' packets,
	 * and nothing sent in this frame can overtake it. It is also the tick the screen shows at the end of the
	 * frame, so the shot leaves from where the survivor is drawn.
	 */
	addEdges(attackPress: boolean, attackRelease: boolean, actionPress: boolean, reload: boolean, glass = false): void {
		if (attackPress) this.eAttackPress += 1;
		if (attackRelease) this.eAttackRelease += 1;
		if (actionPress) this.eActionPress += 1;
		if (reload) this.eReload += 1;
		// EDI-18: the E press is for the window's glass (the hint named it) -- it rides with the edge, never apart from it
		if (actionPress && glass) this.eGlass = true;
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
		const due = math.floor(this.acc / step);
		if (due > MAX_COMMANDS_PER_FRAME) this.dropBacklog(due - MAX_COMMANDS_PER_FRAME, step);
		let made = 0;
		while (this.acc >= step && made < MAX_COMMANDS_PER_FRAME) {
			this.acc -= step;
			made += 1;
			// the frame's taps ride the last command it builds (see `addEdges`)
			const newest = this.acc < step || made >= MAX_COMMANDS_PER_FRAME;
			out.push(this.build(raw, newest));
		}
	}

	/**
	 * A stall (alt-tab, a long hitch, a breakpoint) left more time in the accumulator than the server's queue could
	 * ever hold. The OLDEST `n` command intervals of it are dropped, BEFORE the frame builds its commands -- and they
	 * are dropped as TIME, not as numbers: `seq` does not move, and the unacked queue is kept.
	 *
	 * The server WAITS through the ticks it had nothing for, without spending a number (server/sim/players.ts: a
	 * filled tick never advances `lastSeq`), so after a stall it is exactly where this numbering stopped. Carrying
	 * on from there means:
	 *  - the commands this frame builds, and whatever was unacked before the stall, are all still sent (the queue
	 *    stays consecutive, which the redundancy window needs) and still replayed by the reconciliation -- they are
	 *    exactly what the server is about to simulate, so the stall costs no correction;
	 *  - no stall, however long, can push the numbering out of the ±INPUT_SEQ_WINDOW window, so it never needs the
	 *    server's re-anchor and its RESYNC_IDLE_TICKS wait (which the server may not reach in time when it stalled
	 *    too: Studio runs everything on one PC).
	 *
	 * The rule before this ADVANCED `seq` by the dropped count ("the client's copy of the server's tick numbering",
	 * from when a fill still spent a number) and cleared the unacked queue, AFTER building the frame's commands: the
	 * frame's commands -- and its taps -- were predicted and then never sent. tools/test-input-buffer.mjs case 4
	 * measured it: 156 commands predicted by their owner and never simulated, 38 of 776 taps lost.
	 */
	private dropBacklog(n: number, step: number): void {
		this.acc -= n * step;
		this.stallDropped += n;
		this.stalls += 1;
	}

	/** builds one command from `raw` -- with the edges seen since the last drain when `withEdges` -- and queues it */
	private build(raw: RawInput, withEdges: boolean): InputCommand {
		let edges = 0;
		// the glass bit is the edge's own (protocol.ts note 23): only the command that carries the E press has it
		let held = raw.held - (raw.held & HeldBit.Glass);
		if (withEdges) {
			edges = packEdges(this.eAttackPress, this.eAttackRelease, this.eActionPress, this.eReload);
			if (this.eGlass && this.eActionPress > 0) held += HeldBit.Glass;
			this.eAttackPress = 0;
			this.eAttackRelease = 0;
			this.eActionPress = 0;
			this.eReload = 0;
			this.eGlass = false;
		}
		this.seq = wrapU16(this.seq + 1);
		const mag = math.clamp(raw.magnitude, 0, 1);
		const len = math.sqrt(raw.moveX * raw.moveX + raw.moveY * raw.moveY);
		// makeCommand takes the direction's length as the magnitude: feed it a vector of exactly `mag`
		const scale = len > 1e-6 ? mag / len : 0;
		const cmd = makeCommand(this.seq, raw.moveX * scale, raw.moveY * scale, raw.aim, held, edges);
		this.pending.push(cmd);
		while (this.pending.size() > MAX_PENDING) this.pending.remove(0);
		this.unsent = math.min(this.unsent + 1, this.pending.size());
		this.sampled += 1;
		return cmd;
	}

	/**
	 * This frame's packets, appended to `out` oldest first: ONE PER COMMAND built since the last flush, each with
	 * its command plus the (up to) INPUT_REDUNDANCY - 1 unacked ones before it, newest first (§2.2). A packet the
	 * local token bucket refuses is skipped; its command still rides in the next two. A frame that built nothing
	 * sends nothing: at 240 FPS the stream stays at 60 packets/s instead of re-sending the same packet every frame.
	 *
	 * Why per COMMAND and not per frame. A packet holds INPUT_REDUNDANCY = 3 commands, and a frame of 1/15 s builds
	 * four. One packet per frame therefore never carried the oldest of them -- the one that carried the frame's taps
	 * back then -- and the server jumped over its number: at 15 FPS it simulated 3 commands in 4 (17 fills a
	 * second, 322 commands predicted and never simulated in 20 s) and 0 of 270 taps. At 20 FPS three commands
	 * a frame left each one in a single packet, i.e. no redundancy at all, and the dilation's fourth lost 21 of
	 * 360 taps; a lone 70 ms frame lost its taps the same way (tools/test-input-buffer.mjs, cases 7-10). Per
	 * command, the wire is the one §2.2 describes at every frame rate -- 60 packets/s, three copies of everything --
	 * which is still an eighth of Roblox's ~500 events/s budget per client.
	 */
	flush(viewTick: number, viewFrac: number, now: number, out: Array<InputPacket>): void {
		const list = this.pending;
		const n = list.size();
		const first = math.max(0, n - this.unsent);
		this.unsent = 0;
		for (let i = first; i < n; i++) {
			if (!this.trySend(now)) continue;
			const newest = list[i];
			const cmds = [newest];
			for (let j = i - 1; j >= 0 && cmds.size() < INPUT_REDUNDANCY; j--) {
				// §8.1 wants consecutive seqs; the queue always is, and this keeps a packet honest if it ever is not
				if (list[j].seq !== wrapU16(newest.seq - (i - j))) break;
				cmds.push(list[j]);
			}
			out.push({ viewTick, viewFrac, cmds });
		}
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

	/**
	 * The seq the next command built will carry. An edge pressed now, and a backpack verb made now (§2.4 `atSeq`,
	 * client/net/backpackSync.ts), belong to it: this frame's commands are already built.
	 */
	nextSeq(): number {
		return wrapU16(this.seq + 1);
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
