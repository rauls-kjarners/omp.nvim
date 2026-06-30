local M = {}
local uv = vim.uv

local function read_info_file(path)
  local f = io.open(path, "r")
  if not f then return nil end
  local data = f:read("*a")
  f:close()
  
  local ok, parsed = pcall(vim.fn.json_decode, data)
  if ok and type(parsed) == "table" then
    return parsed
  end
  return nil
end

local active_sockets = {}
local sockets_dir = (os.getenv("XDG_RUNTIME_DIR") or "/tmp") .. "/omp-nvim-sockets"

local function check_and_add_socket(info_path)
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
  if not req then return end
  while true do
    local name, ftype = uv.fs_scandir_next(req)
    if not name then break end
    if ftype == "file" and name:match("%.info$") then
      check_and_add_socket(sockets_dir .. "/" .. name)
    end
  end
end

local function broadcast_active_file(path)
  local msg = vim.fn.json_encode({ type = "active_file", path = path }) .. "\n"
  
  for socket_path, _ in pairs(active_sockets) do
    local pipe = uv.new_pipe(false)
    if pipe then
      pipe:connect(socket_path, function(err)
        if not err then
          pipe:write(msg, function()
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
  if bufname == "" then return "" end

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

function M.setup()
  uv.fs_mkdir(sockets_dir, 511, function() end) -- Ensure it exists
  sync_sockets()

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

  -- Initialize immediately so we capture the file before the terminal opens
  update_active_path()

  local last_broadcast_path = nil
  local function handle_buf_change()
    local path = get_relative_active_path()
    if path ~= "" and path ~= last_broadcast_path then
      last_broadcast_path = path
      broadcast_active_file(path)
    end
  end

  -- Watch for new OMP sockets so we can broadcast to them the moment they boot
  local watcher = uv.new_fs_event()
  if watcher then
    watcher:start(sockets_dir, {}, function(err, filename, events)
      if not err and filename and filename:match("%.info$") then
        vim.defer_fn(function()
          check_and_add_socket(sockets_dir .. "/" .. filename)
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
