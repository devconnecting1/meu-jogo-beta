import { GameContext } from "shared/game/context";
import { ownsEquip, outfitLookOf, petLookOf, totalPendingPacks } from "shared/game/save";
import { ACHIEVEMENTS } from "shared/data/achievements";
import { COSTUMES } from "shared/data/shop";
import { cosmeticSlotOf, PetLook } from "shared/data/cosmetics";
import { langGet } from "shared/data/lang";
import { MAX_PLAYERS } from "shared/net/mpConfig";
import { onWalletChanged } from "../systems/saveClient";
import { SurvivorPreview } from "../view/cosmeticPreview";
import { attachFlyover, detachFlyover, TownFlyover } from "../view/townFlyover";
import { Wordmark } from "./logo";
import { paintPlate } from "./plate";
import { PixelIcon, PixelIconKind } from "./pixelIcon";
import { popup } from "./popup";
import { RunState, SurvivorScreen } from "./survivor";
import { GAME, SURFACE, TEXT, THEME, fontOf, space } from "./theme";
import { drawingBox } from "./wardrobe";
import {
	Button,
	Dialog,
	Keycap,
	Progress,
	autoFocus,
	buttonForeground,
	fmtInt,
	makeCoinPill,
	makeFrame,
	makeLabel,
	makeListRow,
	makeScreen,
	makeScrollList,
	makeSurface,
	onLayoutChange,
	setVisible,
	topInset,
	uiScale,
	viewportSize,
} from "./widgets";
import * as Kit from "./window";

export type { RunState } from "./survivor";

/*
 * The lobby (docs/DESIGN_RULES.md UI-10): a PC game's title screen, and behind the START plate the Survivor screen
 * (client/ui/survivor.ts). Both stand on the town flyover (client/view/townFlyover.ts): the real town of the world
 * the player is about to enter, drifting past under a dark scrim.
 *
 *   PROJECT Z                                                    ($ 1,843)
 *   Zombie survival                                     (loading / offline)
 *   ┌───────────────────────────┐   ┌ Fabricio ──────────────── LEVEL 7 ┐
 *   │ ▶  START                  │   │                                    │
 *   │    Continue this run      │   │   the survivor, outfit and pet     │
 *   └───────────────────────────┘   │                                    │
 *   [🛍 Shop      Packs & costumes]   └────────────────────────────────────┘
 *   [👕 Wardrobe             2 / 9]   ┌ Town ──────────────────────────────┐
 *   [🏆 Achievements        3 / 20]   │ [☀ Day 7   ] [👤 2 / 6  ] [✝ Day 12] │
 *   [▮ Records         Best day 12]   │   Afternoon    in town     last fell │
 *   [? How to play               ]   └────────────────────────────────────┘
 *   [⚙ Settings                  ]
 *   [★ Credits                   ]
 *
 * No tips ticker: the tips live in How to play. The left survivor card is gone too: who the survivor is and what
 * they carry is the Survivor screen's, where the city is entered from; the menu keeps the survivor as a picture.
 *
 * Both pages live in one mounted screen and switch by visibility (the Bag's rule): the Survivor page is built the
 * first time START opens it and kept until the lobby closes; going back and forth creates nothing
 * (npm run test:lobby).
 */

export type LobbyPage = "menu" | "survivor";

export interface LobbyHandlers {
	/** Enter the city / Continue: main.client's playPressed (the startRun semantics, unchanged) */
	onPlay: () => void;
	/** MP-21, the run is over: pay to continue now (main.client's doRebirth) */
	onRebirth: () => void;
	/** MP-21, the run is over: wait for daybreak, the same life (main.client's enterToWait, keeping it) */
	onWaitDawn: () => void;
	/** MP-21, the run is over: a new life (main.client's doNewRun) */
	onNewRun: () => void;
	onShop: () => void;
	/** the wardrobe (MON-04); `from` is the page its X comes back to */
	onWardrobe: (from: LobbyPage) => void;
	onSettings: () => void;
	onCredits?: () => void;
	/** `thenPlay`: opened from the first-run prompt, the city follows the tutorial */
	onTutorial: (thenPlay?: boolean) => void;
	/** the page on screen changed (main.client rebuilds a lobby on the page the player was on) */
	onPage?: (page: LobbyPage) => void;
}

