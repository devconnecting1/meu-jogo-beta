import { MP_PHASE } from "shared/net/mpConfig";
import { updateBosses as stepBosses } from "shared/sim/ai/bossBrain";
import { GameRefs } from "./types";
import { aiContext } from "./zombieAI";

/*
 * The client's side of the bosses (docs/MULTIPLAYER.md §11.3 F2). Their behaviour moved to
 * shared/sim/ai/bossBrain.ts, which the authoritative server tick runs (server/sim/bosses.ts); this is the
 * adapter, and it stops simulating entirely once the server owns them (MP_PHASE >= 2).
 */

export function updateBosses(refs: GameRefs, dt: number): void {
	if (MP_PHASE >= 2) return;
	stepBosses(aiContext(refs), dt);
}
