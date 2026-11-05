-- Relay only OMP's PNG uploads and virtual Kitty placements. Neovim renders
-- the colored Unicode placeholder cells; the outer terminal owns the bitmap.
local M = {}
local ESC, ST = "\27", "\27\\"
local states = {}
local enabled = false
local writer
local tty
local max_upload = 32 * 1024 * 1024
local owners = {}

function M.support_error()
  if vim.fn.has("nvim-0.12") ~= 1 then
    return "Terminal graphics require Neovim >= 0.12; context synchronization still supports 0.10"
  end
  if vim.fn.has("win32") == 1 or not pcall(require, "ffi") then
    return "Terminal graphics require a POSIX host with LuaJIT FFI"
  end
  if vim.env.TMUX or vim.env.STY or vim.env.ZELLIJ then
    return "Terminal graphics inside tmux, screen and Zellij are not supported"
  end
  if vim.uv.guess_handle(1) ~= "tty" then
    return "Terminal graphics require a TUI with a TTY stdout"
  end
end

function M.terminal_env()
  if enabled and not M.support_error() then
    return { PI_FORCE_IMAGE_PROTOCOL = "kitty", PI_KITTY_PLACEHOLDERS = "1" }
  end
  -- Override inherited settings from the outer shell when this path cannot
  -- carry images; otherwise OMP emits invisible placeholder cells.
  return { PI_FORCE_IMAGE_PROTOCOL = "none", PI_KITTY_PLACEHOLDERS = "0" }
end

local function write_tty(data)
  -- This path requires a real TUI, not --headless, --embed or a GUI client.
  if vim.uv.guess_handle(1) ~= "tty" then
    return false, "The outer stdout is not a TTY"
  end
  -- Open our own blocking file description. Nvim's stdout is nonblocking;
  -- writing directly to fd 1 can split an APC at EAGAIN and lose its suffix.
  if not tty then
    -- Resolve the actual device: macOS PTYs can have a TTY stdout without a
    -- controlling /dev/tty (notably when Nvim is launched by another host).
    local ok, ffi = pcall(require, "ffi")
    if not ok then
      return false, "LuaJIT FFI is required to resolve the outer TTY device"
    end
    pcall(ffi.cdef, "char *ttyname(int fd);")
    local device = ffi.C.ttyname(1)
    local path = device ~= nil and ffi.string(device) or ""
    if not path:match("^/dev/[%w/_%.%-]+$") then
      return false, "Cannot resolve the outer TTY device"
    end
    local err
    tty, err = io.open(path, "wb")
    if not tty then
      return false, err
    end
    tty:setvbuf("no")
  end
  local ok, err = tty:write(data)
  if not ok then
    return false, err
  end
  return true
end

local function parse(sequence)
  if sequence:sub(1, 3) ~= ESC .. "_G" then
    return
  end
  local header, payload = sequence:sub(4):match("^([^;]*);(.*)$")
  header = header or sequence:sub(4)
  local params = {}
  for field in header:gmatch("[^,]+") do
    local k, v = field:match("^(%a)=(%-?%w+)$")
    if not k or params[k] then
      return
    end
    params[k] = v
  end
  return params, payload
end

local function image_id(value)
  local n = value and tonumber(value)
  return n and n >= 1 and n <= 0xffffff and n % 1 == 0 and n or nil
end

