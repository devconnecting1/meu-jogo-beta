import { GameContext } from "shared/game/context";
import { langGet } from "shared/data/lang";
import {
	Bar,
	FONTS,
	PALETTE,
	addAspect,
	fmtInt,
	makeAnchored,
	makeBar,
	makeButton,
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
	private dayIcon: Frame | undefined;
	private weaponLabel: TextLabel | undefined;
	private magLabel: TextLabel | undefined;
	private ammoLabel: TextLabel | undefined;
	private reloadBar: Bar | undefined;
	private vignette: Array<Frame> = [];
	private flash = 0;
	private feed: Frame | undefined;
	private banner: TextLabel | undefined;
	private bannerSub: TextLabel | undefined;
	private bannerScale: UIScale | undefined;
	private bannerGen = 0;
	private feedOrder = 0;
	private joyBase: Frame | undefined;
	private joyKnob: Frame | undefined;
	private fireBtn: Frame | undefined;
	private actionBtn: TextButton | undefined;
	private hintBox: Frame | undefined;
	private hintKey: Frame | undefined;
	private hintLabel: TextLabel | undefined;
	private mounted = false;
	private last = new Map<string, string>();

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

	mount(): void {
		if (this.mounted) return;
		this.mounted = true;
		this.last.clear();
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

		// ---- top-left: pause + vitals
		const status = makeAnchored(root, "Status", 0, 0, 350, 92, 14, 10, true, k);
		const pauseBtn = makeButton(status, "Pause", "II", 0, 0, 56, 56, "secondary", (): void => this.onPause?.(), {
			textSize: 22,
			font: FONTS.display,
		});
		pauseBtn.ZIndex = 5;
		const vitals = makeFrame(status, "Vitals", 66, 0, 284, 92, PALETTE.surface, {
			radius: 12,
			transparency: 0.35,
			stroke: PALETTE.strokeSoft,
			strokeTransparency: 0.4,
		});
		makeLabel(vitals, "HpTag", "HP", 10, 8, 40, 20, 13, PALETTE.hp, { font: FONTS.bold, align: "left" });
		this.hpBar = makeBar(vitals, "HpBar", 52, 8, 222, 20, PALETTE.hp, { label: true, textSize: 13 });
		makeLabel(vitals, "FoodTag", "FOOD", 10, 36, 40, 20, 11, PALETTE.hunger, { font: FONTS.bold, align: "left" });
		this.hungerBar = makeBar(vitals, "FoodBar", 52, 36, 222, 20, PALETTE.hunger, { label: true, textSize: 13 });
		this.levelLabel = makeLabel(vitals, "Level", "LV 1", 10, 64, 40, 20, 12, PALETTE.exp, {
			font: FONTS.bold,
			align: "left",
		});
		this.expBar = makeBar(vitals, "ExpBar", 52, 69, 222, 10, PALETTE.exp);

		// ---- top-centre: day + phase (+ clock with a watch)
		const dayBox = makeAnchored(root, "DayBox", 0.5, 0, 230, 52, 0, 10, true, k);
		makeFrame(dayBox, "Bg", 0, 0, 230, 52, PALETTE.surface, {
			radius: 26,
			transparency: 0.3,
			stroke: PALETTE.strokeSoft,
			strokeTransparency: 0.4,
		});
		const icon = makeFrame(dayBox, "SunMoon", 14, 12, 28, 28, PALETTE.accent, { radius: 14, zIndex: 2 });
		addAspect(icon, 1);
		this.dayIcon = icon;
		this.dayLabel = makeLabel(dayBox, "Day", "Day 1", 52, 5, 166, 26, 20, PALETTE.text, {
			font: FONTS.bold,
			align: "left",
			zIndex: 2,
		});
		this.phaseLabel = makeLabel(dayBox, "Phase", "", 52, 29, 166, 18, 13, PALETTE.textDim, {
			align: "left",
			zIndex: 2,
		});

		// ---- top-right: backpack
		const bagBox = makeAnchored(root, "BagBox", 1, 0, 132, 56, 14, 10, true, k);
		makeButton(bagBox, "Backpack", mobile ? "BAG" : "BAG  (B)", 0, 0, 132, 56, "secondary", (): void =>
			this.onBackpack?.(),
		);

		// ---- bottom-right (left of the fire button on touch): weapon, compact and translucent
		const weaponBox = makeAnchored(root, "WeaponBox", 1, 1, 230, 70, mobile ? 130 * k + 40 : 14, 14, false, k);
		makeFrame(weaponBox, "Bg", 0, 0, 230, 70, PALETTE.surface, {
			radius: 12,
			transparency: 0.45,
			stroke: PALETTE.strokeSoft,
			strokeTransparency: 0.5,
		});
		this.weaponLabel = makeLabel(weaponBox, "WeaponName", "", 12, 6, 206, 20, 14, PALETTE.textDim, {
			align: "left",
			zIndex: 2,
		});
		this.magLabel = makeLabel(weaponBox, "Mag", "", 12, 26, 130, 30, 24, PALETTE.text, {
			font: FONTS.bold,
			align: "left",
			zIndex: 2,
		});
		this.ammoLabel = makeLabel(weaponBox, "Pool", "", 140, 30, 78, 24, 16, PALETTE.coin, {
			font: FONTS.bold,
			align: "right",
			zIndex: 2,
		});
		const reload = makeBar(weaponBox, "Reload", 12, 58, 206, 6, PALETTE.success);
		reload.frame.ZIndex = 2;
		reload.setRatio(0);
		reload.frame.Visible = false;
		this.reloadBar = reload;

		// ---- touch controls
		const joyBase = makeFrame(root, "JoyBase", 110, 470, 140, 140, PALETTE.text, {
			transparency: 0.8,
			radius: 70,
			stroke: PALETTE.text,
			strokeTransparency: 0.6,
		});
		joyBase.AnchorPoint = new Vector2(0.5, 0.5);
		addAspect(joyBase, 1);
		joyBase.Visible = mobile;
		this.joyBase = joyBase;
		const joyKnob = makeFrame(joyBase, "JoyKnob", 70, 70, 60, 60, PALETTE.text, { transparency: 0.45, radius: 30 });
		joyKnob.AnchorPoint = new Vector2(0.5, 0.5);
		this.joyKnob = joyKnob;

		const fireBox = makeAnchored(root, "FireBox", 1, 1, 130, 130, 24, 24, false, k);
		const fire = makeFrame(fireBox, "Fire", 0, 0, 130, 130, PALETTE.danger, {
			radius: 65,
			transparency: 0.45,
			stroke: lightStroke(),
			strokeTransparency: 0.5,
		});
		makeLabel(fire, "FireTag", "FIRE", 0, 45, 130, 40, 18, PALETTE.text, { font: FONTS.bold, zIndex: 2 });
		fireBox.Visible = mobile;
		this.fireBtn = fire;

		const actionBox = makeAnchored(
			root,
			"ActionBox",
			1,
			1,
			96,
			96,
			mobile ? 40 : 30,
			(mobile ? 130 : 70) * k + 40,
			false,
			k,
		);
		const action = makeButton(
			actionBox,
			"ActionBtn",
			"USE",
			0,
			0,
			96,
			96,
			"primary",
			(): void => this.onAction?.(),
			{
				radius: 48,
				textSize: 20,
			},
		);
		action.ZIndex = 6;
		action.Visible = false;
		this.actionBtn = action;

		// ---- interaction prompt ("E  Open door"), bottom centre
		const hintBox = makeAnchored(root, "HintBox", 0.5, 1, 440, 46, 0, 96, false, k);
		const hintBg = makeFrame(hintBox, "Bg", 0, 0, 440, 46, PALETTE.surface, {
			radius: 23,
			transparency: 0.2,
			stroke: PALETTE.accent,
			strokeTransparency: 0.55,
		});
		const hintKey = makeFrame(hintBg, "Key", 8, 7, 32, 32, PALETTE.accent, { radius: 8, zIndex: 2 });
		makeLabel(hintKey, "Glyph", "E", 0, 0, 32, 32, 18, PALETTE.textOnAccent, { font: FONTS.display, zIndex: 3 });
		this.hintKey = hintKey;
		this.hintLabel = makeLabel(hintBg, "Text", "", 50, 0, 374, 46, 17, PALETTE.text, {
			font: FONTS.medium,
			align: "left",
			zIndex: 2,
		});
		hintBox.Visible = false;
		this.hintBox = hintBox;

		// ---- messages: banner (waves, morning, boss) + feed
		const bannerBox = makeAnchored(root, "BannerBox", 0.5, 0, 720, 110, 0, 20 + 64 * k, true);
		const banner = makeLabel(bannerBox, "Banner", "", 0, 0, 720, 70, 52, PALETTE.text, { font: FONTS.display });
		banner.TextStrokeTransparency = 0.35;
		banner.TextStrokeColor3 = PALETTE.overlay;
		banner.TextTransparency = 1;
		const scale = new Instance("UIScale");
		scale.Parent = banner;
		this.banner = banner;
		this.bannerScale = scale;
		const sub = makeLabel(bannerBox, "BannerSub", "", 0, 70, 720, 32, 20, PALETTE.textDim, { font: FONTS.medium });
		sub.TextStrokeTransparency = 0.5;
		sub.TextTransparency = 1;
		this.bannerSub = sub;

		const feed = makeAnchored(root, "Feed", 0.5, 0, 560, 176, 0, 136 + 64 * k, true);
		const layout = new Instance("UIListLayout");
		layout.SortOrder = Enum.SortOrder.LayoutOrder;
		layout.HorizontalAlignment = Enum.HorizontalAlignment.Center;
		layout.Padding = new UDim(0.03, 0);
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
		for (const [name, pos, size, rotation] of edges) {
			const f = new Instance("Frame");
			f.Name = `Vignette${name}`;
			f.Position = pos;
			f.Size = size;
			f.BackgroundColor3 = PALETTE.blood;
			f.BackgroundTransparency = 1;
			f.BorderSizePixel = 0;
			f.Active = false;
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
		this.dayIcon = undefined;
		this.weaponLabel = undefined;
		this.magLabel = undefined;
		this.ammoLabel = undefined;
		this.reloadBar = undefined;
		this.vignette = [];
		this.feed = undefined;
		this.banner = undefined;
		this.bannerSub = undefined;
		this.bannerScale = undefined;
		this.joyBase = undefined;
		this.joyKnob = undefined;
		this.fireBtn = undefined;
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
		this.hpBar?.setRatio(hpRatio);
		this.hpBar?.setText(`${math.max(0, math.ceil(state.hp))} / ${state.hpMax}`);
		const foodRatio = state.hungerMax > 0 ? state.hunger / state.hungerMax : 0;
		this.hungerBar?.setRatio(foodRatio);
		this.hungerBar?.setText(`${math.clamp(math.floor(foodRatio * 100 + 0.5), 0, 100)}%`);
		const pulse = 0.5 + 0.5 * math.sin(now * 8);
		this.hpBar?.setColor(hpRatio < 0.25 ? PALETTE.hp.Lerp(PALETTE.text, 0.35 * pulse) : PALETTE.hp);
		this.hungerBar?.setColor(foodRatio < 0.15 ? PALETTE.hunger.Lerp(PALETTE.danger, pulse) : PALETTE.hunger);
		this.expBar?.setRatio(state.expMax > 0 ? state.exp / state.expMax : 0);
		this.setText(this.levelLabel, "level", `LV ${state.level}`);

		// day / phase / clock
		this.setText(this.dayLabel, "day", `${this.tr("Day")} ${state.day}`);
		let phase = this.phaseName(state.dayTime);
		if (state.showClock) {
			const h = math.floor(state.dayTime) % 24;
			const m = math.floor((state.dayTime % 1) * 60);
			phase = `${phase}  ·  ${string.format("%02d:%02d", h, m)}`;
		}
		this.setText(this.phaseLabel, "phase", phase);
		if (this.dayIcon !== undefined) {
			const c = state.isNight ? PALETTE.info : PALETTE.accent;
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
			this.magLabel.TextColor3 = empty ? PALETTE.danger : PALETTE.text;
		}
		if (this.reloadBar !== undefined) {
			this.reloadBar.frame.Visible = state.reloading;
			this.reloadBar.setRatio(state.reloadRatio);
		}

		// damage vignette: hit flash + a slow pulse when HP is low
		this.flash = math.max(0, this.flash - 1.6 / 60);
		let intensity = math.max(math.clamp(state.hitFlash, 0, 1) * 0.75, this.flash);
		if (hpRatio > 0 && hpRatio < 0.3) {
			const low = (0.3 - hpRatio) / 0.3;
			intensity = math.max(intensity, low * (0.3 + 0.15 * math.sin(now * 4)));
		}
		const transparency = 1 - math.clamp(intensity, 0, 0.9);
		for (const f of this.vignette) f.BackgroundTransparency = transparency;

		// touch controls
		const ctx = this.ctx;
		const input = ctx.input;
		const touch = UserInputService.TouchEnabled;
		if (this.joyBase !== undefined && this.joyKnob !== undefined) {
			if (input.joystickActive) {
				this.joyBase.Visible = true;
				this.joyBase.Position = UDim2.fromScale(
					input.joystickBaseX / math.max(ctx.viewW, 1),
					input.joystickBaseY / math.max(ctx.viewH, 1),
				);
				const dx = (input.joystickX - input.joystickBaseX) / math.max(input.joystickRadius, 1);
				const dy = (input.joystickY - input.joystickBaseY) / math.max(input.joystickRadius, 1);
				this.joyKnob.Position = UDim2.fromScale(0.5 + dx * 0.35, 0.5 + dy * 0.35);
				this.joyBase.BackgroundTransparency = 0.7;
			} else {
				this.joyBase.Visible = touch;
				this.joyBase.BackgroundTransparency = 0.85;
				this.joyKnob.Position = UDim2.fromScale(0.5, 0.5);
			}
		}
		if (this.fireBtn !== undefined) {
			this.fireBtn.BackgroundTransparency = input.attackHeld ? 0.2 : 0.45;
		}
	}

	/** gameplay announcement: waves / morning / boss as a banner, the rest in the feed */
	showMessage(text: string): void {
		const kind = classify(text);
		const shown = this.tr(text);
		if (kind === "wave") {
			this.showBanner(shown, PALETTE.danger, this.tr("Zombies are coming"));
		} else if (kind === "night") {
			this.showBanner(shown, PALETTE.info, this.tr("Survive the night"));
		} else if (kind === "morning") {
			this.showBanner(shown, PALETTE.accent, "");
		} else if (kind === "boss") {
			this.showBanner(shown, PALETTE.success, "");
		} else {
			this.pushFeed(shown, kind === "level" ? PALETTE.exp : kind === "warn" ? PALETTE.danger : PALETTE.text);
		}
	}

	private showBanner(text: string, color: Color3, subText: string): void {
		const banner = this.banner;
		const sub = this.bannerSub;
		const scale = this.bannerScale;
		if (banner === undefined || sub === undefined || scale === undefined) return;
		const gen = ++this.bannerGen;
		banner.Text = text;
		banner.TextColor3 = color;
		sub.Text = subText;
		banner.TextTransparency = 1;
		sub.TextTransparency = 1;
		scale.Scale = 1.25;
		tween(banner, 0.25, { TextTransparency: 0 });
		tween(sub, 0.35, { TextTransparency: 0.1 });
		tween(scale, 0.3, { Scale: 1 });
		task.delay(2.6, () => {
			if (gen !== this.bannerGen || banner.Parent === undefined) return;
			tween(banner, 0.5, { TextTransparency: 1 });
			tween(sub, 0.5, { TextTransparency: 1 });
		});
	}

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
		const line = makeFrame(feed, "Line", 0, 0, 560, 38, PALETTE.overlay, { transparency: 0.35, radius: 19 });
		line.LayoutOrder = ++this.feedOrder;
		line.SetAttribute("Text", text);
		line.SetAttribute("Born", os.clock());
		const g = new Instance("UIGradient");
		g.Transparency = new NumberSequence([
			new NumberSequenceKeypoint(0, 1),
			new NumberSequenceKeypoint(0.2, 0.2),
			new NumberSequenceKeypoint(0.8, 0.2),
			new NumberSequenceKeypoint(1, 1),
		]);
		g.Parent = line;
		const label = makeLabel(line, "Text", text, 20, 0, 520, 38, 18, color, { font: FONTS.bold, zIndex: 2 });
		label.TextStrokeTransparency = 0.6;
		task.spawn(() => {
			while (line.Parent !== undefined) {
				const born = line.GetAttribute("Born");
				if (typeIs(born, "number") && os.clock() - born >= FEED_TIME) break;
				task.wait(0.25);
			}
			if (line.Parent === undefined) return;
			tween(line, 0.4, { BackgroundTransparency: 1 });
			tween(label, 0.4, { TextTransparency: 1, TextStrokeTransparency: 1 });
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

function lightStroke(): Color3 {
	return PALETTE.danger.Lerp(new Color3(1, 1, 1), 0.3);
}
