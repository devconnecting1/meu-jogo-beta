--[[
	Studio smoke check — the boundary the Node tests cannot see.

	Run it in the CLIENT datamodel of a Play session (Roblox Studio MCP: execute_luau). It returns one
	verdict plus a line per check, so a Studio pass costs one command instead of a session of clicking.

	WHY THIS EXISTS, and what belongs here rather than in tools/test-*.mjs:

	The node suite transpiles our TypeScript and runs it under V8. That covers every rule, number, protocol
	and cadence in the game, and it runs on every push. What it structurally cannot see is the edge where
	our code meets the engine — and that edge is where this project's worst bugs have lived:

	  · the client not booting at all, because a module chunk passed Luau's 200-local limit (the build was
	    green: TypeScript has no such rule, and V8 does not either);
	  · the UI skin falling back to the flat look on every boot, because ContentProvider reports Failure for
	    a content STRING where it succeeds for the ImageLabel that shows it;
	  · every snapshot being discarded because nothing had connected OnClientEvent;
	  · a player standing in the street while sitting in the lobby;
	  · assets that load in Edit and not in Play, and the other way round.

	So the rule of thumb this file encodes: if it can be proved without the engine, it belongs in
	tools/test-*.mjs and in CI. What is left here is "does it boot, is it drawn, does it load, does it run".

	It never starts or stops the session, never touches the save, and leaves nothing behind.
]]

local ContentProvider = game:GetService("ContentProvider")
local Players = game:GetService("Players")
local ReplicatedStorage = game:GetService("ReplicatedStorage")
local RunService = game:GetService("RunService")
local SoundService = game:GetService("SoundService")
local Workspace = game:GetService("Workspace")

--- how many frames to sample for the frame-rate reading (a short window: the MCP call cannot yield long)
local FRAME_SAMPLES = 20
--- the mixer builds this many voices (client/audio/audio.ts)
local EXPECTED_VOICES = 30
--- below this the client itself is stuttering, and everything on screen will read as a teleport
local FPS_FLOOR = 30

local lines = {}
local failures = 0
local warnings = 0

local function pass(name, detail)
	table.insert(lines, string.format("  ok    %s%s", name, detail and ("  (" .. detail .. ")") or ""))
end

local function fail(name, detail)
	failures += 1
	table.insert(lines, string.format("  FALHA %s%s", name, detail and ("  (" .. detail .. ")") or ""))
end

local function warnLine(name, detail)
	warnings += 1
	table.insert(lines, string.format("  aviso %s%s", name, detail and ("  (" .. detail .. ")") or ""))
end

local function check(ok, name, detail)
	if ok then
		pass(name, detail)
	else
		fail(name, detail)
	end
end

-- ---------------------------------------------------------------- 1. the client booted

table.insert(lines, "1) o cliente subiu")

local player = Players.LocalPlayer
check(player ~= nil, "LocalPlayer existe", player and player.Name or nil)

local gui = player and player:FindFirstChild("PlayerGui") and player.PlayerGui:FindFirstChild("GameGui")
check(gui ~= nil, "GameGui montada")

local root = gui and gui:FindFirstChild("Root")
check(root ~= nil, "Root da interface presente")

-- main.client.ts prints "client ready" on its LAST line: if the modules had failed to load, every require
-- above it would have failed too and nothing would be on screen
local ready = false
do
	local ok, history = pcall(function()
		return game:GetService("LogService"):GetLogHistory()
	end)
	if ok and #history > 0 then
		for _, e in ipairs(history) do
			if string.find(e.message, "client ready", 1, true) then
				ready = true
			end
		end
		check(ready, "main.client chegou ao fim (client ready)")
	else
		warnLine("main.client chegou ao fim", "LogService vazio neste contexto — leia o console pelo MCP")
	end
end

-- ---------------------------------------------------------------- 2. duplicated modules (the Rojo hazard)

table.insert(lines, "2) modulos sem duplicata")

local dups = {}
local function scanDup(inst)
	local seen = {}
	for _, c in ipairs(inst:GetChildren()) do
		seen[c.Name] = (seen[c.Name] or 0) + 1
		if seen[c.Name] == 2 then
			table.insert(dups, inst:GetFullName() .. " -> " .. c.Name)
		end
		scanDup(c)
	end
end
for _, r in ipairs({ ReplicatedStorage:FindFirstChild("TS"), player and player:FindFirstChild("PlayerScripts") }) do
	if r ~= nil then
		scanDup(r)
	end
