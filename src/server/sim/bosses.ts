import { BOSS_NET_ID_MAX } from "shared/net/mpConfig";
import { BossState } from "shared/game/entities";
import * as Ctx from "shared/sim/ai/context";
import { updateBosses } from "shared/sim/ai/bossBrain";

/*
 * The server's bosses (docs/MULTIPLAYER.md §3.1 step 2, §4.2 "Chefe", §11.3 F2-2A).
 *
 * The behaviour is the shared one (shared/sim/ai/bossBrain.ts); what lives here is what only the server has:
 * the identity a boss travels under (`netId`, a u8 per §4.2) and the death the replication has to announce.
 * The centipede's 50 body segments never go on the wire — the client rebuilds the trail from the head — so
 * nothing here has to keep a history of them.
 */

export interface BossDeath {
	netId: number;
	type: number;
	x: number;
	y: number;
}

interface BossRecord {
	netId: number;
	x: number;
	y: number;
	type: number;
	tick: number;
}

/** the bosses alive on this server, with the ids the snapshot carries */
export class BossRoster {
	readonly list: Array<BossState> = [];

	private readonly ids = new Map<BossState, BossRecord>();
	private readonly free: Array<number> = [];
	private readonly deaths: Array<BossDeath> = [];
	private nextId = 1;

	private takeId(): number {
		const reused = this.free.shift();
		if (reused !== undefined) return reused;
		if (this.nextId > BOSS_NET_ID_MAX) return BOSS_NET_ID_MAX;
		const id = this.nextId;
		this.nextId += 1;
		return id;
	}

	/** the id this boss travels under, or 0 while it has not been registered yet */
	netIdOf(b: BossState): number {
		return this.ids.get(b)?.netId ?? 0;
	}

	/**
	 * One tick of every boss, then the bookkeeping: new bosses get an id, the ones that left the list are
	 * announced as dead. A boss list is at most MAX_BOSSES long, so both passes are free.
	 */
	step(refs: Ctx.AiRefs, dt: number, tick: number): void {
		updateBosses(refs, dt);
		for (const b of this.list) {
			let rec = this.ids.get(b);
			if (rec === undefined) {
				rec = { netId: this.takeId(), x: b.x, y: b.y, type: b.type, tick };
				this.ids.set(b, rec);
			} else {
				rec.x = b.x;
				rec.y = b.y;
				rec.tick = tick;
			}
		}
		if (this.ids.size() === this.list.size()) return;
		const gone = new Array<BossState>();
		for (const [b, rec] of this.ids) {
			if (rec.tick !== tick) gone.push(b);
		}
		for (const b of gone) {
			const rec = this.ids.get(b) as BossRecord;
			this.ids.delete(b);
			// a boss id comes back into play at once: there are at most MAX_BOSSES and the death is reliable
			this.free.push(rec.netId);
			this.deaths.push({ netId: rec.netId, type: rec.type, x: rec.x, y: rec.y });
		}
	}

	/** the bosses that died since the last call (F2-2D sends one reliable event per entry) */
	takeDeaths(out: Array<BossDeath>): Array<BossDeath> {
		for (const d of this.deaths) out.push(d);
		this.deaths.clear();
		return out;
	}
}