export interface LobbyStatus {
	/** the save is still being loaded from the server */
	loading: boolean;
	/** what START leads to: a fresh life, a run suspended in memory, a run over (MP-21), a new life waiting */
	run: RunState;
	/** the server owns this survivor's death and runs the town (MP-21, MP-20): the wording, the town's numbers */
	hosted: boolean;
	/**
	 * The run's clock has been the server's (DayNight.serverDriven): with `hosted`, the server stands a dead survivor
	 * up at daybreak, so MP-21's free wait is on offer -- the condition main.client's dawn wait uses. The lobby also
	 * takes the world's hour published on the Workspace as that proof (a survivor who joined dead has not run a
	 * clock yet, but the server that publishes it is the one that revives).
	 */
	clockDriven?: boolean;
	/** the town the player enters (MP-22: the server's seed); the flyover draws it */
	seed: number;
	/** MP-22: the day the last town fell on, when this client saw it fall */
	fellOn?: number;
	/** why progress is not being saved (undefined = saving normally) */
	offlineNote?: string;
}

export interface LobbyHandle {
	/** rewrites both pages for a new status (a world that ended, a LoadAck): text and visibility only */
	refresh(status: LobbyStatus): void;
	show(page: LobbyPage): void;
	page(): LobbyPage;
	close(): void;
}

// ---------------------------------------------------------------- the town's live numbers (MP-20)

/**
 * What the server publishes about its town, once a second, as Workspace attributes (server/net/mpHost.ts, the
 * §12.2 metrics): the world's day, its hour and how many survivors stand in it. A client in the lobby has no
 * other window on the town (no snapshot, no Clock), and these replicate on their own. test:lobby pins the names.
 */
export const WORLD_DAY_ATTR = "pz_world_day";
export const DAY_TIME_ATTR = "pz_day_time";
export const IN_WORLD_ATTR = "pz_sim_players";

function numberAttr(name: string): number | undefined {
	const v = game.GetService("Workspace").GetAttribute(name);
	return typeIs(v, "number") ? v : undefined;
}

// ---------------------------------------------------------------- the two dialogs of the menu

const ACH_W = 660;
const ACH_H = 530;
const ACH_ROW_H = 60;

function visibleAchievements(ctx: GameContext): [number, number] {
	let done = 0;
	let total = 0;
	for (const a of ACHIEVEMENTS) {
		if (a.hidden === true) continue;
		total++;
		if ((ctx.save.achievements[a.id] ?? 0) >= a.max) done++;
	}
	return [done, total];
}

