/*
 * The survivor with an outfit and a pet, drawn inside a UI Frame at 3–4× the in-world size — the wardrobe's preview
 * (MON-04: "desenhados no sobrevivente, no mundo e na prévia do guarda-roupa").
 *
 * It is NOT a second drawing of the cosmetics. It is the very same `drawSurvivor` + `drawPet` the world uses, fed
 * through its own pooled `Renderer` and a `Camera` zoomed in on a small fixed scene, so the preview can never drift
 * from what the other players will see: a change to a hat lands in the world, on the allies and here at once.
 *
 *   const preview = new SurvivorPreview(panel, { x: 16, y: 60, w: 420, h: 260 });
 *   preview.setEquipped(save.equipOutfit, save.equipPet);   // or setOutfit(OutfitLook.Cowboy) / setPet(PetLook.Eagle)
 *   preview.draw();                                          // once, or every frame with a clock for the tail wag
 *   ...
 *   preview.destroy();
 *
 * The scene always keeps room for a pet at the survivor's side, so trying pets on never moves or rescales the
 * survivor. The scale is the one asked for (3.5× by default) unless the box is too small for the scene, in which
 * case it shrinks until everything fits: a preview must never clip the hat it is selling.
 *
 * A wardrobe TILE draws one cosmetic on its own (`subject`): "outfit" is the survivor alone, framed on the survivor;
 * "pet" is the pet alone, framed on the pet. Same drawing code, a smaller scene, so a tile shows exactly what the
 * big preview and the world show.
 *
 * Coordinates are in the parent's own units (the UI's design units under its UIScale), exactly like any other
 * widget; nothing here reads the screen size.
 */
import { Camera } from "shared/engine/camera";
import { Z } from "shared/engine/colors";
import { Renderer } from "shared/engine/renderer";
import { OutfitLook, PetLook, outfitLookOfEquip, petLookOfEquip } from "shared/data/cosmetics";
import { WEAPONS, meleeReach } from "shared/data/weapons";
import { drawPet } from "./cosmeticsView";
import { createPetFollower } from "./petFollow";
import { createLook, createSwingTrail, drawSurvivor } from "./survivorView";

/** the scale asked for when the caller does not say (MON-04: 3–4×) */
export const PREVIEW_SCALE = 3.5;
/** facing the bottom of the box: the pose a wardrobe shows */
export const PREVIEW_FACING = math.pi / 2;
/** where the pet stands, from the survivor's centre, in world units (their left side seen from the front) */
const PET_X = 52;
const PET_Y = 12;
/**
 * The scene, in world units around the survivor's centre: the survivor with the widest hat and the dagger held out,
 * and the widest pet (the eagle, wings half open) at its side. tools/test-cosmetics.mjs draws every outfit × every
 * pet and checks each sprite lands inside this box.
 */
export const PREVIEW_SCENE = { minX: -36, maxX: 84, minY: -26, maxY: 48 } as const;
/** an outfit's tile: the survivor alone, centred on it (widest hat, dagger held out, shadow) */
export const OUTFIT_SCENE = { minX: -34, maxX: 30, minY: -24, maxY: 44 } as const;
/** a pet's tile: the pet alone, standing at the origin (the eagle's open wings, a dog's length and tail) */
export const PET_SCENE = { minX: -30, maxX: 30, minY: -28, maxY: 32 } as const;
/**
 * The shop's pet packs (client/ui/shop.ts): ONE known pet, standing still, framed on itself -- not on the room the
 * eagle's open wings need -- so a small card still shows it big: a bird (the Pigeon's pack) and a dog (the Carolina's).
 * tools/test-cosmetics.mjs draws each pack's pet, flat and in pixel art, and checks every sprite and texel lands inside.
 */
const BIRD_SCENE = { minX: -16, maxX: 16, minY: -18, maxY: 20 } as const;
const DOG_SCENE = { minX: -24, maxX: 24, minY: -27, maxY: 29 } as const;

/** the scene that frames pet `look` alone in a small picture (the shop's pet packs); any other pet: PET_SCENE */
export function packPetScene(look: number): PreviewScene {
	if (look === PetLook.Pigeon || look === PetLook.WhitePigeon) return BIRD_SCENE;
	if (look === PetLook.Carolina) return DOG_SCENE;
	return PET_SCENE;
}

/** what a preview frames: the survivor with a pet at its side (the wardrobe's big preview), or one of the two */
export type PreviewSubject = "both" | "outfit" | "pet";

export interface PreviewScene {
	readonly minX: number;
	readonly maxX: number;
	readonly minY: number;
	readonly maxY: number;
}

/** the scene a subject frames */
export function sceneOf(subject: PreviewSubject): PreviewScene {
	if (subject === "outfit") return OUTFIT_SCENE;
	if (subject === "pet") return PET_SCENE;
	return PREVIEW_SCENE;
}

/** scale and camera centre that fit a scene (PREVIEW_SCENE by default) in a w × h box, at `preferred` or less */
export interface PreviewFit {
	scale: number;
	camX: number;
	camY: number;
}

export function previewFit(
	w: number,
	h: number,
	preferred = PREVIEW_SCALE,
	scene: PreviewScene = PREVIEW_SCENE,
): PreviewFit {
	const sw = scene.maxX - scene.minX;
	const sh = scene.maxY - scene.minY;
	const fit = math.min(w / sw, h / sh);
	return {
		scale: math.max(0.1, math.min(preferred, fit)),
		camX: (scene.minX + scene.maxX) / 2,
		camY: (scene.minY + scene.maxY) / 2,
	};
}

