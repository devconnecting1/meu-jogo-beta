/*
 * The Context column of design/locale/ProjectZ.csv: one short English hint per Source string that a translator
 * (human, or Roblox's automatic one) could get wrong reading it alone -- a common word with another meaning
 * ("Round" is a magazine, not a shape; "Watch" is a wristwatch, not the verb), or a game-specific name a
 * dictionary will not have (Rebirth, a boss, a skill, a title).
 *
 * Every entry here was checked against where lang.ts's own comments or a grep of `src/` say the string is
 * actually drawn -- gen-locale.mjs's error message on an unknown key is the one place that check can rot, so
 * read it if this file stops matching lang.ts. A handful of entries (noted below, e.g. "Attack", "Round",
 * "Make") are not called through tr() by any screen today: they are the original Dead Town's item stat and
 * action vocabulary that lang.ts's own header says this file still carries (categories kept, descriptions
 * removed, F6), sitting next to the ones that ARE wired up. Their meaning is read off that position, not
 * invented, and is called out so a reviewer can re-check it.
 *
 * gen-locale.mjs FAILS the build if a key here is no longer in LANG_TABLE, so a renamed or removed string
 * cannot leave a stale, misleading row behind.
 */
export const CONTEXT = {
	// item/skill categories (backpack.ts tabs, admin spawn groups, itemInfo.ts type labels) -- several of these
	// (Item, Skill, Placeable, Etc, Usable, Survival, Fighting) are not drawn by any screen today; see the header
	Craft: "Bag tab: the crafting section (make items from materials)",
	Item: "generic item-category label (not drawn today; see the header)",
	Skill: "generic skill-category label (a perk), not a rating",
	Placeable: "item category: a buildable structure you place down",
	Weapon: 'item-card type label: "Weapon · Rifle", "Weapon · Bow", etc.',
	Equipment: "item type label: armor/tools slot; also an admin spawn group",
	Etc: "item category: misc crafting materials, not weapons or food",
	Ammo: "item type / HUD chip label: bullets or arrows for a weapon",
	Usable: "item category: a consumable (food, medicine, a tool)",
	Survival: 'skill category name (see "Survival skill")',
	Fighting: 'skill category name (see "Fighting skill")',
	Material: "item category: a crafting material",

	// crafting/Bag action-button verbs -- Make and Cook are not wired to any button today, kept for the same
	// reason as the categories above; Equip, Drop, Use, Melt and Learn are
	Make: 'crafting action button: make/craft an item (see "Craft")',
	Equip: "button: put on or hold this item (Bag, Wardrobe)",
	Drop: "button: discard the item, dropping it on the ground",
	Use: 'button: consume or activate the item (food shows "Eat" instead)',
	Cook: "action: prepare raw food at a lit fire or a stove",
	Melt: "action: smelt ore or scrap into metal at a brazier/furnace",
	Learn: "button: spend a skill point to level up this skill",

	// weapon/equipment stat labels -- Attack, Rate of fire, Recoil and Round are not on today's item card
	// (it only shows Damage, Cooldown/Draw time, Reach/Range, Magazine), kept for the same reason as above
	Attack: "weapon stat label: offensive power (paired with Defense)",
	Defense: "armor stat: how much damage it blocks",
	"Rate of fire": "weapon stat: how many shots fire per second",
	Recoil: "weapon stat: how much a gun kicks/spreads when fired",
	Round: "weapon stat: bullets held per magazine, not a shape",
	"Health recovery": "item stat: HP restored on use (food/medicine)",
	"Hunger recovery": "item stat: FOOD/hunger restored on use",
	Speed: "equipment stat: move-speed bonus from armor/clothing",
	Reloading: "HUD status text shown while a gun is reloading",
	"Skill point": "the currency spent in the Skills tab to level up a skill",

	// boss names
	Centipede: "boss name: a giant centipede monster",
	Rafflesia: "boss name: a giant carnivorous-flower monster",
	Giant: "boss name (a huge zombie), not the adjective",
	Hedgehog: "boss name (a spiked zombie boss), not the animal",

	Price: "label: the coin cost on a shop/wardrobe/rebirth card",

	// weapon item names with another everyday meaning
	Saw: 'weapon item: a hand saw (tool), not the past tense of "see"',
	Bow: "weapon item: a bow and arrow, not a ribbon bow or to bow",

	// equip items with another everyday meaning
	Compass: "equip item: a navigation compass, not a drawing tool",
	Watch: 'equip item: a wristwatch that tells time, not the verb "watch"',
	"Digital Watch": 'same item as "Watch", with a digital display',
	Torchlight: "equip item: a lit torch you carry, not a brand name",

	// placeables with another everyday meaning
	Trap: "buildable: a device that damages zombies that step on it",
	Cooker: "buildable: a stove for cooking food",

	// materials with another everyday meaning
	Bulb: "crafting material: a light bulb, not a plant bulb",
	Cloth: "crafting material (fabric); also the item card's Slot value",
	Drone: "crafting material: a mechanical drone part, not an insect",
	Gold: "crafting material (raw gold), not the game's currency (coins)",

	// pets and costumes
	Carolina: "pet name: a dog breed (Carolina Dog), not the US state",
	Santa: "cosmetic outfit name: a Santa Claus costume",
	Zombie: "cosmetic outfit name: a zombie costume, not the enemy",
	Cowboy: "cosmetic outfit name: a cowboy costume",

	// skill names (shared/data/achievements.ts-style perks in the Bag's Skills tab); each context is that
	// skill's own one-line effect, right after it in LANG_TABLE
	Health: "skill name: more maximum HP",
	Recovery: "skill name: health regenerates faster",
	Knockback: "skill name: melee hits push zombies back further",
	"Melee damage": "skill name: melee weapons deal more damage",
	"Quick reload": "skill name: reloading takes less time",
	"Shooting skill": "skill name: guns spread less (steadier aim)",
	"Robin Hood": "skill name: arrows fly faster and straighter",
	Trot: "skill name: you walk faster",
	Patience: "skill name: hunger drains more slowly",
	Pickpocket: "skill name: zombies drop more loot",
	Thief: "skill name: searching a building finds one more item",
	Chef: "skill name: cooking may give double food",
	Dwarf: "skill name: smelting may give double metal",
	Robotics: "skill name: turrets hit harder, drones fly longer",
	Engineering: "skill name: generators make more power, boxes hold more",
	Cat: "skill name: your footsteps are quieter",
	Nocturnal: "skill name: you see further at night",
	Repairman: "skill name: repairs go faster",
	"Move shooting": "skill name: moving adds no spread to your shots",
	"Head shooter": "skill name: shots can hit the head for extra damage",
	"Poison immunity": "skill name: poison hurts less",

	Rules: "menu button: opens the game's rules text",
	ADMIN: "button that opens the admin panel (admins only)",

	// achievement names (shared/data/achievements.ts); context is that achievement's own howTo line
	Arrival: "achievement name: step into the city for the first time",
	"Lights On": "achievement name: switch on a powered electric lamp",
	"Close Quarters": "achievement name: put down zombies with melee weapons",
	"Quiet Archer": "achievement name: put down zombies with a bow",
	Scavenger: "achievement name (currently hidden, has no trigger yet)",
	Metalworker: "achievement name: smelt metal in a brazier or furnace",
	"Long Shot": "achievement name: put down zombies with a sniper rifle",
	"Centipede Down": "achievement name: help defeat the Centipede boss",
	"Rafflesia Down": "achievement name: help defeat the Rafflesia boss",
	"Giant Down": "achievement name: help defeat the Giant boss",
	"Hedgehog Down": "achievement name: help defeat the Hedgehog boss",
	"Street Sweeper": "achievement name: put down zombies of any kind",
	"Odd Ones Out": "achievement name: put down special (non-walker) zombies",
	Woodpile: "achievement name: gather wood into your backpack",
	"First Sunrise": "achievement name: live through a whole day in the city",
	"Road Trip": "achievement name: ride a bicycle or a motorcycle",
	Deathless: "achievement name: survive nights in one life without dying",
	Unseen: "achievement name (currently hidden, has no trigger yet)",
	"Camp Cook": "achievement name: cook food over a fire or a stove",
	"Sentry Builder": "achievement name: put down a zombie with your own turret",

	Unlocked: "achievement/title status: earned",
	"In progress": "achievement status: partly done, not finished",
	"Not started": "achievement status: no progress made yet",

	// main menu
	Continue: "main menu button: resume your saved survivor (not New game)",
	"New game": "main menu button: start a new life (keeps level and coins)",
	Records: "menu button: your personal-best stats, not audio/db records",
	Credits: "menu button: the credits screen (who made it), not currency",

	// Settings (client/ui/settings.ts, tutorial.ts SCHEMES)
	SFX: "settings row: sound-effects volume (gunshots, hits, footsteps)",
	BGM: "settings row: background-music volume (night music, ambience)",
	"Reduce motion": "settings row: stills the moving town for motion sensitivity",
	Auto: "graphics quality option: switches quality automatically",
	High: "graphics quality option: highest detail",
	Low: "graphics quality option: simplest, most performant",
	Off: "settings toggle value: turned off",
	On: "settings toggle value: turned on",
	Defaults: "settings button: resets this tab back to its defaults",
	Reset: "button: confirm resetting settings back to defaults",
	Device: "settings row: which input device's controls to show",
	Menu: "control legend: opens the in-run menu (never pauses the game)",
	Backpack: "control legend: opens the Bag inventory (never pauses the game)",
	Aim: "control legend: aims your equipped weapon",
	Interact: "control legend: the context-sensitive action key (loot, use)",
	Mode: "How to play row: the game's co-op mode, not a settings mode",

	// survivor / loadout
	Survivor: "your character's name; also a title earned for one night",
	Level: "stat label: your survivor's XP level, not a floor or a rating",
	Clothes: "loadout slot: the body-clothing item worn",
	Hand: "loadout slot: a hand tool/gadget (flashlight, compass, watch)",
	Gun: "loadout slot: the equipped firearm (see Weapon for melee)",
	Outfit: "loadout slot: the cosmetic costume worn",
	Pet: "loadout slot: the cosmetic companion that follows you",

	// shop / save
	Owned: "shop/wardrobe status: you already bought this item",
	Pending: "shop status: a pack bought but not yet in your backpack",
	Received: "status: a one-time reward already given (welcome gift)",
	"Saving...": "save indicator: the server is writing your progress now",
	Saved: "save indicator: your progress was written successfully",
	Rebirth: "mechanic: pay coins to revive this life now (vs New game)",
	Purchased: "shop status: this pack/item was just bought",

	// HUD / time of day
	Melee: "weapon type label: close-combat weapons (vs guns or the bow)",
	Night: "time-of-day label: nighttime, when zombies swarm",
	Day: 'time-of-day label, and also the town\'s day counter ("Day 7")',
	Delivered: "shop status: a pack's contents were added to your backpack",

	// compass / GPS in hand
	Camp: "compass/GPS label: your placed camp marker",
	North: "compass label: the cardinal direction",
	N: "compass dial: abbreviation for North",
	Reload: "control legend: reload the equipped gun",
	Skip: "button: skip the tutorial/onboarding step",

	// item card type and stat labels (client/ui/itemInfo.ts)
	Rifle: "weapon type label shown on the item card",
	"Machine gun": "weapon type label shown on the item card",
	Shotgun: "weapon type label shown on the item card",
	"Sniper rifle": "weapon type label shown on the item card",
	Special: "weapon type label: unique-mechanic weapons (flamethrower, stun gun)",
	Food: "item type label shown on the item card",
	Medicine: "item type label shown on the item card",
	Clothing: "item type label: body armor/clothes",
	Tool: "item type label: hand-held gadgets (flashlight, compass, watch)",
	Gear: "Bag tab / item type label: tools and equipment, not vehicle gear",
	Buildable: "item type label: a placeable structure",
	Fuel: "item type label: oil, burned by vehicles and generators",
	Cooldown: "weapon stat: time between attacks or shots",
	"Draw time": "bow stat: how long you must hold before it fires",
	Range: "weapon stat: shooting distance, not a mountain range or a stove",
	Reach: "melee weapon stat: how far it hits",
	Magazine: "gun stat: ammo held before reloading, not a publication",
	Charge: "stun gun stat: its charge level, not a fee or to charge",
	Slot: "item-card stat: which equip slot it goes in",
	Click: "control legend: mouse click",
	Tap: "control legend: touchscreen tap",
	Unequip: "button: take off/remove the worn item",
	"Put away": "button: holster your weapon, leaving your hands empty",

	// wardrobe / titles
	Status: "wardrobe row label; its value is Locked, Owned or Equipped",
	Equipped: "wardrobe status: this outfit or pet is worn now",
	coins: "the game's currency, earned by playing (not literal coins)",
	Title: "loadout label: the earned title (singular of the Titles tab)",
	None: "value: no title equipped",
	Locked: "status: not yet earned or bought",
	"Horde Breaker": "title name: put down 100 zombies",
	"Week One": "title name: survive 7 days in one life",

	// HUD console bar prefixes and the touch fire button
	HP: "HUD bar prefix: current/max health",
	FOOD: "HUD bar prefix: current/max hunger",
	LV: "HUD bar prefix: level",
	FIRE: "touch button: fire the equipped weapon",

	// lobby
	Start: "lobby button: opens the Survivor screen to enter the city",
	Empty: "loadout slot value: nothing equipped there",
	Town: "lobby label: the shared town's current status/day",
	Solo: "lobby value: you're the only survivor in this town",

	// the Bag's item detail state tags and hotbar/loadout keys, drawn in ALL CAPS on screen (case-sensitive,
	// see lang.ts's own header): the same meaning as their Title Case counterparts above, on a different screen
	EQUIPPED: "Bag item state: this item is worn or held now",
	DEFAULT: "Bag item state: empty hands, no weapon equipped",
	COSTUME: "Bag item state: shown via an equipped cosmetic override",
	MAKES: 'crafting recipe: how many the recipe produces ("MAKES ×2")',
	START: 'button label (all caps), same meaning as "Start"',
	LEVEL: "label (all caps): survivor level, paired with a number",
	WEAPON: "loadout slot key (all caps): the melee weapon equipped",
	CLOTHES: "loadout slot key (all caps): body clothing",
	HAND: "loadout slot key (all caps): a hand tool/gadget, not melee",
	GUN: "loadout slot key (all caps): the firearm equipped",
	OUTFIT: "loadout slot key (all caps): the cosmetic costume worn",
	PET: "loadout slot key (all caps): the cosmetic companion",
	TITLE: "loadout slot key (all caps): the earned title",
	USE: "touch-button caption (all caps): use the item",
	RELOAD: "touch-button caption (all caps): reload the gun",

	Eat: 'button: consume a food item ("Use" is for other items)',

	// Skills tab category subtitles and the maxed-out value
	"Survival skill": "skill category name shown under a survival-type skill",
	"Fighting skill": "skill category name shown under a combat-type skill",
	"Utility skill": "skill category name shown under a utility-type skill",
	Max: "value: this skill is at its maximum level",

	// Records window
	"All time": "Records section: totals across every life ever played",
	Rebirths: "Records stat: how many times you've paid to Rebirth",

	// match scoreboard (client/ui/scoreboard.ts)
	Lv: "scoreboard column header: survivor level",
	Alive: "scoreboard status: still playing, not downed",
	Down: "scoreboard status: knocked down/incapacitated, not defeated",
	Dead: "scoreboard status: this life has ended",

	// ground items and crafting proximity
	full: "pickup prompt: you're already carrying the max of this item",
	smelter: '"Near you" list item: a lit brazier/furnace (for smelting)',
};