function showAchievements(ctx: GameContext): void {
	const lang = ctx.save.settings.langType;
	const tr = (k: string): string => langGet(k, lang);
	const visible = ACHIEVEMENTS.filter(a => a.hidden !== true);
	const [done] = visibleAchievements(ctx);
	const dialog = Dialog(ctx.uiLayer, "Achievements", {
		w: ACH_W,
		h: ACH_H,
		title: tr("Achievements"),
		description: `${done} / ${visible.size()}`,
		zIndex: 300,
		closeButton: true,
	});
	const pad = space(6);
	const listW = ACH_W - pad * 2;
	const list = makeScrollList(dialog.card, "List", pad, dialog.contentY, listW, ACH_H - dialog.contentY - pad);
	// unfinished (closest to done first), then finished
	const ordered = [...visible];
	const ratio = (a: (typeof visible)[number]): number => (ctx.save.achievements[a.id] ?? 0) / math.max(a.max, 1);
	ordered.sort((a, b) => {
		const ra = ratio(a) >= 1 ? -1 : ratio(a);
		const rb = ratio(b) >= 1 ? -1 : ratio(b);
		return ra > rb;
	});
	for (let i = 0; i < ordered.size(); i++) {
		const a = ordered[i];
		const cur = math.min(ctx.save.achievements[a.id] ?? 0, a.max);
		const complete = cur >= a.max;
		const row = makeListRow(list, `Ach${a.id}`, i, ACH_ROW_H);
		// pixel chip: filled in `success` when the achievement is done, an empty socket otherwise
		const badge = makeSurface(row, "Badge", space(4), 16, 28, 28, "well", {
			fill: complete ? GAME.success : THEME.background,
			border: complete ? GAME.success : THEME.border,
			zIndex: 2,
		});
		if (complete) {
			makeLabel(badge, "Check", "✓", 0, 0, 28, 28, TEXT.base, THEME.background, {
				weight: Enum.FontWeight.Bold,
				zIndex: 3,
			});
		}
		const textX = space(4) + 28 + space(3);
		const nameColor = complete ? THEME.foreground : THEME.mutedForeground;
		makeLabel(row, "Name", tr(a.title), textX, 8, 330, 24, TEXT.base, nameColor, { font: "label", align: "left" });
		const bar = Progress(row, "Progress", {
			x: textX,
			y: 38,
			w: 360,
			h: 8,
			color: complete ? GAME.success : THEME.primary,
		});
		bar.setRatio(cur / math.max(a.max, 1));
		const value = `${fmtInt(cur)} / ${fmtInt(a.max)}`;
		makeLabel(row, "Value", value, listW - 170, 14, 150, 32, TEXT.sm, THEME.mutedForeground, {
			font: "numeric",
			align: "right",
		});
	}
}

/**
 * The personal bests. No "Bosses defeated" line: Núcleo 1 has no boss (CON-03), and a counter of something the
 * game does not have yet only ever says 0.
 */
function showRecords(ctx: GameContext): void {
	const s = ctx.save;
	const tr = (k: string): string => langGet(k, s.settings.langType);
	const lines = [
		`${tr("Best day")}:  ${s.bestDay}`,
		`${tr("Life day")}:  ${s.day}`,
		`${tr("Level")}:  ${s.level}`,
		`${tr("Rebirth")}:  ${s.deathCount}`,
	];
	popup(ctx, tr("Personal bests"), lines.join("\n"), [{ text: tr("Close"), variant: "secondary" }]);
}

// ---------------------------------------------------------------- the menu page (1120 x 630 design units)

const MARGIN = 40;
const NAV_X = MARGIN;
const NAV_Y = 120;
const NAV_W = 380;
const START_H = 92;
const START_GAP = space(3.5);
const ITEM_H = 46;
const ITEM_GAP = 6;
const ITEMS_Y = NAV_Y + START_H + START_GAP;
const RIGHT_X = NAV_X + NAV_W + space(8);
const RIGHT_W = 1120 - MARGIN - RIGHT_X;
const INSET = space(4);
const STAGE_H = 304;
const TOWN_Y = NAV_Y + STAGE_H + space(3);
const CELL_H = 64;
const CELL_PAD = 8;
const TOWN_GROOVE_H = CELL_H + CELL_PAD * 2;
const TOWN_H = Kit.sectionHeight(TOWN_GROOVE_H);
const TOWN_GROOVE_W = RIGHT_W - INSET * 2;
/** the header band: opaque down to HEADER_SOLID, fading out by HEADER_FADE (design units from the body's top) */
const HEADER_SOLID = 112;
const HEADER_FADE = 150;

const BOLD = fontOf("sans", Enum.FontWeight.Bold);
const EXTRA_BOLD = fontOf("sans", Enum.FontWeight.ExtraBold);

interface NavItem {
	key: string;
	icon: PixelIconKind;
	onClick: () => void;
	/** the one-line subtitle, only where it carries real information */
	sub?: () => string;
	subLabel?: TextLabel;
}

interface TownCell {
	frame: Frame;
	icon: Frame;
	value: TextLabel;
	caption: TextLabel;
}

