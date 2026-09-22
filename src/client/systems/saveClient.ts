import { PlayerSaveData } from "shared/game/save";
import { NET_FOLDER, REMOTE_LOAD_ACK, REMOTE_LOAD_REQUEST, REMOTE_SAVE_REQUEST } from "shared/net/net";

const HttpService = game.GetService("HttpService");
const ReplicatedStorage = game.GetService("ReplicatedStorage");

const MAX_SAVE_LENGTH = 100000;

function netRemote(name: string): RemoteEvent {
	const folder = ReplicatedStorage.WaitForChild(NET_FOLDER) as Folder;
	return folder.WaitForChild(name) as RemoteEvent;
}

export async function loadPlayerSave(): Promise<PlayerSaveData | null> {
	const loadAck = netRemote(REMOTE_LOAD_ACK);
	const waiter = new Promise<PlayerSaveData | null>(resolve => {
		const conn = loadAck.OnClientEvent.Connect((save: PlayerSaveData) => {
			conn.Disconnect();
			resolve(save);
		});
	});
	netRemote(REMOTE_LOAD_REQUEST).FireServer();
	return await waiter;
}

export function persistSave(save: PlayerSaveData): void {
	const json = HttpService.JSONEncode(save);
	if (json.size() >= MAX_SAVE_LENGTH) {
		return;
	}
	netRemote(REMOTE_SAVE_REQUEST).FireServer(json);
}
