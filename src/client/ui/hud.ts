import { GameContext } from "shared/game/context";
import { langGet } from "shared/data/lang";
import { GAME, RADIUS, TEXT, THEME, TRANSPARENCY, space } from "./theme";
import {
	Badge,
	Bar,
	Button,
	Card,
	Progress,
	addAspect,
	badgeWidth,
	fmtInt,
	makeAnchored,
	makeFrame,
	makeLabel,
	tween,
} from "./widgets";

export interface HudState {
	hp: number;
	hpMax: number;
	hunger: number;
	hungerMax: number;
	level: number;
	exp: number;
	expMax: number;
	day: number;
	/** 0..24 in-game hours */
	dayTime: number;
	isNight: boolean;
	/** a watch/sundial is equipped: show HH:MM (as in the original, the time is an item perk) */
	showClock: boolean;
	weaponName: string;
	mag: number;
	magSize: number;
	reloading: boolean;
	reloadRatio: number;
	ammoPool: number;
	/** 1 → 0 after taking damage */
	hitFlash: number;
}

type MessageKind = "wave" | "morning" | "night" | "boss" | "level" | "warn" | "normal";

function classify(msg: string): MessageKind {
	if (msg.match("^Wave %d")[0] !== undefined) return "wave";
	if (msg === "Good morning") return "morning";
	if (msg === "Night is coming") return "night";
	if (msg === "You killed it") return "boss";
	if (msg === "Level UP") return "level";
	if (msg === "No ammo") return "warn";
	return "normal";
}

const UserInputService = game.GetService("UserInputService");

const FEED_MAX = 4;
const FEED_TIME = 3.5;
const FEED_W = 560;
const FEED_H = 176;
const FEED_LINE_H = 34;
const FEED_LINE_MIN_W = 200;

const CENTER = UDim2.fromScale(0.5, 0.5);

const BANNER_W = 720;
const BANNER_H = 110;
const BANNER_MIN_W = 280;

export class Hud {
	onPause: (() => void) | undefined;
	onBackpack: (() => void) | undefined;
	/** tapping the on-screen action button (mobile) */
	onAction: (() => void) | undefined;

	private ctx: GameContext;
	private root: Frame | undefined;
	private hpBar: Bar | undefined;
	private hungerBar: Bar | undefined;
	private expBar: Bar | undefined;
	private levelLabel: TextLabel | undefined;
	private dayLabel: TextLabel | undefined;
	private phaseLabel: TextLabel | undefined;
	private clockLabel: TextLabel | undefined;
	private dayIcon: Frame | undefined;
	private weaponLabel: TextLabel | undefined;
	private magLabel: TextLabel | undefined;
	private ammoLabel: TextLabel | undefined;
	private reloadBar: Bar | undefined;
	private vignette: Array<Frame> = [];
	private vignetteT = 1;
	private flash = 0;
	private feed: Frame | undefined;
	private bannerCard: Frame | undefined;
	private banner: TextLabel | undefined;
	private bannerSub: TextLabel | undefined;
	private bannerScale: UIScale | undefined;
	private bannerGen = 0;
	private feedOrder = 0;
	private joyBase: Frame | undefined;
	private joyKnob: Frame | undefined;
	private joyActive: boolean | undefined;
	private fireBtn: Frame | undefined;
	private fireHeld: boolean | undefined;
	private actionBtn: TextButton | undefined;
	private hintBox: Frame | undefined;
	private hintKey: Frame | undefined;
	private hintLabel: TextLabel | undefined;
	private mounted = false;
	private last = new Map<string, string>();
	private ratios = new Map<string, number>();

	constructor(ctx: GameContext) {
		this.ctx = ctx;
	}

	private tr(key: string): string {
		return langGet(key, this.ctx.save.settings.langType);
	}

	/** sets a label's text only when it changed (the HUD updates every frame) */
	private setText(label: TextLabel | undefined, key: string, text: string): void {
		if (label === undefined || this.last.get(key) === text) return;
		this.last.set(key, text);
		label.Text = text;
	}

