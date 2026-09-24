/*
 * The storefront signs of the town (docs/DESIGN_RULES.md EDI-03, ART-07): how a building says what it is from the
 * street, so the player knows where the medicine, the ammunition and the food are before walking in (EDI-04: the
 * roof hides the inside until you enter). As DATA, the way shared/data/itemIcons.ts keeps the item icons.
 *
 * Each sign is a lightbox board drawn at the town art's 4 world units per texel (ART-02), one character per texel
 * in the colours of SIGN_ART below: a 1-texel `k` outline, a face in the type's own colour with a lighter top row
 * (the light comes from the top left, the convention of the town art) and a grimy bottom row, and a pictogram of
 * what is sold inside. No letters: a sign is read by shape and colour, in any language, and no brand is imitated
 * (CON-02). The board is sized to the building (a real supermarket's sign is bigger than a pharmacy's): 24 x 16
 * texels (96 x 64 units, ~1.75 x 1.2 m) on the small shops, 32 x 20 (128 x 80) on the four big buildings -- the
 * same texel, so no board is chunkier than the town around it.
 *
 * Two drawings of the same pixels:
 *  - flat: client/view/buildingSigns.ts decomposes the grid into a few rectangles (runs), painted in `order`
 *    (a colour's rectangle may spill over the texels of a colour painted after it, so the outline is one Frame
 *    under the whole board and the face another);
 *  - art: tools/gen-world-art.mjs writes each grid to design/world-art/<texture>.png, texel for texel, so once
 *    uploaded (`npm run cloud -- upload-art`) a sign is one ImageLabel.
 *
 * This module imports nothing (the art generator reads it with a bare TypeScript transpile).
 */

/** world units per texel of a sign: the town art's WORLD_TEXEL (client/view/worldArtAssets.ts) */
export const SIGN_TEXEL = 4;

/**
 * The colours of the signs: ART colours, like the town's and the item icons' (not UI roles, UI-01). A few days
 * after the outbreak the signs are as they were the week before -- a little sun-faded, never neon (APO-03).
 */
export const SIGN_ART: Record<string, Color3> = {
	// the outline, the dark of a pictogram (a pistol, cutlery, wheels), steel
	k: Color3.fromRGB(26, 24, 28),
	d: Color3.fromRGB(54, 56, 62),
	g: Color3.fromRGB(112, 116, 124),
	s: Color3.fromRGB(168, 172, 178),
	// faded white, and white in shade
	W: Color3.fromRGB(236, 234, 224),
	w: Color3.fromRGB(196, 194, 184),
	// red: the supermarket's board, an apple, a book's cover, the pump's stripe
	p: Color3.fromRGB(226, 116, 100),
	r: Color3.fromRGB(188, 52, 46),
	R: Color3.fromRGB(126, 32, 30),
	// the pharmacy's green cross
	v: Color3.fromRGB(132, 202, 112),
	e: Color3.fromRGB(64, 168, 88),
	E: Color3.fromRGB(34, 110, 58),
	// the hospital road sign's blue
	a: Color3.fromRGB(96, 140, 204),
	b: Color3.fromRGB(46, 92, 166),
	B: Color3.fromRGB(30, 60, 114),
	// the school's chalkboard
	j: Color3.fromRGB(72, 104, 86),
	h: Color3.fromRGB(50, 80, 64),
	H: Color3.fromRGB(36, 58, 47),
	// paper
	c: Color3.fromRGB(234, 222, 188),
	C: Color3.fromRGB(186, 170, 132),
	// the gas station's charcoal
	z: Color3.fromRGB(88, 92, 100),
	x: Color3.fromRGB(60, 64, 70),
	X: Color3.fromRGB(42, 44, 50),
	// the gun shop's khaki
	q: Color3.fromRGB(228, 214, 176),
	o: Color3.fromRGB(206, 188, 142),
	O: Color3.fromRGB(162, 144, 104),
	// the clothing store's teal
	u: Color3.fromRGB(70, 154, 156),
	t: Color3.fromRGB(36, 118, 122),
	T: Color3.fromRGB(24, 82, 86),
	// the diner's mustard, and a baguette
	Y: Color3.fromRGB(240, 204, 120),
	y: Color3.fromRGB(222, 172, 66),
	Q: Color3.fromRGB(172, 128, 46),
	// the corner grocery's leaf green
	L: Color3.fromRGB(124, 172, 88),
	l: Color3.fromRGB(84, 136, 62),
	m: Color3.fromRGB(56, 100, 44),
	// a kraft paper bag: its folded rim, the paper, its side in shade
	i: Color3.fromRGB(226, 200, 150),
	f: Color3.fromRGB(204, 168, 112),
	F: Color3.fromRGB(158, 122, 76),
};

