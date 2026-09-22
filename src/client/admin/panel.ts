import { TEXT, space } from "../ui/theme";
import {
	Button,
	Card,
	CardHeader,
	Separator,
	Sidebar,
	SidebarHandle,
	cardHeaderHeight,
	clearChildren,
	makeAnchored,
} from "../ui/widgets";
import {
	CONTENT_H,
	CONTENT_W,
	PanelCtx,
	SECTIONS,
	SectionBuilder,
	SectionHandle,
	SectionId,
	region,
} from "./panelTypes";
import { buildPlayers } from "./sectionPlayers";
import { buildProgress } from "./sectionProgress";
import { buildSpawn } from "./sectionSpawn";
import { buildCamera, buildDebug, buildWorld } from "./sectionWorld";
import { buildServer } from "./sectionServer";
import type { PlayerRow } from "shared/admin/protocol";

/*
 * Admin panel shell: a Card docked at the left of the screen (the world stays visible and clickable for the
 * spawn / teleport tools), a Sidebar with the sections and a content area. Sections are built when selected and
 * destroyed when left or when the panel closes (no polling while hidden).
 */

const PANEL_W = 640;
const PAD = space(4);
/** navigation rail at the left of the content */
const RAIL_W = 150;
/** title strip geometry of the kit (widgets.ts): margin from the panel edge and strip height at TEXT.xl */
const STRIP_INSET = space(2);
const STRIP_H = math.ceil(TEXT.xl * 1.3) + space(3);
/** close button: an icon plate that fits inside the title strip */
const CLOSE_W = 26;
/** where the header (title strip + subtitle) ends, measured by the kit itself */
const HEADER_H = cardHeaderHeight(TEXT.xl, 1);
/** rail / content top, below the header rule */
const CONTENT_Y = HEADER_H + space(2);
// the panel grows with its header instead of squeezing CONTENT_W/CONTENT_H (the sections lay out in those)
const PANEL_H = CONTENT_Y + CONTENT_H + PAD;

const BUILDERS: Record<SectionId, SectionBuilder> = {
	players: buildPlayers,
	progress: buildProgress,
	spawn: buildSpawn,
	world: buildWorld,
	camera: buildCamera,
	debug: buildDebug,
	server: buildServer,
};

export class AdminPanel {
	private box?: Frame;
	private content?: Frame;
	private sidebar?: SidebarHandle;
	private section?: SectionHandle;
	private sectionId: SectionId = "players";

	constructor(
		private readonly p: PanelCtx,
		private readonly layer: ScreenGui,
		private readonly subtitle: string,
	) {}

	isOpen(): boolean {
		return this.box !== undefined && this.box.Visible;
	}

	toggle(): void {
		if (this.isOpen()) this.close();
		else this.open();
	}

	open(): void {
		if (this.box === undefined) this.build();
		this.box!.Visible = true;
		this.show(this.sectionId);
		this.p.refreshPlayers();
	}

	close(): void {
		if (this.box === undefined) return;
		this.box.Visible = false;
		this.dropSection();
	}

	/** opens the panel on a section */
	goTo(id: SectionId): void {
		if (!this.isOpen()) {
			this.sectionId = id;
			this.open();
			return;
		}
		this.show(id);
	}

	update(dt: number): void {
		if (!this.isOpen()) return;
		this.section?.update?.(dt);
	}

	playersChanged(): void {
		if (this.isOpen()) this.section?.onPlayers?.();
	}

	watch(row: PlayerRow): void {
		if (this.isOpen()) this.section?.onWatch?.(row);
	}

	private dropSection(): void {
		this.section?.destroy?.();
		this.section = undefined;
		if (this.content !== undefined) clearChildren(this.content);
	}

	private show(id: SectionId): void {
		this.dropSection();
		this.sectionId = id;
		const index = SECTIONS.findIndex(s => s.id === id);
		this.sidebar?.setActive(index);
		const content = this.content;
		if (content === undefined) return;
		this.section = BUILDERS[id](this.p, content);
	}

	private build(): void {
		// docked at the LEFT: toasts (top-right), the bag button and the weapon box stay visible
		const box = makeAnchored(this.layer, "AdminPanel", 0, 0, PANEL_W, PANEL_H, 14, 10, true);
		box.ZIndex = 20;
		const card = Card(box, "Card", { x: 0, y: 0, w: PANEL_W, h: PANEL_H, zIndex: 20, pad: PAD });
		// clicks on the panel never reach the game (no attack / placement under it)
		card.Active = true;
		// title strip across the top of the panel (the reference's window header), subtitle in muted under it
		const headerY = CardHeader(card, "Admin panel", this.subtitle, {
			titleSize: TEXT.xl,
			action: CLOSE_W + space(2),
		});
		// closing is a destructive action: the red plate of the kit, over the strip at its right
		Button(card, "Close", "X", {
			x: PANEL_W - STRIP_INSET - space(1) - CLOSE_W,
			y: STRIP_INSET + (STRIP_H - CLOSE_W) / 2,
			w: CLOSE_W,
			h: CLOSE_W,
			size: "icon",
			variant: "destructive",
			zIndex: 23,
			onClick: () => this.close(),
		});
		Separator(card, "HeaderRule", { x: PAD, y: headerY, length: PANEL_W - PAD * 2, zIndex: 21 });
		const top = headerY + space(2);
		this.sidebar = Sidebar(card, "Sections", {
			x: PAD,
			y: top,
			w: RAIL_W,
			h: PANEL_H - top - PAD,
			items: SECTIONS.map(s => s.label),
			itemH: 38,
			zIndex: 21,
			onChange: index => this.show(SECTIONS[index].id),
		});
		const content = region(card, "Content", PAD + RAIL_W + space(4), top, CONTENT_W, CONTENT_H);
		content.ZIndex = 21;
		this.content = content;
		this.box = box;
	}
}