class MenuPage {
	readonly frame: Frame;
	readonly start: TextButton;
	private readonly ctx: GameContext;
	private readonly tr: (k: string) => string;
	private readonly startTitle: TextLabel;
	private readonly startSub: TextLabel;
	private readonly status: TextLabel;
	private readonly items: Array<NavItem>;
	private readonly name: TextLabel;
	private readonly level: Frame;
	private readonly preview: SurvivorPreview;
	private readonly cells: Array<TownCell> = [];
	private readonly sun: Frame;
	private readonly moon: Frame;
	/** how many town cells are laid out (-1: none yet) */
	private cellCount = -1;
	/** START's title sits high (a subtitle under it) or centred */
	private titleHigh: boolean | undefined;
	readonly coins: { refresh(): void };

	constructor(body: Frame, ctx: GameContext, handlers: LobbyHandlers, openSurvivor: () => void) {
		this.ctx = ctx;
		const lang = ctx.save.settings.langType;
		const tr = (k: string): string => langGet(k, lang);
		this.tr = tr;
		const frame = makeFrame(body, "Menu", 0, 0, 1120, 630, THEME.background, { transparency: 1 });
		this.frame = frame;

		// ---- the header, on the opaque band (the lobby draws it under the body)
		Wordmark(frame, "Title", MARGIN, 20, 460, 60, TEXT.xl5);
		makeLabel(frame, "Tagline", tr("Zombie survival"), MARGIN + 2, 80, 400, 22, TEXT.sm, THEME.mutedForeground, {
			align: "left",
		});
		this.coins = makeCoinPill(frame, "Coins", 850, 28, 230, 52, () => ctx.save.money, handlers.onShop);
		this.status = makeLabel(frame, "Status", "", 560, 84, 520, 22, TEXT.sm, THEME.mutedForeground, {
			align: "right",
		});

		// ---- START: the one steel-blue plate, bigger than the rest
		const start = Button(frame, "Start", "", {
			x: NAV_X,
			y: NAV_Y,
			w: NAV_W,
			h: START_H,
			variant: "default",
			onClick: openSurvivor,
		});
		this.start = start;
		const fg = buttonForeground("default");
		PixelIcon(start, "Icon", "start", 44, START_H / 2, 36, fg, start.ZIndex + 1);
		this.startTitle = makeLabel(start, "Title", tr("Start").upper(), 84, 16, NAV_W - 104, 40, TEXT.xl3, fg, {
			font: EXTRA_BOLD,
			align: "left",
			zIndex: start.ZIndex + 1,
		});
		this.startSub = makeLabel(start, "Sub", "", 84, 56, NAV_W - 104, 22, TEXT.base, fg, {
			align: "left",
			zIndex: start.ZIndex + 1,
		});

		// ---- the rest of the menu: iron plates with a pixel icon, a title and, where it says something, a subtitle
		const items: Array<NavItem> = [
			{ key: "Shop", icon: "shop", onClick: handlers.onShop, sub: () => tr("Packs & costumes") },
			{
				key: "Wardrobe",
				icon: "wardrobe",
				onClick: (): void => handlers.onWardrobe("menu"),
				sub: () => this.wardrobeCount(),
			},
			{
				key: "Achievements",
				icon: "trophy",
				onClick: (): void => showAchievements(ctx),
				sub: () => {
					const [done, total] = visibleAchievements(ctx);
					return `${done} / ${total}`;
				},
			},
			{
				key: "Records",
				icon: "records",
				onClick: (): void => showRecords(ctx),
				sub: () => `${tr("Best day")} ${ctx.save.bestDay}`,
			},
			{ key: "How to play", icon: "help", onClick: (): void => handlers.onTutorial(false) },
			{ key: "Settings", icon: "settings", onClick: handlers.onSettings },
			{ key: "Credits", icon: "credits", onClick: (): void => handlers.onCredits?.() },
		];
		this.items = items;
		const ifg = buttonForeground("secondary");
		for (let i = 0; i < items.size(); i++) {
			const item = items[i];
			const b = Button(frame, `Nav${i}`, "", {
				x: NAV_X,
				y: ITEMS_Y + i * (ITEM_H + ITEM_GAP),
				w: NAV_W,
				h: ITEM_H,
				variant: "secondary",
				onClick: item.onClick,
			});
			const z = b.ZIndex + 1;
			PixelIcon(b, "Icon", item.icon, 26, ITEM_H / 2, 20, ifg, z);
			makeLabel(b, "Title", tr(item.key), 48, 0, 160, ITEM_H, TEXT.lg, ifg, {
				font: BOLD,
				align: "left",
				zIndex: z,
			});
			if (item.sub !== undefined) {
				item.subLabel = makeLabel(b, "Sub", "", NAV_W - space(4) - 150, 0, 150, ITEM_H, TEXT.sm, ifg, {
					align: "right",
					zIndex: z,
				});
			}
		}

		// ---- the stage: the survivor, big, as everyone sees them, with the name and level of their nameplate
		const stage = Kit.Section(frame, "Stage", { x: RIGHT_X, y: NAV_Y, w: RIGHT_W, h: STAGE_H });
		const sz = stage.frame.ZIndex + 1;
		const keyW = 120;
		this.name = makeLabel(
			stage.frame,
			"Name",
			"",
			space(5),
			Kit.SECTION_TITLE_MID - 16,
			RIGHT_W - space(10) - keyW,
			32,
			TEXT.xl2,
			THEME.foreground,
			{ font: BOLD, align: "left", zIndex: sz },
		);
		this.level = Keycap(stage.frame, "Level", "", {
			x: RIGHT_W - space(5),
			cy: Kit.SECTION_TITLE_MID,
			anchorX: 1,
			h: 28,
			minW: 110,
			textSize: TEXT.base,
			font: BOLD,
			zIndex: sz,
		});
		const bedW = RIGHT_W - INSET * 2;
		const bedH = STAGE_H - Kit.SECTION_CONTENT_Y - INSET;
		const bed = Kit.Groove(stage.frame, "Bed", INSET, Kit.SECTION_CONTENT_Y, bedW, bedH);
		const box = drawingBox(bed, "Preview", 0, 0, bedW, bedH, bed.ZIndex + 1);
		// with no pet the survivor stands in the middle; with one, the scene keeps the pet's room at their side
		const subject = petLookOf(ctx.save) === PetLook.None ? "outfit" : "both";
		this.preview = new SurvivorPreview(box, { w: bedW, h: bedH, scale: 4, subject, zIndex: box.ZIndex });

		// ---- the town: its day and hour, who is in it, and the last one that fell (MP-20, MP-22)
		const town = Kit.Section(frame, "Town", { x: RIGHT_X, y: TOWN_Y, w: RIGHT_W, h: TOWN_H, title: tr("Town") });
		const groove = Kit.Groove(town.frame, "Cells", INSET, Kit.SECTION_CONTENT_Y, TOWN_GROOVE_W, TOWN_GROOVE_H);
		const kinds: Array<PixelIconKind> = ["sun", "people", "grave"];
		for (let i = 0; i < 3; i++) {
			const cell = makeFrame(groove, `Cell${i}`, 0, CELL_PAD, 100, CELL_H, THEME.background, {
				transparency: 1,
				zIndex: groove.ZIndex + 1,
			});
			paintPlate(cell, SURFACE.section, "flat", 4);
			const z = cell.ZIndex + 1;
			const icon = PixelIcon(cell, "Icon", kinds[i], 28, CELL_H / 2, 24, THEME.foreground, z).frame;
			const value = makeLabel(cell, "Value", "", 52, 8, 100, 28, TEXT.xl2, THEME.foreground, {
				font: BOLD,
				align: "left",
				zIndex: z,
			});
			const caption = makeLabel(cell, "Caption", "", 52, 36, 100, 20, TEXT.sm, THEME.foreground, {
				align: "left",
				zIndex: z,
			});
			this.cells.push({ frame: cell, icon, value, caption });
		}
		this.sun = this.cells[0].icon;
		this.moon = PixelIcon(
			this.cells[0].frame,
			"Moon",
			"moon",
			28,
			CELL_H / 2,
			24,
			THEME.foreground,
			this.sun.ZIndex,
		).frame;
	}

