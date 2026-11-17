local M = {}
local uv = vim.uv

local function read_info_file(path)
  local f = io.open(path, "r")
  if not f then
    return nil
  end
  local data = f:read("*a")
  f:close()

  local ok, parsed = pcall(vim.json.decode, data)
  if ok and type(parsed) == "table" then
    return parsed
  end
  return nil
end

-- path -> true (connecting placeholder) or uv_pipe handle (connected).
local active_sockets = {}
local raw_sockets_dir = (os.getenv("XDG_RUNTIME_DIR") or uv.os_tmpdir()) .. "/omp-nvim-sockets"
-- Realpath set in setup(): macOS FSEvents fires on /private/var, not the /var symlink.
local sockets_dir = raw_sockets_dir

local active_relative_path = ""

-- .info files never change after listen(); skip re-parsing an unchanged mtime.
local scanned_mtimes = {}

-- Also invalidates the mtime cache, else the session would never be reconnected.
local function drop_socket(socket_path, pipe)
  if pipe and pipe ~= true then
    pcall(function()
      pipe:close()
    end)
  end
  -- EOF and a late write error can both drop this path; never evict a reconnected pipe.
  if active_sockets[socket_path] == pipe then
    active_sockets[socket_path] = nil
    scanned_mtimes[socket_path .. ".info"] = nil
  end
end

local function connect_socket(socket_path, info_path)
  active_sockets[socket_path] = true
  local pipe = uv.new_pipe(false)
  if not pipe then
    active_sockets[socket_path] = nil
    return
  end

  pipe:connect(socket_path, function(err)
    if err then
      active_sockets[socket_path] = nil
      if err ~= "ECONNREFUSED" and err ~= "ENOENT" then
        scanned_mtimes[info_path] = nil
      end
      return
    end

    active_sockets[socket_path] = pipe
    -- OMP never writes to us, so this fires only on peer EOF/error.
    pipe:read_start(function(rerr, data)
      if rerr or not data then
        drop_socket(socket_path, pipe)
      end
    end)
    if active_relative_path ~= "" then
      local msg = vim.json.encode({ type = "active_file", path = active_relative_path }) .. "\n"
      pipe:write(msg, function(we)
        if we then
          drop_socket(socket_path, pipe)
        end
      end)
    end
  end)
end

local function check_and_add_socket(info_path)
  local st = uv.fs_stat(info_path)
  if not st then
    scanned_mtimes[info_path] = nil
    return
  end

  local mtime_key = st.mtime.sec .. ":" .. st.mtime.nsec
  if scanned_mtimes[info_path] == mtime_key then
    return
  end
  scanned_mtimes[info_path] = mtime_key

  local info = read_info_file(info_path)
  if not info or not info.cwd then
    return
  end

  local cwd = vim.fn.getcwd()
  local real_cwd = uv.fs_realpath(cwd) or cwd
  local real_info_cwd = uv.fs_realpath(info.cwd) or info.cwd
  if real_info_cwd ~= real_cwd then
    return
  end

  local socket_path = info_path:gsub("%.info$", "")
  if active_sockets[socket_path] then
    return
  end

  connect_socket(socket_path, info_path)
end

-- macOS FSEvents fires only on the real path (/private/var). Re-resolve every
-- scan: a realpath that failed while the dir was missing must not stick.
local function resolve_sockets_dir()
  sockets_dir = uv.fs_realpath(raw_sockets_dir) or raw_sockets_dir
  M._sockets_dir = sockets_dir
end

-- Whether fs_stat birthtime is real. Without statx, libuv aliases it to ctime,
-- which moves on every entry change in the dir. nil until measured.
local birthtime_reliable = nil

