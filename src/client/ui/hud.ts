import { GameContext } from "shared/game/context";
import { COLORS } from "shared/engine/colors";
import { makeFrame, makeLabel, makeButton, makeBar, Bar } from "./widgets";

export interface HudState {
	hp: number;
	hpMax: number;
	hunger: number;
	hungerMax: number;
	level: number;
	exp: number;
	expMax: number;
	day: number;
	weaponName: string;
	mag: number;
	magSize: number;
	reloadRatio: number;
	ammoPool: number;
}

export class Hud {
	onPause: (() => void) | undefined;
	onBackpack: (() => void) | undefined;

	private ctx: GameContext;
	private root: Frame | undefined;
	private hpBar: Bar | undefined;
	private hungerBar: Bar | undefined;
	private expBar: Bar | undefined;
	private levelLabel: TextLabel | undefined;
	private dayLabel: TextLabel | undefined;
	private magLabel: TextLabel | undefined;
	private ammoLabel: TextLabel | undefined;
	private reloadBar: Bar | undefined;
	private weaponLabel: TextLabel | undefined;
	private vignette: Frame | undefined;
	private messageBox: Frame | undefined;
	private joyBase: Frame | undefined;
	private joyKnob: Frame | undefined;
	private fireBtn: Frame | undefined;
	private actionBtn: TextButton | undefined;
	private actionLabel: TextLabel | undefined;
	private blinkTime = 0;
	private mounted = false;

	constructor(ctx: GameContext) {
		this.ctx = ctx;
	}

