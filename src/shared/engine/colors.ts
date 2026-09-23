export const COLORS = {
	bg: Color3.fromRGB(18, 18, 24),
	grass: Color3.fromRGB(74, 108, 62),
	grassDark: Color3.fromRGB(58, 88, 48),
	grassLight: Color3.fromRGB(86, 120, 70),
	parkGrass: Color3.fromRGB(66, 104, 56),
	dirtPath: Color3.fromRGB(138, 118, 86),
	road: Color3.fromRGB(78, 78, 84),
	roadLine: Color3.fromRGB(200, 190, 120),
	sidewalk: Color3.fromRGB(150, 148, 140),
	curb: Color3.fromRGB(118, 116, 110),
	borderForest: Color3.fromRGB(28, 46, 30),
	fence: Color3.fromRGB(96, 80, 60),
	floorWood: Color3.fromRGB(140, 110, 76),
	floorTile: Color3.fromRGB(168, 168, 172),
	floorShop: Color3.fromRGB(150, 146, 136),
	wallHouse: Color3.fromRGB(214, 204, 186),
	wallShop: Color3.fromRGB(176, 180, 186),
	wallWood: Color3.fromRGB(110, 78, 50),
	wallIron: Color3.fromRGB(130, 136, 144),
	doormat: Color3.fromRGB(120, 70, 50),
	roofRed: Color3.fromRGB(160, 70, 60),
	roofBlue: Color3.fromRGB(70, 96, 150),
	roofGray: Color3.fromRGB(110, 110, 118),
	roofGreen: Color3.fromRGB(76, 120, 78),
	treeTrunk: Color3.fromRGB(92, 66, 40),
	treeLeaf: Color3.fromRGB(48, 110, 48),
	treeLeafDark: Color3.fromRGB(34, 84, 38),
	treeLeafLight: Color3.fromRGB(74, 138, 64),
	player: Color3.fromRGB(90, 160, 220),
	playerDark: Color3.fromRGB(50, 100, 160),
	playerSkin: Color3.fromRGB(226, 186, 150),
	weapon: Color3.fromRGB(46, 46, 52),
	blade: Color3.fromRGB(220, 224, 232),
	zombie1: Color3.fromRGB(100, 150, 90),
	zombie2: Color3.fromRGB(140, 110, 160),
	zombie3: Color3.fromRGB(180, 90, 70),
	zombie4: Color3.fromRGB(150, 130, 70),
	zombie5: Color3.fromRGB(90, 170, 160),
	zombieFeet: Color3.fromRGB(52, 58, 48),
	detect: Color3.fromRGB(255, 220, 60),
	boss: Color3.fromRGB(170, 50, 50),
	blood: Color3.fromRGB(160, 20, 30),
	bloodZombie: Color3.fromRGB(92, 132, 48),
	acid: Color3.fromRGB(120, 200, 70),
	shadow: Color3.fromRGB(0, 0, 0),
	white: Color3.fromRGB(255, 255, 255),
	uiPanel: Color3.fromRGB(40, 40, 48),
	uiPanelLight: Color3.fromRGB(65, 65, 65),
	uiAccent: Color3.fromRGB(200, 160, 60),
	uiText: Color3.fromRGB(230, 230, 230),
	uiTextDim: Color3.fromRGB(160, 160, 160),
	uiRed: Color3.fromRGB(200, 60, 60),
	uiGreen: Color3.fromRGB(70, 180, 80),
	uiBlue: Color3.fromRGB(70, 120, 200),
	uiYellow: Color3.fromRGB(230, 200, 70),
	overlayNight: Color3.fromRGB(8, 10, 30),
	overlayDawn: Color3.fromRGB(180, 90, 50),
	door: Color3.fromRGB(150, 110, 70),
	ironDoor: Color3.fromRGB(170, 175, 185),
	barricade: Color3.fromRGB(130, 95, 60),
	ironBarricade: Color3.fromRGB(150, 155, 165),
	turret: Color3.fromRGB(90, 90, 100),
	trap: Color3.fromRGB(120, 120, 130),
	lamp: Color3.fromRGB(250, 230, 150),
	campfire: Color3.fromRGB(240, 140, 40),
	item: Color3.fromRGB(240, 220, 120),
	itemWeapon: Color3.fromRGB(150, 170, 200),
	itemEquip: Color3.fromRGB(190, 140, 210),
	itemUse: Color3.fromRGB(120, 210, 120),
	car: Color3.fromRGB(180, 60, 60),
	carGlass: Color3.fromRGB(40, 52, 66),
	carLight: Color3.fromRGB(250, 240, 200),
	carTail: Color3.fromRGB(200, 40, 40),
	trashBin: Color3.fromRGB(46, 84, 50),
	trashLid: Color3.fromRGB(64, 108, 68),
	parcel: Color3.fromRGB(220, 180, 100),
	bullet: Color3.fromRGB(255, 240, 160),
	arrow: Color3.fromRGB(200, 170, 110),
};