-- Real only if birthtime held while ctime advanced across a probe create/remove.
-- tmpfs reports 0: harmless, it never reuses inode numbers.
local function probe_birthtime(dir)
  local before = uv.fs_stat(dir)
  if not before then
    return -- gone; ensure_sockets_dir() retries after the next mkdir
  end
  -- No .info suffix, so scans ignore it; costs at most one extra macOS rescan.
  local probe = dir .. "/.omp-birthtime-probe"
  local fd = uv.fs_open(probe, "w", 384) -- 0o600
  if not fd then
    return -- not writable; stay unmeasured rather than guess
  end
  uv.fs_close(fd)
  uv.fs_unlink(probe)
  local after = uv.fs_stat(dir)
  if not after then
    return
  end
  local was, now, ctime = before.birthtime or {}, after.birthtime or {}, after.ctime or {}
  birthtime_reliable = was.sec == now.sec
    and was.nsec == now.nsec
    and not (now.sec == ctime.sec and now.nsec == ctime.nsec)
end

-- mkdir -p: macOS may reap the parent too. Sync so realpath sees the dir.
local function ensure_sockets_dir()
  pcall(vim.fn.mkdir, raw_sockets_dir, "p", 448) -- 0o700 matches the TS side
  resolve_sockets_dir()
  -- A failed probe stays unmeasured and is retried here.
  if birthtime_reliable == nil then
    probe_birthtime(sockets_dir)
  end
end

-- dev+ino misses a same-path recreate on ext4 (inode reused at once); birthtime
-- covers it where reliable.
local function dir_fingerprint(st)
  if not st then
    return nil
  end
  if not birthtime_reliable then
    return ("%d:%d"):format(st.dev, st.ino)
  end
  local birth = st.birthtime or {}
  return ("%d:%d:%d.%d"):format(st.dev, st.ino, birth.sec or 0, birth.nsec or 0)
end

local watched_dir = nil

local ensure_watcher

local function sync_sockets()
  -- Re-resolve first: all active_sockets/scanned_mtimes keys derive from it.
  resolve_sockets_dir()
  local req = uv.fs_scandir(sockets_dir)
  if not req then
    -- macOS reaps $TMPDIR. Rebind: the old watch is on the deleted inode.
    ensure_sockets_dir()
    ensure_watcher(true)
    return
  end
  local seen = {}
  while true do
    local name, ftype = uv.fs_scandir_next(req)
    if not name then
      break
    end
    if ftype == "file" and name:match("%.info$") then
      local info_path = sockets_dir .. "/" .. name
      seen[info_path] = true
      check_and_add_socket(info_path)
    end
  end
  -- Prune cache for vanished .info files but keep the pipe: macOS deletes $TMPDIR
  -- files of live servers. Only EOF/write failure proves death.
  for cached_path in pairs(scanned_mtimes) do
    if not seen[cached_path] then
      scanned_mtimes[cached_path] = nil
    end
  end
  -- Rebind if the dir was recreated (inotify watch dies with the old inode);
  -- otherwise re-arm a watcher that failed to start (reaper can race mkdir).
  local fingerprint = dir_fingerprint(uv.fs_stat(sockets_dir))
  -- No fingerprint for a live watcher: bound inode unknown, so rebind.
  ensure_watcher(fingerprint ~= nil and (watched_dir == nil or fingerprint ~= watched_dir))
end

local function broadcast_active_file(path)
  local msg = vim.json.encode({ type = "active_file", path = path }) .. "\n"

  for socket_path, pipe in pairs(active_sockets) do
    if pipe ~= true then -- true = still connecting
      pipe:write(msg, function(err)
        if err then
          drop_socket(socket_path, pipe)
        end
      end)
    end
  end
end

function M._get_display_path(bufname, buftype, line, v_line, mode)
  if buftype ~= "" and buftype ~= "acwrite" then
    return ""
  end
  if bufname == "" then
    return ""
  end

  local filename = vim.fn.fnamemodify(bufname, ":.")
  local display_str = filename .. ":" .. line

  if mode == "v" or mode == "V" or mode == "\22" then
    if v_line ~= line then
      local start_line = math.min(v_line, line)
      local end_line = math.max(v_line, line)
      display_str = filename .. ":" .. start_line .. "-" .. end_line
    end
  end

  return display_str
end

local active_watcher = nil
local last_broadcast_path = nil