	/** sets a bar's fill only when the ratio changed */
	private setRatio(bar: Bar | undefined, key: string, ratio: number): void {
		if (bar === undefined || this.ratios.get(key) === ratio) return;
		this.ratios.set(key, ratio);
		bar.setRatio(ratio);
	}

	/** sets a bar's indicator colour only when it changed */
	private setFill(bar: Bar | undefined, color: Color3): void {
		if (bar !== undefined && bar.fill.BackgroundColor3 !== color) bar.setColor(color);
	}

	mount(): void {
		if (this.mounted) return;
		this.mounted = true;
		this.last.clear();
		this.ratios.clear();
		const ctx = this.ctx;
		const mobile = UserInputService.TouchEnabled;
		// "UI size" setting (0..1, default 0.5): 80% .. 120% of the HUD controls
		const k = 0.8 + 0.4 * math.clamp(ctx.save.settings.uiSize, 0, 1);
		const root = new Instance("Frame");
		root.Name = "HudRoot";
		root.Size = UDim2.fromScale(1, 1);
		root.BackgroundTransparency = 1;
		root.BorderSizePixel = 0;
		root.Parent = ctx.hudLayer;
		this.root = root;

		this.buildVignette(root);
		this.buildStatus(root, k);
		this.buildDay(root, k);

		// ---- top-right: backpack
		const bagBox = makeAnchored(root, "BagBox", 1, 0, 132, 56, 14, 10, true, k);
		Button(bagBox, "Backpack", mobile ? "BAG" : "BAG  (B)", {
			x: 0,
			y: 0,
			w: 132,
			variant: "secondary",
			size: "lg",
			onClick: (): void => this.onBackpack?.(),
		});

		this.buildWeapon(root, k, mobile);
		this.buildTouch(root, k, mobile);
		this.buildHint(root, k);
		this.buildMessages(root, k);
	}

	/** top-left: pause button + vitals card (HP, food, level / XP) */
	private buildStatus(root: Frame, k: number): void {
		const w = 350;
		const h = 92;
		const status = makeAnchored(root, "Status", 0, 0, w, h, 14, 10, true, k);
		const pauseSize = 56;
		Button(status, "Pause", "II", {
			x: 0,
			y: 0,
			w: pauseSize,
			h: pauseSize,
			variant: "secondary",
			size: "icon",
			font: "display",
			textSize: TEXT.xl2,
			zIndex: 5,
			onClick: (): void => this.onPause?.(),
		});

		const vitalsX = pauseSize + space(2);
		const vitalsW = w - vitalsX;
		const vitals = Card(status, "Vitals", { x: vitalsX, y: 0, w: vitalsW, h, variant: "hud" });
		const pad = space(3);
		const tagW = 44;
		const rowH = 20;
		const barX = pad + tagW;
		const barW = vitalsW - barX - pad;
		const rowY = (i: number): number => space(2) + i * (rowH + space(2));
		const tag = (name: string, text: string, row: number, color: Color3): TextLabel =>
			makeLabel(vitals, name, text, pad, rowY(row), tagW, rowH, TEXT.xs, color, {
				weight: Enum.FontWeight.Bold,
				align: "left",
				zIndex: 2,
			});

		tag("HpTag", "HP", 0, GAME.hp);
		this.hpBar = Progress(vitals, "HpBar", {
			x: barX,
			y: rowY(0),
			w: barW,
			h: rowH,
			color: GAME.hp,
			label: true,
			textSize: TEXT.xs,
		});
		tag("FoodTag", "FOOD", 1, GAME.food);
		this.hungerBar = Progress(vitals, "FoodBar", {
			x: barX,
			y: rowY(1),
			w: barW,
			h: rowH,
			color: GAME.food,
			label: true,
			textSize: TEXT.xs,
		});
		this.levelLabel = tag("Level", "LV 1", 2, GAME.xp);
		const xpH = 10;
		this.expBar = Progress(vitals, "ExpBar", {
			x: barX,
			y: rowY(2) + (rowH - xpH) / 2,
			w: barW,
			h: xpH,
			color: GAME.xp,
		});
	}

