export const NET_FOLDER = "Net";
export const REMOTE_SAVE_REQUEST = "SaveRequest";
export const REMOTE_LOAD_REQUEST = "LoadRequest";
export const REMOTE_SAVE_ACK = "SaveAck";
export const REMOTE_LOAD_ACK = "LoadAck";
export const REMOTE_ANALYTICS = "Analytics";

export interface NetRemotes {
	saveRequest: RemoteEvent;
	loadRequest: RemoteEvent;
	saveAck: RemoteEvent;
	loadAck: RemoteEvent;
	analytics: RemoteEvent;
}

function ensureRemote(folder: Folder, name: string): RemoteEvent {
	let remote = folder.FindFirstChild(name);
	if (remote === undefined) {
		const created = new Instance("RemoteEvent");
		created.Name = name;
		created.Parent = folder;
		remote = created;
	}
	return remote as RemoteEvent;
}

export function getRemotes(): NetRemotes {
	const storage = game.GetService("ReplicatedStorage");
	let folder = storage.FindFirstChild(NET_FOLDER);
	if (folder === undefined) {
		const created = new Instance("Folder");
		created.Name = NET_FOLDER;
		created.Parent = storage;
		folder = created;
	}
	const net = folder as Folder;
	return {
		saveRequest: ensureRemote(net, REMOTE_SAVE_REQUEST),
		loadRequest: ensureRemote(net, REMOTE_LOAD_REQUEST),
		saveAck: ensureRemote(net, REMOTE_SAVE_ACK),
		loadAck: ensureRemote(net, REMOTE_LOAD_ACK),
		analytics: ensureRemote(net, REMOTE_ANALYTICS),
	};
}
