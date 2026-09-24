/*
 * The wardrobe's Supporter tab (docs/DESIGN_RULES.md MON-07): what the "Last Town Supporter" subscription is, told
 * plainly, and the platform's own prompt. It exists only when a subscription id is configured
 * (shared/data/supporter.ts); with none, the wardrobe has no such tab at all.
 *
 *   ┌ Last Town Supporter ───────────────────────────────────── NOT SUBSCRIBED ┐
 *   │ ┌ preview ────────────┐  What you get                                     │
 *   │ │   (your survivor)   │  ♥ A heart beside your name, for everyone to see. │  (♥: the pixel heart)
 *   │ │  LV 12 ♥ Editor3D   │  Your melee swing trail in the Supporter rose.    │
 *   │ └─────────────────────┘  What it never gives                              │
 *   │                          No coins, XP, items or titles: nothing that       │
 *   │                          changes a night.                                  │
 *   │                          99 Robux / month · renews until you cancel        │
 *   │                          [                 See price                  ]    │
 *   └────────────────────────────────────────────────────────────────────────────┘
 *
 * - Honest by construction (BEM-02, BEM-08, MON-01): what it gives, what it never gives, that it renews monthly and can
 *   be cancelled -- and the price and period as the platform states them (`GetSubscriptionProductInfoAsync`, the
 *   player's own currency and wording), because the Roblox guidelines ask for price and duration wherever it is
 *   offered. The button says "See price" (never "BUY NOW") and stays disabled until the platform has stated that price
 *   here; a subscription the platform says is not for sale is not offered at all (the button goes, the price line says
 *   so). An answer that did not come is asked again the next time the tab opens. The platform's prompt shows the price
 *   again before anything is paid. Subscribed: the status says so and the button offers the platform's cancel prompt,
 *   as plainly (review of 97cd734, LOW5).
 * - The heart here is the menus' pixel heart (client/ui/pixelIcon.ts), in the Supporter rose. On the nameplate it stays
 *   the "♥" glyph: the plate is text only, with a pixel shadow under every line and no surface behind it (DESIGN_RULES
 *   MON-05 "Placa, sem fundo"; test:backpack 9b counts none), measured for contrast over every ground at night
 *   (test:world-art §9), and redrawn in the world every frame from a pool -- nine opaque Frames and a shadow of their own
 *   per plate would break all three for the same heart.
 * - Who is subscribed is the SERVER's word (the `pz_supporter` attribute, client/systems/supporterClient.ts); the page
 *   repaints when it changes (a purchase registered, a lapse), and writes nothing else.
 * - The preview is the street's own drawing: your survivor and your nameplate WITH the heart, so what you see here is
 *   what everybody will see. The rose swing trail is described, not animated (the page does not run a frame loop).
 * - Built once when the wardrobe opens; switching to the tab and a status change only rewrite text (UI-09).
 */
import { GameContext } from "shared/game/context";
import { langGet } from "shared/data/lang";
import { SUPPORTER_SUBSCRIPTION_ID } from "shared/data/supporter";
import { outfitLookOf } from "shared/game/save";
import { SurvivorPreview } from "../view/cosmeticPreview";
import { drawingBox } from "./drawingBox";
import { Nameplate, profileOf } from "./nameplate";
import { PixelIcon } from "./pixelIcon";
import { toast } from "./popup";
import { OVER_WORLD, TEXT, THEME, fontOf, space } from "./theme";
import { Button, Keycap, makeFrame, makeLabel, setButtonEnabled, setButtonVariant } from "./widgets";
import { localIsSupporter, onSupporterChanged, promptSupporter } from "../systems/supporterClient";
import * as Kit from "./window";

const BOLD = fontOf("sans", Enum.FontWeight.Bold);
const KEY_H = 28;
const ACTION_H = 44;
const PREVIEW_W = 300;
const LINE_H = 22;
/** the pixel heart before "A heart beside your name": its side, and the gap to the words */
const HEART_S = 14;
const HEART_GAP = 8;

