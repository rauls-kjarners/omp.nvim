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

  -- Active OMP sessions
  local active = omp._active_sockets
  local count = 0
  for _ in pairs(active) do
    count = count + 1
  end
  if count > 0 then
    vim.health.ok(count .. " active OMP session(s) connected in this directory")
  else
    vim.health.info("No active OMP sessions detected (start OMP in this project directory)")
  end
end

return M