	private wardrobeCount(): string {
		let owned = 0;
		let total = 0;
		for (const c of COSTUMES) {
			if (c.equipId < 0 || cosmeticSlotOf(c.equipId) === 0) continue;
			total++;
			if (ownsEquip(this.ctx.save, c.equipId)) owned++;
		}
		return `${owned} / ${total}`;
	}

	/** places the town cells: three across, or two when there is no fallen town to show (only when that changes) */
	private layoutCells(count: number): void {
		if (count === this.cellCount) return;
		this.cellCount = count;
		const w = (TOWN_GROOVE_W - CELL_PAD * (count + 1)) / count;
		for (let i = 0; i < this.cells.size(); i++) {
			const c = this.cells[i];
			setVisible(c.frame, i < count);
			if (i >= count) continue;
			c.frame.Position = UDim2.fromScale(
				(CELL_PAD + i * (w + CELL_PAD)) / TOWN_GROOVE_W,
				CELL_PAD / TOWN_GROOVE_H,
			);
			c.frame.Size = UDim2.fromScale(w / TOWN_GROOVE_W, CELL_H / TOWN_GROOVE_H);
			c.frame.SetAttribute("DesignW", w);
			// the icon keeps its place at the left; the two lines take what is left of the cell
			for (const label of [c.value, c.caption]) {
				label.Position = UDim2.fromScale(52 / w, label.Position.Y.Scale);
				label.Size = UDim2.fromScale((w - 60) / w, label.Size.Y.Scale);
			}
			c.icon.Position = UDim2.fromScale(28 / w, 0.5);
			if (i === 0) this.moon.Position = c.icon.Position;
		}
	}

