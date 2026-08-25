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
-- Tests observe this table to verify cwd-matched sockets are discovered.
local active_sockets = {}
local raw_sockets_dir = (os.getenv("XDG_RUNTIME_DIR") or uv.os_tmpdir()) .. "/omp-nvim-sockets"
-- Resolved to the real path (no symlinks) in M.setup() after mkdir, so the
-- FSEvents watcher fires correctly on macOS where os.tmpdir() returns a path
-- under /var which is a symlink to /private/var.
local sockets_dir = raw_sockets_dir

-- Module-level so connect callbacks (which are async) can read the current
-- value without needing a closure into M.setup().
local active_relative_path = ""

-- .info files are written once at listen() and never modified, so once a file's
-- mtime has been parsed we can skip re-reading it. Without this, every
-- sync_sockets() (BufEnter/BufWritePost/CursorHold/CursorHoldI, plus the
-- fs_event watcher) would re-parse JSON and re-run fs_realpath for every .info
-- file — including dead ones left behind by crashed OMP processes.
local scanned_mtimes = {}

-- Drop a socket from the live set and invalidate its mtime cache entry, so the
-- next sync_sockets() re-reads the .info file and reconnects. Without the cache
-- invalidation check_and_add_socket() returns early on the unchanged mtime and
-- the OMP session stays unreachable until it restarts — the widget then shows
-- nothing for the rest of the Neovim session.
local function drop_socket(socket_path, pipe)
  if pipe and pipe ~= true then
    pcall(function()
      pipe:close()
    end)
  end
  -- Identity check. read_start EOF and a queued write callback are two async
  -- drop triggers for the same pipe: if EOF dropped it and the next scan
  -- already reconnected, the late write error must not evict the fresh pipe
  -- (which would then be leaked open and never written to).
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
    -- EOF detection. OMP never writes to us, so this callback only fires when
    -- the peer goes away (err, or a nil chunk = EOF). Without it a dead
    -- session lingers in active_sockets until the next write fails, which may
    -- never come if the user stops moving the cursor.
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

-- Resolve the sockets directory through symlinks (macOS $TMPDIR lives under
-- /var, a symlink to /private/var, and FSEvents only fires on the real path).
-- Re-run on every scan: an intermediate component can be retargeted, and a
-- realpath that failed while the directory was missing must not stick — once
-- the directory exists again the recreate branch below never runs, so nothing
-- else would ever fix the cached spelling.
local function resolve_sockets_dir()
  sockets_dir = uv.fs_realpath(raw_sockets_dir) or raw_sockets_dir
  M._sockets_dir = sockets_dir -- refresh seam with realpath-resolved dir
end

-- Whether uv.fs_stat()'s birthtime is a real creation time on this filesystem.
-- libuv only gets one from statx(); where statx is unavailable — kernels
-- < 4.11, or a seccomp filter that rejects it, after which libuv latches
-- no_statx for the whole process — uv__to_stat() aliases birthtime to ctime
-- (libuv src/unix/fs.c), and a directory's ctime advances every time an entry
-- is created or removed inside it. Folding that into the fingerprint below
-- would rebind the watcher on every .info file an OMP session writes. nil
-- until measured.
local birthtime_reliable = nil

-- Measure it on the directory we are about to watch instead of guessing from a
-- table of filesystems: create and remove one probe entry and see what moved.
--   birthtime moved with ctime          -> aliased to ctime, unusable
--   birthtime still equal to ctime      -> ctime granularity too coarse to
--                                          tell the two apart; assume unusable
--   birthtime held while ctime advanced -> a real creation time
-- A filesystem that reports no birthtime at all (tmpfs leaves it 0) lands in
-- the last case and contributes a constant 0 — harmless, and those filesystems
-- allocate inode numbers from a counter and never reuse them, so dev+ino
-- already identifies the directory there.
local function probe_birthtime(dir)
  local before = uv.fs_stat(dir)
  if not before then
    return -- gone; ensure_sockets_dir() retries after the next mkdir
  end
  -- No .info suffix, so sync_sockets() ignores it and on_fs_event() treats it
  -- as an unnamed change: at most one extra rescan, and only on macOS, where
  -- FSEvents watches the path rather than the inode and can still see a
  -- directory this call recreated. Bounded either way — measured once per
  -- session.
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

-- mkdir -p (macOS can reap the whole $TMPDIR subtree, so the parent may be
-- gone too) plus a fresh realpath. Synchronous: the async form returns before
-- the directory exists, racing the realpath.
local function ensure_sockets_dir()
  pcall(vim.fn.mkdir, raw_sockets_dir, "p", 448) -- 0o700 matches the TS side
  resolve_sockets_dir()
  -- Once per session, and only against a directory that exists and is ours to
  -- write to; a failed probe leaves it unmeasured and is retried here.
  if birthtime_reliable == nil then
    probe_birthtime(sockets_dir)
  end
end

-- Identity of the directory the live watcher is bound to. dev+ino is not
-- enough: ext4 hands the just-freed inode number straight back to the next
-- mkdir at the same path, so a delete+recreate is invisible in ino alone (this
-- is why the check passed on macOS and failed on Linux CI). birthtime closes it
-- wherever the filesystem reports a usable one; where it does not, dev+ino is
-- the only identity available and a same-path recreate is caught only by the
-- missing-directory branch of sync_sockets().
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

-- Fingerprint of what the watcher actually bound; see the rebind check in
-- sync_sockets().
local watched_dir = nil

-- Forward declaration: sync_sockets() rebinds the watcher when the sockets
-- directory has been recreated, and the watcher callback calls sync_sockets().
local ensure_watcher

