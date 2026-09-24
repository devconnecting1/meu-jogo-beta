#!/usr/bin/env node
/*
 * Place properties that a publish must carry (npm run check:place).
 *
 * Some settings are PLACE properties, not script state: a script cannot set them, and Studio's Properties window
 * only changes the copy open in Studio. What players get is whatever `rojo build` writes, because both the CI place
 * and `npm run cloud -- publish` upload a fresh build of default.project.json. A value toggled only in Studio is
 * therefore silently back to the engine default after the next publish.
 *
 *   Players.BanningEnabled = true      the Ban API (BanAsync, UnbanAsync, GetBanHistoryAsync) behind the admin
 *                                      panel's ban form; it "cannot be modified via Luau scripts" (Players docs)
 *   TextChatService.ChatVersion        TextChatService: the filtered, reportable chat MP-17 builds on
 *
 *   node tools/check-place.mjs                 checks default.project.json pins them
 *   node tools/check-place.mjs <place.rbxlx>   also checks the XML place Rojo actually built (CI does this)
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/** [service, property, value, how it looks in an .rbxlx] */
const PINS = [
	["Players", "BanningEnabled", true, /<bool name="BanningEnabled">true<\/bool>/],
	["TextChatService", "ChatVersion", "TextChatService", /<token name="ChatVersion">1<\/token>/],
];

let failed = 0;
const check = (ok, what) => {
	console.log(`${ok ? "ok  " : "FAIL"} ${what}`);
	if (!ok) failed++;
};

const project = JSON.parse(readFileSync(join(ROOT, "default.project.json"), "utf8"));
for (const [service, prop, value] of PINS) {
	const node = project.tree?.[service];
	check(
		node?.$className === service && node?.$properties?.[prop] === value,
		`default.project.json pins ${service}.${prop} = ${JSON.stringify(value)}`,
	);
}

// MP-24: every server picks its own town. A developer may pin one on ServerStorage (pz_town_seed) to reproduce it in
// Studio; a pin in the project file would ship, and every live server would open on the same streets
check(
	!JSON.stringify(project).includes("pz_town_seed"),
	"default.project.json does not pin the town's seed (ServerStorage pz_town_seed is for Studio only, MP-24)",
);

const placePath = process.argv[2];
if (placePath !== undefined) {
	if (!existsSync(placePath)) {
		check(false, `${placePath} exists (build it with: rojo build -o ${placePath})`);
	} else {
		const xml = readFileSync(placePath, "utf8");
		for (const [service, prop, , pattern] of PINS) {
			// the property must sit inside the service's own <Item>, not just anywhere in the file
			const at = xml.indexOf(`<Item class="${service}"`);
			const end = at < 0 ? -1 : xml.indexOf("</Properties>", at);
			check(
				at >= 0 && end > at && pattern.test(xml.slice(at, end)),
				`${placePath}: ${service}.${prop} is written`,
			);
		}
	}
}

if (failed > 0) {
	console.error(`\n${failed} check(s) failed: a publish would reset these to the engine default.`);
	process.exit(1);
}