	private write(label: TextLabel, text: string): void {
		if (label.Text !== text) label.Text = text;
	}

	refresh(status: LobbyStatus): void {
		const tr = this.tr;
		const save = this.ctx.save;
		// START says where it leads only when that is news: a run to continue, a run over, a new life waiting
		let sub = "";
		if (status.run === "suspended") sub = tr("Continue this run");
		else if (status.run === "over") sub = tr("Your run is over");
		else if (status.run === "newLife") sub = tr("Your new life wakes at first light");
		const packs = totalPendingPacks(save);
		if (packs > 0) sub = sub === "" ? `${tr("Packs")} +${packs}` : `${sub}  ·  ${tr("Packs")} +${packs}`;
		this.write(this.startSub, sub);
		setVisible(this.startSub, sub !== "");
		const high = sub !== "";
		if (this.titleHigh !== high) {
			this.titleHigh = high;
			this.startTitle.Position = UDim2.fromScale(84 / NAV_W, (high ? 16 : (START_H - 40) / 2) / START_H);
		}

		if (status.loading) {
			this.write(this.status, tr("Loading your progress..."));
			this.status.TextColor3 = THEME.mutedForeground;
		} else if (status.offlineNote !== undefined) {
			this.write(this.status, status.offlineNote);
			this.status.TextColor3 = THEME.destructive;
		} else {
			this.write(this.status, "");
		}
		for (const item of this.items) {
			if (item.sub !== undefined && item.subLabel !== undefined) this.write(item.subLabel, item.sub());
		}
		this.coins.refresh();

		const Players = game.GetService("Players");
		const me = Players.LocalPlayer as Player | undefined;
		this.write(this.name, me !== undefined ? me.DisplayName : tr("Survivor"));
		Kit.setValueKey(this.level, `${tr("Level")} ${save.level}`.upper());
		this.preview.setOutfit(outfitLookOf(save));
		this.preview.setPet(petLookOf(save));
		this.refreshTown(status);
	}