/** the lines of the page (lang keys) */
export const SUPPORTER_TEXT = {
	title: "Last Town Supporter",
	active: "ACTIVE",
	inactive: "NOT SUBSCRIBED",
	getsHead: "What you get",
	getsHeart: "A heart beside your name, for everyone to see.",
	getsTrail: "Your melee swing trail in the Supporter rose.",
	neverHead: "What it never gives",
	never: "No coins, XP, items or titles: nothing that changes a night.",
	renews: "Renews every month until you cancel. You can cancel at any time.",
	priceUnknown: "Roblox shows the price before you confirm.",
	thanks: "You are a Supporter. Thank you for keeping the town alive!",
	see: "See price",
	cancel: "Cancel subscription",
	cancelHint: "You can cancel in your Roblox settings, under Subscriptions.",
	unavailable: "Subscriptions are not available right now.",
} as const;

export interface SupporterPage {
	frame: Frame;
	/** the page's button: the pad lands here when the tab opens */
	action: TextButton;
	/** rewrites the status, the note and the button from the server's word (no Instance is created) */
	refresh: () => void;
	destroy(): void;
}

/** the page, built into `parent` at (x, y, w, h) of its design space; hidden until the wardrobe shows it */
export function mountSupporterPage(
	ctx: GameContext,
	parent: Instance,
	x: number,
	y: number,
	w: number,
	h: number,
): SupporterPage {
	const lang = ctx.save.settings.langType;
	const tr = (k: string): string => langGet(k, lang);
	const frame = makeFrame(parent, "SupporterPage", x, y, w, h, THEME.background, { transparency: 1 });
	frame.Visible = false;
	const sec = Kit.Section(frame, "Supporter", { x: 0, y: 0, w, h, title: tr(SUPPORTER_TEXT.title) });
	const z = sec.frame.ZIndex + 1;
	const status = Keycap(sec.frame, "Status", "", {
		x: w - space(5),
		cy: Kit.SECTION_TITLE_MID,
		anchorX: 1,
		h: KEY_H,
		minW: 120,
		textSize: TEXT.base,
		font: BOLD,
		zIndex: z,
	});

	// ---- the preview: your survivor, and the street's own nameplate under it with the heart on
	const inset = space(4);
	const top = Kit.SECTION_CONTENT_Y;
	const bedH = h - top - inset;
	const bed = Kit.Groove(sec.frame, "PreviewBed", inset, top, PREVIEW_W, bedH);
	const bodyS = math.min(bedH * 0.5, 140);
	const bodyTop = bedH * 0.12;
	const bodyBox = drawingBox(bed, "Survivor", (PREVIEW_W - bodyS) / 2, bodyTop, bodyS, bodyS, bed.ZIndex + 1);
	const body = new SurvivorPreview(bodyBox, { w: bodyS, h: bodyS, subject: "outfit", zIndex: bodyBox.ZIndex });
	body.setOutfit(outfitLookOf(ctx.save));
	body.draw(0);
	const plateTop = bodyTop + bodyS + space(1);
	const plateHost = makeFrame(bed, "PlateHost", 0, plateTop, PREVIEW_W, bedH - plateTop, THEME.background, {
		transparency: 1,
		zIndex: bed.ZIndex + 1,
	});
	const me = game.GetService("Players").LocalPlayer;
	const who = me !== undefined ? profileOf(me) : { displayName: tr("Survivor"), name: tr("Survivor") };
	const plate = new Nameplate(plateHost, plateHost.ZIndex + 1, who, { self: true });
	const placePlate = (): void => plate.update(plateHost.AbsoluteSize.X / 2, 0, ctx.save.level, true, 0, true);
	plateHost.GetPropertyChangedSignal("AbsoluteSize").Connect(placePlate);
	placePlate();

	// ---- the words: what it gives, what it never gives, the terms, the price
	const tx = inset + PREVIEW_W + space(5);
	const tw = w - tx - inset;
	let ty = top;
	const line = (name: string, text: string, color: Color3, bold: boolean, rows = 1, indent = 0): TextLabel => {
		const size = bold ? TEXT.base : TEXT.sm;
		const l = makeLabel(sec.frame, name, text, tx + indent, ty, tw - indent, LINE_H * rows, size, color, {
			font: bold ? BOLD : undefined,
			align: "left",
			valign: "top",
			zIndex: z,
		});
		ty += LINE_H * rows + space(1);
		return l;
	};
	line("GetsHead", tr(SUPPORTER_TEXT.getsHead), THEME.foreground, true);
	// the pixel heart, centred on the first text line (the label hangs from its top)
	PixelIcon(sec.frame, "Heart", "heart", tx + HEART_S / 2, ty + TEXT.sm / 2 + 1, HEART_S, OVER_WORLD.supporter, z);
	line("GetsHeart", tr(SUPPORTER_TEXT.getsHeart), OVER_WORLD.supporter, false, 1, HEART_S + HEART_GAP);
	line("GetsTrail", tr(SUPPORTER_TEXT.getsTrail), THEME.foreground, false);
	ty += space(2);
	line("NeverHead", tr(SUPPORTER_TEXT.neverHead), THEME.foreground, true);
	line("Never", tr(SUPPORTER_TEXT.never), THEME.foreground, false, 2);
	ty += space(2);
	line("Renews", tr(SUPPORTER_TEXT.renews), THEME.foreground, false, 2);
	// the platform's own price and period ("R$ 99" + "/month", in the player's wording), once it answers
	const price = line("Price", tr(SUPPORTER_TEXT.priceUnknown), THEME.foreground, true);
	const note = line("Note", "", OVER_WORLD.supporter, true, 2);

	let busy = false;
	/** the price and period as the platform stated them ("R$ 99/month"); undefined until it answered with one */
	let priceText: string | undefined;
	/** the platform's IsForSale (true until it says otherwise) */
	let forSale = true;
	let asking = false;
	const act = (): void => {
		if (busy) return;
		if (localIsSupporter()) {
			// the platform's cancel prompt; where it cannot be shown, the plain way there
			const [ok] = pcall(() => {
				if (me !== undefined) {
					game.GetService("MarketplaceService").PromptCancelSubscription(me, SUPPORTER_SUBSCRIPTION_ID);
				}
			});
			if (!ok) toast(ctx, tr(SUPPORTER_TEXT.cancelHint), "info");
			return;
		}
		// offered only with its price on the page, and only while the platform sells it
		if (priceText === undefined || !forSale) return;
		if (!promptSupporter()) toast(ctx, tr(SUPPORTER_TEXT.unavailable), "error");
	};
	const action = Button(sec.frame, "Action", "", {
		x: tx,
		y: h - inset - ACTION_H,
		w: tw,
		h: ACTION_H,
		textSize: TEXT.lg,
		zIndex: z,
		onClick: act,
	});

	/** writes the status, the price line, the note and the button from what is known now (no Instance is created) */
	const paint = (): void => {
		if (frame.Parent === undefined) return;
		const active = localIsSupporter();
		Kit.setValueKey(status, tr(active ? SUPPORTER_TEXT.active : SUPPORTER_TEXT.inactive));
		note.Text = active ? tr(SUPPORTER_TEXT.thanks) : "";
		price.Text = !forSale ? tr(SUPPORTER_TEXT.unavailable) : (priceText ?? tr(SUPPORTER_TEXT.priceUnknown));
		action.Text = tr(active ? SUPPORTER_TEXT.cancel : SUPPORTER_TEXT.see);
		setButtonVariant(action, active ? "secondary" : "default");
		// a subscriber can always reach the cancel prompt; the offer needs its price on the page, and a sale
		action.Visible = active || forSale;
		setButtonEnabled(action, !busy && (active || (forSale && priceText !== undefined)));
		placePlate();
	};
	/** the price as the platform states it: a yield, off the opening frame; asked again at the next refresh if it failed */
	const askPrice = (): void => {
		if (asking || priceText !== undefined || !forSale) return;
		asking = true;
		task.spawn(() => {
			const [ok, info] = pcall(() =>
				game.GetService("MarketplaceService").GetSubscriptionProductInfoAsync(SUPPORTER_SUBSCRIPTION_ID),
			);
			asking = false;
			if (!ok || frame.Parent === undefined || !typeIs(info, "table")) return;
			const i = info as unknown as Record<string, unknown>;
			forSale = i.IsForSale !== false;
			const shown = typeIs(i.DisplayPrice, "string") ? i.DisplayPrice : "";
			const period = typeIs(i.DisplaySubscriptionPeriod, "string") ? i.DisplaySubscriptionPeriod : "";
			if (shown !== "") priceText = `${shown}${period}`;
			paint();
		});
	};
	const refresh = (): void => {
		paint();
		askPrice();
	};
	const unsubscribe = onSupporterChanged(refresh);

	refresh();
	return {
		frame,
		action,
		refresh,
		destroy(): void {
			busy = true;
			unsubscribe();
			body.destroy();
			plate.destroy();
			frame.Destroy();
		},
	};
}