	mount(): void {
		if (this.mounted) return;
		this.mounted = true;
		const ctx = this.ctx;
		const root = makeFrame(ctx.hudLayer, "HudRoot", 0, 0, 1120, 630, COLORS.bg, { transparency: 1 });
		this.root = root;

		const vignette = makeFrame(root, "Vignette", 0, 0, 1120, 630, Color3.fromRGB(180, 20, 30), { transparency: 1 });
		this.vignette = vignette;

		const pauseBtn = makeButton(root, "Pause", "II", 8, 8, 44, 44, COLORS.uiPanelLight, (): void => {
			if (this.onPause !== undefined) this.onPause();
		});
		pauseBtn.ZIndex = 5;

		const dayFrame = makeFrame(root, "DayFrame", 470, 8, 180, 44, Color3.fromRGB(40, 40, 48), {
			transparency: 0.25,
		});
		const clockIcon = makeFrame(dayFrame, "Clock", 8, 8, 28, 28, COLORS.uiYellow);
		clockIcon.ZIndex = 2;
		const dayLabel = makeLabel(dayFrame, "Day", "Day 1", 42, 6, 130, 32, 20, COLORS.uiText);
		dayLabel.TextXAlignment = Enum.TextXAlignment.Left;
		dayLabel.ZIndex = 2;
		this.dayLabel = dayLabel;

		makeLabel(root, "HpIcon", "HP", 12, 62, 36, 22, 14, COLORS.uiRed);
		const hpBar = makeBar(root, "HpBar", 54, 64, 220, 18, COLORS.uiRed);
		this.hpBar = hpBar;
		makeLabel(root, "HungerIcon", "FD", 12, 90, 36, 22, 14, COLORS.uiYellow);
		const hungerBar = makeBar(root, "HungerBar", 54, 92, 220, 18, COLORS.uiYellow);
		this.hungerBar = hungerBar;
		const expBar = makeBar(root, "ExpBar", 54, 120, 220, 12, COLORS.uiBlue);
		this.expBar = expBar;
		const levelLabel = makeLabel(root, "Level", "LV 1", 282, 114, 90, 24, 16, COLORS.uiTextDim);
		levelLabel.TextXAlignment = Enum.TextXAlignment.Left;
		this.levelLabel = levelLabel;

		const bagBtn = makeButton(root, "Backpack", "BAG", 668, 8, 56, 44, COLORS.uiPanelLight, (): void => {
			if (this.onBackpack !== undefined) this.onBackpack();
		});
		bagBtn.ZIndex = 5;

		const panel = makeFrame(root, "WeaponPanel", 860, 540, 244, 84, Color3.fromRGB(30, 30, 38), {
			transparency: 0.15,
		});
		const weaponLabel = makeLabel(panel, "WeaponName", "", 10, 6, 224, 24, 15, COLORS.uiTextDim);
		weaponLabel.ZIndex = 2;
		this.weaponLabel = weaponLabel;
		const magLabel = makeLabel(panel, "Mag", "0 / 0", 10, 32, 120, 30, 22, COLORS.uiText);
		magLabel.TextXAlignment = Enum.TextXAlignment.Left;
		magLabel.ZIndex = 2;
		this.magLabel = magLabel;
		const ammoLabel = makeLabel(panel, "Pool", "0", 140, 34, 94, 26, 18, COLORS.uiYellow);
		ammoLabel.TextXAlignment = Enum.TextXAlignment.Right;
		ammoLabel.ZIndex = 2;
		this.ammoLabel = ammoLabel;
		const reloadBar = makeBar(panel, "Reload", 10, 66, 224, 10, COLORS.uiGreen);
		reloadBar.setRatio(0);
		reloadBar.frame.ZIndex = 2;
		reloadBar.fill.ZIndex = 3;
		this.reloadBar = reloadBar;

		const mobile = game.GetService("UserInputService").TouchEnabled;
		const joyAlpha = mobile ? 0.35 : 1;
		const joyBase = makeFrame(root, "JoyBase", 100, 430, 130, 130, Color3.fromRGB(200, 200, 200), {
			transparency: 1 - 0.35 * joyAlpha,
		});
		joyBase.AnchorPoint = new Vector2(0.5, 0.5);
		joyBase.Visible = mobile;
		this.joyBase = joyBase;
		const joyKnob = makeFrame(joyBase, "JoyKnob", 65, 65, 56, 56, Color3.fromRGB(230, 230, 230), {
			transparency: 0.55,
		});
		joyKnob.AnchorPoint = new Vector2(0.5, 0.5);
		this.joyKnob = joyKnob;

		const fireBtn = makeFrame(root, "FireBtn", 1010, 500, 96, 96, COLORS.uiRed, {
			transparency: mobile ? 0.45 : 1,
		});
		fireBtn.AnchorPoint = new Vector2(0.5, 0.5);
		fireBtn.Visible = mobile;
		const fireTag = makeLabel(fireBtn, "FireTag", "FIRE", 0, 34, 96, 28, 16, Color3.fromRGB(255, 240, 240));
		fireTag.ZIndex = 2;
		this.fireBtn = fireBtn;

		const actionBtn = new Instance("TextButton");
		actionBtn.Name = "ActionBtn";
		actionBtn.Position = UDim2.fromScale(890 / 1120, 470 / 630);
		actionBtn.Size = UDim2.fromScale(76 / 1120, 76 / 630);
		actionBtn.BackgroundColor3 = COLORS.uiAccent;
		actionBtn.BorderSizePixel = 0;
		actionBtn.Text = "";
		actionBtn.Visible = false;
		actionBtn.ZIndex = 6;
		actionBtn.Parent = root;
		this.actionBtn = actionBtn;
		const actionLabel = makeLabel(actionBtn, "ActionText", "E", 0, 18, 76, 40, 24, Color3.fromRGB(30, 30, 30));
		actionLabel.ZIndex = 7;
		this.actionLabel = actionLabel;

		const messageBox = makeFrame(root, "Messages", 310, 170, 500, 200, COLORS.bg, { transparency: 1 });
		this.messageBox = messageBox;
	}

	unmount(): void {
		if (!this.mounted) return;
		this.mounted = false;
		if (this.root !== undefined) this.root.Destroy();
		this.root = undefined;
		this.hpBar = undefined;
		this.hungerBar = undefined;
		this.expBar = undefined;
		this.levelLabel = undefined;
		this.dayLabel = undefined;
		this.magLabel = undefined;
		this.ammoLabel = undefined;
		this.reloadBar = undefined;
		this.weaponLabel = undefined;
		this.vignette = undefined;
		this.messageBox = undefined;
		this.joyBase = undefined;
		this.joyKnob = undefined;
		this.fireBtn = undefined;
		this.actionBtn = undefined;
		this.actionLabel = undefined;
	}

