/*
 * Waiting for a TextChatService default channel, robustly.
 *
 * Both server/chat/proximityChat.ts and client/view/chatBubbles.ts need the exact same thing at boot:
 * TextChatService.TextChannels.RBXGeneral, which `TextChatService.CreateDefaultTextChannels` builds a MOMENT
 * after the channels folder itself exists, not at the same instant. A plain `Instance:WaitForChild(name,
 * timeout)` should cover that gap on its own, but real playtests logged "RBXGeneral not found" from both call
 * sites despite a generous 30 s budget -- the two-argument WaitForChild races its own timeout against the
 * ChildAdded signal it is listening for, and when the child is added the same frame the timeout also elapses,
 * the timeout can win the race and hand back undefined for a channel that exists a tick later. That is "losing
 * the race" against a channel Roblox was always going to create.
 *
 * `waitForChildRobust` removes the race outright: check what is already there FIRST (so an existing child is
 * never missed), THEN listen for `ChildAdded` (so a child that arrives mid-wait is never missed either), and
 * only give up once `timeoutS` real seconds have genuinely passed with nothing found. It is a coroutine the
 * caller starts with `task.spawn`, exactly like both call sites already do, so a slow or genuinely absent
 * TextChatService never holds up the rest of boot.
 */

/**
 * `parent:WaitForChild(name)`, immune to the timeout/ChildAdded race described above. Returns the child once
 * found, or undefined once `timeoutS` seconds have passed without one appearing.
 */
export function waitForChildRobust(parent: Instance, name: string, timeoutS: number): Instance | undefined {
	const existing = parent.FindFirstChild(name);
	if (existing !== undefined) return existing;
	let found: Instance | undefined;
	const conn = parent.ChildAdded.Connect(child => {
		if (found === undefined && child.Name === name) found = child;
	});
	const deadline = os.clock() + timeoutS;
	while (found === undefined && os.clock() < deadline) {
		task.wait(0.1);
	}
	conn.Disconnect();
	// one last look: `found` may still be unset if the deadline and the ChildAdded landed the same poll
	return found ?? parent.FindFirstChild(name);
}
