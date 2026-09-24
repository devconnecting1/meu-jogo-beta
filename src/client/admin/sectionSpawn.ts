import { WEAPONS } from "shared/data/weapons";
import { EQUIPS } from "shared/data/equips";
import { USABLES } from "shared/data/usables";
import { ETC_ITEMS } from "shared/data/etcItems";
import { AMMO_LABELS, ItemGroup, isAmmoEtcId } from "shared/admin/ops";
import { ADMIN_WORLD_LIMITS } from "shared/admin/worldOps";
import { TEXT, THEME, space } from "../ui/theme";
import {
	Button,
	ListRowButton,
	Slider,
	SliderHandle,
	Tabs,
	clearChildren,
	makeLabel,
	makeScrollList,
	setButtonVariant,
} from "../ui/widgets";
import { TextInput } from "./controls";
import { CONTENT_H, CONTENT_W, PanelCtx, SectionHandle, region } from "./panelTypes";
import { SPAWN_KINDS, STRUCTURE_KINDS, SpawnKind, StructureKind } from "./world";

/*
 * Spawn, through AdminWorld: pick what, how many and how it behaves, then "Place on map" arms the click-to-place mode
 * (placement.ts) with a ghost of the real footprint under the cursor. Where the server owns the world, each click is a
 * request it validates and runs (client/admin/serverWorld.ts): what it places is for everybody, and the toast says
 * what it really did. A spawned zombie or boss pays nobody (no XP, kill, loot or trophy), so spawning is never a way to
 * farm; items and structures make the admin's own run assisted.
 */

const ITEM_GROUPS: Array<{ group: ItemGroup; label: string }> = [
	{ group: "weapon", label: "Weapons" },
	{ group: "equip", label: "Equipment" },
	{ group: "use", label: "Consumables" },
	{ group: "etc", label: "Materials" },
	{ group: "ammo", label: "Ammo" },
];

function itemEntries(group: ItemGroup): Array<[number, string]> {
	const out: Array<[number, string]> = [];
	if (group === "weapon") {
		WEAPONS.forEach((w, i) => out.push([i, w.name]));
	} else if (group === "equip") {
		EQUIPS.forEach((e, i) => out.push([i, e.name]));
	} else if (group === "use") {
		USABLES.forEach((u, i) => out.push([i, u.name]));
	} else if (group === "etc") {
		ETC_ITEMS.forEach((e, i) => {
			if (!isAmmoEtcId(i)) out.push([i, e.name]);
		});
	} else {
		// electricity has no ground item
		AMMO_LABELS.forEach((name, i) => {
			if (i <= 4) out.push([i, name]);
		});
	}
	return out;
}

/** state kept while the panel lives, so reopening the section keeps the last choices */
const memory = {
	tab: 0,
	kind: "walker" as SpawnKind,
	count: 5,
	chase: false,
	itemGroup: 0,
	itemIndex: 0,
	itemCount: 1,
	structure: "barricade" as StructureKind,
};