local function sync_sockets()
  -- Re-resolve before scanning: every key in active_sockets and scanned_mtimes
  -- is derived from this string, so the scan below and the watcher must agree
  -- on it.
  resolve_sockets_dir()
  local req = uv.fs_scandir(sockets_dir)
  if not req then
    -- Directory itself is gone (macOS reaps $TMPDIR contents every night).
    -- Recreate it so the next OMP session has somewhere to bind, and rebind the
    -- watcher: the old handle is still attached to the deleted inode and will
    -- never fire again.
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
  -- Forget cache entries whose .info file is gone, so the map doesn't grow
  -- unbounded across OMP crashes/restarts and so a returning session is
  -- re-read. A missing .info does NOT mean the peer died: macOS deletes
  -- $TMPDIR files older than 3 days even while the server is listening on
  -- them. The pipe is the source of truth — keep it until a write actually
  -- fails, which drop_socket handles.
  for cached_path in pairs(scanned_mtimes) do
    if not seen[cached_path] then
      scanned_mtimes[cached_path] = nil
    end
  end
  -- Rebind when the directory on disk is no longer the one we bound: a
  -- delete+recreate at the same path (the reaper, then OMP recreating it)
  -- leaves an inode-bound inotify watch dead on Linux while the handle still
  -- looks live, so _watcher_active() would report running while discovery has
  -- silently degraded to buffer/idle polling. Otherwise just re-arm a watcher
  -- that failed to start earlier; no-op while one is live. The reaper can
  -- delete the directory between our mkdir and fs_event start (start then
  -- returns nil+ENOENT and nothing is bound), and the OMP extension recreates
  -- the directory itself afterwards.
  local fingerprint = dir_fingerprint(uv.fs_stat(sockets_dir))
  -- A live watcher with no fingerprint means the stat right after the bind lost
  -- the race with the reaper: we cannot tell which inode the handle is attached
  -- to, so rebind rather than keep a watch that may be dead while
  -- _watcher_active() reports healthy.
  ensure_watcher(fingerprint ~= nil and (watched_dir == nil or fingerprint ~= watched_dir))
end

local function broadcast_active_file(path)
  local msg = vim.json.encode({ type = "active_file", path = path }) .. "\n"

  for socket_path, pipe in pairs(active_sockets) do
    if pipe ~= true then -- skip connecting placeholders; only write to live pipes
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
    return "" -- Don't update if it's a terminal or special buffer
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

-- Cheap path: cursor/selection moved, so only the line numbers in the widget
-- payload changed. No socket rescan here — CursorMoved fires per keystroke and
-- fs_scandir + fs_stat per .info file on every one is pure syscall churn.
local function broadcast_if_changed()
  update_active_path()
  local path = active_relative_path
  if path ~= "" and path ~= last_broadcast_path then
    last_broadcast_path = path
    broadcast_active_file(path)
  end
end

-- Sync path: buffer/idle events, where an OMP session may have booted since the
-- last scan. Backstop for the fs_event watcher (macOS FSEvents does not
-- reliably report the filename), not the primary discovery mechanism.
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
      -- Unconditional: a newly discovered session has never seen our path, so
      -- the broadcast_if_changed() dedupe must not suppress it. Record it after
      -- the fact so the dedupe and _broadcast_state() stay accurate.
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
  -- luv returns nil plus an error string here (e.g. ENOENT when the directory
  -- does not exist); it does not raise. Checking only pcall would store a
  -- handle that never fires, and checkhealth would report a running watcher.
  local ok, ret = pcall(watcher.start, watcher, sockets_dir, {}, on_fs_event)
  if ok and ret == 0 then
    active_watcher = watcher
    -- Fingerprint of what we actually bound, so sync_sockets() can spot a
    -- delete+recreate at the same path.
    watched_dir = dir_fingerprint(uv.fs_stat(sockets_dir))
  else
    watched_dir = nil
    pcall(function()
      watcher:close()
    end)
  end
end

-- Test/health seams (prefixed with _ to signal internal use). The watcher and
-- path are read through functions because they are reassigned at runtime.
M._active_sockets = active_sockets
M._check_and_add_socket = check_and_add_socket
M._drop_socket = drop_socket
M._sockets_dir = sockets_dir

function M._watcher_active()
  return active_watcher ~= nil
end

-- Fingerprint of the directory the live watcher is bound to, or nil. Lets tests
-- prove a rebind happened after a delete+recreate at the same path, which is
-- otherwise invisible: the handle stays non-nil either way.
function M._watched_dir()
  return watched_dir
end

-- Whether birthtime is part of the fingerprint on this filesystem, or nil while
-- unmeasured. Lets tests skip the reused-inode-number case, which is
-- undetectable from stat alone without a usable birthtime.
function M._birthtime_reliable()
  return birthtime_reliable
end

function M._broadcast_state()
  return active_relative_path, last_broadcast_path
end

function M.setup()
  ensure_sockets_dir()
  -- Module-scoped, so a repeated setup() would otherwise inherit the old dedupe
  -- value and suppress the first broadcast after a reload.
  last_broadcast_path = nil
  -- Rebind before the first scan: sync_sockets() ends in ensure_watcher(false),
  -- which would otherwise bind a handle this call immediately stops and
  -- replaces (two uv_fs_event allocations per setup()).
  ensure_watcher(true)
  sync_sockets()

  local group = vim.api.nvim_create_augroup("OmpNvimGroup", { clear = true })

  -- Capture the active file immediately so OMP receives context the moment it boots
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
      -- Close all persistent pipes. The OS closes FDs on exit anyway, but
      -- explicit close lets OMP detect the disconnect before process teardown,
      -- which is more reliable than sending a message (async delivery not
      -- guaranteed during shutdown).
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
