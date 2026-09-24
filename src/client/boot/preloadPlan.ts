/*
 * The client's ONE preload plan (ContentProvider:PreloadAsync), in the order the player needs the assets.
 *
 * The engine keeps every downloaded asset in its own disk cache; a preload only fetches ahead of time, so an image is
 * already there the first time it is drawn. The Roblox docs recommend preloading only what is needed first -- the
 * loading screen, the menu, the starting area -- never everything. What this game shows first is the lobby: the kit's
 * panels over the real town gliding behind them (UI-10). So, one thread, one step after the other:
 *
 *   1. what the first screens are made of: the UI skin (client/ui/skin.ts preloadSkin: 13 tiny textures, and its
 *      own flat fallback), the item icons' atlas (client/ui/itemIcon.ts: the HUD's hotbar and the Bag draw from it),
 *      then the textures of the town the lobby's flyover draws -- the very town the match takes
 *      (client/boot/townCache.ts): the ground, roads, roofs, trees, cars, litter, and last its building signs (ART-07)
 *      and the helipad, small on the facades. The menu icons are pixel Frames (client/ui/pixelIcon.ts): nothing to
 *      fetch;
 *   2. the characters' sheets (client/view/charSheets.ts, charArt.ts: the lobby's walkers, a run's bodies), then
 *      the world art's own pass (client/view/worldArt.ts preloadWorldArt): it asks for every texture again -- by now
 *      all in the cache, so it is quick -- and keeps its fallbacks exactly as they are (every texture missing after a
 *      retry: the town is drawn flat; a character sheet missing: its group is drawn flat; the atlas missing: the
 *      icons are drawn with Frames);
 *   3. the sounds (client/audio/audio.ts preloadSounds): the interface first (the lobby's clicks), then the run's
 *      effects, then the music and ambience beds.
 *
 * Nothing waits on it: the logo, the lobby and the input run as before, and whatever is not in yet draws the moment
 * it lands. Probes are real ImageLabels / Sounds (skin.ts measured that a content string reports Failure), parented
 * out of sight; the docs note the engine may drop an invisible texture from memory after the preload, but it stays in
 * the disk cache, which is what saves the download. One line in the Output when it is done: [PZ-LOAD] preload ...
 */
import { SOUNDS, SoundBus, SoundDef } from "shared/data/sounds";
import { preloadSkin } from "../ui/skin";
import { preloadWorldArt } from "../view/worldArt";
import { WORLD_ART, WORLD_ART_NAMES, WorldArtName } from "../view/worldArtAssets";

const ContentProvider = game.GetService("ContentProvider");

/** the order the sound buses are fetched in: what the lobby plays, what a fight plays, what the night plays */
const SOUND_ORDER: ReadonlyArray<SoundBus> = ["ui", "sfx", "bgm"];

/** the characters' sheets (client/view/charSheets.ts): the lobby's walkers and a run's bodies, after the town */
const SHEET_PREFIXES: ReadonlyArray<string> = ["survivors", "zombies", "dogs", "birds", "weapons"];

/** step 2 rather than 1: a character sheet (a few big images the lobby's town does not need at a glance) */
export function laterArt(name: string): boolean {
	for (const p of SHEET_PREFIXES) if (name.sub(1, p.size()) === p) return true;
	return false;
}

/**
 * Where a world texture goes in step 1: the icon atlas (the HUD), the town, then the building signs and the helipad
 * (small, on the facades). The order inside a PreloadAsync list is the order the engine is asked in.
 */
function firstRank(name: WorldArtName): number {
	if (name === "itemIcons") return 0;
	if (name.sub(1, 4) === "sign" || name === "helipad") return 2;
	return 1;
}

/** the world art's ids of one step (step 1 in firstRank order, then the generated order) */
export function worldArtIds(later: boolean): Array<string> {
	const out: Array<string> = [];
	for (let rank = 0; rank <= (later ? 0 : 2); rank++) {
		for (const name of WORLD_ART_NAMES) {
			const id = WORLD_ART[name].id;
			if (id === "" || laterArt(name) !== later) continue;
			if (!later && firstRank(name) !== rank) continue;
			out.push(id);
		}
	}
	return out;
}