export interface BuildingSign {
	/** its texture in the town art (design/world-art/<texture>.png, a WorldArtName) */
	texture: string;
	/** what the pictogram shows */
	shows: string;
	/** the order the flat drawing paints the colours in (first: the outline); every colour of `rows` is in it */
	order: string;
	/** the grid, top to bottom: every row as long as the first (24 x 16 on a small shop, 32 x 20 on a big one) */
	rows: Array<string>;
	/** a marking painted on the roof, read from the air (only where a real building of the type has one) */
	roofMark?: "helipad";
}

/**
 * One sign per building type that is not a house (shared/data/buildings.ts BuildingType), each its own pictogram
 * on its own board colour: no two alike. The market (7) and the small market (8) both sell food, so they share the
 * roof colour (EDI-03) and not the sign: the supermarket's cart, the corner grocery's paper bag.
 */
export const BUILDING_SIGNS: Record<number, BuildingSign> = {
	3: {
		texture: "signSchool",
		shows: "an open book on a chalkboard",
		order: "khjcCrRHd",
		rows: [
			"kkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkk",
			"kjjjjjjjjjjjjjjjjjjjjjjjjjjjjjjk",
			"khhhhhhhhhhhhhhhhhhhhhhhhhhhhhhk",
			"khhhhhhhhhhhhhhhhhhhhhhhhhhhhhhk",
			"khhhhhhhcccccchhhhcccccchhhhhhhk",
			"khhhhhcccccccccCCccccccccchhhhhk",
			"khhhhhcccccccccCCccccccccchhhhhk",
			"khhhhhccCCCCCCcCCcCCCCCCcchhhhhk",
			"khhhhhcccccccccCCccccccccchhhhhk",
			"khhhhhccCCCCccCCCCccCCCCCchhhhhk",
			"khhhhhcccccccccCCccccccccchhhhhk",
			"khhhhhccCCCCCCcCCcCCCCCccchhhhhk",
			"khhhhhcccccccccCCccccccccchhhhhk",
			"khhhhhccccccccCCCCcccccccchhhhhk",
			"khhhhrrrrrrrrrrRRrrrrrrrrrrhhhhk",
			"khhhhhRRRRRRRRRddRRRRRRRRRhhhhhk",
			"khhhhhhhhhhhhhhhhhhhhhhhhhhhhhhk",
			"khhhhhhhhhhhhhhhhhhhhhhhhhhhhhhk",
			"kHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHk",
			"kkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkk",
		],
	},
	4: {
		texture: "signHospital",
		shows: "the white H of the hospital road sign, on blue",
		roofMark: "helipad",
		order: "kabWB",
		rows: [
			"kkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkk",
			"kaaaaaaaaaaaaaaaaaaaaaaaaaaaaaak",
			"kbWWWWWWWWWWWWWWWWWWWWWWWWWWWWbk",
			"kbWbbbbbbbbbbbbbbbbbbbbbbbbbbWbk",
			"kbWbbbbbbbbbbbbbbbbbbbbbbbbbbWbk",
			"kbWbbbbbbbWWWbbbbbbWWWbbbbbbbWbk",
			"kbWbbbbbbbWWWbbbbbbWWWbbbbbbbWbk",
			"kbWbbbbbbbWWWbbbbbbWWWbbbbbbbWbk",
			"kbWbbbbbbbWWWbbbbbbWWWbbbbbbbWbk",
			"kbWbbbbbbbWWWWWWWWWWWWbbbbbbbWbk",
			"kbWbbbbbbbWWWWWWWWWWWWbbbbbbbWbk",
			"kbWbbbbbbbWWWbbbbbbWWWbbbbbbbWbk",
			"kbWbbbbbbbWWWbbbbbbWWWbbbbbbbWbk",
			"kbWbbbbbbbWWWbbbbbbWWWbbbbbbbWbk",
			"kbWbbbbbbbWWWbbbbbbWWWbbbbbbbWbk",
			"kbWbbbbbbbbbbbbbbbbbbbbbbbbbbWbk",
			"kbWbbbbbbbbbbbbbbbbbbbbbbbbbbWbk",
			"kbWWWWWWWWWWWWWWWWWWWWWWWWWWWWbk",
			"kBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBk",
			"kkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkk",
		],
	},
	5: {
		texture: "signGas",
		shows: "a fuel pump, its hose and nozzle hanging on its side",
		order: "kzxRWwXdgr",
		rows: [
			"kkkkkkkkkkkkkkkkkkkkkkkk",
			"kzzzzzzzzzzzzzzzzzzzzzzk",
			"kxxxxxxxxxxxxxxxxxxxxxxk",
			"kxxxxxWWWWWWWxxxxxxxxxxk",
			"kxxxxxWdddddwWWxxxxxxxxk",
			"kxxxxxWdgggdwxxWxxxxxxxk",
			"kxxxxxWdddddwxxWxxxxxxxk",
			"kxxxxxWWWWWWwxxWxxxxxxxk",
			"kxxxxxrrrrrrRxxWxxxxxxxk",
			"kxxxxxWWWWWWwxWWWxxxxxxk",
			"kxxxxxWWWWWWwxWWwxxxxxxk",
			"kxxxxxWWWWWWwxWxxxxxxxxk",
			"kxxxxxWWWWWWwxxxxxxxxxxk",
			"kxxxxxggggggggxxxxxxxxxk",
			"kXXXXXXXXXXXXXXXXXXXXXXk",
			"kkkkkkkkkkkkkkkkkkkkkkkk",
		],
	},
	6: {
		texture: "signPharmacy",
		shows: "a green cross lightbox",
		order: "kWveEw",
		rows: [
			"kkkkkkkkkkkkkkkkkkkkkkkk",
			"kWWWWWWWWWWWWWWWWWWWWWWk",
			"kWWWWWWWWWvvvvWWWWWWWWWk",
			"kWWWWWWWWWveeEWWWWWWWWWk",
			"kWWWWWWWWWveeEWWWWWWWWWk",
			"kWWWWWWWWWveeEWWWWWWWWWk",
			"kWWWWWvvvvveeevvvvWWWWWk",
			"kWWWWWveeeeeeeeeeEWWWWWk",
			"kWWWWWveeeeeeeeeeEWWWWWk",
			"kWWWWWEEEEEeeeEEEEWWWWWk",
			"kWWWWWWWWWveeEWWWWWWWWWk",
			"kWWWWWWWWWveeEWWWWWWWWWk",
			"kWWWWWWWWWveeEWWWWWWWWWk",
			"kWWWWWWWWWEEEEWWWWWWWWWk",
			"kwwwwwwwwwwwwwwwwwwwwwwk",
			"kkkkkkkkkkkkkkkkkkkkkkkk",
		],
	},
	7: {
		texture: "signMarket",
		shows: "a shopping cart",
		order: "krWpwRd",
		rows: [
			"kkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkk",
			"kppppppppppppppppppppppppppppppk",
			"krrrrrrrrrrrrrrrrrrrrrrrrrrrrrrk",
			"krrWWWrrrrrrrrrrrrrrrrrrrrrrrrrk",
			"krrrrrWrrrrrrrrrrrrrrrrrrrrrrrrk",
			"krrrrrrWrrrrrrrrrrrrrrrrrrrrrrrk",
			"krrrrrrrWWWWWWWWWWWWWWWWWWWWrrrk",
			"krrrrrrrWWWWWWWWWWWWWWWWWWWwrrrk",
			"krrrrrrrrWWrrrrrrrrrrrrrrrWwrrrk",
			"krrrrrrrrWWWWWWWWWWWWWWWWWwrrrrk",
			"krrrrrrrrrWWrrrrrrrrrrrrrWwrrrrk",
			"krrrrrrrrrWWWWWWWWWWWWWWWWwrrrrk",
			"krrrrrrrrrrWWrrrrrrrrrrrrWwrrrrk",
			"krrrrrrrrrrwwwwwwwwwwwwwwwrrrrrk",
			"krrrrrrrrWWWWWWWWWWWWWWWWWWrrrrk",
			"krrrrrrrrrrddrrrrrrrrrddrrrrrrrk",
			"krrrrrrrrrrddrrrrrrrrrddrrrrrrrk",
			"krrrrrrrrrrrrrrrrrrrrrrrrrrrrrrk",
			"kRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRk",
			"kkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkk",
		],
	},
	8: {
		texture: "signGrocery",
		shows: "a paper grocery bag with a baguette and an apple",
		order: "klrRQLyFimefYp",
		rows: [
			"kkkkkkkkkkkkkkkkkkkkkkkk",
			"kLLLLLLLLLLLLLLLLLLLLLLk",
			"klllllllllllllllllYYlllk",
			"klllllllllFelllllYyllllk",
			"kllllllllprrllllYQlllllk",
			"klllllllprrrrllYyllllllk",
			"klllllllrrrrRlYylllllllk",
			"kllllliiiiiiiiiiiilllllk",
			"kllllllfffffffffFllllllk",
			"kllllllfffffffffFllllllk",
			"kllllllfffffffffFllllllk",
			"kllllllfffffffffFllllllk",
			"kllllllfffffffffFllllllk",
			"kllllllFFFFFFFFFFllllllk",
			"kmmmmmmmmmmmmmmmmmmmmmmk",
			"kkkkkkkkkkkkkkkkkkkkkkkk",
		],
	},
	9: {
		texture: "signGuns",
		shows: "a pistol",
		order: "koqsdO",
		rows: [
			"kkkkkkkkkkkkkkkkkkkkkkkk",
			"kqqqqqqqqqqqqqqqqqqqqqqk",
			"kooooooooooooooooooooook",
			"kooooooooooooooooooooook",
			"koossssssssssssssssdoook",
			"kooddddddddddddddddddook",
			"kooddddddddddddddddddook",
			"koooooooooodddodddddoook",
			"koooooooooodododddddoook",
			"koooooooooodddodddddoook",
			"koooooooooooooodddddoook",
			"kooooooooooooooodddddook",
			"kooooooooooooooodddddook",
			"kooooooooooooooooooooook",
			"kOOOOOOOOOOOOOOOOOOOOOOk",
			"kkkkkkkkkkkkkkkkkkkkkkkk",
		],
	},
	10: {
		texture: "signClothes",
		shows: "a T-shirt",
		order: "ktuWwT",
		rows: [
			"kkkkkkkkkkkkkkkkkkkkkkkk",
			"kuuuuuuuuuuuuuuuuuuuuuuk",
			"ktttttttWWWwwWWWtttttttk",
			"ktttttWWWWWWWWWWWWtttttk",
			"kttttWWWWWWWWWWWWWWttttk",
			"ktttWWWWWWWWWWWWWWWWtttk",
			"ktttWWWWWWWWWWWWWWWWtttk",
			"ktttwWWwWWWWWWWWwWWwtttk",
			"kttttttwWWWWWWWWwttttttk",
			"kttttttwWWWWWWWWwttttttk",
			"kttttttwWWWWWWWWwttttttk",
			"kttttttwWWWWWWWWwttttttk",
			"kttttttwwwwwwwwwwttttttk",
			"kttttttttttttttttttttttk",
			"kTTTTTTTTTTTTTTTTTTTTTTk",
			"kkkkkkkkkkkkkkkkkkkkkkkk",
		],
	},
	11: {
		texture: "signDiner",
		shows: "a plate between a fork and a knife",
		order: "kyYQWwdX",
		rows: [
			"kkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkk",
			"kYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYk",
			"kyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyk",
			"kyyydydydyyyyyyyyyyyyyyyyydyyyyk",
			"kyyydydydyyyyyWWWWyyyyyyyddyyyyk",
			"kyyydydydyyyWWWWWWWWyyyydddyyyyk",
			"kyyydydydyyWWWwwwwWWWyyydddyyyyk",
			"kyyydddddyyWWwwwwwwWWyyydddyyyyk",
			"kyyyydddyyWWwwwwwwwwWWyydddyyyyk",
			"kyyyyydyyyWWwwwwwwwwWWyydddyyyyk",
			"kyyyyydyyyWWwwwwwwwwWWyyyddyyyyk",
			"kyyyyXXXyyWWwwwwwwwwWWyyyXXyyyyk",
			"kyyyyXXXyyyWWwwwwwwWWyyyyXXyyyyk",
			"kyyyyXXXyyyWWWwwwwWWwyyyyXXyyyyk",
			"kyyyyXXXyyyyWWWWWWwwyyyyyXXyyyyk",
			"kyyyyXXXyyyyyywwwwyyyyyyyXXyyyyk",
			"kyyyyyXyyyyyyyyyyyyyyyyyyyXyyyyk",
			"kyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyk",
			"kQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQk",
			"kkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkk",
		],
	},
};

