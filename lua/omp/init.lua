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

local active_sockets = {}
local sockets_dir = (os.getenv("XDG_RUNTIME_DIR") or uv.os_tmpdir()) .. "/omp-nvim-sockets"

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
      active_sockets[socket_path] = true
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
  -- doesn't grow unbounded across repeated OMP crashes/restarts.
  for cached_path in pairs(scanned_mtimes) do
    if not seen[cached_path] then
      scanned_mtimes[cached_path] = nil
    end
  end
end

local function broadcast_active_file(path)
  local msg = vim.json.encode({ type = "active_file", path = path }) .. "\n"

  for socket_path, _ in pairs(active_sockets) do
    local pipe = uv.new_pipe(false)
    if pipe then
      pipe:connect(socket_path, function(err)
        if not err then
          pipe:write(msg, function(write_err)
            if write_err then
              active_sockets[socket_path] = nil
            end
            pipe:close()
          end)
        else
          active_sockets[socket_path] = nil
          pipe:close()
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
  uv.fs_mkdir(sockets_dir, 448, function() end) -- 0o700: match TS side
  sync_sockets()

  -- Guard against repeated setup(): stop the previous watcher to prevent leaks
  if active_watcher then
    active_watcher:stop()
    active_watcher:close()
    active_watcher = nil
  end

  local group = vim.api.nvim_create_augroup("OmpNvimGroup", { clear = true })
  local active_relative_path = ""

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
    watcher:start(sockets_dir, {}, function(err, filename, _events)
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
end

return M
