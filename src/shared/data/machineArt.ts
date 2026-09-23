/*
 * The electric builds, drawn (docs/DESIGN_RULES.md ELE-01..ELE-08, ART-02): pixel art as DATA, the way
 * shared/data/buildingSigns.ts keeps the storefront signs and shared/data/itemIcons.ts the item icons.
 *
 * Each sprite is a grid at the town art's 4 world units per texel (ART-02), one character per texel in the colours of
 * MACHINE_ART below ('.' is empty): a 1-texel `k` outline, the light from the top left (a lighter top and left edge,
 * a darker bottom and right), and the colours with a fixed meaning (LEG-02): BLUE for the machines, YELLOW for
 * electricity (a box's gauge, a pad's charging ring, the reactor's hazard band). Every sprite is the size of its build
 * (shared/sim/placement.ts PLACEABLES), so what collides is what is drawn (COL-01).
 *
 * The parts that move are sprites of their own, drawn turned about their `pivot` (in texels): the turret's head, a
 * drone, the signal generator's dish. What only a state shows -- a lit lens, a glowing plate, a gauge's bars, a status
 * lamp, a muzzle flash -- is drawn over them by client/view/machinesView.ts, so no sprite exists twice.
 *
 * Two drawings of the same pixels, as the signs:
 *  - flat: client/view/machinesView.ts decomposes each grid into a few rectangles, painted in MACHINE_ART_ORDER;
 *  - art: tools/gen-world-art.mjs writes each grid to design/world-art/<texture>.png, texel for texel, so once
 *    uploaded (`npm run cloud -- upload-art`) a machine is one ImageLabel (ART-01: without an id, nothing changes).
 *
 * This module imports nothing (the art generator reads it with a bare TypeScript transpile).
 */

/** world units per texel of a machine: the town art's WORLD_TEXEL (client/view/worldArtAssets.ts) */
export const MACHINE_TEXEL = 4;

/** the colours of the machines: ART colours, like the town's and the signs' (not UI roles, UI-01) */
export const MACHINE_ART: Record<string, Color3> = {
	// the outline, a dark panel, steel in three tones and its shine
	k: Color3.fromRGB(26, 24, 28),
	n: Color3.fromRGB(42, 44, 50),
	d: Color3.fromRGB(72, 76, 84),
	g: Color3.fromRGB(112, 118, 128),
	s: Color3.fromRGB(162, 168, 178),
	w: Color3.fromRGB(224, 228, 234),
	// blue: the machines (LEG-02), in shade, body and light; and glass
	B: Color3.fromRGB(30, 52, 96),
	b: Color3.fromRGB(44, 78, 138),
	a: Color3.fromRGB(80, 128, 196),
	c: Color3.fromRGB(160, 208, 238),
	// yellow: electricity (LEG-02)
	y: Color3.fromRGB(232, 198, 64),
	// copper, for the coil
	o: Color3.fromRGB(196, 122, 58),
	O: Color3.fromRGB(128, 74, 38),
	// red: the fuel tank and the battery's + post
	r: Color3.fromRGB(180, 50, 44),
	p: Color3.fromRGB(226, 112, 96),
};

/** the order the colours are painted in (the flat drawing's rectangles may spill over later colours, never earlier) */
export const MACHINE_ART_ORDER = "kndBgObarosypcw";

export interface MachineSprite {
	/** the texture's name in the town art (design/world-art/<texture>.png) */
	texture: string;
	/** what it shows (the art manifest's description) */
	shows: string;
	/** the texel a turning sprite turns about, and that sits on the point it is drawn at; the centre if absent */
	pivot?: [number, number];
	rows: Array<string>;
}