/**
 * A gas station's price sign (DESIGN_RULES EDI-16): the pylon on its footing at the street corner of the forecourt,
 * drawn upright like the storefront signs and seen from both streets. The same pixel art (SIGN_TEXEL, SIGN_ART, the
 * 1-texel outline): the charcoal board of the station's storefront sign with its pump pictogram on top, then three
 * grades, each a coloured tab and a price panel -- dark: the power went a few days ago (ART-07), and a panel with no
 * digits carries no text to translate and no brand to imitate (CON-02). Below the board, its steel post; the post's
 * foot stands on the footing (world.ts `placeGas`, tags "gas_sign"). Texture `signPrice`; flat, its runs.
 */
export const PRICE_SIGN: BuildingSign = {
	texture: "signPrice",
	shows: "a price pylon: the pump pictogram over three grade tabs and their dark price panels, on a steel post",
	order: "kzxXdWwrRgseEyQ",
	rows: [
		"kkkkkkkkkkkkkkkk",
		"kzzzzzzzzzzzzzzk",
		"kxxxxWWWWWxxxxxk",
		"kxxxxWdddWxWxxxk",
		"kxxxxWWWWWxWxxxk",
		"kxxxxrrrrRxWxxxk",
		"kxxxxWWWWWWWxxxk",
		"kxxxxWWWWwxxxxxk",
		"kxxxggggggxxxxxk",
		"kXXXXXXXXXXXXXXk",
		"keeEkddddddddddk",
		"kEEEkddddddddddk",
		"kXXXXXXXXXXXXXXk",
		"kyyQkddddddddddk",
		"kQQQkddddddddddk",
		"kXXXXXXXXXXXXXXk",
		"kWWwkddddddddddk",
		"kwwwkddddddddddk",
		"kkkkkkkkkkkkkkkk",
		"......ksgk......",
		"......ksgk......",
		"......ksgk......",
		"......ksgk......",
		"......ksgk......",
		"......ksgk......",
	],
};
/** the rows of PRICE_SIGN that are its post, under the board (the rest is the board) */
export const PRICE_SIGN_POST_ROWS = 6;

/**
 * The hospital's roof marking, in texels: the heliport of a hospital as ICAO draws it -- a red H on a white cross
 * made of five squares -- on the dark deck of the landing area inside its white ring, painted on the roof and worn.
 * The deck is what makes it read on the hospital's white roof. A rooftop helipad is how a real hospital is told
 * from the air; it is sized down with the building (the town is compressed: a hospital is 19 x 15 m). Texture
 * `helipad` (tools/gen-world-art.mjs); flat, the deck with its ring (one circle), the cross and the H.
 */
export const HELIPAD = {
	/** the texture's side */
	size: 64,
	/** outer diameter of the ring, and its width */
	ring: 60,
	ringWidth: 2,
	/** side of each of the cross's five squares */
	square: 12,
	/** the H inside the middle square: its height, the width of a leg, the height of the bar */
	letter: 10,
	leg: 3,
	bar: 2,
	/** colours (SIGN_ART): the deck, the white paint, the red H; and the paint's opacity (a roof, not a sticker) */
	deck: "x",
	paint: "W",
	mark: "r",
	alpha: 0.85,
};
