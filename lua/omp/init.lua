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
-- mtime has been parsed we can skip re-reading it. Without this, sync_sockets()
-- running on every CursorMoved (see handle_buf_change) would re-parse JSON and
-- re-run fs_realpath for every .info file — including dead ones left behind by
-- crashed OMP processes — on every keystroke.
local scanned_mtimes = {}

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
  if info and info.cwd then
    local cwd = vim.fn.getcwd()
    local real_cwd = uv.fs_realpath(cwd) or cwd
    local real_info_cwd = uv.fs_realpath(info.cwd) or info.cwd
    if real_info_cwd == real_cwd then
      local socket_path = info_path:gsub("%.info$", "")
      if not active_sockets[socket_path] then
        -- Set true as a connecting placeholder so we don't double-connect on
        -- re-entry. Upgraded to the live pipe handle once the connect succeeds.
        active_sockets[socket_path] = true
        local pipe = uv.new_pipe(false)
        if pipe then
          pipe:connect(socket_path, function(err)
            if err then
              active_sockets[socket_path] = nil
              -- A live server we briefly failed to reach should not be ignored
              -- forever, so drop the mtime cache to retry on the next scan.
              -- But ECONNREFUSED/ENOENT means the socket is dead (crash leftover
              -- or gone) — keep the cache so we don't retry-storm it every event.
              if err ~= "ECONNREFUSED" and err ~= "ENOENT" then
                scanned_mtimes[info_path] = nil
              end
              return
            end
            -- Persistent pipe is ready. Upgrade placeholder → handle.
            active_sockets[socket_path] = pipe
            -- Immediately push the current active file to this new OMP session
            -- so context is available without waiting for the next vim event.
            if active_relative_path ~= "" then
              local msg = vim.json.encode({ type = "active_file", path = active_relative_path }) .. "\n"
              pipe:write(msg, function(we)
                if we then
                  pcall(function()
                    pipe:close()
                  end)
                  active_sockets[socket_path] = nil
                end
              end)
            end
          end)
        else
          active_sockets[socket_path] = nil
        end
      end
    end
  end
end

local function sync_sockets()
  local req = uv.fs_scandir(sockets_dir)
  if not req then
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
  -- Prune cache entries for .info files that no longer exist, so the map
  -- doesn't grow unbounded across repeated OMP crashes/restarts. Also close
  -- any persistent pipe whose OMP process has gone away.
  for cached_path in pairs(scanned_mtimes) do
    if not seen[cached_path] then
      scanned_mtimes[cached_path] = nil
      local sock_path = cached_path:gsub("%.info$", "")
      local pipe = active_sockets[sock_path]
      if pipe and pipe ~= true then
        pcall(function()
          pipe:close()
        end)
      end
      active_sockets[sock_path] = nil
    end
  end
end

local function broadcast_active_file(path)
  local msg = vim.json.encode({ type = "active_file", path = path }) .. "\n"

  for socket_path, pipe in pairs(active_sockets) do
    if pipe ~= true then -- skip connecting placeholders; only write to live pipes
      pipe:write(msg, function(err)
        if err then
          pcall(function()
            pipe:close()
          end)
          active_sockets[socket_path] = nil
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

-- Test seams (prefixed with _ to signal internal use)
M._active_sockets = active_sockets
M._check_and_add_socket = check_and_add_socket
M._sockets_dir = sockets_dir

local active_watcher = nil

function M.setup()
  -- Synchronous mkdir so fs_realpath below sees the directory. The async form
  -- (with callback) returns immediately, making the realpath call race against
  -- the not-yet-created directory on the very first run.
  pcall(uv.fs_mkdir, raw_sockets_dir, 448) -- ignore EEXIST; 0o700 matches TS side
  sockets_dir = uv.fs_realpath(raw_sockets_dir) or raw_sockets_dir
  M._sockets_dir = sockets_dir -- refresh seam with realpath-resolved dir
  sync_sockets()

  -- Guard against repeated setup(): stop the previous watcher to prevent leaks
  if active_watcher then
    active_watcher:stop()
    active_watcher:close()
    active_watcher = nil
  end

  local group = vim.api.nvim_create_augroup("OmpNvimGroup", { clear = true })

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

  local function get_relative_active_path()
    update_active_path()
    return active_relative_path
  end

  -- Capture the active file immediately so OMP receives context the moment it boots
  update_active_path()
  local last_broadcast_path = nil
  local function handle_buf_change()
    -- Rescan on every change (cheap scandir). Fixes macOS FSEvents not always
    -- reporting filenames in the watcher callback, so OMP sessions started after
    -- Neovim are discovered here rather than being silently missed.
    sync_sockets()
    local path = get_relative_active_path()
    if path ~= "" and path ~= last_broadcast_path then
      last_broadcast_path = path
      broadcast_active_file(path)
    end
  end

  -- fs_event watcher: fast-path for Linux (inotify delivers filename reliably).
  -- On macOS (FSEvents) filename may be nil or the directory name — fall back to
  -- a full sync_sockets() in that case so newly booted OMP sessions are found.
  local watcher = uv.new_fs_event()
  if watcher then
    active_watcher = watcher
    watcher:start(sockets_dir, {}, function(err, filename, _)
      if err then
        return
      end
      if filename and filename:match("%.info$") then
        vim.defer_fn(function()
          check_and_add_socket(sockets_dir .. "/" .. filename)
          local path = get_relative_active_path()
          if path ~= "" then
            broadcast_active_file(path)
          end
        end, 100)
      else
        -- macOS FSEvents: filename is nil or directory — full rescan
        vim.defer_fn(function()
          sync_sockets()
          local path = get_relative_active_path()
          if path ~= "" then
            broadcast_active_file(path)
          end
        end, 100)
      end
    end)
  end

  vim.api.nvim_create_autocmd({ "BufEnter", "BufWritePost", "CursorHold", "CursorHoldI", "CursorMoved" }, {
    group = group,
    callback = handle_buf_change,
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
