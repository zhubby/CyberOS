local mp = require("mp")
local assdraw = require("mp.assdraw")

local overlay = mp.create_osd_overlay("ass-events")
local visible = false
local last_input = 0
local row = "buttons"
local selected = 2
local menu = nil
local render
local timer
local colors = {
    background = "0E0A05",
    panel = "120D16",
    text = "E7ECF4",
    muted = "ADA8BD",
    yellow = "0AEEFC",
    red = "3C00FF",
    cyan = "FFF000",
}
local languages = {
    zho = "中文", chi = "中文", zh = "中文", eng = "英语", en = "英语",
    jpn = "日语", ja = "日语", yue = "粤语", kor = "韩语", ko = "韩语",
}

local function escape(value)
    return tostring(value):gsub("\\", "\\\239\187\191"):gsub("{", "\\{"):gsub("}", "\\}"):gsub("[\r\n]", " ")
end

local function time_label(seconds)
    seconds = math.max(0, math.floor(seconds or 0))
    if seconds >= 3600 then
        return string.format("%d:%02d:%02d", math.floor(seconds / 3600), math.floor(seconds / 60) % 60, seconds % 60)
    end
    return string.format("%02d:%02d", math.floor(seconds / 60), seconds % 60)
end

local function tracks(kind)
    local result = {}
    for _, track in ipairs(mp.get_property_native("track-list", {})) do
        if track.type == kind then result[#result + 1] = track end
    end
    return result
end

local function track_label(track)
    local language = languages[track.lang] or track.lang
    local label = language or ("轨道 " .. track.id)
    if track.title and track.title ~= "" then label = label .. " · " .. track.title end
    if track["demux-channel-count"] then label = label .. " · " .. track["demux-channel-count"] .. "ch" end
    return label
end

local function current_track(kind)
    local property = kind == "audio" and "aid" or "sid"
    local current = mp.get_property_native(property)
    for _, track in ipairs(tracks(kind)) do
        if tostring(track.id) == tostring(current) then return track_label(track) end
    end
    return kind == "sub" and "关闭" or "无可用音轨"
end

local function rectangle(ass, left, top, width, height, color, alpha)
    ass:new_event()
    ass:pos(0, 0)
    ass:append(string.format("{\\an7\\bord0\\shad0\\1c&H%s&\\alpha&H%s&}", color, alpha or "00"))
    ass:draw_start()
    ass:rect_cw(left, top, left + width, top + height)
    ass:draw_stop()
end

local function text(ass, left, top, value, size, color, right)
    ass:new_event()
    ass:pos(left, top)
    ass:append(string.format("{\\an7\\fnNoto Sans CJK SC\\fs%d\\bord0\\shad0\\1c&H%s&\\alpha&H00&}", size, color or colors.text))
    if right then ass:append(string.format("{\\clip(%.0f,%.0f,%.0f,%.0f)}", left, top, right, top + size * 2)) end
    ass:append(escape(value))
end

local function hide()
    visible = false
    menu = nil
    timer:kill()
    overlay:remove()
end

local function show()
    visible = true
    last_input = mp.get_time()
    timer:resume()
    render()
end

local function seek(seconds)
    mp.commandv("seek", seconds, "relative+exact")
    show()
end

local function open_tracks(kind)
    local entries = {}
    if kind == "sub" then entries[1] = { id = "no", label = "关闭字幕" } end
    for _, track in ipairs(tracks(kind)) do
        entries[#entries + 1] = { id = track.id, label = track_label(track) }
    end
    if #entries == 0 then show(); return end
    local property = kind == "audio" and "aid" or "sid"
    local current = mp.get_property_native(property)
    local cursor = 1
    for index, entry in ipairs(entries) do
        if tostring(entry.id) == tostring(current) then cursor = index end
    end
    menu = { property = property, entries = entries, cursor = cursor }
    show()
end

render = function()
    if not visible then return end
    local screen_width, screen_height = mp.get_osd_size()
    if screen_width <= 0 or screen_height <= 0 then return end
    local height = 1080
    local width = screen_width / screen_height * height
    local panel_width = math.min(1080, width - 64)
    local left = (width - panel_width) / 2
    local top = height * 0.69
    local inner = panel_width - 48
    local ass = assdraw.ass_new()
    local paused = mp.get_property_native("pause", false)
    local duration = mp.get_property_number("duration", 0)
    local position = math.max(0, mp.get_property_number("time-pos", 0))
    if duration > 0 then position = math.min(position, duration) end

    rectangle(ass, left, top, panel_width, 238, colors.background, "14")
    rectangle(ass, left, top, 4, 238, colors.red)
    text(ass, left + 24, top + 12, "CYBEROS  /  播放控制", 23, colors.yellow)
    text(ass, left + 24, top + 46, time_label(position) .. " / " .. time_label(duration), 25)
    if row == "progress" and not menu then
        rectangle(ass, left + 20, top + 81, inner + 8, 18, colors.cyan)
    end
    rectangle(ass, left + 24, top + 85, inner, 10, colors.panel)
    if duration > 0 then rectangle(ass, left + 24, top + 85, inner * position / duration, 10, colors.yellow) end

    local labels = { "后退 10秒", paused and "继续播放" or "暂停", "前进 10秒", "音轨", "字幕", "返回媒体库" }
    local button_width = (inner - 60) / #labels
    for index, label in ipairs(labels) do
        local button_left = left + 24 + (index - 1) * (button_width + 12)
        if row == "buttons" and selected == index and not menu then
            rectangle(ass, button_left - 3, top + 114, button_width + 6, 54, colors.cyan)
        end
        rectangle(ass, button_left, top + 117, button_width, 48, colors.panel)
        text(ass, button_left + 10, top + 124, label, 23, colors.text, button_left + button_width - 4)
    end
    text(ass, left + 24, top + 176, "音轨: " .. current_track("audio") .. "     字幕: " .. current_track("sub"), 21, colors.muted, left + panel_width - 24)
    text(ass, left + 24, top + 208, "方向键选择 · 确定操作 · 返回退出 · Home 回媒体库", 18, colors.muted, left + panel_width - 24)

    if menu then
        local count = math.min(5, #menu.entries)
        local first = math.max(1, math.min(menu.cursor - 2, #menu.entries - count + 1))
        local menu_width = math.min(800, panel_width)
        local menu_left = (width - menu_width) / 2
        local menu_top = top - count * 48 - 78
        rectangle(ass, menu_left, menu_top, menu_width, count * 48 + 64, colors.background)
        rectangle(ass, menu_left, menu_top, 4, count * 48 + 64, colors.red)
        text(ass, menu_left + 20, menu_top + 10, menu.property == "aid" and "选择音轨" or "选择字幕", 25, colors.yellow)
        for index = first, first + count - 1 do
            local entry = menu.entries[index]
            local entry_top = menu_top + 52 + (index - first) * 48
            if index == menu.cursor then
                rectangle(ass, menu_left + 12, entry_top - 2, menu_width - 24, 42, colors.cyan)
                rectangle(ass, menu_left + 15, entry_top + 1, menu_width - 30, 36, colors.panel)
            end
            text(ass, menu_left + 24, entry_top, entry.label, 25, index == menu.cursor and colors.yellow or colors.text, menu_left + menu_width - 24)
        end
    end
    overlay.res_x = width
    overlay.res_y = height
    overlay.data = ass.text
    overlay:update()
end

local function navigate(direction)
    if menu then
        if direction == "up" then menu.cursor = math.max(1, menu.cursor - 1) end
        if direction == "down" then menu.cursor = math.min(#menu.entries, menu.cursor + 1) end
    elseif not visible then
        row = "buttons"
        selected = 2
        if direction == "left" or direction == "right" then
            row = "progress"
            seek(direction == "left" and -10 or 10)
            return
        end
    elseif direction == "up" then
        row = "progress"
    elseif direction == "down" then
        row = "buttons"
    elseif row == "progress" then
        seek(direction == "left" and -10 or 10)
        return
    else
        selected = math.max(1, math.min(6, selected + (direction == "left" and -1 or 1)))
    end
    show()
end

local function activate()
    if not visible then row = "buttons"; selected = 2; show(); return end
    if menu then
        local choice = menu.entries[menu.cursor]
        mp.set_property_native(menu.property, choice.id)
        menu = nil
    elseif row == "progress" then
        row = "buttons"
        selected = 2
    elseif selected == 1 then seek(-10); return
    elseif selected == 2 then mp.commandv("cycle", "pause")
    elseif selected == 3 then seek(10); return
    elseif selected == 4 then open_tracks("audio"); return
    elseif selected == 5 then open_tracks("sub"); return
    elseif selected == 6 then mp.commandv("quit"); return end
    show()
end

local function quit()
    hide()
    mp.commandv("quit")
end

local function back()
    if menu then menu = nil; show() else quit() end
end

timer = mp.add_periodic_timer(0.25, function()
    if visible and not menu and not mp.get_property_native("pause", false) and mp.get_time() - last_input >= 5 then
        hide()
    else
        render()
    end
end)
timer:kill()

local function bind(key, callback, repeatable)
    mp.add_forced_key_binding(key, "cyberos-tv-" .. key, callback, { repeatable = repeatable or false })
end

for _, key in ipairs({ "GO_BACK", "ESC", "BS" }) do bind(key, back) end
for _, key in ipairs({ "HOMEPAGE", "HOME" }) do
    bind(key, function()
        mp.commandv("script-message", "cyberos-tv-home")
        quit()
    end)
end
bind("STOP", quit)
for _, direction in ipairs({ "left", "right", "up", "down" }) do
    bind(direction:upper(), function() navigate(direction) end, true)
end
bind("ENTER", activate)
bind("KP_ENTER", activate)
bind("MENU", show)
bind("F6", function() seek(-10) end, true)
bind("F7", function() seek(10) end, true)
for _, key in ipairs({ "F9", "a", "A" }) do bind(key, function() open_tracks("audio") end) end
for _, key in ipairs({ "F10", "s", "S" }) do bind(key, function() open_tracks("sub") end) end
for _, key in ipairs({ "SPACE", "PLAYPAUSE" }) do
    bind(key, function() mp.commandv("cycle", "pause"); show() end)
end
bind("PLAY", function() mp.set_property_native("pause", false); show() end)
bind("PAUSE", function() mp.set_property_native("pause", true); show() end)

mp.register_event("file-loaded", show)
mp.register_event("end-file", hide)
mp.observe_property("pause", "bool", function(_, paused)
    if paused then show() elseif visible then show() end
end)
for _, property in ipairs({ "track-list", "aid", "sid", "osd-dimensions" }) do
    mp.observe_property(property, "native", function() if visible then render() end end)
end