-- Kept independently testable: untrusted child escape sequences must never
-- become an unrestricted terminal passthrough (file reads, global deletes, etc).
function M._new_relay(write)
  local relay = { ids = {}, uploads = 0, placements = 0, rejected = 0, bytes = 0 }
  local pending
  local function emit(data)
    local ok, err = write(data)
    if ok == false then
      relay.error = err or "Cannot write graphics to the outer terminal"
      return false
    end
    return true
  end
  function relay.clear()
    for id in pairs(relay.ids) do
      emit(ESC .. "_Ga=d,d=I,i=" .. id .. ",q=2" .. ST)
      if owners[id] == relay then
        owners[id] = nil
      end
    end
    relay.ids = {}
    pending = nil
  end
  function relay.receive(sequence)
    local p, payload = parse(sequence)
    if not p then
      return
    end
    local id = image_id(p.i)
    local action = p.a
    -- A bare m= continuation belongs only to a previously accepted upload.
    local continuation = not action and not id and pending and payload ~= nil
    if action == "t" or continuation then
      if not continuation then
        pending = nil
        if not id or p.f ~= "100" or (p.t and p.t ~= "d") or p.o then
          relay.rejected = relay.rejected + 1
          return
        end
        if owners[id] and owners[id] ~= relay then
          relay.rejected = relay.rejected + 1
          relay.error = "Kitty image ID is already owned by another attached OMP terminal"
          return
        end
        if vim.tbl_count(relay.ids) >= 128 and not relay.ids[id] then
          relay.rejected = relay.rejected + 1
          return
        end
        pending = { id = id, bytes = 0 }
      else
        for k in pairs(p) do
          if k ~= "m" and k ~= "q" then
            relay.rejected = relay.rejected + 1
            pending = nil
            return
          end
        end
      end
      if not payload or payload:find("[^A-Za-z0-9+/=]") or (p.m and p.m ~= "0" and p.m ~= "1") then
        relay.rejected = relay.rejected + 1
        pending = nil
        return
      end
      pending.bytes = pending.bytes + #payload
      if pending.bytes > max_upload then
        -- A partially uploaded image also needs scoped cleanup.
        relay.ids[pending.id] = true
        emit(ESC .. "_Ga=d,d=I,i=" .. pending.id .. ",q=2" .. ST)
        relay.ids[pending.id] = nil
        owners[pending.id] = nil
        pending = nil
        relay.rejected = relay.rejected + 1
        return
      end
      relay.ids[pending.id] = true
      owners[pending.id] = relay
      -- Rebuild the first header so file/shared-memory media and non-quiet
      -- response requests cannot leak through. Chunk bodies are base64 only.
      local header = continuation and "m=" .. (p.m or "0")
        or "a=t,f=100,t=d,q=2,i=" .. pending.id .. ",m=" .. (p.m or "0")
      if not emit(ESC .. "_G" .. header .. ";" .. payload .. ST) then
        pending = nil
        return
      end
      relay.bytes = relay.bytes + #payload
      if p.m ~= "1" then
        pending = nil
        relay.uploads = relay.uploads + 1
      end
    elseif action == "p" and p.U == "1" and id and relay.ids[id] then
      local cols, rows = tonumber(p.c), tonumber(p.r)
      if
        not cols
        or not rows
        or cols < 1
        or rows < 1
        or cols > 297
        or rows > 297
        or cols % 1 ~= 0
        or rows % 1 ~= 0
        or (p.p and not image_id(p.p))
      then
        relay.rejected = relay.rejected + 1
        return
      end
      if
        emit(ESC .. "_Ga=p,U=1,q=2,i=" .. id .. ",c=" .. cols .. ",r=" .. rows .. (p.p and ",p=" .. p.p or "") .. ST)
      then
        relay.placements = relay.placements + 1
      end
    elseif action == "d" then
      if id and relay.ids[id] then
        emit(ESC .. "_Ga=d,d=I,i=" .. id .. ",q=2" .. ST)
        relay.ids[id] = nil
        owners[id] = nil
        pending = nil
      elseif not p.i and (p.d == "a" or p.d == "A") then
        -- OMP's full display reset must not delete image.nvim's images.
        relay.clear()
      else
        relay.rejected = relay.rejected + 1
      end
    else
      relay.rejected = relay.rejected + 1
    end
  end
  return relay
end

function M.attach(buf)
  if not enabled or not vim.api.nvim_buf_is_valid(buf) or vim.bo[buf].buftype ~= "terminal" then
    return false
  end
  local reason = M.support_error()
  if reason then
    return false, reason
  end
  if not states[buf] then
    states[buf] = M._new_relay(writer)
  end
  return true
end

function M.status()
  return states
end

function M.is_enabled()
  return enabled
end

function M.setup(opts)
  opts = opts or {}
  enabled = opts.enabled == true
  writer = write_tty
  local group = vim.api.nvim_create_augroup("OmpNvimGraphics", { clear = true })
  if not enabled then
    for _, relay in pairs(states) do
      relay.clear()
    end
    states = {}
    if tty then
      tty:close()
      tty = nil
    end
    return
  end
  vim.api.nvim_create_autocmd("TermRequest", {
    group = group,
    callback = function(ev)
      local relay = states[ev.buf]
      if relay then
        relay.receive(ev.data.sequence)
      end
    end,
  })
  vim.api.nvim_create_autocmd({ "TermClose", "BufWipeout" }, {
    group = group,
    callback = function(ev)
      if states[ev.buf] then
        states[ev.buf].clear()
        states[ev.buf] = nil
      end
    end,
  })
  vim.api.nvim_create_autocmd("VimLeavePre", {
    group = group,
    callback = function()
      for _, relay in pairs(states) do
        relay.clear()
      end
      if tty then
        tty:close()
        tty = nil
      end
    end,
  })
end

return M
