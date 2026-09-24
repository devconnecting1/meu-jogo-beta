-- The server's chase field on a town of any size (tools/bench-town.mjs), with --codegen like a Roblox server
-- (server/sim/flowField.luau is --!native):
--   1. a full rebuild with six survivors 3000 u apart round the centre (docs/MULTIPLAYER.md §3.3's worst case);
--   2. the tile cache after the survivors have been everywhere: `MultiFlowField.tiles` is never evicted, so this is
--      the field's memory at the end of a long session.
--   luau -O2 --codegen field.luau -a <mods dir relative to this file> <seed>
local rt = require("./rt")
local args = { ... }
rt.use(args[1])
local seed = tonumber(args[2]) or 7331
local W = rt.import("shared/game/world")
local FF = rt.import("server/sim/flowField")
local serverPlayers = rt.import("server/sim/players")

math.randomseed(20260924)
local world = W.generateTown(seed)
local cx, cy = world.width / 2, world.height / 2
local sources = {}
for i = 0, 5 do
	local a = (i / 6) * math.pi * 2
	local spot = serverPlayers.findSpawnPoint(world, { allies = { { x = cx + math.cos(a) * 3000, y = cy + math.sin(a) * 3000 } } })
	table.insert(sources, { x = spot.x, y = spot.y, index = i, seed = 0 })
end
local f = FF.MultiFlowField.new()
f:rebuild(world, sources)
local best = math.huge
for _ = 1, 3 do
	local t0 = os.clock()
	f:startRebuild(world, sources)
	f:step(1e9)
	best = math.min(best, os.clock() - t0)
end
print(string.format("  flow field         full rebuild, 6 survivors 3000 u apart: %d tiles, %d cells, %.1f ms (%.2f us/cell)",
	f.lastTiles, f.lastCells, best * 1000, best * 1e6 / math.max(1, f.lastCells)))

collectgarbage("collect")
local before = collectgarbage("count")
local g = FF.MultiFlowField.new()
local pts = {}
for y = 700, world.height - 700, 2048 do
	for x = 700, world.width - 700, 2048 do
		table.insert(pts, { x = x, y = y })
	end
end
for i = 1, #pts, 6 do
	local src = {}
	for k = 0, 5 do
		local p = pts[i + k]
		if p ~= nil then
			table.insert(src, { x = p.x, y = p.y, index = k, seed = 0 })
		end
	end
	g:startRebuild(world, src)
	g:step(1e9)
end
collectgarbage("collect")
local kb = collectgarbage("count") - before
local n = 0
for _ in g.tiles do
	n += 1
end
print(string.format("  flow field cache   after visiting the whole town: %d tiles, %.1f MB (never evicted)", n, kb / 1024))
