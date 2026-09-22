export interface ShopPack {
	id: number;
	name: string;
	contents: string;
	price: number;
}

export const SHOP_PACKS: Array<ShopPack> = [
	{ id: 0, name: "Starter pack", contents: "Cotton clothes X 1#Axe X 1#Flashlight X 1", price: 20 },
	{ id: 1, name: "Food aid", contents: "Cooked meat X 3#Pizza X 3#Cooked meal X 3", price: 20 },
	{ id: 2, name: "Emergency kit", contents: "First aid kit X 2#Bandage X 3#Adrenaline X 2", price: 30 },
	{ id: 3, name: "Basic craft kit", contents: "Wood X 20#Cloth X 10#Stone X 20", price: 10 },
	{ id: 4, name: "Pro craft kit", contents: "Blueprint X 5#Steel X 20#Machine parts X 10", price: 20 },
	{ id: 5, name: "Electric craft kit", contents: "Battery X 5#Computer chip X 2#Bulb X 2", price: 20 },
	{ id: 6, name: "Ammo craft kit", contents: "Steel X 10#Gunpowder X 10", price: 20 },
	{ id: 7, name: "Pigeon the bird", contents: "Pigeon the bird X 1", price: 10 },
	{ id: 8, name: "Carolina the dog", contents: "Carolina the dog X 1", price: 10 },
];

export interface CoinPack {
	id: number;
	name: string;
	productId: string;
	coins: number;
	bonus: number;
	usd: string;
	krw: string;
}

export const COIN_PACKS: Array<CoinPack> = [
	{ id: 0, name: "5 coins", productId: "", coins: 5, bonus: 0, usd: "", krw: "" },
	{ id: 1, name: "100 coins", productId: "100coins", coins: 100, bonus: 0, usd: "US $ 0.99", krw: "1000 원" },
	{ id: 2, name: "300 + 30 coins", productId: "300coins", coins: 300, bonus: 30, usd: "US $ 2.99", krw: "2900 원" },
	{ id: 3, name: "600 + 100 coins", productId: "600coins", coins: 600, bonus: 100, usd: "US $ 5.99", krw: "5900 원" },
	{
		id: 4,
		name: "1000 + 300 coins",
		productId: "1000coins",
		coins: 1000,
		bonus: 300,
		usd: "US $ 9.99",
		krw: "9900 원",
	},
];

export interface CostumeDef {
	id: number;
	name: string;
	productId: string;
	usd: string;
	krw: string;
}

export const COSTUMES: Array<CostumeDef> = [
	{ id: 0, name: "Pigeon", productId: "pigeon", usd: "US $ 0.99", krw: "1000 원" },
	{ id: 1, name: "White pigeon", productId: "whitepigeon", usd: "US $ 0.99", krw: "1000 원" },
	{ id: 2, name: "Eagle", productId: "eagle", usd: "US $ 1.99", krw: "1900 원" },
	{ id: 3, name: "Carolina", productId: "carolina", usd: "US $ 0.99", krw: "1000 원" },
	{ id: 4, name: "Malamute", productId: "malamute", usd: "US $ 0.99", krw: "1000 원" },
	{ id: 5, name: "Doberman", productId: "doberman", usd: "US $ 0.99", krw: "1000 원" },
	{ id: 6, name: "Santa", productId: "santa", usd: "US $ 0.99", krw: "1000 원" },
	{ id: 7, name: "Zombie", productId: "zombie", usd: "US $ 0.99", krw: "1000 원" },
	{ id: 8, name: "Cowboy", productId: "cowboy", usd: "US $ 0.99", krw: "1000 원" },
];
