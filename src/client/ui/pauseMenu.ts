import { GameContext } from "shared/game/context";
import { langGet } from "shared/data/lang";
import { rebirthPrice } from "shared/data/shop";
import { TEXT, THEME, TRANSPARENCY, space } from "./theme";
import { SCHEMES, SCHEME_TOUCH, currentScheme } from "./tutorial";
import {
	Badge,
	Button,
	ButtonVariant,
	CARD_STRIP_INSET,
	Card,
	CardHeader,
	CoinIcon,
	autoFocus,
	badgeWidth,
	cardStripHeight,
	centredRect,
	fmtInt,
	makeLabel,
	makeScreen,
	makeSurface,
	nl,
} from "./widgets";

export interface PauseHandlers {
	onResume?: () => void;
	onSave?: () => void;
	onHome?: () => void;
	onShop?: () => void;
	onSettings?: () => void;
	onRebirth?: () => void;
	onNewRun?: () => void;
}

export interface PauseInfo {
	/** small note under the buttons (e.g. why saving is off) */
	note?: string;
}

const GAME_OVER_W = 460;
const GAME_OVER_H = 440;
const PAUSE_W = 360;
const PAUSE_H = 470;
/** the "P" key cap on the menu's title strip */
const KEY_BADGE = 30;

/**
 * kind 0 = the in-run menu (P / Start / the menu button), kind 2 = game over; both are cards over a scrim.
 *
 * DESIGN_RULES UI-06: the name stayed (`showPause`, the file) but nothing here pauses anything. The world is
 * the server's and shared, and solo follows the same rule: the town keeps going behind this card, so the card
 * never says "Paused", and its scrim only dims the street (TRANSPARENCY.overWorld) so what is coming stays in
 * sight round the panel. The survivor stands still while it is open (client/main.client.ts, InputState.setHeld).
 */
