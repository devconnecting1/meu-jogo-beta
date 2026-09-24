import { GameContext } from "shared/game/context";
import { ownsEquip, outfitLookOf, petLookOf, totalPendingPacks } from "shared/game/save";
import { COSTUMES } from "shared/data/shop";
import { cosmeticSlotOf, PetLook } from "shared/data/cosmetics";
import { langGet } from "shared/data/lang";
import { MAX_PLAYERS } from "shared/net/mpConfig";
import { onWalletChanged } from "../systems/saveClient";
import { SurvivorPreview } from "../view/cosmeticPreview";
import { pinFlyover, TownFlyover } from "../view/townFlyover";
import { achievementCounts, showAchievements } from "./achievements";
import { Wordmark } from "./logo";
import { paintPlate } from "./plate";
import { PixelIcon, PixelIconKind } from "./pixelIcon";
import { showRecords } from "./records";
import { RunState, SURVIVOR_WINDOW, SurvivorScreen } from "./survivor";
import { SURFACE, TEXT, THEME, fontOf, space } from "./theme";
import { drawingBox } from "./wardrobe";
import {
	Button,
	Keycap,
	autoFocus,
	buttonForeground,
	makeCoinPill,
	makeFrame,
	makeLabel,
	makeScreen,
	setVisible,
} from "./widgets";
import * as Kit from "./window";

export type { RunState } from "./survivor";