/**
 * The palette of the item icons (shared/data/itemIcons.ts, drawn by client/ui/itemIcon.ts): ART colours, like the
 * world's above and the cosmetics' (client/view/cosmeticsView.ts), not UI roles -- a pistol is gunmetal and an apple
 * is red whatever the theme says, so these never go through the tweakcn theme (DESIGN_RULES UI-01 is about the
 * interface's own colours; UI-11 about the icons). Keyed by the one character an icon's rows use for the colour.
 *
 * Every icon has a 1-pixel `k` outline, so it reads on any tile face (dark iron, the iron of an equipped item, the
 * blue of the selection) and at 32 px (MON-02's floor): a silhouette first, 2-4 colours and a highlight inside.
 */
export const ICON_ART: Record<string, Color3> = {
	// the outline and the darkest neutrals
	k: Color3.fromRGB(22, 20, 24),
	X: Color3.fromRGB(44, 44, 50),
	g: Color3.fromRGB(62, 64, 72),
	G: Color3.fromRGB(98, 102, 112),
	// steel: dark, mid, the shine of an edge
	S: Color3.fromRGB(106, 114, 126),
	s: Color3.fromRGB(158, 166, 178),
	w: Color3.fromRGB(222, 228, 236),
	// stone and concrete
	N: Color3.fromRGB(84, 84, 90),
	q: Color3.fromRGB(128, 128, 134),
	Q: Color3.fromRGB(174, 174, 178),
	// wood
	B: Color3.fromRGB(94, 60, 34),
	b: Color3.fromRGB(146, 98, 58),
	y: Color3.fromRGB(194, 144, 90),
	// leather
	L: Color3.fromRGB(86, 54, 34),
	l: Color3.fromRGB(134, 86, 52),
	// red (meat, blood, a first-aid cross, a fuel can)
	R: Color3.fromRGB(122, 22, 28),
	r: Color3.fromRGB(200, 46, 50),
	p: Color3.fromRGB(238, 120, 114),
	// cooked brown (roast meat, bread crust, baked potato)
	M: Color3.fromRGB(98, 54, 28),
	m: Color3.fromRGB(162, 98, 50),
	n: Color3.fromRGB(206, 140, 80),
	// bone, fat, cream
	f: Color3.fromRGB(240, 228, 204),
	// green (a leaf, zombie rot, a circuit board is `C`)
	E: Color3.fromRGB(38, 88, 40),
	e: Color3.fromRGB(78, 152, 66),
	v: Color3.fromRGB(140, 202, 100),
	C: Color3.fromRGB(34, 108, 70),
	// brass and gold
	O: Color3.fromRGB(146, 104, 28),
	o: Color3.fromRGB(214, 166, 60),
	u: Color3.fromRGB(250, 216, 112),
	// fire
	F: Color3.fromRGB(212, 70, 28),
	x: Color3.fromRGB(246, 142, 40),
	z: Color3.fromRGB(254, 222, 96),
	// blue: cloth, glass, a screen
	A: Color3.fromRGB(40, 66, 118),
	a: Color3.fromRGB(76, 124, 194),
	c: Color3.fromRGB(158, 208, 240),
	// canvas, cloth, paper
	T: Color3.fromRGB(148, 122, 86),
	t: Color3.fromRGB(206, 182, 136),
	h: Color3.fromRGB(236, 220, 184),
	// white and light grey (a bandage, a label, a bulb)
	i: Color3.fromRGB(200, 202, 206),
	W: Color3.fromRGB(248, 248, 244),
	// purple (a sedative, a berry)
	P: Color3.fromRGB(80, 42, 108),
	j: Color3.fromRGB(142, 88, 178),
	// the light of a torch or a bulb
	Y: Color3.fromRGB(255, 244, 164),
};

/**
 * The order the colours of an icon are painted in, first to last. The drawer covers each colour's pixels with as few
 * Frames as it can, and a Frame may spill over pixels a LATER colour paints anyway -- so the outline, painted first,
 * is a handful of big rectangles under the whole silhouette, and each colour after it is its own few rectangles.
 * The order only changes how many Frames an icon costs, never what it looks like.
 */
export const ICON_ART_ORDER = "kXgNBLRMEPACOFGSqblmTerajxoytQsnhifpvcuzwWY";

/**
 * Draw layers of the world (ZIndex inside the sprite layer; the HUD/dark overlay are separate
 * sibling layers above the whole world). Lowest → highest:
 * ground < road/sidewalk < static shadows < building floor < decals (blood, puddles) <
 * actor shadows < ground items < structures/walls < zombies < player < bosses < projectiles <
 * particles < actor markers ("!") < roof < tree canopy < effects < build ghost.
 *
 * Decals sit ABOVE the building floor (not below it) so blood/acid inside a house stays visible;
 * static shadows (buildings, cars, trees) stay below the floor so a building never darkens its
 * own interior. Anything an actor emits (particles, tracers, "!") stays below the roof so a closed
 * roof really hides what happens inside.
 */
export const Z = {
	/** sidewalk = ground, yard grass = ground + 1, grass patches / park paths = ground + 2 */
	ground: 1,
	road: 4,
	roadLine: 5,
	shadow: 6,
	floor: 8,
	floorDetail: 9,
	decal: 11,
	actorShadow: 13,
	item: 15,
	structure: 20,
	zombie: 30,
	player: 36,
	boss: 42,
	projectile: 48,
	particle: 50,
	actorFx: 52,
	roof: 60,
	canopy: 70,
	effect: 80,
	outline: 85,
	uiWorld: 90,
};