	/** top-centre: sun / moon, "Day N", phase (+ HH:MM with a watch) */
	private buildDay(root: Frame, k: number): void {
		const w = 230;
		const h = 52;
		const dayBox = makeAnchored(root, "DayBox", 0.5, 0, w, h, 0, 10, true, k);
		Card(dayBox, "Bg", { x: 0, y: 0, w, h, variant: "hud" });
		const iconSize = 28;
		const icon = makeFrame(dayBox, "SunMoon", space(3), (h - iconSize) / 2, iconSize, iconSize, GAME.sun, {
			radius: RADIUS.full,
			zIndex: 2,
		});
		addAspect(icon, 1);
		this.dayIcon = icon;
		const textX = space(3) + iconSize + space(3);
		const textW = w - textX - space(3);
		this.dayLabel = makeLabel(dayBox, "Day", "Day 1", textX, 5, textW, 26, TEXT.xl, THEME.foreground, {
			font: "heading",
			align: "left",
			zIndex: 2,
		});
		this.phaseLabel = makeLabel(dayBox, "Phase", "", textX, 29, textW, 18, TEXT.xs, THEME.mutedForeground, {
			font: "caption",
			align: "left",
			zIndex: 2,
		});
		this.clockLabel = makeLabel(dayBox, "Clock", "", textX, 29, textW, 18, TEXT.xs, THEME.mutedForeground, {
			mono: true,
			weight: Enum.FontWeight.Regular,
			align: "right",
			zIndex: 2,
		});
	}

	/** bottom-right (left of the fire button on touch): weapon name, magazine, reserve, reload progress */
	private buildWeapon(root: Frame, k: number, mobile: boolean): void {
		const w = 230;
		const h = 70;
		const weaponBox = makeAnchored(root, "WeaponBox", 1, 1, w, h, mobile ? 130 * k + 40 : 14, 14, false, k);
		Card(weaponBox, "Bg", { x: 0, y: 0, w, h, variant: "hud" });
		const pad = space(3);
		const innerW = w - pad * 2;
		const magW = 144;
		this.weaponLabel = makeLabel(weaponBox, "WeaponName", "", pad, 6, innerW, 18, TEXT.sm, THEME.mutedForeground, {
			font: "caption",
			align: "left",
			zIndex: 2,
		});
		this.magLabel = makeLabel(weaponBox, "Mag", "", pad, 24, magW, 32, TEXT.xl2, THEME.foreground, {
			font: "numeric",
			align: "left",
			zIndex: 2,
		});
		this.ammoLabel = makeLabel(
			weaponBox,
			"Pool",
			"",
			pad + magW,
			30,
			innerW - magW,
			24,
			TEXT.base,
			THEME.mutedForeground,
			{
				mono: true,
				align: "right",
				zIndex: 2,
			},
		);
		const reload = Progress(weaponBox, "Reload", {
			x: pad,
			y: 58,
			w: innerW,
			h: 6,
			color: GAME.success,
			value: 0,
			zIndex: 2,
		});
		reload.frame.Visible = false;
		this.reloadBar = reload;
	}