export function buildSpawn(p: PanelCtx, content: Frame): SectionHandle {
	const bodyY = 42;
	const bodyH = CONTENT_H - bodyY;
	const body = region(content, "Body", 0, bodyY, CONTENT_W, bodyH);
	let slider: SliderHandle | undefined;

	const cleanup = (): void => {
		slider?.disconnect();
		slider = undefined;
	};

	const placeButton = (y: number, onClick: () => void): void => {
		Button(body, "Place", "Place on map", { x: 0, y, w: CONTENT_W, h: 42, variant: "default", onClick });
	};

	const buildZombies = (): void => {
		const colW = (CONTENT_W - space(2)) / 2;
		const buttons = new Map<SpawnKind, TextButton>();
		SPAWN_KINDS.forEach((k, i) => {
			const b = Button(body, `Kind${i}`, k.label, {
				x: (i % 2) * (colW + space(2)),
				y: math.floor(i / 2) * 38,
				w: colW,
				h: 32,
				size: "sm",
				variant: k.kind === memory.kind ? "default" : "outline",
				onClick: () => {
					memory.kind = k.kind;
					for (const [kind, other] of buttons) {
						setButtonVariant(other, kind === memory.kind ? "default" : "outline");
					}
				},
			});
			buttons.set(k.kind, b);
		});
		const y0 = math.ceil(SPAWN_KINDS.size() / 2) * 38 + 4;
		const countLabel = makeLabel(body, "CountLabel", "", 0, y0, CONTENT_W, 20, TEXT.sm, THEME.foreground, {
			font: "label",
			align: "left",
		});
		const showCount = (): void => {
			countLabel.Text = `Count: ${memory.count}`;
		};
		showCount();
		slider = Slider(body, "Count", {
			x: 0,
			y: y0 + 22,
			w: CONTENT_W,
			h: 26,
			step: 1 / 19,
			get: () => (memory.count - 1) / 19,
			set: v => {
				memory.count = math.clamp(math.round(v * 19) + 1, 1, 20);
				showCount();
			},
		});
		Tabs(body, "State", {
			x: 0,
			y: y0 + 56,
			w: CONTENT_W,
			h: 32,
			items: ["Wandering", "Chasing the survivor"],
			value: memory.chase ? 1 : 0,
			onChange: i => {
				memory.chase = i === 1;
			},
		});
		placeButton(y0 + 96, () => {
			const info = SPAWN_KINDS.find(k => k.kind === memory.kind)!;
			const count = info.boss ? math.min(memory.count, ADMIN_WORLD_LIMITS.BOSSES) : memory.count;
			p.placement.begin({
				kind: "zombie",
				spawn: memory.kind,
				count,
				chase: memory.chase,
				label: `${info.label} ×${count}`,
			});
		});
		makeLabel(
			body,
			"Hint",
			`Zombies more than ${p.world.spawnRange("zombie")} u from every survivor are recycled. At most ${ADMIN_WORLD_LIMITS.BOSSES} bosses at once. Spawns give no XP or loot.`,
			0,
			y0 + 144,
			CONTENT_W,
			34,
			TEXT.xs,
			THEME.mutedForeground,
			{ align: "left", valign: "top" },
		);
	};

	const buildItems = (): void => {
		Tabs(body, "Groups", {
			x: 0,
			y: 0,
			w: CONTENT_W,
			h: 32,
			items: ITEM_GROUPS.map(g => g.label),
			value: memory.itemGroup,
			textSize: TEXT.xs,
			onChange: i => {
				memory.itemGroup = i;
				memory.itemIndex = itemEntries(ITEM_GROUPS[i].group)[0]?.[0] ?? 0;
				build();
			},
		});
		const group = ITEM_GROUPS[memory.itemGroup].group;
		const list = makeScrollList(body, "Items", 0, 40, CONTENT_W, bodyH - 40 - 100);
		const rows = new Map<number, TextLabel>();
		const entries = itemEntries(group);
		if (entries.find(e => e[0] === memory.itemIndex) === undefined) memory.itemIndex = entries[0]?.[0] ?? 0;
		const mark = (): void => {
			for (const [index, label] of rows) {
				const name = entries.find(e => e[0] === index)?.[1] ?? "?";
				label.Text = index === memory.itemIndex ? `▸ ${name}` : name;
			}
		};
		let order = 0;
		for (const [index, name] of entries) {
			const b = ListRowButton(list, `Item${index}`, order++, 32, () => {
				memory.itemIndex = index;
				mark();
			});
			rows.set(
				index,
				makeLabel(b, "Name", name, space(3), 0, CONTENT_W - space(6), 32, TEXT.sm, THEME.cardForeground, {
					font: "label",
					align: "left",
					zIndex: b.ZIndex + 1,
				}),
			);
		}
		mark();
		const fy = bodyH - 92;
		makeLabel(body, "CountLabel", "Count", 0, fy, 80, 36, TEXT.sm, THEME.foreground, {
			font: "label",
			align: "left",
		});
		const count = TextInput(body, "Count", {
			x: 84,
			y: fy,
			w: 100,
			text: tostring(memory.itemCount),
			numeric: true,
			maxLength: 4,
		});
		placeButton(fy + 44, () => {
			const n = math.clamp(count.getInt() ?? 1, 1, 9999);
			memory.itemCount = n;
			const name = entries.find(e => e[0] === memory.itemIndex)?.[1] ?? "item";
			p.placement.begin({ kind: "item", group, index: memory.itemIndex, count: n, label: `${name} ×${n}` });
		});
	};

	const buildStructures = (): void => {
		const colW = (CONTENT_W - space(2)) / 2;
		const buttons = new Map<StructureKind, TextButton>();
		STRUCTURE_KINDS.forEach((k, i) => {
			const b = Button(body, `Structure${i}`, k.label, {
				x: (i % 2) * (colW + space(2)),
				y: math.floor(i / 2) * 38,
				w: colW,
				h: 32,
				size: "sm",
				variant: k.kind === memory.structure ? "default" : "outline",
				onClick: () => {
					memory.structure = k.kind;
					for (const [kind, other] of buttons) {
						setButtonVariant(other, kind === memory.structure ? "default" : "outline");
					}
				},
			});
			buttons.set(k.kind, b);
		});
		const y0 = math.ceil(STRUCTURE_KINDS.size() / 2) * 38 + 8;
		placeButton(y0, () => {
			const info = STRUCTURE_KINDS.find(k => k.kind === memory.structure)!;
			p.placement.begin({ kind: "structure", structure: memory.structure, label: info.label });
		});
		makeLabel(
			body,
			"Hint",
			"Structures go exactly where you click (red = something is in the way). Lamps start off: press E next to them.",
			0,
			y0 + 50,
			CONTENT_W,
			34,
			TEXT.xs,
			THEME.mutedForeground,
			{ align: "left", valign: "top" },
		);
	};

	const build = (): void => {
		cleanup();
		clearChildren(body);
		if (memory.tab === 0) buildZombies();
		else if (memory.tab === 1) buildItems();
		else buildStructures();
	};

	Tabs(content, "Tabs", {
		x: 0,
		y: 0,
		w: CONTENT_W,
		h: 34,
		items: ["Zombies & bosses", "Items", "Structures"],
		value: memory.tab,
		onChange: i => {
			memory.tab = i;
			build();
		},
	});
	build();

	return {
		destroy(): void {
			cleanup();
		},
	};
}
