import { GAME_NAME } from "shared/module";
import { defaultSave, PlayerSaveData } from "shared/game/save";
import { getRemotes } from "shared/net/net";

const Players = game.GetService("Players");
const DataStoreService = game.GetService("DataStoreService");
const HttpService = game.GetService("HttpService");

const DATA_STORE_NAME = "ProjectZ_Save_v1";
const MAX_SAVE_LENGTH = 100000;
const AUTOSAVE_INTERVAL = 150 / 30;

const remotes = getRemotes();
const dataStore = DataStoreService.GetDataStore(DATA_STORE_NAME);
const sessions = new Map<Player, PlayerSaveData>();

function saveKey(player: Player): string {
	return tostring(player.UserId);
}

function decodeSave(raw: string): PlayerSaveData {
	const [ok, value] = pcall((): unknown => HttpService.JSONDecode(raw));
	if (ok && value !== undefined) {
		return value as PlayerSaveData;
	}
	return defaultSave();
}

function readSave(player: Player): PlayerSaveData {
	const [ok, raw] = pcall((): unknown => {
		const [value] = dataStore.GetAsync<string>(saveKey(player));
		return value;
	});
	if (ok && typeIs(raw, "string")) {
		return decodeSave(raw);
	}
	return defaultSave();
}

function writeSave(player: Player, save: PlayerSaveData): boolean {
	const json = HttpService.JSONEncode(save);
	if (json.size() >= MAX_SAVE_LENGTH) {
		return false;
	}
	const [ok] = pcall(() => {
		dataStore.SetAsync(saveKey(player), json);
	});
	return ok;
}

remotes.loadRequest.OnServerEvent.Connect(player => {
	const save = readSave(player);
	sessions.set(player, save);
	remotes.loadAck.FireClient(player, save);
});

remotes.saveRequest.OnServerEvent.Connect((player, saveJson) => {
	if (!typeIs(saveJson, "string") || saveJson.size() >= MAX_SAVE_LENGTH) {
		remotes.saveAck.FireClient(player, false);
		return;
	}
	const [ok] = pcall(() => {
		dataStore.SetAsync(saveKey(player), saveJson);
	});
	if (ok) {
		sessions.set(player, decodeSave(saveJson));
	}
	remotes.saveAck.FireClient(player, ok);
});

function onPlayerAdded(player: Player): void {
	const save = readSave(player);
	sessions.set(player, save);
}

Players.PlayerAdded.Connect(onPlayerAdded);
for (const player of Players.GetPlayers()) {
	onPlayerAdded(player);
}

Players.PlayerRemoving.Connect(player => {
	const save = sessions.get(player);
	if (save !== undefined) {
		writeSave(player, save);
	}
	sessions.delete(player);
});

task.spawn(() => {
	while (true) {
		task.wait(AUTOSAVE_INTERVAL);
		for (const [player, save] of sessions) {
			writeSave(player, save);
		}
	}
});

print(`[${GAME_NAME}] server ready`);