	/** touch: floating joystick, FIRE circle and the USE button (shown for actionable hints) */
	private buildTouch(root: Frame, k: number, mobile: boolean): void {
		const joySize = 140;
		const joyBase = makeFrame(root, "JoyBase", 110, 470, joySize, joySize, THEME.foreground, {
			transparency: TRANSPARENCY.touchIdle,
			radius: RADIUS.full,
			stroke: THEME.foreground,
			strokeTransparency: TRANSPARENCY.touchStroke,
		});
		joyBase.AnchorPoint = new Vector2(0.5, 0.5);
		addAspect(joyBase, 1);
		joyBase.Visible = mobile;
		this.joyBase = joyBase;
		const knobSize = 60;
		const joyKnob = makeFrame(joyBase, "JoyKnob", joySize / 2, joySize / 2, knobSize, knobSize, THEME.foreground, {
			transparency: TRANSPARENCY.touchKnob,
			radius: RADIUS.full,
		});
		joyKnob.AnchorPoint = new Vector2(0.5, 0.5);
		this.joyKnob = joyKnob;

		const fireSize = 130;
		const fireBox = makeAnchored(root, "FireBox", 1, 1, fireSize, fireSize, 24, 24, false, k);
		const fire = makeFrame(fireBox, "Fire", 0, 0, fireSize, fireSize, THEME.destructive, {
			radius: RADIUS.full,
			transparency: TRANSPARENCY.fireIdle,
			stroke: THEME.foreground,
			strokeTransparency: TRANSPARENCY.touchStroke,
		});
		makeLabel(fire, "FireTag", "FIRE", 0, 45, fireSize, 40, TEXT.lg, THEME.destructiveForeground, {
			weight: Enum.FontWeight.Bold,
			zIndex: 2,
		});
		fireBox.Visible = mobile;
		this.fireBtn = fire;

		const actionSize = 96;
		const actionBox = makeAnchored(
			root,
			"ActionBox",
			1,
			1,
			actionSize,
			actionSize,
			mobile ? 40 : 30,
			(mobile ? 130 : 70) * k + 40,
			false,
			k,
		);
		const action = Button(actionBox, "ActionBtn", "USE", {
			x: 0,
			y: 0,
			w: actionSize,
			h: actionSize,
			variant: "default",
			radius: RADIUS.full,
			font: "title",
			textSize: TEXT.xl,
			zIndex: 6,
			onClick: (): void => this.onAction?.(),
		});
		action.Visible = false;
		this.actionBtn = action;
	}

	/** interaction prompt ("E  Open door"), bottom centre */
	private buildHint(root: Frame, k: number): void {
		const w = 440;
		const h = 46;
		const hintBox = makeAnchored(root, "HintBox", 0.5, 1, w, h, 0, 96, false, k);
		const hintBg = Card(hintBox, "Bg", { x: 0, y: 0, w, h, variant: "popover", transparency: TRANSPARENCY.hud });
		const keySize = 32;
		const keyPad = (h - keySize) / 2;
		this.hintKey = Badge(hintBg, "Key", "E", {
			x: keyPad,
			y: keyPad,
			w: keySize,
			h: keySize,
			variant: "default",
			textSize: TEXT.lg,
			zIndex: 2,
		});
		const textX = keyPad + keySize + space(3);
		this.hintLabel = makeLabel(
			hintBg,
			"Text",
			"",
			textX,
			0,
			w - textX - space(4),
			h,
			TEXT.lg,
			THEME.popoverForeground,
			{
				font: "label",
				align: "left",
				zIndex: 2,
			},
		);
		hintBox.Visible = false;
		this.hintBox = hintBox;
	}