end
-- a file created while Rojo is connected can land twice; both copies load, and the stale one wins later
check(#dups == 0, "nenhum modulo duplicado", #dups > 0 and table.concat(dups, ", ") or nil)

-- ---------------------------------------------------------------- 3. the interface is actually drawn

table.insert(lines, "3) a interface esta desenhada")

local images, withTexture, visible = 0, 0, 0
if root ~= nil then
	for _, d in ipairs(root:GetDescendants()) do
		if d:IsA("ImageLabel") or d:IsA("ImageButton") then
			images += 1
			if d.Image ~= "" then
				withTexture += 1
			end
			if d.Visible and d.ImageTransparency < 1 then
				visible += 1
			end
		end
	end
end
-- the pixel-bevel skin is 9-slice ImageLabels: none of them textured means the flat fallback took over
check(withTexture > 0, "skin com textura", string.format("%d de %d imagens, %d visiveis", withTexture, images, visible))

-- ---------------------------------------------------------------- 4. audio

table.insert(lines, "4) audio")

local audioRoot = SoundService:FindFirstChild("LastTownAudio")
check(audioRoot ~= nil, "mixer montado (LastTownAudio)")
if audioRoot ~= nil then
	local buses = {}
	for _, g in ipairs(audioRoot:GetChildren()) do
		if g:IsA("SoundGroup") then
			table.insert(buses, string.format("%s=%.2f", g.Name, g.Volume))
		end
	end
	check(#buses == 3, "tres barramentos", table.concat(buses, " "))

	local voices = 0
	for _, d in ipairs(audioRoot:GetDescendants()) do
		if d:IsA("Sound") then
			voices += 1
		end
	end
	local emitter = Workspace:FindFirstChild("LastTownAudioEmitters")
	if emitter ~= nil then
		for _, a in ipairs(emitter:GetDescendants()) do
			if a:IsA("Sound") then
				voices += 1
			end
		end
	end
	check(voices >= EXPECTED_VOICES, "reserva de vozes", string.format("%d (esperado >= %d)", voices, EXPECTED_VOICES))
	check(emitter ~= nil, "emissor espacial presente")
end

-- ---------------------------------------------------------------- 5. assets really load

table.insert(lines, "5) assets carregam nesta sessao")
do
	-- ContentProvider answers Failure for a content STRING where the ImageLabel that shows it succeeds, so
	-- always preload the INSTANCE (client/ui/skin.ts learned this the hard way)
	local holder = Instance.new("Folder")
	holder.Parent = ContentProvider
	local probes = {}
	if root ~= nil then
		for _, d in ipairs(root:GetDescendants()) do
			if (d:IsA("ImageLabel") or d:IsA("ImageButton")) and d.Image ~= "" and #probes < 3 then
				local copy = Instance.new("ImageLabel")
				copy.Image = d.Image
				copy.Parent = holder
				table.insert(probes, copy)
			end
		end
	end
	if #probes == 0 then
		warnLine("assets", "nenhuma textura na tela para sondar")
	else
		local bad = 0
		pcall(function()
			ContentProvider:PreloadAsync(probes, function(_, status)
				if status ~= Enum.AssetFetchStatus.Success then
					bad += 1
				end
			end)
		end)
		check(bad == 0, "texturas da tela carregam", string.format("%d de %d falharam", bad, #probes))
	end
	holder:Destroy()
end

-- ---------------------------------------------------------------- 6. multiplayer wiring

table.insert(lines, "6) rede")
do
	local folder = ReplicatedStorage:FindFirstChild("Net")
	if folder == nil then
		warnLine("remotes", "pasta Net ausente — MP_PHASE = 0 ou host fora do ar")
	else
		local missing = {}
		for _, name in ipairs({ "Input", "Intent", "Snap", "World", "TimeSync" }) do
			if folder:FindFirstChild(name) == nil then
				table.insert(missing, name)
			end
		end
		check(#missing == 0, "remotes criados", #missing > 0 and ("faltam " .. table.concat(missing, ", ")) or nil)
	end
end

-- ---------------------------------------------------------------- 7. the client's own frame rate

table.insert(lines, "7) ritmo do cliente")
do
	local worst = 0
	local total = 0
	local t0 = os.clock()
	for _ = 1, FRAME_SAMPLES do
		local a = os.clock()
		RunService.Heartbeat:Wait()
		local d = os.clock() - a
		total += d
		if d > worst then
			worst = d
		end
	end
	local fps = FRAME_SAMPLES / math.max(1e-6, os.clock() - t0)
	-- perfect interpolation still reads as a teleport when the client only draws a few times a second:
	-- a 150 ms frame moves an ally 31 u in one step, correctly (tools/test-smoothness.mjs case 5)
	check(fps >= FPS_FLOOR, "taxa de quadros", string.format("%.0f fps, pior quadro %.0f ms", fps, worst * 1000))
end

-- ---------------------------------------------------------------- verdict

local head
if failures > 0 then
	head = string.format("FALHOU: %d verificacao(oes), %d aviso(s)", failures, warnings)
else
	head = string.format("PASSOU%s", warnings > 0 and string.format(" com %d aviso(s)", warnings) or "")
end
return head .. "\n" .. table.concat(lines, "\n")
