local script = assert(arg[1])

local function fixture(overrides)
    local properties = {
        pause = false,
        duration = 120,
        ["time-pos"] = 30,
        aid = 1,
        sid = false,
        ["track-list"] = {
            { type = "audio", id = 1, lang = "zho", selected = true },
            { type = "audio", id = 4, lang = "eng", title = "Commentary" },
            { type = "sub", id = 7, lang = "zho", title = "Chinese" },
        },
    }
    for name, value in pairs(overrides or {}) do properties[name] = value end
    local keys, events, observers, commands, timers = {}, {}, {}, {}, {}
    local now = 0
    local overlay = { data = "" }
    function overlay:update() end
    function overlay:remove() self.data = "" end
    local mp = {
        get_time = function() return now end,
        get_osd_size = function() return 1920, 1080 end,
        get_property_native = function(name, default)
            local value = properties[name]
            if value == nil then return default end
            return value
        end,
        get_property_number = function(name, default) return properties[name] or default end,
        create_osd_overlay = function() return overlay end,
        add_forced_key_binding = function(key, _, callback) keys[key] = callback end,
        register_event = function(name, callback) events[name] = callback end,
        observe_property = function(name, _, callback) observers[name] = callback end,
        add_periodic_timer = function(_, callback)
            local timer = { enabled = true, callback = callback }
            function timer:kill() self.enabled = false end
            function timer:resume() self.enabled = true end
            timers[#timers + 1] = timer
            return timer
        end,
        commandv = function(...)
            local command = { ... }
            commands[#commands + 1] = command
            if command[1] == "cycle" and command[2] == "pause" then
                properties.pause = not properties.pause
                if observers.pause then observers.pause("pause", properties.pause) end
            end
        end,
        set_property_native = function(name, value)
            properties[name] = value
            commands[#commands + 1] = { "set", name, value }
            if observers[name] then observers[name](name, value) end
        end,
    }
    package.loaded.mp = mp
    package.loaded["mp.assdraw"] = {
        ass_new = function()
            local ass = { text = "" }
            function ass:new_event() self.text = self.text .. "\n" end
            function ass:append(value) self.text = self.text .. value end
            function ass:pos() end
            function ass:draw_start() end
            function ass:draw_stop() end
            function ass:rect_cw() end
            return ass
        end,
    }
    dofile(script)
    events["file-loaded"]()
    return {
        properties = properties,
        overlay = overlay,
        commands = commands,
        press = function(key) assert(keys[key], "Missing binding: " .. key)() end,
        advance = function(seconds)
            now = now + seconds
            for _, timer in ipairs(timers) do if timer.enabled then timer.callback() end end
        end,
        event = function(name) events[name]() end,
    }
end

for _, key in ipairs({ "GO_BACK", "ESC", "BS", "STOP" }) do
    local player = fixture()
    player.press(key)
    assert(player.commands[1][1] == "quit", key .. " must leave native playback")
    assert(#player.commands == 1, key .. " must preserve library context")
end

for _, key in ipairs({ "HOMEPAGE", "HOME" }) do
    local player = fixture()
    player.press(key)
    assert(player.commands[1][1] == "script-message" and player.commands[1][2] == "cyberos-tv-home", key .. " must notify the library before exiting")
    assert(player.commands[2][1] == "quit", key .. " must leave native playback")
end

local player = fixture()
assert(player.overlay.data:find("暂停", 1, true), "HUD must show pause")
assert(player.overlay.data:find("音轨", 1, true), "HUD must show audio selection")
assert(player.overlay.data:find("字幕", 1, true), "HUD must show subtitle selection")
assert(player.overlay.data:find("00:30", 1, true), "HUD must show current position")
assert(player.overlay.data:find("02:00", 1, true), "HUD must show duration")
player.advance(6)
assert(player.overlay.data == "", "HUD must hide after inactivity")
player.press("ENTER")
assert(#player.commands == 0, "First OK must reveal controls without pausing")
player.press("ENTER")
assert(player.properties.pause, "Second OK must pause")
player.advance(30)
assert(player.overlay.data ~= "", "Paused playback must keep controls visible")

player = fixture()
player.advance(6)
player.press("RIGHT")
assert(player.commands[1][1] == "seek" and player.commands[1][2] == 10, "Hidden right must seek")
player.press("LEFT")
assert(player.commands[2][2] == -10, "Progress focus must seek left")
player.press("DOWN")
player.press("LEFT")
player.press("ENTER")
assert(player.commands[3][2] == -10, "Rewind button must seek")

player = fixture()
player.press("RIGHT")
player.press("RIGHT")
player.press("ENTER")
assert(player.overlay.data:find("Commentary", 1, true), "Audio menu must show real track metadata")
player.advance(30)
assert(player.overlay.data ~= "", "Track selection must not disappear while idle")
player.press("DOWN")
player.press("ENTER")
assert(player.properties.aid == 4, "Audio choice must use the track id rather than its index")
player.press("RIGHT")
player.press("ENTER")
player.press("DOWN")
player.press("ENTER")
assert(player.properties.sid == 7, "Subtitle menu must select the chosen track")
player.press("ENTER")
player.press("UP")
player.press("ENTER")
assert(player.properties.sid == "no", "Subtitles must be explicitly switchable off")

player = fixture()
player.press("RIGHT")
player.press("RIGHT")
player.press("ENTER")
player.press("GO_BACK")
assert(#player.commands == 0, "Back must close a track menu first")
player.press("GO_BACK")
assert(player.commands[1][1] == "quit", "Back must then leave playback")

player = fixture()
player.press("RIGHT")
player.press("RIGHT")
player.press("ENTER")
player.press("HOMEPAGE")
assert(player.commands[1][1] == "script-message" and player.commands[2][1] == "quit", "Home must notify and exit even from a track menu")

player = fixture({ ["track-list"] = {}, duration = 0 })
player.press("RIGHT")
player.press("RIGHT")
player.press("ENTER")
assert(#player.commands == 0, "Missing tracks must not issue an invalid selection")
player.event("end-file")
assert(player.overlay.data == "", "End of playback must remove the overlay")

print("TV controls: remote exit, HUD, seeking, track selection and timers passed")