	/** banner (waves, morning, night, boss) as a bordered card + the feed of short messages below it */
	private buildMessages(root: Frame, k: number): void {
		const bannerBox = makeAnchored(root, "BannerBox", 0.5, 0, BANNER_W, BANNER_H, 0, 20 + 64 * k, true);
		// the card is resized to the message in showBanner; the texts stay centred over it
		const card = Card(bannerBox, "Card", { x: 0, y: 0, w: BANNER_W, h: BANNER_H, variant: "popover" });
		card.BackgroundTransparency = 1;
		const cardStroke = card.FindFirstChildOfClass("UIStroke");
		if (cardStroke !== undefined) cardStroke.Transparency = 1;
		this.bannerCard = card;
		const pad = space(6);
		const banner = makeLabel(
			bannerBox,
			"Banner",
			"",
			pad,
			space(3),
			BANNER_W - pad * 2,
			58,
			TEXT.xl5,
			THEME.foreground,
			{
				font: "display",
				zIndex: 2,
			},
		);
		banner.TextTransparency = 1;
		this.banner = banner;
		const sub = makeLabel(
			bannerBox,
			"BannerSub",
			"",
			pad,
			70,
			BANNER_W - pad * 2,
			28,
			TEXT.lg,
			THEME.mutedForeground,
			{
				font: "label",
				zIndex: 2,
			},
		);
		sub.TextTransparency = 1;
		this.bannerSub = sub;
		const scale = new Instance("UIScale");
		scale.Parent = bannerBox;
		this.bannerScale = scale;

		const feed = makeAnchored(root, "Feed", 0.5, 0, FEED_W, FEED_H, 0, 136 + 64 * k, true);
		const layout = new Instance("UIListLayout");
		layout.SortOrder = Enum.SortOrder.LayoutOrder;
		layout.HorizontalAlignment = Enum.HorizontalAlignment.Center;
		layout.Padding = new UDim(space(1.5) / FEED_H, 0);
		layout.Parent = feed;
		this.feed = feed;
	}

	private buildVignette(root: Frame): void {
		const edges: Array<[string, UDim2, UDim2, number]> = [
			["Top", UDim2.fromScale(0, 0), UDim2.fromScale(1, 0.3), 90],
			["Bottom", UDim2.fromScale(0, 0.7), UDim2.fromScale(1, 0.3), 270],
			["Left", UDim2.fromScale(0, 0), UDim2.fromScale(0.22, 1), 0],
			["Right", UDim2.fromScale(0.78, 0), UDim2.fromScale(0.22, 1), 180],
		];
		this.vignette = [];
		this.vignetteT = 1;
		for (const [name, pos, size, rotation] of edges) {
			const f = new Instance("Frame");
			f.Name = `Vignette${name}`;
			f.Position = pos;
			f.Size = size;
			f.BackgroundColor3 = GAME.blood;
			f.BackgroundTransparency = 1;
			f.BorderSizePixel = 0;
			f.Active = false;
			// game effect (not decoration): the red fades from the screen edge towards the centre
			const g = new Instance("UIGradient");
			g.Rotation = rotation;
			g.Transparency = new NumberSequence([new NumberSequenceKeypoint(0, 0), new NumberSequenceKeypoint(1, 1)]);
			g.Parent = f;
			f.Parent = root;
			this.vignette.push(f);
		}
	}

	unmount(): void {
		if (!this.mounted) return;
		this.mounted = false;
		this.root?.Destroy();
		this.root = undefined;
		this.hpBar = undefined;
		this.hungerBar = undefined;
		this.expBar = undefined;
		this.levelLabel = undefined;
		this.dayLabel = undefined;
		this.phaseLabel = undefined;
		this.clockLabel = undefined;
		this.dayIcon = undefined;
		this.weaponLabel = undefined;
		this.magLabel = undefined;
		this.ammoLabel = undefined;
		this.reloadBar = undefined;
		this.vignette = [];
		this.vignetteT = 1;
		this.feed = undefined;
		this.bannerCard = undefined;
		this.banner = undefined;
		this.bannerSub = undefined;
		this.bannerScale = undefined;
		this.joyBase = undefined;
		this.joyKnob = undefined;
		this.joyActive = undefined;
		this.fireBtn = undefined;
		this.fireHeld = undefined;
		this.actionBtn = undefined;
		this.hintBox = undefined;
		this.hintKey = undefined;
		this.hintLabel = undefined;
		this.flash = 0;
	}

	isMounted(): boolean {
		return this.mounted;
	}

	private phaseName(t: number): string {
		if (t >= 19 || t < 6) return this.tr("Night");
		if (t < 11) return this.tr("Morning");
		if (t < 16) return this.tr("Afternoon");
		return this.tr("Evening");
	}