/** every sound the catalogue uses, bus by bus in SOUND_ORDER, each asset once (an empty slot is silent: skipped) */
export function soundIdsInOrder(): Array<string> {
	const seen = new Set<string>();
	const out: Array<string> = [];
	for (const bus of SOUND_ORDER) {
		for (const [, entry] of pairs(SOUNDS)) {
			const def = entry as SoundDef;
			if (def.bus !== bus || def.id === "" || seen.has(def.id)) continue;
			seen.add(def.id);
			out.push(def.id);
		}
	}
	return out;
}

/** preloads `ids` through throwaway ImageLabels out of sight; YIELDS; answers how many did not arrive */
function fetchImages(ids: ReadonlyArray<string>): number {
	if (ids.size() === 0) return 0;
	const holder = new Instance("Folder");
	holder.Name = "PreloadPlan";
	holder.Parent = ContentProvider;
	const probes: Array<ImageLabel> = [];
	for (const id of ids) {
		const probe = new Instance("ImageLabel");
		probe.Image = id;
		probe.Parent = holder;
		probes.push(probe);
	}
	let missed = 0;
	pcall(() =>
		ContentProvider.PreloadAsync(probes, (_id: string, status: Enum.AssetFetchStatus) => {
			if (status !== Enum.AssetFetchStatus.Success) missed += 1;
		}),
	);
	holder.Destroy();
	return missed;
}

/** what the plan did, step by step (the [PZ-LOAD] line, and the tests) */
export interface PreloadReport {
	/** seconds each step took: 1 skin + icon atlas + town (and its signs), 2 characters, 3 sounds */
	seconds: [number, number, number];
	/** assets asked for in each step */
	counts: [number, number, number];
	/** assets that did not arrive (the skin's after its retry; the rest on the first try) */
	missed: number;
	done: boolean;
}

const report: PreloadReport = { seconds: [0, 0, 0], counts: [0, 0, 0], missed: 0, done: false };
let started = false;

/** the plan's report so far */
export function preloadReport(): Readonly<PreloadReport> {
	return report;
}

function fmt(s: number): string {
	return `${math.floor(s * 1000 + 0.5)} ms`;
}

/** the plan itself, step after step; YIELDS (startPreload runs it on a thread of its own) */
export function runPreloadPlan(fetchSounds: (ids: ReadonlyArray<string>) => number): PreloadReport {
	const t0 = os.clock();
	// 1. the first screens: the kit's panels, the icon atlas, the town the flyover draws (and the match takes)
	const skin = preloadSkin();
	const town = worldArtIds(false);
	report.missed += skin.missing + fetchImages(town);
	report.counts[0] = skin.total + town.size();
	const t1 = os.clock();
	report.seconds[0] = t1 - t0;
	// 2. the characters; then the world art's own pass keeps its fallbacks (all cached by now)
	const later = worldArtIds(true);
	report.missed += fetchImages(later);
	report.counts[1] = later.size();
	preloadWorldArt();
	const t2 = os.clock();
	report.seconds[1] = t2 - t1;
	// 3. the sounds: the interface, the fight, the night
	const sounds = soundIdsInOrder();
	report.missed += fetchSounds(sounds);
	report.counts[2] = sounds.size();
	const t3 = os.clock();
	report.seconds[2] = t3 - t2;
	report.done = true;
	print(
		`[PZ-LOAD] preload: 1) skin + icons + town ${report.counts[0]} in ${fmt(report.seconds[0])}` +
			` · 2) characters ${report.counts[1]} in ${fmt(report.seconds[1])}` +
			` · 3) sounds ${report.counts[2]} in ${fmt(report.seconds[2])}` +
			` · ${fmt(t3 - t0)} in all, ${report.missed} missed`,
	);
	return report;
}

/** starts the plan once, on its own thread: nothing waits for it (client/main.client.ts, at boot) */
export function startPreload(fetchSounds: (ids: ReadonlyArray<string>) => number): void {
	if (started) return;
	started = true;
	task.spawn(() => runPreloadPlan(fetchSounds));
}
