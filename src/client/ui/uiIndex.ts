// UI barrel: design system (theme), kit (widgets) and screens
export { THEME, SIDEBAR, GAME, TRANSPARENCY, SPACING, RADIUS, BORDER, TEXT, TYPE, FONT_FAMILY } from "./theme";
export { space, fontOf, roleFont, hex } from "./theme";
export type { TextRole, TextStyle, FontFamilyKey } from "./theme";
export {
	DESIGN_W,
	DESIGN_H,
	topInset,
	viewportSize,
	uiScale,
	hairline,
	scaleText,
	setStrokeWidth,
	onLayoutChange,
	isFocused,
	gamepadActive,
	autoFocus,
	setDesign,
	addCorner,
	addStroke,
	addAspect,
	tween,
	clearChildren,
	makeFrame,
	makeLabel,
	setTextSize,
	BUTTON_SIZE,
	buttonForeground,
	Button,
	setButtonVariant,
	setButtonEnabled,
	Card,
	CardTitle,
	CardDescription,
	cardHeaderHeight,
	CardHeader,
	CardContent,
	CardFooter,
	badgeWidth,
	Badge,
	setBadge,
	Separator,
	Progress,
	Tabs,
	Sidebar,
	makeScreen,
	makeAnchored,
	Dialog,
	Slider,
	showToast,
	makeScrollList,
	makeListRow,
	ListRowButton,
	CoinIcon,
	makeCoinPill,
	nl,
	fmtNum,
	fmtInt,
	fmtSeconds,
} from "./widgets";
export type {
	FontSpec,
	FrameOpts,
	TextAlign,
	LabelOpts,
	ButtonVariant,
	ButtonSize,
	ButtonProps,
	CardVariant,
	CardProps,
	CardTextOpts,
	CardHeaderOpts,
	BadgeVariant,
	BadgeProps,
	SeparatorProps,
	Bar,
	ProgressProps,
	TabsProps,
	TabsHandle,
	SidebarProps,
	SidebarHandle,
	Screen,
	ScreenOpts,
	DialogProps,
	DialogHandle,
	SliderProps,
	SliderHandle,
	ScrollList,
	CoinPill,
} from "./widgets";
export { showLogo } from "./logo";
export { showLobby } from "./lobby";
export type { LobbyHandle, LobbyHandlers, LobbyPage, LobbyStatus, RunState } from "./lobby";
export { showShop, actionErrorText } from "./shop";
export { showSettings } from "./settings";
export { showCredits } from "./credits";
export { Hud } from "./hud";
export type { HudState } from "./hud";
export { Backpack } from "./backpack";
export { Nameplate } from "./nameplate";
export { showPause } from "./pauseMenu";
export type { PauseHandlers, PauseInfo } from "./pauseMenu";
export { showTutorial } from "./tutorial";
export { popup, toast } from "./popup";
export type { PopupButtonSpec, ToastKind } from "./popup";