export const MACHINE_SPRITES: Record<string, MachineSprite> = {
	turretBase: {
		texture: "machineTurret",
		shows: "the turret's mount: an octagonal steel plate, the ring the head turns on, four bolts",
		rows: [
			"....kkkkkkkk....",
			"...kssssssssk...",
			"..ksggggggggsk..",
			".ksgggkkkkgggsk.",
			"ksggwknnnnkwggsk",
			"ksggknnnnnnkggdk",
			"ksgknnnnnnnnkgdk",
			"ksgknnnnnnnnkgdk",
			"ksgknnnnnnnnkgdk",
			"ksgknnnnnnnnkgdk",
			"ksggknnnnnnkggdk",
			"ksggwknnnnkwggdk",
			".ksgggkkkkgggdk.",
			"..ksggggggggdk..",
			"...ksdddddddk...",
			"....kkkkkkkk....",
		],
	},
	turretHead: {
		texture: "machineTurretHead",
		shows: "the turret's head: a blue dome and the barrel, pointing +x (it turns)",
		pivot: [4, 4],
		rows: [
			"...kk........",
			".kkaakk......",
			".kccaak......",
			"kacaaaakkkkkk",
			"kaaaabaaddddk",
			".kaabbakkkkkk",
			".kkaakk......",
			"...kk........",
		],
	},
	shockBase: {
		texture: "machineShock",
		shows: "the electric turret: copper coil rings round a steel terminal",
		rows: [
			"......kkkk......",
			"....kksssskk....",
			"..kkssgoogsskk..",
			"..ksgoooooogsk..",
			".ksgooOOOOoogsk.",
			".ksooOooooOoodk.",
			"ksgoOoossooOogsk",
			"ksooOoswssoOoodk",
			"ksooOossssoOoodk",
			"ksgoOoossooOogdk",
			".ksooOooooOoodk.",
			".ksgooOOOOoogdk.",
			"..ksgoooooogdk..",
			"..kksdgoogddkk..",
			"....kksdddkk....",
			"......kkkk......",
		],
	},
	battery: {
		texture: "machineBattery",
		shows: "the battery box: blue case, the gauge window, the two posts",
		rows: [
			"kkkkkkkkkk",
			"karraaddak",
			"kabbbbbbBk",
			"kannnnnnBk",
			"kannnnnnBk",
			"kannnnnnBk",
			"kannnnnnBk",
			"kannnnnnBk",
			"kaBBBBBBBk",
			"kkkkkkkkkk",
		],
	},
	solar: {
		texture: "machineSolar",
		shows: "the solar generator: nine blue cells in a steel frame",
		rows: [
			"kkkkkkkkkkkkkkkkkk",
			"kssssssssssssssssk",
			"kscaaancaaancaaadk",
			"ksbabbnbabbnbabbdk",
			"ksbbbbnbbbbnbbbbdk",
			"ksbbbbnbbbbnbbbbdk",
			"ksnnnnnnnnnnnnnndk",
			"kscaaancaaancaaadk",
			"ksbabbnbabbnbabbdk",
			"ksbbbbnbbbbnbbbbdk",
			"ksbbbbnbbbbnbbbbdk",
			"ksnnnnnnnnnnnnnndk",
			"kscaaancaaancaaadk",
			"ksbabbnbabbnbabbdk",
			"ksbbbbnbbbbnbbbbdk",
			"ksbbbbnbbbbnbbbbdk",
			"ksdddddddddddddddk",
			"kkkkkkkkkkkkkkkkkk",
		],
	},
	reactor: {
		texture: "machineReactor",
		shows: "the nuclear reactor: the vessel, its hazard band, the dome and the core",
		rows: [
			"........kkkk........",
			".....kkksssskkk.....",
			"....ksnnnnyyyysk....",
			"...ksnnnnddyyyysk...",
			"..ksnndddssdddynsk..",
			".ksyyddssssssddnnsk.",
			".kyyddswssssssddnnk.",
			".kyydswwnnnnsssdnnk.",
			"ksyydssnnnnnnssdnnsk",
			"ksydsssnnnnnnsssdndk",
			"ksndsssnnnnnnsssdydk",
			"ksnndssnnnnnnssdyydk",
			".knndsssnnnnsssdyyk.",
			".knnddssssssssddyyk.",
			".ksnnddssssssddyydk.",
			"..ksnydddssdddnndk..",
			"...ksyyyyddnnnndk...",
			"....ksyyyynnnndk....",
			".....kkksdddkkk.....",
			"........kkkk........",
		],
	},
	oilGenerator: {
		texture: "machineOil",
		shows: "the oil generator: the radiator grille, the red tank and its cap, the exhaust",
		rows: [
			"..................",
			"kkkkkkkkkkkkkkkkkk",
			"kggggggggggggggggk",
			"kggggggddkkkkkkknk",
			"kgkkkkkddkpppppknk",
			"kggggggddkrrrrrknk",
			"kgkkkkkddkrrwwrknk",
			"kggggggddkrrssrknk",
			"kgkkkkkddkrrrrrknk",
			"kggggggddkkkkkkknk",
			"kgkkkkkdddddddddnk",
			"kggggggdddddkkddnk",
			"kgkkkkkddddknnkdnk",
			"kggggggddddknnkdnk",
			"kgkkkkkdddddkkddnk",
			"kgnnnnnnnnnnnnnnnk",
			"kkkkkkkkkkkkkkkkkk",
			"..................",
		],
	},
	lamp: {
		texture: "machineLamp",
		shows: "the lamp: a floodlight head on its plate",
		rows: [
			"............",
			".kkkkkkkkkk.",
			".kssskksssk.",
			".kskkddkkdk.",
			".kskcccckdk.",
			".kkdcwccdkk.",
			".kkdccccdkk.",
			".kskcccckdk.",
			".kskkddkkdk.",
			".ksddkkdddk.",
			".kkkkkkkkkk.",
			"............",
		],
	},
	padTurret: {
		texture: "machinePadTurret",
		shows: "the turret drone's pad: the charging ring and its contacts",
		rows: [
			"kkkkkkkkkkkk",
			"kddddddddddk",
			"kdnyyyyyynkk",
			"kdyynnnnyydk",
			"kdynnnnnnykk",
			"kdynnonnnydk",
			"kdynnnonnykk",
			"kdynnnnnnydk",
			"kdyynnnnyykk",
			"kdnyyyyyyndk",
			"kdkdkdkdkdkk",
			"kkkkkkkkkkkk",
		],
	},
	padLamp: {
		texture: "machinePadLamp",
		shows: "the lamp drone's pad",
		rows: [
			"kkkkkkkkkk",
			"kdddyydddk",
			"kdyynnyykk",
			"kdynnnnydk",
			"kynnonnnyk",
			"kynnnonnyk",
			"kdynnnnykk",
			"kdyynnyydk",
			"kdkdyykdkk",
			"kkkkkkkkkk",
		],
	},
	droneTurret: {
		texture: "machineDroneTurret",
		shows: "the turret drone: four rotors, the body and its gun, pointing +x (it turns)",
		pivot: [5, 5],
		rows: [
			".kkk...kkk.",
			"kgsgk.kgsgk",
			"kgggkkkgggk",
			".kkkdddkkk.",
			"...kaaak...",
			"...kacadddk",
			"...kaaak...",
			".kkkdddkkk.",
			"kgggkkkgggk",
			"kgsgk.kgsgk",
			".kkk...kkk.",
		],
	},
	droneLamp: {
		texture: "machineDroneLamp",
		shows: "the lamp drone: four rotors and the lamp",
		pivot: [5, 5],
		rows: [
			".kkk...kkk.",
			"kgsgk.kgsgk",
			"kgggkkkgggk",
			".kkkdddkkk.",
			"...kaaak...",
			"...kcwck...",
			"...kaaak...",
			".kkkdddkkk.",
			"kgggkkkgggk",
			"kgsgk.kgsgk",
			".kkk...kkk.",
		],
	},
	gps: {
		texture: "machineBeacon",
		shows: "the signal generator's base: the plate and the mast",
		rows: [
			"............",
			".kkkkkkkkkk.",
			".kssssssssk.",
			".ksggkkggdk.",
			".ksgkddkgdk.",
			".kskddddkdk.",
			".kskddddkdk.",
			".ksgkddkgdk.",
			".ksggkkggdk.",
			".knddddddnk.",
			".kkkkkkkkkk.",
			"............",
		],
	},
	dish: {
		texture: "machineBeaconDish",
		shows: "the signal generator's dish, facing +x (it turns)",
		pivot: [1, 3],
		rows: [".kk...", ".kskk.", ".kwsk.", ".kwssk", ".kwsk.", ".kskk.", ".kk..."],
	},
	cooker: {
		texture: "machineCooker",
		shows: "the cooker: a steel top with two plates and the knobs",
		rows: [
			"kkkkkkkkkkkkkk",
			"kwwwwwwwwwwwwk",
			"kwskksssskksgk",
			"kwkddksskddkgk",
			"kkdnndkkdnndkk",
			"kkdnndkkdnndkk",
			"kwkddksskddkgk",
			"kwskksssskksgk",
			"kwssssssssssgk",
			"kwssssssssssgk",
			"kwkggkggkggkgk",
			"kkkkkkkkkkkkkk",
		],
	},
};
