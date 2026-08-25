local M = {}

function M.check()
  vim.health.start("omp.nvim")

  -- Neovim version
  local version = vim.version()
  local ver_str = string.format("%d.%d.%d", version.major, version.minor, version.patch)
  if version.major > 0 or version.minor >= 10 then
    vim.health.ok("Neovim >= 0.10 (" .. ver_str .. ")")
  else
    vim.health.error("Neovim >= 0.10 required, found " .. ver_str)
  end

  -- vim.uv availability
  if vim.uv then
    vim.health.ok("vim.uv available")
  else
    vim.health.error("vim.uv not available (upgrade to Neovim >= 0.10)")
  end

  -- Sockets directory
  local omp = require("omp")
  local sockets_dir = omp._sockets_dir
  if type(sockets_dir) ~= "string" then
    vim.health.error(
      "omp module is stale (missing internals). A plugin update happened but this Neovim "
        .. "process never re-required the new code (Lazy update alone does not reload "
        .. "already-loaded Lua modules). Fully quit and restart Neovim."
    )
    return
  end
  local stat = vim.uv.fs_stat(sockets_dir)
  if stat then
    if stat.type == "directory" then
      local test_path = sockets_dir .. "/.health_check"
      local ok = pcall(function()
        local f = io.open(test_path, "w")
        if f then
          f:close()
          os.remove(test_path)
        else
          error("not writable")
        end
      end)
      if ok then
        vim.health.ok("Sockets directory writable: " .. sockets_dir)
      else
        vim.health.warn("Sockets directory exists but may not be writable: " .. sockets_dir)
      end
    else
      vim.health.error("Sockets path exists but is not a directory: " .. sockets_dir)
    end
  else
    vim.health.info("Sockets directory not yet created (will be on next setup()): " .. sockets_dir)
  end

  -- fs_event watcher: primary discovery path. Without it, sessions started
  -- while Neovim sits idle are only found on the next buffer/idle event.
  if type(omp._watcher_active) ~= "function" then
    vim.health.warn("omp module predates watcher diagnostics; restart Neovim after updating")
  elseif omp._watcher_active() then
    vim.health.ok("Socket directory watcher running")
  else
    vim.health.warn(
      "Socket directory watcher not running — new OMP sessions are only discovered "
        .. "on BufEnter/BufWritePost/CursorHold, not immediately"
    )
  end

  -- Active OMP sessions. A pipe whose files are gone is still usable (macOS
  -- deletes $TMPDIR entries older than 3 days under the running server), but it
  -- means no new session can be discovered until OMP re-creates them.
  local connected, connecting, orphaned = 0, 0, {}
  for socket_path, pipe in pairs(omp._active_sockets) do
    if pipe == true then
      connecting = connecting + 1
    else
      connected = connected + 1
      if not vim.uv.fs_stat(socket_path) then
        table.insert(orphaned, socket_path)
      end
    end
  end

  if connected > 0 then
    vim.health.ok(connected .. " active OMP session(s) connected in this directory")
  else
    vim.health.info("No active OMP sessions detected (start OMP in this project directory)")
  end
  if connecting > 0 then
    vim.health.info(connecting .. " connection(s) still in progress")
  end
  for _, socket_path in ipairs(orphaned) do
    vim.health.warn("Connected but socket file is gone (reaped or unlinked): " .. socket_path)
  end

  -- What Neovim believes it has published. If OMP shows no active file while
  -- this reports a path, the break is on the extension side, not here.
  if type(omp._broadcast_state) ~= "function" then
    vim.health.warn("omp module predates broadcast diagnostics; restart Neovim after updating")
  else
    local current, broadcast = omp._broadcast_state()
    vim.health.info("Current buffer: " .. (current ~= "" and current or "(none)"))
    vim.health.info("Last broadcast: " .. (broadcast or "(never)"))
  end
end

return M
