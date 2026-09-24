-- What a joining client downloads (docs/MULTIPLAYER.md §4.5 WorldInit), with the REAL compiled encoder
-- (shared/net/protocol encodeWorld / decodeWorld). The static town is never sent -- both sides generate it from the
-- seed -- so this does not depend on the town's size: only on what was built and what lies on the ground near the
-- newcomer. tools/bench-town.mjs runs it once.
--   luau -O2 wire.luau -a <mods dir relative to this file>
local rt = require("./rt")
local args = { ... }
rt.use(args[1])
local P = rt.import("shared/net/protocol")
local CFG = rt.import("shared/net/mpConfig")
local EV = P.WorldEv

local function batch(builds, machines, items, players)
	local ev = {}
	table.insert(ev, { t = EV.InitBegin, mapHash = 123456789, seed = 7331, tick0Time = 1700000000.25, simHz = 60, chunk = 0, chunks = 1 })
	table.insert(ev, { t = EV.Clock, worldDay = 14, dayTime = 21.5, tick = 1234, rain = false, waveFlags = 0 })
	for s = 0, players - 1 do
		table.insert(ev, { t = EV.PlayerJoined, slot = s, userId = 100000000 + s, name = "Survivor_" .. s .. "_abcdefgh", level = 40, outfit = 3, pet = 2, title = 5 })
	end
	for i = 1, builds do
		table.insert(ev, {
			t = EV.SolidAdd,
			id = CFG.DYNAMIC_ID_BASE + i,
			placeable = (i % 20) + 1,
			x = 5000 + (i % 40) * 64,
			y = 5000 + math.floor(i / 40) * 64,
			rot = i % 4,
			hp = 0.75,
			state = 0,
			owner = i % 6,
		})
	end
	for i = 1, machines do
		table.insert(ev, { t = EV.PowerSet, id = CFG.DYNAMIC_ID_BASE + i, state = 3, pilot = CFG.SLOT_NONE })
	end
	for i = 1, items do
		table.insert(ev, {
			t = EV.ItemAdd,
			id = CFG.DYNAMIC_ID_BASE + 100000 + i,
			kind = 4,
			itemId = 23,
			count = 2,
			x = 6000 + (i % 50) * 30,
			y = 6000 + math.floor(i / 50) * 30,
			vx = 0,
			vy = 0,
		})
	end
	return ev
end

local cases = {
	{ "empty server (clock + a roster of 6)", 0, 0, 0 },
	{ "a base: 60 builds, 10 machines, 80 items near", 60, 10, 80 },
	{ "a big base: 300 builds, 40 machines, 300 items near", 300, 40, 300 },
	{ "the caps: 600 builds (server), 150 machines, 1000 items (town)", CFG.MAX_BUILDS_PER_SERVER, 150, CFG.GROUND_ITEM_CAP },
}
for _, c in cases do
	local ev = batch(c[2], c[3], c[4], 6)
	local t0 = os.clock()
	local res = P.encodeWorld({ tick = 1234, events = ev })
	local enc = (os.clock() - t0) * 1000
	local bytes = 0
	for _, p in res.packets do
		bytes += buffer.len(p)
	end
	local t1 = os.clock()
	for _, p in res.packets do
		P.decodeWorld(p)
	end
	local dec = (os.clock() - t1) * 1000
	print(string.format("  WorldInit          %-62s %5d events, %d packet(s), %6d B, encode %.2f ms, decode %.2f ms",
		c[1], #ev, #res.packets, bytes, enc, dec))
end
