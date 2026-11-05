vim.opt.rtp:prepend(assert(vim.env.OMP_GRAPHICS_TEST_PLUGIN))
local dir = assert(vim.env.OMP_GRAPHICS_TEST_DIR)
local g = require("omp.graphics")
g.setup({ enabled = true })
vim.cmd("vsplit")
local buf = vim.api.nvim_get_current_buf()
local job = vim.fn.jobstart(
  { assert(vim.env.OMP_GRAPHICS_TEST_OMP), "--no-session", "--cwd", dir },
  { term = true, cwd = dir, env = g.terminal_env() }
)
assert(g.attach(buf))
vim.cmd.startinsert()
local report = { job = job, stdout_kind = vim.uv.guess_handle(1) }
local function done()
  local state = g.status()[buf]
  report.uploads = state and state.uploads or 0
  report.placements = state and state.placements or 0
  report.bytes = state and state.bytes or 0
  report.rejected = state and state.rejected or 0
  report.error = state and state.error or nil
  report.lines = vim.api.nvim_buf_get_lines(buf, 0, -1, false)
  vim.cmd.stopinsert()
  vim.api.nvim_win_hide(vim.api.nvim_get_current_win())
  report.retained_hidden = g.status()[buf] ~= nil
  vim.cmd("vsplit")
  vim.api.nvim_set_current_buf(buf)
  report.same_job = vim.bo[buf].channel == job
  vim.fn.jobstop(job)
  vim.defer_fn(function()
    report.cleaned = g.status()[buf] == nil
    vim.fn.writefile({ vim.json.encode(report) }, dir .. "/result.json")
    vim.cmd("qa!")
  end, 300)
end
local tries = 0
local function poll()
  tries = tries + 1
  local state = g.status()[buf]
  if (state and state.uploads > 0 and state.placements > 0) or tries > 140 then
    done()
  else
    vim.defer_fn(poll, 100)
  end
end
vim.defer_fn(function()
  vim.api.nvim_chan_send(job, "\27[200~" .. dir .. "/sample.png\27[201~")
  poll()
end, 2500)
