import { GameContext } from "shared/game/context";
import { langGet } from "shared/data/lang";
import { TEXT, THEME, space } from "./theme";
import { BUTTON_SIZE, Badge, Button, Dialog, autoFocus, cardHeaderHeight, makeLabel, nl } from "./widgets";

/*
 * "How to play": the one reference card of the game.
 *
 * The slide deck that used to live here was a lecture — eight panels of text, read once, before the player had
 * ever seen the town, and it still promised keys the game no longer has. Teaching now happens IN the first
 * match (client/onboarding), one short objective at a time; what stays here is the thing a deck is actually
 * good for: a reference you can open from the lobby whenever you forget which key does what.
 *
 * It lists all three schemes side by side, because the same account plays on a phone, on a PC and on a pad.
 */

const UserInputService = game.GetService("UserInputService");

const PANEL_W = 920;
const PAD = space(6);
const COL_GAP = space(3);
const COL_W = (PANEL_W - PAD * 2 - COL_GAP * 2) / 3;
const ROW_H = 30;
const CHIP_W = 78;
const CHIP_H = 22;
const COL_TITLE_H = 26;
const NOTE_H = 40;
const TIPS_H = 68;
const FOOTER_W = 170;

interface Scheme {
	title: string;
	/** [chip, what it does] */
	rows: Array<[string, string]>;
	/** shown under the rows */
	note: string;
}

/** the real bindings, straight from client/bootstrap.ts — nothing here is promised that the game does not do */
const SCHEMES: Array<Scheme> = [
	{
		title: "Keyboard & mouse",
		rows: [
			["W A S D", "Move"],
			["Mouse", "Aim"],
			["Left click", "Attack / shoot"],
			["E", "Interact, search, loot"],
			["R", "Reload"],
			["1 – 5", "Switch weapon"],
			["B", "Backpack (pauses)"],
			["P", "Pause menu"],
		],
		note: "Right click also interacts.",
	},
	{
		title: "Touch",
		rows: [
			["Left thumb", "Move (the stick opens under it)"],
			["Right thumb", "Drag to aim"],
			["Let go", "Fire the aimed shot"],
			["Keep holding", "Automatics keep firing"],
			["USE", "Interact (appears when you can)"],
			["RELOAD", "Reload"],
			["BAG", "Backpack"],
			["II", "Pause"],
		],
		note: "Size, height, floating stick and left-handed: Settings › Touch controls.",
	},
	{
		title: "Gamepad",
		rows: [
			["Left stick", "Move"],
			["Right stick", "Aim"],
			["RT / RB / A", "Attack / shoot"],
			["X", "Interact"],
			["Y", "Reload"],
			["LB", "Backpack"],
			["Start", "Pause menu"],
			["D-pad", "Menus"],
		],
		note: "Menus are navigated with the stick; the selected button carries a focus ring.",
	},
];

const SURVIVAL_TIPS = [
	"Fire keeps the night lit and cooks what you find — 10 wood makes a campfire, no workbench needed.",
	"Houses are looted once with E; their shelves refill after half a day.",
	"Hunger drains all day: eat before it empties, not after.",
	"Waves come at 19:00, 22:00 and 01:00. Be somewhere you chose.",
].join("#");

/** the longest column decides where the notes, the tips and the footer land (nothing is a magic number) */
const MAX_ROWS = (): number => {
	let n = 0;
	for (const s of SCHEMES) n = math.max(n, s.rows.size());
	return n;
};
/** y where the content starts: Dialog draws its title strip + one description line above it */
const HEADER_H = cardHeaderHeight(TEXT.xl2, 1);
const ROWS_Y = HEADER_H + COL_TITLE_H + space(2);
const TIPS_Y = ROWS_Y + MAX_ROWS() * ROW_H + space(1) + NOTE_H + space(3);
const FOOTER_H = BUTTON_SIZE.lg.h;
const PANEL_H = TIPS_Y + TIPS_H + PAD;

/** the reference card, opened from the lobby's "How to play" and from the pause menu */
export function showTutorial(ctx: GameContext, onDone: () => void): () => void {
	const lang = ctx.save.settings.langType;
	const tr = (key: string): string => langGet(key, lang);
	const dialog = Dialog(ctx.uiLayer, "HowToPlay", {
		w: PANEL_W,
		h: PANEL_H,
		title: tr("How to play"),
		description: tr("Everything the game listens to, on every device"),
		zIndex: 260,
	});
	const panel = dialog.card;
	const top = dialog.contentY;
	// the player's own scheme first: a phone player should not have to read the PC column to find theirs
	const order = UserInputService.TouchEnabled && !UserInputService.MouseEnabled ? [1, 0, 2] : [0, 1, 2];

	for (let i = 0; i < order.size(); i++) {
		const scheme = SCHEMES[order[i]];
		const x = PAD + i * (COL_W + COL_GAP);
		makeLabel(panel, `Col${i}Title`, tr(scheme.title), x, top, COL_W, COL_TITLE_H, TEXT.lg, THEME.foreground, {
			font: "heading",
			align: "left",
		});
		const rowsY = top + COL_TITLE_H + space(2);
		for (let r = 0; r < scheme.rows.size(); r++) {
			const [chip, what] = scheme.rows[r];
			const y = rowsY + r * ROW_H;
			Badge(panel, `Col${i}Key${r}`, chip, {
				x,
				y: y + (ROW_H - CHIP_H) / 2,
				w: CHIP_W,
				h: CHIP_H,
				variant: "secondary",
				textSize: TEXT.xs,
			});
			makeLabel(
				panel,
				`Col${i}Row${r}`,
				tr(what),
				x + CHIP_W + space(2),
				y,
				COL_W - CHIP_W - space(2),
				ROW_H,
				TEXT.sm,
				THEME.mutedForeground,
				{ align: "left" },
			);
		}
		makeLabel(
			panel,
			`Col${i}Note`,
			tr(scheme.note),
			x,
			rowsY + scheme.rows.size() * ROW_H + space(1),
			COL_W,
			NOTE_H,
			TEXT.xs,
			THEME.mutedForeground,
			{ align: "left", valign: "top" },
		);
	}

	// footer row: the survival tips on the left, the one way out on the right
	makeLabel(
		panel,
		"Tips",
		nl(tr(SURVIVAL_TIPS)),
		PAD,
		TIPS_Y,
		PANEL_W - PAD * 2 - FOOTER_W - space(4),
		TIPS_H,
		TEXT.xs,
		THEME.foreground,
		{ align: "left", valign: "top" },
	);

	const cleanup = (): void => {
		dialog.root.Destroy();
	};
	const done = Button(panel, "Done", tr("Got it"), {
		x: PANEL_W - PAD - FOOTER_W,
		y: TIPS_Y + (TIPS_H - FOOTER_H) / 2,
		w: FOOTER_W,
		size: "lg",
		variant: "default",
		onClick: (): void => {
			// the lobby asks for this card once, before the first match; answering it is answering the question
			ctx.save.tutorialDone = true;
			cleanup();
			onDone();
		},
	});
	autoFocus(done);
	return cleanup;
}