export function showPause(ctx: GameContext, kind: number, handlers: PauseHandlers, info?: PauseInfo): () => void {
	const lang = ctx.save.settings.langType;
	const tr = (key: string): string => langGet(key, lang);
	const { root, body } = makeScreen(ctx.uiLayer, "Menu", {
		color: THEME.background,
		transparency: TRANSPARENCY.overWorld,
		zIndex: 250,
		content: kind === 2 ? centredRect(GAME_OVER_W, GAME_OVER_H) : centredRect(PAUSE_W, PAUSE_H),
	});
	const pad = space(6);

	if (kind === 2) {
		const w = GAME_OVER_W;
		const innerW = w - pad * 2;
		const panel = Card(body, "Panel", centredRect(GAME_OVER_W, GAME_OVER_H));
		// title strip of the reference art, in the destructive tone (the run is over)
		const top = CardHeader(panel, tr("Game over"), undefined, { color: THEME.destructive });
		const save = ctx.save;
		const stats: Array<[string, string]> = [
			[tr("Survival days"), `${save.day}`],
			[tr("Best day"), `${save.bestDay}`],
			[tr("Level"), `${save.level}`],
		];
		// the numbers of the run sit in a well, like the reference's stat panes
		const statsH = stats.size() * 30 + space(4);
		const statsWell = makeSurface(panel, "Stats", pad, top, innerW, statsH, "well");
		for (let i = 0; i < stats.size(); i++) {
			const [k, v] = stats[i];
			const y = space(2) + i * 30;
			makeLabel(statsWell, `Stat${i}K`, k, space(3), y, 240, 26, TEXT.base, THEME.mutedForeground, {
				align: "left",
				zIndex: 2,
			});
			makeLabel(statsWell, `Stat${i}V`, v, innerW - space(3) - 140, y, 140, 26, TEXT.base, THEME.foreground, {
				font: "numeric",
				align: "right",
				zIndex: 2,
			});
		}
		// rebirth: coin price vs wallet
		const price = rebirthPrice(save.deathCount);
		const canAfford = save.money >= price;
		const walletY = top + statsH + space(3);
		CoinIcon(panel, "Coin", pad, walletY + 4, 18);
		makeLabel(
			panel,
			"Wallet",
			`${tr("Continue price")}: ${fmtInt(price)}   ·   ${fmtInt(save.money)}`,
			pad + 26,
			walletY,
			innerW - 26,
			26,
			TEXT.sm,
			canAfford ? THEME.foreground : THEME.destructive,
			{ font: "numeric", align: "left" },
		);
		// the primary action is Rebirth when affordable; without coins it is shown as destructive (can't pay)
		const rebirthY = walletY + 40;
		const rebirth = Button(panel, "Rebirth", `${tr("Rebirth")}  ·  ${fmtInt(price)}`, {
			x: pad,
			y: rebirthY,
			w: innerW,
			size: "lg",
			variant: canAfford ? "default" : "destructive",
			onClick: (): void => handlers.onRebirth?.(),
		});
		const rowY = rebirthY + 56 + space(3);
		const halfW = (innerW - space(3)) / 2;
		const newRun = Button(panel, "NewRun", tr("New game"), {
			x: pad,
			y: rowY,
			w: halfW,
			variant: "destructive",
			onClick: (): void => handlers.onNewRun?.(),
		});
		Button(panel, "Home", tr("Home"), {
			x: pad + halfW + space(3),
			y: rowY,
			w: halfW,
			variant: "secondary",
			onClick: (): void => handlers.onHome?.(),
		});
		makeLabel(
			panel,
			"Hint",
			nl(
				tr(
					"Rebirth to continue this run, or start a new game from day 1.#Level, skills, coins and packs are kept.",
				),
			),
			pad,
			rowY + 44 + space(3),
			innerW,
			44,
			TEXT.xs,
			THEME.mutedForeground,
		);
		autoFocus(canAfford ? rebirth : newRun);
	} else {
		const w = PAUSE_W;
		const innerW = w - pad * 2;
		const panel = Card(body, "Panel", centredRect(PAUSE_W, PAUSE_H));
		const stripH = cardStripHeight();
		// the key cap on the title strip is the key that opens this menu on the player's device (tutorial.ts SCHEMES,
		// as the HUD's Menu plate reads it): P on a keyboard, Start on a pad; a touch screen has a MENU button, not a
		// key, so no cap. It used to say "P" on every device
		const scheme = currentScheme();
		let menuKey = "";
		if (scheme !== SCHEME_TOUCH) {
			for (const [chip, does] of SCHEMES[scheme].rows) if (does === "Menu") menuKey = chip;
		}
		const keyW = menuKey === "" ? 0 : math.max(KEY_BADGE, badgeWidth(menuKey, TEXT.sm, KEY_BADGE));
		const top = CardHeader(panel, tr("Menu"), undefined, { action: keyW > 0 ? keyW + space(2) : 0 });
		if (keyW > 0) {
			Badge(panel, "KeyHint", menuKey, {
				x: w - CARD_STRIP_INSET - space(2) - keyW,
				y: CARD_STRIP_INSET + (stripH - KEY_BADGE) / 2,
				w: keyW,
				h: KEY_BADGE,
				textSize: TEXT.sm,
				zIndex: 4,
			});
		}
		const items: Array<{ key: string; fn: (() => void) | undefined; variant: ButtonVariant }> = [
			// "Back to game", not "Resume": nothing was suspended, the survivor only stood still (UI-06)
			{ key: "Back to game", fn: handlers.onResume, variant: "default" },
			{ key: "Save", fn: handlers.onSave, variant: "secondary" },
			{ key: "Shop", fn: handlers.onShop, variant: "secondary" },
			{ key: "Settings", fn: handlers.onSettings, variant: "secondary" },
			{ key: "Home", fn: handlers.onHome, variant: "secondary" },
		];
		let first: TextButton | undefined;
		for (let i = 0; i < items.size(); i++) {
			const item = items[i];
			const fn = item.fn;
			const b = Button(panel, `Btn${i}`, tr(item.key), {
				x: pad,
				y: top + i * (48 + space(3)),
				w: innerW,
				h: 48,
				variant: item.variant,
				onClick: (): void => {
					if (fn !== undefined) fn();
				},
			});
			if (i === 0) first = b;
		}
		if (info?.note !== undefined) {
			makeLabel(panel, "Note", info.note, pad, PAUSE_H - pad - 32, innerW, 32, TEXT.xs, THEME.mutedForeground);
		}
		if (first !== undefined) autoFocus(first);
	}

	return (): void => {
		root.Destroy();
	};
}
