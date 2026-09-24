-- The §3.2 server tick on a town of any size (tools/bench-town.mjs --tick): the REAL compiled ServerSimulation and
-- Replicator, six survivors walking in circles 3000 u from the centre (god mode), 150 zombies round them, 20 s.
--   luau -O2 --codegen tick.luau -a <mods dir relative to this file> <spread> <ticks>
local rt = require("./rt")
local args = { ... }
rt.use(args[1])
local spread = tonumber(args[2]) or 3000
local N = tonumber(args[3]) or 1200

local W = rt.import("shared/game/world")
local constants = rt.import("shared/engine/constants")
local simulationMod = rt.import("server/sim/simulation")
local serverPlayers = rt.import("server/sim/players")
local saveMod = rt.import("shared/game/save")
local entities = rt.import("shared/game/entities")
local replication = rt.import("server/net/replication")

math.randomseed(20260922)
local world = W.generateTown(constants.DESIGN.TOWN_SEED)
local sim = simulationMod.ServerSimulation.new({ world = world, zombies = true })
local horde = sim.horde
horde.clock:setClock(18.2, 20)
local cx, cy = world.width / 2, world.height / 2
for i = 0, 5 do
	local a = (i / 6) * math.pi * 2
	local spot = serverPlayers.findSpawnPoint(world, { allies = { { x = cx + math.cos(a) * spread, y = cy + math.sin(a) * spread } } })
	local sp = serverPlayers.createServerPlayer(
		{ slot = i, userId = 1000 + i, name = "bot" .. i },
		saveMod.defaultSave(),
		spot.x,
		spot.y,
		sim.tick,
		sim.simHz
	)
	sp.state.godMode = true
	sim:add(sp)
end
local roster = sim:players()
for i = 0, 149 do
	local p = roster[(i % #roster) + 1].state
	local a = (i / 150) * math.pi * 2 + (i % 7) * 0.13
	local r = 300 + ((i * 37) % 500)
	local ztype = (i % 11 == 0) and (2 + (i % 4)) or 1
	local z = entities.createZombie(ztype, p.x + math.cos(a) * r, p.y + math.sin(a) * r, 20, true)
	z.detect = true
	table.insert(horde.zombies, z)
end

local sent = 0
local transport = {}
function transport:snap(_slot, part)
	sent += buffer.len(part)
end
function transport:fx(_slot, packet)
	sent += buffer.len(packet)
end
function transport:world(_slot, packet)
	sent += buffer.len(packet)
end
function transport:worldAll(packet)
	sent += buffer.len(packet)
end
local rep = replication.Replicator.new(sim, transport, { tick0Time = 0, mapHash = replication.mapHashOf(world), seed = constants.DESIGN.TOWN_SEED })
sim.onTick = function(tick)
	rep:afterTick(tick)
end
sim.onFx = function(e)
	rep:queueFx(e)
end
for _, sp in roster do
	rep:welcome(sp)
end

local seq = 0
local function feed(t)
	seq += 1
	for i, sp in roster do
		sp.started = true
		local ang = ((t / 600) + i / 6) % 1
		table.insert(sp.queue, { seq = seq % 65536, moveAng = math.floor(ang * 256) % 256, moveMag = 255, aim = 0, held = 0, edges = 0 })
	end
end
sim:instrument(function()
	return os.clock() * 1000
end)
for t = 1, 120 do
	feed(t)
	sim:step()
end
local samples = table.create(N, 0)
local names, sums = {}, {}
for k in sim.cost do
	table.insert(names, k)
	sums[k] = 0
end
table.sort(names)
for t = 1, N do
	feed(120 + t)
	local t0 = os.clock()
	sim:step()
	samples[t] = (os.clock() - t0) * 1000
	for _, k in names do
		sums[k] += sim.cost[k]
	end
end
local sorted = table.clone(samples)
table.sort(sorted)
local total = 0
for _, v in samples do
	total += v
end
local parts = {}
for _, k in names do
	if sums[k] / N >= 0.01 then
		table.insert(parts, string.format("%s %.2f", k, sums[k] / N))
	end
end
print(string.format("  server tick        avg %.2f ms, p95 %.2f, p99 %.2f (%d zombies, field %d tiles) | %s | %.1f kB/s out per client",
	total / N, sorted[math.floor(N * 0.95)], sorted[math.floor(N * 0.99)], #horde.zombies, horde.field.lastTiles,
	table.concat(parts, ", "), sent / (N / sim.simHz) / #roster / 1000))
