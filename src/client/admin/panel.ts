import { TEXT, THEME, space } from "../ui/theme";
import { Button, Card, Separator, Sidebar, SidebarHandle, clearChildren, makeAnchored, makeLabel } from "../ui/widgets";
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
const PANEL_H = 540;
const PAD = space(4);
const HEADER_H = 62;

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
		makeLabel(card, "Title", "Admin panel", PAD, 12, 360, 26, TEXT.xl, THEME.cardForeground, {
			font: "heading",
			align: "left",
			zIndex: 21,
		});
		makeLabel(
			card,
			"Subtitle",
			this.subtitle,
			PAD,
			38,
			PANEL_W - PAD * 2 - 50,
			18,
			TEXT.xs,
			THEME.mutedForeground,
			{
				align: "left",
				zIndex: 21,
			},
		);
		Button(card, "Close", "X", {
			x: PANEL_W - PAD - 34,
			y: 12,
			w: 34,
			h: 34,
			size: "icon",
			variant: "secondary",
			zIndex: 21,
			onClick: () => this.close(),
		});
		Separator(card, "HeaderRule", { x: PAD, y: HEADER_H, length: PANEL_W - PAD * 2, zIndex: 21 });
		const railW = 150;
		const top = HEADER_H + space(3);
		this.sidebar = Sidebar(card, "Sections", {
			x: PAD,
			y: top,
			w: railW,
			h: PANEL_H - top - PAD,
			items: SECTIONS.map(s => s.label),
			itemH: 38,
			zIndex: 21,
			onChange: index => this.show(SECTIONS[index].id),
		});
		const content = region(card, "Content", PAD + railW + space(4), top, CONTENT_W, CONTENT_H);
		content.ZIndex = 21;
		this.content = content;
		this.box = box;
	}
}
