-- AI Agent Bridge — بلجن Roblox Studio
-- الحفظ: انسخ الكود في Script جديد > كليك يمين > Save as Local Plugin
-- ملاحظة: عند أول اتصال سيطلب Studio موافقتك على السماح للبلجن بالاتصال بالرابط

local HttpService = game:GetService("HttpService")
local Selection = game:GetService("Selection")
local ChangeHistoryService = game:GetService("ChangeHistoryService")

-- غيّر الرابط إلى رابط موقعك بعد النشر (https://...)
local BASE_URL = "http://localhost:3000"

------------------------------------------------------------
-- واجهة صغيرة: كود الاتصال + زر Connect
------------------------------------------------------------
local toolbar = plugin:CreateToolbar("AI Agent")
local toggleBtn = toolbar:CreateButton("AI Agent", "ربط Studio بموقع الذكاء الاصطناعي", "rbxassetid://0")

local widget = plugin:CreateDockWidgetPluginGui(
	"AIAgentBridge",
	DockWidgetPluginGuiInfo.new(Enum.InitialDockState.Right, false, false, 300, 220, 260, 200)
)
widget.Title = "AI Agent"
toggleBtn.Click:Connect(function()
	widget.Enabled = not widget.Enabled
end)

local root = Instance.new("Frame")
root.Size = UDim2.fromScale(1, 1)
root.BackgroundColor3 = Color3.fromRGB(37, 37, 37)
root.BorderSizePixel = 0
root.Parent = widget

local layout = Instance.new("UIListLayout")
layout.Padding = UDim.new(0, 8)
layout.Parent = root
local pad = Instance.new("UIPadding")
pad.PaddingTop, pad.PaddingLeft, pad.PaddingRight = UDim.new(0, 10), UDim.new(0, 10), UDim.new(0, 10)
pad.Parent = root

local title = Instance.new("TextLabel")
title.Size = UDim2.new(1, 0, 0, 20)
title.BackgroundTransparency = 1
title.TextColor3 = Color3.new(1, 1, 1)
title.TextXAlignment = Enum.TextXAlignment.Left
title.Font = Enum.Font.SourceSansBold
title.TextSize = 16
title.Text = "Connection code (from the website)"
title.Parent = root

local codeBox = Instance.new("TextBox")
codeBox.Size = UDim2.new(1, 0, 0, 34)
codeBox.BackgroundColor3 = Color3.fromRGB(20, 20, 20)
codeBox.TextColor3 = Color3.fromRGB(245, 197, 24)
codeBox.PlaceholderText = "XXXXXXXX"
codeBox.Font = Enum.Font.Code
codeBox.TextSize = 18
codeBox.ClearTextOnFocus = false
codeBox.Text = plugin:GetSetting("agent_code") or ""
codeBox.Parent = root

local connectBtn = Instance.new("TextButton")
connectBtn.Size = UDim2.new(1, 0, 0, 34)
connectBtn.BackgroundColor3 = Color3.fromRGB(0, 120, 215)
connectBtn.TextColor3 = Color3.new(1, 1, 1)
connectBtn.Font = Enum.Font.SourceSansBold
connectBtn.TextSize = 16
connectBtn.Text = "Connect"
connectBtn.Parent = root

local statusLabel = Instance.new("TextLabel")
statusLabel.Size = UDim2.new(1, 0, 0, 40)
statusLabel.BackgroundTransparency = 1
statusLabel.TextColor3 = Color3.fromRGB(170, 170, 170)
statusLabel.TextWrapped = true
statusLabel.TextXAlignment = Enum.TextXAlignment.Left
statusLabel.TextYAlignment = Enum.TextYAlignment.Top
statusLabel.TextSize = 14
statusLabel.Text = "Not connected"
statusLabel.Parent = root

local function setStatus(text, color)
	statusLabel.Text = text
	statusLabel.TextColor3 = color or Color3.fromRGB(170, 170, 170)
end

------------------------------------------------------------
-- أدوات مساعدة
------------------------------------------------------------
local function post(path, body)
	local ok, res = pcall(function()
		return HttpService:RequestAsync({
			Url = BASE_URL .. path,
			Method = "POST",
			Headers = { ["Content-Type"] = "application/json" },
			Body = HttpService:JSONEncode(body),
		})
	end)
	if not ok then
		return false, tostring(res)
	end
	if not res.Success then
		return false, res.StatusCode .. " " .. tostring(res.Body)
	end
	return true, HttpService:JSONDecode(res.Body)
end

local function resolve(path)
	if type(path) ~= "string" or path == "" then
		return nil
	end
	local parts = string.split(path, ".")
	local ok, current = pcall(function()
		return game:GetService(parts[1])
	end)
	if not ok then
		return nil
	end
	for i = 2, #parts do
		current = current and current:FindFirstChild(parts[i])
	end
	return current
end

local function serialize(v)
	local t = typeof(v)
	if t == "Vector3" then
		return { v.X, v.Y, v.Z }
	elseif t == "Vector2" then
		return { v.X, v.Y }
	elseif t == "Color3" then
		return { math.round(v.R * 255), math.round(v.G * 255), math.round(v.B * 255) }
	elseif t == "EnumItem" then
		return v.Name
	elseif t == "Instance" then
		return v:GetFullName()
	elseif t == "CFrame" then
		return { v.X, v.Y, v.Z }
	elseif t == "UDim2" then
		return { v.X.Scale, v.X.Offset, v.Y.Scale, v.Y.Offset }
	elseif t == "BrickColor" then
		return v.Name
	elseif t == "string" or t == "number" or t == "boolean" then
		return v
	end
	return tostring(v)
end

local function convert(current, value)
	local t = typeof(current)
	if t == "Vector3" and type(value) == "table" then
		return Vector3.new(value[1], value[2], value[3])
	elseif t == "Vector2" and type(value) == "table" then
		return Vector2.new(value[1], value[2])
	elseif t == "Color3" and type(value) == "table" then
		return Color3.fromRGB(value[1], value[2], value[3])
	elseif t == "BrickColor" then
		return BrickColor.new(value)
	elseif t == "EnumItem" then
		return current.EnumType[value]
	elseif t == "CFrame" and type(value) == "table" then
		return CFrame.new(value[1], value[2], value[3])
	elseif t == "UDim2" and type(value) == "table" then
		return UDim2.new(value[1], value[2], value[3], value[4])
	elseif t == "UDim" and type(value) == "table" then
		return UDim.new(value[1], value[2])
	elseif t == "Instance" and type(value) == "string" then
		return resolve(value)
	end
	return value
end

local function setProps(inst, props)
	for name, value in pairs(props or {}) do
		local current = inst[name] -- يرمي خطأ إن كانت الخاصية غير موجودة
		inst[name] = convert(current, value)
	end
end

local function tree(inst, depth, budget)
	local node = { name = inst.Name, class = inst.ClassName }
	local kids = inst:GetChildren()
	if #kids > 0 then
		if depth > 0 then
			node.children = {}
			for _, c in ipairs(kids) do
				if budget.n <= 0 then
					node.truncated = true
					break
				end
				budget.n -= 1
				table.insert(node.children, tree(c, depth - 1, budget))
			end
		else
			node.childCount = #kids
		end
	end
	return node
end

------------------------------------------------------------
-- تنفيذ الأدوات
------------------------------------------------------------
local tools = {}
local MUTATING = { create_instance = true, set_properties = true, set_script_source = true, delete_instance = true }

tools.get_explorer = function(a)
	local inst = resolve(a.path)
	assert(inst, "Path not found: " .. tostring(a.path))
	local depth = math.clamp(a.depth or 2, 0, 6)
	return { tree = tree(inst, depth, { n = 400 }) }
end

tools.get_selection = function()
	local out = {}
	for i, inst in ipairs(Selection:Get()) do
		if i > 30 then
			break
		end
		table.insert(out, { path = inst:GetFullName(), class = inst.ClassName })
	end
	return { selection = out }
end

tools.read_script = function(a)
	local inst = resolve(a.path)
	assert(inst and inst:IsA("LuaSourceContainer"), "Script not found: " .. tostring(a.path))
	return { class = inst.ClassName, source = inst.Source }
end

tools.get_properties = function(a)
	local inst = resolve(a.path)
	assert(inst, "Path not found: " .. tostring(a.path))
	local out = {}
	for _, name in ipairs(a.properties or {}) do
		local ok, v = pcall(function()
			return inst[name]
		end)
		out[name] = ok and serialize(v) or "<no such property>"
	end
	return { properties = out }
end

tools.create_instance = function(a)
	local parent = resolve(a.parent)
	assert(parent, "Parent not found: " .. tostring(a.parent))
	local inst = Instance.new(a.className)
	if a.name then
		inst.Name = a.name
	end
	if a.source and inst:IsA("LuaSourceContainer") then
		inst.Source = a.source
	end
	setProps(inst, a.properties)
	inst.Parent = parent
	return { path = inst:GetFullName() }
end

tools.set_properties = function(a)
	local inst = resolve(a.path)
	assert(inst, "Path not found: " .. tostring(a.path))
	setProps(inst, a.properties)
	return { path = inst:GetFullName() }
end

tools.set_script_source = function(a)
	local inst = resolve(a.path)
	assert(inst and inst:IsA("LuaSourceContainer"), "Script not found: " .. tostring(a.path))
	inst.Source = a.source
	return { path = inst:GetFullName(), bytes = #a.source }
end

tools.delete_instance = function(a)
	local inst = resolve(a.path)
	assert(inst, "Path not found: " .. tostring(a.path))
	assert(inst ~= workspace and inst.Parent ~= game, "Refusing to delete a service")
	inst:Destroy()
	return { deleted = a.path }
end

local function execute(cmd)
	local fn = tools[cmd.tool]
	if not fn then
		return { ok = false, error = "Unknown tool: " .. tostring(cmd.tool) }
	end
	local recording
	if MUTATING[cmd.tool] then
		recording = ChangeHistoryService:TryBeginRecording("AI: " .. cmd.tool)
	end
	local ok, result = pcall(fn, cmd.args or {})
	if recording then
		ChangeHistoryService:FinishRecording(
			recording,
			ok and Enum.FinishRecordingOperation.Commit or Enum.FinishRecordingOperation.Cancel
		)
	end
	if ok then
		result = result or {}
		result.ok = true
		return result
	end
	return { ok = false, error = tostring(result) }
end

------------------------------------------------------------
-- حلقة الاتصال (long-poll)
------------------------------------------------------------
local generation = 0
local connected = false

local function loop(gen, code)
	setStatus("Connecting...", Color3.fromRGB(245, 197, 24))
	while generation == gen do
		local ok, data = post("/plugin/poll", { code = code })
		if generation ~= gen then
			break
		end
		if not ok then
			setStatus("❌ " .. tostring(data), Color3.fromRGB(255, 92, 92))
			task.wait(3)
		else
			setStatus("✅ Connected — waiting for the AI", Color3.fromRGB(61, 220, 132))
			for _, cmd in ipairs(data.commands or {}) do
				task.spawn(function()
					setStatus("⚙️ Running: " .. tostring(cmd.tool), Color3.fromRGB(245, 197, 24))
					local result = execute(cmd)
					post("/plugin/result", { code = code, id = cmd.id, result = result })
					if generation == gen then
						setStatus("✅ Connected — waiting for the AI", Color3.fromRGB(61, 220, 132))
					end
				end)
			end
		end
	end
end

local function disconnect()
	generation += 1
	connected = false
	connectBtn.Text = "Connect"
	connectBtn.BackgroundColor3 = Color3.fromRGB(0, 120, 215)
	setStatus("Not connected")
end

connectBtn.MouseButton1Click:Connect(function()
	if connected then
		disconnect()
		return
	end
	local cleaned = string.gsub(codeBox.Text, "%s", "")
	local code = string.upper(cleaned)
	if #code < 4 then
		setStatus("Enter the code shown on the website", Color3.fromRGB(255, 92, 92))
		return
	end
	plugin:SetSetting("agent_code", code)
	generation += 1
	connected = true
	connectBtn.Text = "Disconnect"
	connectBtn.BackgroundColor3 = Color3.fromRGB(160, 50, 50)
	task.spawn(loop, generation, code)
end)

plugin.Unloading:Connect(function()
	generation += 1
end)