	update(state: HudState): void {
		if (!this.mounted || this.root === undefined) return;
		const now = os.clock();

		// vitals
		const hpRatio = state.hpMax > 0 ? state.hp / state.hpMax : 0;
		this.setRatio(this.hpBar, "hp", hpRatio);
		this.setText(this.hpBar?.label, "hpText", `${math.max(0, math.ceil(state.hp))} / ${state.hpMax}`);
		const foodRatio = state.hungerMax > 0 ? state.hunger / state.hungerMax : 0;
		this.setRatio(this.hungerBar, "food", foodRatio);
		this.setText(this.hungerBar?.label, "foodText", `${math.clamp(math.floor(foodRatio * 100 + 0.5), 0, 100)}%`);
		// low HP: blinks hp <-> foreground; low food: blinks food <-> destructive (exact tokens, never blended)
		const wave = math.sin(now * 8);
		this.setFill(this.hpBar, hpRatio < 0.25 && wave > 0 ? THEME.foreground : GAME.hp);
		this.setFill(this.hungerBar, foodRatio < 0.15 && wave > 0 ? THEME.destructive : GAME.food);
		this.setRatio(this.expBar, "exp", state.expMax > 0 ? state.exp / state.expMax : 0);
		this.setText(this.levelLabel, "level", `LV ${state.level}`);

		// day / phase / clock
		this.setText(this.dayLabel, "day", `${this.tr("Day")} ${state.day}`);
		this.setText(this.phaseLabel, "phase", this.phaseName(state.dayTime));
		let clock = "";
		if (state.showClock) {
			const h = math.floor(state.dayTime) % 24;
			const m = math.floor((state.dayTime % 1) * 60);
			clock = string.format("%02d:%02d", h, m);
		}
		this.setText(this.clockLabel, "clock", clock);
		if (this.dayIcon !== undefined) {
			const c = state.isNight ? GAME.moon : GAME.sun;
			if (this.dayIcon.BackgroundColor3 !== c) this.dayIcon.BackgroundColor3 = c;
		}

		// weapon
		this.setText(this.weaponLabel, "weapon", state.weaponName);
		if (state.magSize <= 0) {
			this.setText(this.magLabel, "mag", this.tr("Melee"));
			this.setText(this.ammoLabel, "pool", "");
		} else if (state.reloading) {
			this.setText(this.magLabel, "mag", `${this.tr("Reloading")}...`);
			this.setText(this.ammoLabel, "pool", fmtInt(state.ammoPool));
		} else {
			this.setText(this.magLabel, "mag", `${state.mag} / ${state.magSize}`);
			this.setText(this.ammoLabel, "pool", fmtInt(state.ammoPool));
		}
		if (this.magLabel !== undefined) {
			const empty = state.magSize > 0 && state.mag <= 0 && !state.reloading;
			const c = empty ? THEME.destructive : THEME.foreground;
			if (this.magLabel.TextColor3 !== c) this.magLabel.TextColor3 = c;
		}
		if (this.reloadBar !== undefined) {
			if (this.reloadBar.frame.Visible !== state.reloading) this.reloadBar.frame.Visible = state.reloading;
			if (state.reloading) this.setRatio(this.reloadBar, "reload", state.reloadRatio);
		}

		// damage vignette: hit flash + a slow pulse when HP is low
		this.flash = math.max(0, this.flash - 1.6 / 60);
		let intensity = math.max(math.clamp(state.hitFlash, 0, 1) * 0.75, this.flash);
		if (hpRatio > 0 && hpRatio < 0.3) {
			const low = (0.3 - hpRatio) / 0.3;
			intensity = math.max(intensity, low * (0.3 + 0.15 * math.sin(now * 4)));
		}
		const transparency = 1 - math.clamp(intensity, 0, 0.9);
		if (transparency !== this.vignetteT) {
			this.vignetteT = transparency;
			for (const f of this.vignette) f.BackgroundTransparency = transparency;
		}

		// touch controls
		const ctx = this.ctx;
		const input = ctx.input;
		const touch = UserInputService.TouchEnabled;
		if (this.joyBase !== undefined && this.joyKnob !== undefined) {
			const active = input.joystickActive;
			if (active) {
				this.joyBase.Position = UDim2.fromScale(
					input.joystickBaseX / math.max(ctx.viewW, 1),
					input.joystickBaseY / math.max(ctx.viewH, 1),
				);
				const dx = (input.joystickX - input.joystickBaseX) / math.max(input.joystickRadius, 1);
				const dy = (input.joystickY - input.joystickBaseY) / math.max(input.joystickRadius, 1);
				this.joyKnob.Position = UDim2.fromScale(0.5 + dx * 0.35, 0.5 + dy * 0.35);
			}
			const visible = active || touch;
			if (this.joyBase.Visible !== visible) this.joyBase.Visible = visible;
			if (active !== this.joyActive) {
				this.joyActive = active;
				this.joyBase.BackgroundTransparency = active ? TRANSPARENCY.touchActive : TRANSPARENCY.touchIdle;
				if (!active) this.joyKnob.Position = CENTER;
			}
		}
		if (this.fireBtn !== undefined && input.attackHeld !== this.fireHeld) {
			this.fireHeld = input.attackHeld;
			this.fireBtn.BackgroundTransparency = input.attackHeld ? TRANSPARENCY.fireHeld : TRANSPARENCY.fireIdle;
		}
	}