export interface SurvivorPreviewOpts {
	/** the box, in the parent's units */
	w: number;
	h: number;
	x?: number;
	y?: number;
	/** preferred magnification of the in-world size (default PREVIEW_SCALE); shrinks if the box is too small */
	scale?: number;
	/** what is framed (default "both"): a tile shows only its outfit ("outfit") or only its pet ("pet") */
	subject?: PreviewSubject;
	/**
	 * the box the camera frames, in world units (default: the subject's scene, sceneOf). A picture of ONE known pet
	 * frames that pet (packPetScene: the shop's pet packs) instead of the room the widest pet needs
	 */
	scene?: PreviewScene;
	zIndex?: number;
	name?: string;
}

export class SurvivorPreview {
	/** the box the preview draws in (transparent; style the parent, not this) */
	readonly frame: Frame;
	/** the magnification actually used */
	readonly scale: number;
	readonly subject: PreviewSubject;
	private readonly renderer: Renderer;
	private readonly cam = new Camera();
	private readonly look = createLook();
	private readonly trail = createSwingTrail();
	private readonly pet = createPetFollower();
	private petLook: number = PetLook.None;
	/** a fixed afternoon sun for the drop shadows, answered into one scratch point */
	private readonly sunPoint = { x: 0, y: 0 };
	private readonly sun = (_x: number, _y: number, len: number): { x: number; y: number } => {
		this.sunPoint.x = 0.7 * len;
		this.sunPoint.y = 0.7 * len;
		return this.sunPoint;
	};

	constructor(parent: GuiObject, opts: SurvivorPreviewOpts) {
		const frame = new Instance("Frame");
		frame.Name = opts.name ?? "SurvivorPreview";
		frame.BackgroundTransparency = 1;
		frame.BorderSizePixel = 0;
		frame.Position = UDim2.fromOffset(opts.x ?? 0, opts.y ?? 0);
		frame.Size = UDim2.fromOffset(opts.w, opts.h);
		frame.ZIndex = opts.zIndex ?? 1;
		frame.Parent = parent;
		this.frame = frame;
		this.renderer = new Renderer(frame, "Sprites");
		this.renderer.setView(opts.w, opts.h);
		const subject = opts.subject ?? "both";
		this.subject = subject;
		const fit = previewFit(opts.w, opts.h, opts.scale ?? PREVIEW_SCALE, opts.scene ?? sceneOf(subject));
		this.scale = fit.scale;
		const cam = this.cam;
		cam.setView(opts.w, opts.h);
		cam.zoom = fit.scale;
		cam.x = fit.camX;
		cam.y = fit.camY;

		const look = this.look;
		look.x = 0;
		look.y = 0;
		look.angle = PREVIEW_FACING;
		look.weapon = WEAPONS[0];
		look.swingReach = meleeReach(WEAPONS[0]);
		look.z = Z.player;
		const so = this.sun(0, 0, 10);
		look.shadowX = so.x;
		look.shadowY = so.y;

		// alone on its tile, the pet stands where the survivor would: at the centre of its own scene
		const pet = this.pet;
		pet.x = subject === "pet" ? 0 : PET_X;
		pet.y = subject === "pet" ? 0 : PET_Y;
		pet.angle = PREVIEW_FACING;
		pet.started = true;
	}

	/** OutfitLook to show (0 = the plain survivor) */
	setOutfit(outfit: number): void {
		this.look.outfit = outfit;
	}

	/** PetLook to show at the survivor's side (0 = none) */
	setPet(pet: number): void {
		this.petLook = pet;
	}

	/** the same, from EQUIPS ids — a wardrobe row, or the save's `equipOutfit` / `equipPet` (-1 = none) */
	setEquipped(outfitEquipId: number, petEquipId: number): void {
		this.look.outfit = outfitLookOfEquip(outfitEquipId);
		this.petLook = petLookOfEquip(petEquipId);
	}

	/** what is shown right now: [OutfitLook, PetLook] */
	showing(): [number, number] {
		return [this.look.outfit, this.petLook];
	}

	/**
	 * Draws the scene. Call it once after a change, or every frame with a running `clock` (seconds) for the idle
	 * tail wag; a frame where nothing moved writes no property at all (the renderer caches every value).
	 */
	draw(clock = 0): void {
		const r = this.renderer;
		r.beginFrame();
		this.look.clock = clock;
		const subject = this.subject;
		if (subject !== "outfit" && this.petLook !== PetLook.None) {
			drawPet(r, this.cam, this.pet, this.petLook, clock, this.sun);
		}
		if (subject !== "pet") drawSurvivor(r, this.cam, this.look, this.trail);
		r.endFrame();
	}

	/** how many sprites the last draw used (tests, and a sanity check for a wardrobe grid of previews) */
	spriteCount(): number {
		return this.renderer.drawCount();
	}

	destroy(): void {
		this.renderer.releaseAll();
		this.frame.Destroy();
	}
}

/** the looks a wardrobe can offer, in shop order: handy for building a grid of previews */
export const PREVIEW_OUTFITS = [OutfitLook.None, OutfitLook.Santa, OutfitLook.Zombie, OutfitLook.Cowboy];
export const PREVIEW_PETS = [
	PetLook.None,
	PetLook.Pigeon,
	PetLook.WhitePigeon,
	PetLook.Eagle,
	PetLook.Carolina,
	PetLook.Malamute,
	PetLook.Doberman,
];