	/** the town's cells, from the server's live numbers (hosted) or this life's own town (offline) */
	refreshTown(status: LobbyStatus): void {
		const tr = this.tr;
		const hour = status.hosted ? numberAttr(DAY_TIME_ATTR) : undefined;
		const day = status.hosted ? numberAttr(WORLD_DAY_ATTR) : this.ctx.save.day;
		const inTown = status.hosted ? numberAttr(IN_WORLD_ATTR) : undefined;
		const night = hour !== undefined && (hour >= 19 || hour < 6);
		setVisible(this.sun, !night);
		setVisible(this.moon, night);
		const [dayCell, peopleCell, fellCell] = this.cells;
		this.write(dayCell.value, day !== undefined ? `${tr("Day")} ${math.floor(day)}` : `${tr("Day")} …`);
		this.write(dayCell.caption, hour !== undefined ? tr(phaseOf(hour)) : tr("Town"));
		if (status.hosted) {
			this.write(peopleCell.value, inTown !== undefined ? `${math.floor(inTown)} / ${MAX_PLAYERS}` : "…");
			this.write(peopleCell.caption, tr("in town"));
		} else {
			this.write(peopleCell.value, tr("Solo"));
			this.write(peopleCell.caption, tr("your own town"));
		}
		const fell = status.fellOn;
		if (fell !== undefined) {
			this.write(fellCell.value, `${tr("Day")} ${fell}`);
			this.write(fellCell.caption, tr("last town fell"));
		}
		this.layoutCells(fell !== undefined ? 3 : 2);
	}

	draw(clock: number): void {
		this.preview.draw(clock);
	}

	destroy(): void {
		this.preview.destroy();
	}
}

/** the HUD's words for the hour (hud.ts phaseName) */
function phaseOf(t: number): string {
	if (t >= 19 || t < 6) return "Night";
	if (t < 11) return "Morning";
	if (t < 16) return "Afternoon";
	return "Evening";
}

// ---------------------------------------------------------------- the screen

/** ZIndex of the lobby's layers under its root: the town, the header band, the pages */
const Z_TOWN = 1;
const Z_BAND = 2;
const Z_BODY = 3;

/**
 * The opaque band the header stands on: the page colour from the top of the screen down to HEADER_SOLID of the
 * body, fading out by HEADER_FADE -- the title, the tagline and the status note read on the page colour itself,
 * whatever the town draws under them (UI-10).
 */
function headerBand(root: Frame): Frame {
	const band = new Instance("Frame");
	band.Name = "HeaderBand";
	band.BackgroundColor3 = THEME.background;
	band.BorderSizePixel = 0;
	band.ZIndex = Z_BAND;
	band.Active = false;
	const fade = new Instance("UIGradient");
	fade.Rotation = 90;
	fade.Parent = band;
	onLayoutChange(band, () => {
		const v = viewportSize();
		const inset = topInset();
		const scale = uiScale();
		const avail = v.Y - inset;
		const bodyTop = inset + math.max(0, (avail - 630 * scale) / 2);
		const solid = bodyTop + HEADER_SOLID * scale;
		const total = bodyTop + HEADER_FADE * scale;
		band.Position = new UDim2(0, 0, 0, 0);
		band.Size = new UDim2(1, 0, 0, math.ceil(total));
		const k = math.clamp(solid / math.max(total, 1), 0, 1);
		fade.Transparency = new NumberSequence([
			new NumberSequenceKeypoint(0, 0),
			new NumberSequenceKeypoint(k, 0),
			new NumberSequenceKeypoint(1, 1),
		]);
	});
	band.Parent = root;
	return band;
}