	/** gameplay announcement: waves / morning / night / boss as a banner, the rest in the feed */
	showMessage(text: string): void {
		const kind = classify(text);
		const shown = this.tr(text);
		if (kind === "wave") {
			this.showBanner(shown, THEME.destructive, this.tr("Zombies are coming"));
		} else if (kind === "night") {
			this.showBanner(shown, GAME.moon, this.tr("Survive the night"));
		} else if (kind === "morning") {
			this.showBanner(shown, GAME.sun, "");
		} else if (kind === "boss") {
			this.showBanner(shown, GAME.rare, "");
		} else {
			this.pushFeed(
				shown,
				kind === "level" ? GAME.xp : kind === "warn" ? THEME.destructive : THEME.popoverForeground,
			);
		}
	}

	private showBanner(text: string, color: Color3, subText: string): void {
		const card = this.bannerCard;
		const banner = this.banner;
		const sub = this.bannerSub;
		const scale = this.bannerScale;
		if (card === undefined || banner === undefined || sub === undefined || scale === undefined) return;
		const gen = ++this.bannerGen;
		banner.Text = text;
		banner.TextColor3 = color;
		sub.Text = subText;
		// fit the card to the message (estimated width; TextScaled shrinks anything longer)
		const textW = math.max(badgeWidth(text, TEXT.xl5, 0), subText === "" ? 0 : badgeWidth(subText, TEXT.lg, 0));
		const w = math.clamp(textW + space(12), BANNER_MIN_W, BANNER_W);
		const h = subText === "" ? 70 + space(3) : BANNER_H;
		card.Position = UDim2.fromScale((BANNER_W - w) / 2 / BANNER_W, 0);
		card.Size = UDim2.fromScale(w / BANNER_W, h / BANNER_H);
		const stroke = card.FindFirstChildOfClass("UIStroke");
		card.BackgroundTransparency = 1;
		if (stroke !== undefined) stroke.Transparency = 1;
		banner.TextTransparency = 1;
		sub.TextTransparency = 1;
		scale.Scale = 1.2;
		tween(card, 0.2, { BackgroundTransparency: TRANSPARENCY.hud });
		if (stroke !== undefined) tween(stroke, 0.2, { Transparency: 0 });
		tween(banner, 0.25, { TextTransparency: 0 });
		tween(sub, 0.35, { TextTransparency: 0 });
		tween(scale, 0.3, { Scale: 1 });
		task.delay(2.6, () => {
			if (gen !== this.bannerGen || banner.Parent === undefined) return;
			tween(card, 0.5, { BackgroundTransparency: 1 });
			if (stroke !== undefined) tween(stroke, 0.5, { Transparency: 1 });
			tween(banner, 0.5, { TextTransparency: 1 });
			tween(sub, 0.5, { TextTransparency: 1 });
		});
	}