	update(state: HudState): void {
		if (!this.mounted || this.root === undefined) return;
		const ctx = this.ctx;
		if (this.hpBar !== undefined) this.hpBar.setRatio(state.hpMax > 0 ? state.hp / state.hpMax : 0);
		if (this.hungerBar !== undefined) {
			this.hungerBar.setRatio(state.hungerMax > 0 ? state.hunger / state.hungerMax : 0);
		}
		if (this.expBar !== undefined) this.expBar.setRatio(state.expMax > 0 ? state.exp / state.expMax : 0);
		if (this.levelLabel !== undefined) this.levelLabel.Text = `LV ${state.level}`;
		if (this.dayLabel !== undefined) this.dayLabel.Text = `Day ${state.day}`;
		if (this.weaponLabel !== undefined) this.weaponLabel.Text = state.weaponName;
		if (this.magLabel !== undefined) {
			this.magLabel.Text = state.magSize > 0 ? `${state.mag} / ${state.magSize}` : "--";
		}
		if (this.ammoLabel !== undefined) this.ammoLabel.Text = `${state.ammoPool}`;
		if (this.reloadBar !== undefined) this.reloadBar.setRatio(state.reloadRatio);

		this.blinkTime = os.clock();
		if (this.hungerBar !== undefined) {
			if (state.hunger < 5) {
				const pulse = 0.5 + 0.5 * math.sin(this.blinkTime * 8);
				this.hungerBar.frame.BackgroundTransparency = 0.4 * pulse;
				this.hungerBar.fill.BackgroundTransparency = 0.3 * (1 - pulse);
			} else {
				this.hungerBar.frame.BackgroundTransparency = 0;
				this.hungerBar.fill.BackgroundTransparency = 0;
			}
		}

		const input = ctx.input;
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
				this.joyBase.BackgroundTransparency = 0.55;
			} else if (game.GetService("UserInputService").TouchEnabled) {
				this.joyBase.Visible = true;
				this.joyBase.BackgroundTransparency = 0.75;
				this.joyKnob.Position = UDim2.fromScale(0.5, 0.5);
			} else {
				this.joyBase.Visible = false;
			}
		}
		if (this.fireBtn !== undefined) {
			this.fireBtn.Visible = game.GetService("UserInputService").TouchEnabled;
			this.fireBtn.BackgroundTransparency = input.attackHeld ? 0.25 : 0.55;
		}
	}

	showMessage(text: string): void {
		const box = this.messageBox;
		if (box === undefined) return;
		const label = makeLabel(box, "Msg", text, 0, 0, 500, 26, 18, COLORS.uiText);
		label.BackgroundTransparency = 1;
		label.TextTransparency = 0;
		label.ZIndex = 20;
		const kids = box.GetChildren();
		let index = 0;
		for (const kid of kids) {
			if (kid.IsA("TextLabel")) {
				kid.Position = new UDim2(0, 0, 0, index * 30);
				kid.TextTransparency = math.min(index * 0.18, 0.8);
				index++;
			}
		}
		const TweenService = game.GetService("TweenService");
		task.delay(3, (): void => {
			if (label.Parent !== undefined) {
				const tween = TweenService.Create(
					label,
					new TweenInfo(0.5, Enum.EasingStyle.Quad, Enum.EasingDirection.In),
					{ TextTransparency: 1 },
				);
				tween.Play();
				tween.Completed.Wait();
				label.Destroy();
			}
		});
	}

	setInteractHint(text: string | undefined): void {
		const btn = this.actionBtn;
		const lbl = this.actionLabel;
		if (btn === undefined || lbl === undefined) return;
		if (text === undefined) {
			btn.Visible = false;
			return;
		}
		btn.Visible = true;
		lbl.Text = text.size() > 1 ? text : "E";
		if (text.size() > 1) lbl.TextSize = 14;
		else lbl.TextSize = 24;
	}

	showDamage(alpha: number): void {
		const v = this.vignette;
		if (v === undefined) return;
		const TweenService = game.GetService("TweenService");
		const target = 1 - math.clamp(alpha, 0, 0.85);
		v.BackgroundTransparency = target;
		TweenService.Create(v, new TweenInfo(0.6, Enum.EasingStyle.Quad, Enum.EasingDirection.Out), {
			BackgroundTransparency: 1,
		}).Play();
	}
}