/*
 * The lobby (docs/DESIGN_RULES.md UI-10): a PC game's title screen, and behind the START plate the Survivor screen
 * (client/ui/survivor.ts). Both stand on the town flyover (client/view/townFlyover.ts): the real town of the world
 * the player is about to enter, drifting past under a dark scrim.
 *
 *   PROJECT Z                                                    (● 1,843)
 *   Zombie survival                                     (loading / offline)
 *   ┌───────────────────────────┐   ┌ Fabricio ──────────────── LEVEL 7 ┐
 *   │ ▶  START                  │   │                                    │
 *   │    Continue this run      │   │   the survivor, outfit and pet     │
 *   └───────────────────────────┘   │                                    │
 *   [🛍 Shop      Packs & costumes]   └────────────────────────────────────┘
 *   [👕 Wardrobe             2 / 9]   ┌ Town ──────────────────────────────┐
 *   [🏆 Achievements        3 / 18]   │ [☀ Day 7   ] [👤 2 / 6  ] [✝ Day 12] │
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
	/**
	 * the wardrobe (MON-04); `from` is the page its X comes back to, `slot` the tab it opens on (EquipSlot.Outfit or
	 * Pet: the Survivor screen's loadout tile of that slot); none = its first
	 */
	onWardrobe: (from: LobbyPage, slot?: number) => void;
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
	/**
	 * Lobby idle time (client/boot/warmup.ts): builds the Survivor page out of sight, so START only shows it. Answers
	 * true when it built it now (false: already built, or the lobby is closed).
	 */
	prebuild(): boolean;
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
/** the loading / offline note under the coins: a small panel plate of its own, so the red reads on a fixed colour */
const NOTE_X = 760;
const NOTE_Y = 86;
const NOTE_W = 320;
const NOTE_H = 24;

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
	private readonly statusPlate: Frame;
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

		// ---- the header, straight over the town. There used to be an opaque band behind it, a black strip across the
		// top of the flyover that read as a rendering fault (owner, 2026-09-23). The scrim alone holds `foreground` at
		// 4,5:1 over a white world (test:contrast, UI-10), so the title and the tagline use it; the note, whose red
		// would not, sits on a small panel plate of its own
		Wordmark(frame, "Title", MARGIN, 20, 460, 60, TEXT.xl5);
		makeLabel(frame, "Tagline", tr("Zombie survival"), MARGIN + 2, 80, 400, 22, TEXT.sm, THEME.foreground, {
			align: "left",
		});
		this.coins = makeCoinPill(frame, "Coins", 850, 28, 230, 52, () => ctx.save.money, handlers.onShop);
		this.statusPlate = makeFrame(frame, "StatusPlate", NOTE_X, NOTE_Y, NOTE_W, NOTE_H, SURFACE.panel, {});
		this.status = makeLabel(
			this.statusPlate,
			"Status",
			"",
			8,
			0,
			NOTE_W - 16,
			NOTE_H,
			TEXT.sm,
			THEME.mutedForeground,
			{
				align: "right",
			},
		);
		setVisible(this.statusPlate, false);

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
		this.startTitle = makeLabel(start, "Title", tr("START"), 84, 16, NAV_W - 104, 40, TEXT.xl3, fg, {
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
				onClick: (): void => {
					showAchievements(ctx);
				},
				sub: () => {
					const [done, total] = achievementCounts(ctx.save);
					return `${done} / ${total}`;
				},
			},
			{
				key: "Records",
				icon: "records",
				onClick: (): void => {
					showRecords(ctx);
				},
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
		// the player's display name: never captured for automatic translation (compliance F9)
		this.name.AutoLocalize = false;
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
		setVisible(this.statusPlate, this.status.Text !== "");
		for (const item of this.items) {
			if (item.sub !== undefined && item.subLabel !== undefined) this.write(item.subLabel, item.sub());
		}
		this.coins.refresh();

		const Players = game.GetService("Players");
		const me = Players.LocalPlayer as Player | undefined;
		this.write(this.name, me !== undefined ? me.DisplayName : tr("Survivor"));
		Kit.setValueKey(this.level, `${tr("LEVEL")} ${save.level}`);
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

export function showLobby(
	ctx: GameContext,
	handlers: LobbyHandlers,
	initial: LobbyStatus,
	open: LobbyPage = "menu",
): LobbyHandle {
	// see-through: the town behind the menus is pinned in the backdrop layer (the world's ScreenGui, under the menus'),
	// and it stays there when the lobby hands over to Settings, the Wardrobe, the Shop... (townFlyover.ts pinFlyover);
	// only the run releases it
	const screen = makeScreen(ctx.uiLayer, "Lobby", { transparency: 1 });
	const { root, body } = screen;
	let status = initial;
	let current: LobbyPage = "menu";
	let closed = false;
	let flyover: TownFlyover = pinFlyover(ctx.backdropLayer, status.seed);

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
			onWardrobe: (slot?: number): void => handlers.onWardrobe("survivor", slot),
			onTutorial: handlers.onTutorial,
		});
		survivor = s;
		return s;
	};

	const hourNow = (): number | undefined => (status.hosted ? numberAttr(DAY_TIME_ATTR) : undefined);

	handle = {
		refresh(update: LobbyStatus): void {
			if (closed) return;
			if (update.seed !== status.seed) flyover = pinFlyover(ctx.backdropLayer, update.seed);
			status = update;
			flyover.setDayTime(hourNow());
			menu.refresh(status);
			survivor?.refresh(survivorState());
		},
		show(page: LobbyPage): void {
			if (closed) return;
			// the menu is a page that reaches the screen's edges; the Survivor screen is a window, centred on the
			// full screen (UI-07): the one body moves to centre what is showing
			screen.setContent(page === "survivor" ? SURVIVOR_WINDOW : undefined);
			if (page === "survivor") {
				const s = survivor ?? buildSurvivor();
				s.refresh(survivorState());
				setVisible(menu.frame, false);
				setVisible(s.frame, true);
				s.focus();
			} else {
				if (survivor !== undefined) setVisible(survivor.frame, false);
				setVisible(menu.frame, true);
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
		prebuild(): boolean {
			if (closed || survivor !== undefined) return false;
			const s = buildSurvivor();
			s.refresh(survivorState());
			setVisible(s.frame, false);
			return true;
		},
		close(): void {
			if (closed) return;
			closed = true;
			for (const c of conns) c.Disconnect();
			unsubscribe();
			// the flyover is not this screen's: it stays pinned behind the next menu screen, gliding on, until the run
			// releases it (main.client.ts mountRun)
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
