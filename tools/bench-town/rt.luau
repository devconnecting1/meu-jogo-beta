-- The roblox-ts runtime and the few Roblox globals the pure shared/server modules touch, for the Luau CLI
-- (tools/bench-town.mjs). Usage: local rt = require("./rt"); rt.use("../../.cache/bench-town/mods-1x");
-- local W = rt.import("shared/game/world")
--
-- Every module was written by bench-town.mjs as `return function(__rt) <module> end`: the CLI sandboxes each
-- module's globals, so the runtime and the Roblox globals it touches come in as locals. A module compiled with
-- `--!native` is written as itself (required: native under --codegen, like on a Roblox server); every other one as a
-- string that is `loadstring`ed (always interpreted, like the generator on the server and everything on a client).
local rt = {}
local RT = {}
local root = "./mods"
local manifest = {}
local cache = {}
local loading = {}
rt.nativeCount = 0

local PathMT = {}
PathMT.__index = function(self, k)
	if k == "Parent" then
		local p = rawget(self, "__path")
		local parent = string.match(p, "^(.*)/[^/]+$") or ""
		return setmetatable({ __path = parent }, PathMT)
	end
	return nil
end
local function path(p)
	return setmetatable({ __path = p }, PathMT)
end

local function load(mod)
	local m = cache[mod]
	if m ~= nil then
		return m
	end
	if loading[mod] then
		error("circular import of " .. mod)
	end
	loading[mod] = true
	local file = root .. "/" .. mod
	local wrapper
	if manifest[mod] then
		rt.nativeCount += 1
		wrapper = require(file)
	else
		local src = require(file)
		local fn, err = loadstring(src, "=" .. mod)
		if fn == nil then
			error(err)
		end
		wrapper = fn()
	end
	local value = wrapper(RT)
	loading[mod] = nil
	cache[mod] = value
	return value
end

local TS = {}
function TS.import(_context, parent, ...)
	local p = parent.__path
	for i = 1, select("#", ...) do
		p = p .. "/" .. select(i, ...)
	end
	p = string.gsub(p, "^RS/TS", "shared")
	p = string.gsub(p, "^SSS/TS", "server")
	p = string.gsub(p, "^/", "")
	if manifest[p] == nil and manifest[p .. "/init"] ~= nil then
		p = p .. "/init"
	end
	if manifest[p] == nil then
		error("no module " .. p)
	end
	return load(p)
end
RT.TS = TS
RT.script = function(p)
	return path((string.gsub(p, "/init$", "")))
end
RT.game = {
	GetService = function(_, name)
		if name == "ReplicatedStorage" then
			return path("RS")
		end
		if name == "ServerScriptService" then
			return path("SSS")
		end
		return setmetatable({}, {
			__index = function()
				return function() end
			end,
		})
	end,
}

local Color3 = {}
Color3.__index = Color3
function Color3.new(r, g, b)
	return setmetatable({ R = r or 0, G = g or 0, B = b or 0 }, Color3)
end
function Color3.fromRGB(r, g, b)
	return Color3.new(r / 255, g / 255, b / 255)
end
function Color3.fromHSV(h, s, v)
	local i = math.floor(h * 6)
	local f = h * 6 - i
	local p, q, t = v * (1 - s), v * (1 - f * s), v * (1 - (1 - f) * s)
	local m = ({ { v, t, p }, { q, v, p }, { p, v, t }, { p, q, v }, { t, p, v }, { v, p, q } })[(i % 6) + 1]
	return Color3.new(m[1], m[2], m[3])
end
function Color3.fromHex(_)
	return Color3.new(0, 0, 0)
end
function Color3:Lerp(o, k)
	return Color3.new(self.R + (o.R - self.R) * k, self.G + (o.G - self.G) * k, self.B + (o.B - self.B) * k)
end
function Color3:ToHSV()
	return 0, 0, 0
end
RT.Color3 = Color3
RT.Vector2 = {
	new = function(x, y)
		return { X = x or 0, Y = y or 0 }
	end,
}
RT.UDim2 = {
	new = function(...)
		return { ... }
	end,
	fromOffset = function(...)
		return { ... }
	end,
	fromScale = function(...)
		return { ... }
	end,
}
local RandomMT = {}
RandomMT.__index = RandomMT
function RandomMT:NextNumber(a, b)
	a = a or 0
	b = b or 1
	return a + math.random() * (b - a)
end
function RandomMT:NextInteger(a, b)
	return math.random(a, b)
end
RT.Random = {
	new = function(_)
		return setmetatable({}, RandomMT)
	end,
}
RT.warn = function(...)
	print("WARN", ...)
end
RT.debug = {
	traceback = function(m)
		return tostring(m)
	end,
	profilebegin = function(_) end,
	profileend = function() end,
}
RT.task = {}

--- `dir` relative to this file (a require path: "./x" or "../x")
function rt.use(dir)
	root = (string.sub(dir, 1, 1) == ".") and dir or ("./" .. dir)
	manifest = require(root .. "/manifest")
	cache = {}
end

function rt.import(mod)
	return load(mod)
end

return rt