export function showLobby(
	ctx: GameContext,
	handlers: LobbyHandlers,
	initial: LobbyStatus,
	open: LobbyPage = "menu",
): LobbyHandle {
	const { root, body } = makeScreen(ctx.uiLayer, "Lobby");
	body.ZIndex = Z_BODY;
	let status = initial;
	let current: LobbyPage = "menu";
	let closed = false;
	let flyover: TownFlyover = attachFlyover(root, status.seed, Z_TOWN);
	const band = headerBand(root);

	let survivor: SurvivorScreen | undefined;
	const survivorState = () => {
		const hour = status.hosted ? numberAttr(DAY_TIME_ATTR) : undefined;
		return {
			run: status.run,
			hosted: status.hosted,
			worldDay: status.hosted ? numberAttr(WORLD_DAY_ATTR) : undefined,
			// MP-21's free way out, only where the server revives at daybreak (it owns the death and runs the clock)
			canWait: status.run === "over" && status.hosted && (status.clockDriven === true || hour !== undefined),
			hour,
		};
	};
	let handle: LobbyHandle;
	const menu = new MenuPage(body, ctx, handlers, () => handle.show("survivor"));

	const buildSurvivor = (): SurvivorScreen => {
		const s = new SurvivorScreen(body, ctx, {
			onBack: (): void => handle.show("menu"),
			onPlay: handlers.onPlay,
			onRebirth: handlers.onRebirth,
			onWaitDawn: handlers.onWaitDawn,
			onNewRun: handlers.onNewRun,
			onWardrobe: (): void => handlers.onWardrobe("survivor"),
			onTutorial: handlers.onTutorial,
		});
		survivor = s;
		return s;
	};

	const hourNow = (): number | undefined => (status.hosted ? numberAttr(DAY_TIME_ATTR) : undefined);

	handle = {
		refresh(update: LobbyStatus): void {
			if (closed) return;
			if (update.seed !== status.seed) flyover = attachFlyover(root, update.seed, Z_TOWN);
			status = update;
			flyover.setDayTime(hourNow());
			menu.refresh(status);
			survivor?.refresh(survivorState());
		},
		show(page: LobbyPage): void {
			if (closed) return;
			if (page === "survivor") {
				const s = survivor ?? buildSurvivor();
				s.refresh(survivorState());
				setVisible(menu.frame, false);
				setVisible(s.frame, true);
				setVisible(band, false);
				s.focus();
			} else {
				if (survivor !== undefined) setVisible(survivor.frame, false);
				setVisible(menu.frame, true);
				setVisible(band, true);
				autoFocus(menu.start);
			}
			if (current !== page) {
				current = page;
				handlers.onPage?.(page);
			}
		},
		page(): LobbyPage {
			return current;
		},
		close(): void {
			if (closed) return;
			closed = true;
			for (const c of conns) c.Disconnect();
			unsubscribe();
			// the flyover's pool outlives this screen (the Shop and back reuses it): off the root before it goes
			detachFlyover();
			menu.destroy();
			survivor?.destroy();
			root.Destroy();
		},
	};

	// the town's live numbers: the menu's cells, the flyover's hour and the Survivor screen's "Day N"
	const Workspace = game.GetService("Workspace");
	const onWorld = (): void => {
		if (closed) return;
		flyover.setDayTime(hourNow());
		menu.refreshTown(status);
		if (survivor !== undefined && current === "survivor") survivor.refresh(survivorState());
	};
	const conns: Array<RBXScriptConnection> = [
		Workspace.GetAttributeChangedSignal(WORLD_DAY_ATTR).Connect(onWorld),
		Workspace.GetAttributeChangedSignal(DAY_TIME_ATTR).Connect(onWorld),
		Workspace.GetAttributeChangedSignal(IN_WORLD_ATTR).Connect(onWorld),
	];
	// the survivor previews breathe (a dog's tail); only the page on screen is drawn
	const t0 = os.clock();
	conns.push(
		game.GetService("RunService").RenderStepped.Connect(() => {
			const t = os.clock() - t0;
			if (current === "menu") menu.draw(t);
			else survivor?.draw(t);
		}),
	);
	const unsubscribe = onWalletChanged(() => {
		if (closed) return;
		menu.refresh(status);
		if (survivor !== undefined) survivor.refresh(survivorState());
	});

	handle.refresh(status);
	handle.show(open);
	return handle;
}