	/** toast-like line (small HUD card) under the banner; repeated messages refresh instead of stacking */
	private pushFeed(text: string, color: Color3): void {
		const feed = this.feed;
		if (feed === undefined) return;
		const entries: Array<Frame> = [];
		for (const child of feed.GetChildren()) {
			if (!child.IsA("Frame")) continue;
			if (child.GetAttribute("Text") === text) {
				// repeated message: refresh the existing line instead of stacking copies
				child.SetAttribute("Born", os.clock());
				child.LayoutOrder = ++this.feedOrder;
				return;
			}
			entries.push(child);
		}
		entries.sort((a, b) => a.LayoutOrder < b.LayoutOrder);
		while (entries.size() >= FEED_MAX) entries.remove(0)?.Destroy();
		const w = math.clamp(badgeWidth(text, TEXT.base, FEED_LINE_H) + space(6), FEED_LINE_MIN_W, FEED_W);
		const line = Card(feed, "Line", {
			x: 0,
			y: 0,
			w,
			h: FEED_LINE_H,
			variant: "popover",
			transparency: TRANSPARENCY.hud,
		});
		line.LayoutOrder = ++this.feedOrder;
		line.SetAttribute("Text", text);
		line.SetAttribute("Born", os.clock());
		const label = makeLabel(line, "Text", text, space(4), 0, w - space(8), FEED_LINE_H, TEXT.base, color, {
			font: "label",
			zIndex: 2,
		});
		const stroke = line.FindFirstChildOfClass("UIStroke");
		// enter: fade in
		line.BackgroundTransparency = 1;
		label.TextTransparency = 1;
		if (stroke !== undefined) stroke.Transparency = 1;
		tween(line, 0.2, { BackgroundTransparency: TRANSPARENCY.hud });
		tween(label, 0.2, { TextTransparency: 0 });
		if (stroke !== undefined) tween(stroke, 0.2, { Transparency: 0 });
		task.spawn(() => {
			while (line.Parent !== undefined) {
				const born = line.GetAttribute("Born");
				if (typeIs(born, "number") && os.clock() - born >= FEED_TIME) break;
				task.wait(0.25);
			}
			if (line.Parent === undefined) return;
			// fading out: the same message arriving now gets a fresh line instead of refreshing this one
			line.SetAttribute("Text", undefined);
			tween(line, 0.4, { BackgroundTransparency: 1 });
			tween(label, 0.4, { TextTransparency: 1 });
			if (stroke !== undefined) tween(stroke, 0.4, { Transparency: 1 });
			task.wait(0.4);
			line.Destroy();
		});
	}

	/**
	 * Interaction prompt from the game ("E: Open door", "Repair: needs Wood"...). Hints starting with
	 * "E: " are actions: keyboard players see the E key badge, touch players get the USE button.
	 */
	setInteractHint(text: string | undefined): void {
		const box = this.hintBox;
		const btn = this.actionBtn;
		if (box === undefined || btn === undefined) return;
		if (text === undefined || text === "") {
			if (box.Visible) box.Visible = false;
			if (btn.Visible) btn.Visible = false;
			return;
		}
		const actionable = text.sub(1, 3) === "E: ";
		const touch = UserInputService.TouchEnabled;
		if (!box.Visible) box.Visible = true;
		if (this.hintKey !== undefined) this.hintKey.Visible = actionable && !touch;
		this.setText(this.hintLabel, "hint", actionable ? text.sub(4) : text);
		const showBtn = actionable && touch;
		if (btn.Visible !== showBtn) btn.Visible = showBtn;
	}

	/** extra red flash (e.g. explosions); the regular hit flash comes from HudState.hitFlash */
	showDamage(alpha: number): void {
		this.flash = math.max(this.flash, math.clamp(alpha, 0, 0.85));
	}
}
