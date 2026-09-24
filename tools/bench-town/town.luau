-- One town on the REAL compiled generator (tools/bench-town.mjs): generation time, its pace steps, heap, counts,
-- the spatial grids, and the work that grows with the town (the O(solids) walks, the ground's cull loop).
--   luau -O2 town.luau -a <mods dir relative to this file> <seed> <reps>
-- Run WITHOUT --codegen: the generator is interpreted on a Roblox server too (world.luau has no --!native), and the
-- walks below model client code, which is never native.
local rt = require("./rt")
local args = { ... }
local dir = args[1]
local seed = tonumber(args[2]) or 7331
local reps = tonumber(args[3]) or 3
rt.use(dir)
local W = rt.import("shared/game/world")

local function heap()
	collectgarbage("collect")
	collectgarbage("collect")
	return collectgarbage("count")
end

-- 1. generation: min over `reps` (a shared box's wall time only ever adds), with every `pace` step timed
local best, bestSteps = math.huge, nil
local world
for _ = 1, reps do
	world = nil
	heap()
	local steps = {}
	local last = os.clock()
	local t0 = last
	world = W.generateTown(seed, function()
		local now = os.clock()
		table.insert(steps, (now - last) * 1000)
		last = now
	end)
	local ms = (os.clock() - t0) * 1000
	table.insert(steps, (os.clock() - last) * 1000)
	if ms < best then
		best, bestSteps = ms, steps
	end
end
local head = bestSteps[1]
local tail = bestSteps[#bestSteps]
local mid = {}
local midSum = 0
for i = 2, #bestSteps - 1 do
	table.insert(mid, bestSteps[i])
	midSum += bestSteps[i]
end
table.sort(mid)
local function pct(t, p)
	return t[math.max(1, math.floor(#t * p))] or 0
end

world = nil
local h0 = heap()
world = W.generateTown(seed)
local townKB = heap() - h0

local kinds, buildings, rooms, loot = {}, 0, 0, 0
local btypes = {}
for _, s in world.solids do
	kinds[s.kind] = (kinds[s.kind] or 0) + 1
	if s.kind == "building" then
		buildings += 1
		rooms += s.rooms and #s.rooms or 0
		loot += s.lootSpots and #s.lootSpots or 0
		local t = s.buildingType or 0
		btypes[t] = (btypes[t] or 0) + 1
	end
end
local kl = {}
for k, n in kinds do
	table.insert(kl, k .. " " .. n)
end
table.sort(kl)
local bl = {}
for t, n in btypes do
	table.insert(bl, "t" .. t .. " " .. n)
end
table.sort(bl)
local function gridStats(g)
	local used, entries = 0, 0
	for _, c in g.cells do
		if #c > 0 then
			used += 1
			entries += #c
		end
	end
	return g.cols * g.rows, used, entries
end
local gc, gu, ge = gridStats(world.grid)
local fc, fu, fe = gridStats(world.fine)

print(string.format("town %d x %d u (%.0f Mu2), seed %d", world.width, world.height, world.width * world.height / 1e6, seed))
print(string.format("  generation         %8.1f ms (min of %d)   head %.1f ms, %d building steps: avg %.2f p50 %.2f p95 %.2f max %.2f ms, tail %.1f ms",
	best, reps, head, #mid, midSum / math.max(1, #mid), pct(mid, 0.5), pct(mid, 0.95), mid[#mid] or 0, tail))
print(string.format("  heap               %8.0f KB", townKB))
print(string.format("  solids %d, buildings %d (%s), rooms %d, loot spots %d", #world.solids, buildings, table.concat(bl, ", "), rooms, loot))
print("  kinds              " .. table.concat(kl, ", "))
print(string.format("  roads %d, lots %d, junctions %d, crossings %d", #world.roads, #world.lots, #world.junctions, #world.crossings))
print(string.format("  grid 512 u         %d cells, %d used, %d entries | fine 128 u: %d cells, %d used, %d entries", gc, gu, ge, fc, fu, fe))

-- 2. what grows with the town, per call (min of many)
local function minus(n, fn)
	local b = math.huge
	for _ = 1, n do
		local t0 = os.clock()
		fn()
		b = math.min(b, os.clock() - t0)
	end
	return b * 1e6
end
local CAMP = { "campfire", "brazier", "craftdesk", "craftdesk_pro", "gps" }
local function includes(t, v)
	for _, x in t do
		if x == v then
			return true
		end
	end
	return false
end
local sink = 0
local scan = minus(100, function()
	for _, s in world.solids do
		if s.tags == "trap" or s.tags == "trap_electric" then
			sink += 1
			break
		end
	end
end)
local camp = minus(100, function()
	local bd = math.huge
	for _, s in world.solids do
		if s.removed ~= true and includes(CAMP, s.tags) then
			local d = s.x * s.x + s.y * s.y
			if d < bd then
				bd = d
			end
		end
	end
end)
local fires = minus(100, function()
	local n = 0
	for _, s in world.solids do
		if s.removed ~= true and s.tags == "campfire" then
			n += 1
		end
	end
	sink += n
end)
local cx, cy = world.width / 2, world.height / 2
local vx0, vy0, vw, vh = cx - 1100, cy - 650, 2200, 1300
local function overlaps(x, y, w, h)
	return x < vx0 + vw and x + w > vx0 and y < vy0 + vh and y + h > vy0
end
local ground = minus(500, function()
	local n = 0
	for _, lot in world.lots do
		if overlaps(lot.x, lot.y, lot.w, lot.h) then
			n += 1
		end
	end
	for _, road in world.roads do
		if overlaps(road.x, road.y, road.w, road.h) then
			for _, j in world.junctions do
				if (road.vertical and j.x == road.x) or (not road.vertical and j.y == road.y) then
					n += 1
				end
			end
		end
	end
	for _, c in world.crossings do
		if overlaps(c.x, c.y, c.w, c.h) then
			n += 1
		end
	end
	sink += n
end)
local list = {}
local query = minus(500, function()
	table.clear(list)
	W.querySolids(world, vx0 - 400, vy0 - 400, vx0 + vw + 400, vy0 + vh + 400, list)
end)
print(string.format("  O(solids) walks    scanTraps %.0f us | compass nearestCamp %.0f us | lesson countCampfires %.0f us", scan, camp, fires))
print(string.format("  one screen's cull  ground loop (lots, roads x junctions, crossings) %.1f us | querySolids +400 u %.1f us (%d solids)", ground, query, #list))