local function update_active_path()
  local buf = vim.api.nvim_get_current_buf()
  local buftype = vim.api.nvim_get_option_value("buftype", { buf = buf })
  local bufname = vim.api.nvim_buf_get_name(buf)
  local line = vim.fn.line(".")
  local v_line = vim.fn.line("v")
  local mode = vim.fn.mode()

  local display_str = M._get_display_path(bufname, buftype, line, v_line, mode)
  if display_str ~= "" then
    active_relative_path = display_str
  end
end

-- No rescan: CursorMoved fires per keystroke.
local function broadcast_if_changed()
  update_active_path()
  local path = active_relative_path
  if path ~= "" and path ~= last_broadcast_path then
    last_broadcast_path = path
    broadcast_active_file(path)
  end
end

-- Backstop for the watcher (macOS FSEvents may omit the filename).
local function handle_buf_change()
  sync_sockets()
  broadcast_if_changed()
end

local function on_fs_event(err, filename, _)
  if err then
    return
  end
  vim.defer_fn(function()
    if filename and filename:match("%.info$") then
      check_and_add_socket(sockets_dir .. "/" .. filename)
    else
      -- macOS FSEvents: filename is nil or the directory itself — full rescan
      sync_sockets()
    end
    update_active_path()
    if active_relative_path ~= "" then
      -- Bypass dedupe (a new session never saw our path), then record it.
      last_broadcast_path = active_relative_path
      broadcast_active_file(active_relative_path)
    end
  end, 100)
end

-- Assigns the forward-declared local; `local function` here would shadow it.
ensure_watcher = function(rebind)
  if active_watcher then
    if not rebind then
      return
    end
    pcall(function()
      active_watcher:stop()
    end)
    pcall(function()
      active_watcher:close()
    end)
    active_watcher = nil
    watched_dir = nil
  end

  local watcher = uv.new_fs_event()
  if not watcher then
    return
  end
  -- luv returns nil+err (e.g. ENOENT) instead of raising.
  local ok, ret = pcall(watcher.start, watcher, sockets_dir, {}, on_fs_event)
  if ok and ret == 0 then
    active_watcher = watcher
    watched_dir = dir_fingerprint(uv.fs_stat(sockets_dir))
  else
    watched_dir = nil
    pcall(function()
      watcher:close()
    end)
  end
end

-- Test/health seams. Watcher and dir use getters: reassigned at runtime.
M._active_sockets = active_sockets
M._check_and_add_socket = check_and_add_socket
M._drop_socket = drop_socket
M._sockets_dir = sockets_dir

function M._watcher_active()
  return active_watcher ~= nil
end

-- Lets tests see rebinds, which are invisible on the handle.
function M._watched_dir()
  return watched_dir
end

-- nil while unmeasured.
function M._birthtime_reliable()
  return birthtime_reliable
end

function M._broadcast_state()
  return active_relative_path, last_broadcast_path
end

function M.setup()
  ensure_sockets_dir()
  -- Reset dedupe so a reload re-broadcasts.
  last_broadcast_path = nil
  -- Rebind first, else sync_sockets() binds a handle we'd immediately replace.
  ensure_watcher(true)
  sync_sockets()

  local group = vim.api.nvim_create_augroup("OmpNvimGroup", { clear = true })
  update_active_path()

  vim.api.nvim_create_autocmd({ "BufEnter", "BufWritePost", "CursorHold", "CursorHoldI" }, {
    group = group,
    callback = handle_buf_change,
  })

  vim.api.nvim_create_autocmd({ "CursorMoved", "CursorMovedI" }, {
    group = group,
    callback = broadcast_if_changed,
  })

  vim.api.nvim_create_autocmd({ "VimLeavePre" }, {
    group = group,
    callback = function()
      -- Explicit close lets OMP see the disconnect before teardown.
      for socket_path, pipe in pairs(active_sockets) do
        active_sockets[socket_path] = nil
        if pipe ~= true then
          pcall(function()
            pipe:close()
          end)
        end
      end
    end,
  })
end

return M
