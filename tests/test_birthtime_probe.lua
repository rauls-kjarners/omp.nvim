-- Simulates libuv without statx (birthtime aliased to ctime). Separate Neovim:
-- the probe latches once per session, so the stub must precede setup().
local uv = vim.uv

local function assert_true(cond, msg)
  if not cond then
    print("FAIL: " .. msg)
    os.exit(1)
  end
end

print("Running OMP birthtime-probe tests...")

local root = vim.fn.tempname()
vim.fn.mkdir(root, "p")
vim.env.XDG_RUNTIME_DIR = root
local raw_dir = root .. "/omp-nvim-sockets"

-- Mimics libuv's uv__to_stat() fallback. Suffix match covers raw and realpath spellings.
local real_fs_stat = uv.fs_stat
local pinned_ino = nil
vim.uv.fs_stat = function(path)
  local st = real_fs_stat(path)
  if st and path:match("omp%-nvim%-sockets$") then
    st.birthtime = { sec = st.ctime.sec, nsec = st.ctime.nsec }
    if pinned_ino then
      st.ino = pinned_ino
    end
  end
  return st
end

local omp = require("omp")
omp.setup()

assert_true(
  omp._birthtime_reliable() == false,
  "Probe should reject a birthtime that moves with ctime, got " .. tostring(omp._birthtime_reliable())
)

local fingerprint = omp._watched_dir()
assert_true(
  fingerprint ~= nil and fingerprint:match("^%d+:%d+$") ~= nil,
  "A rejected birthtime must leave dev:ino as the whole fingerprint, got " .. tostring(fingerprint)
)

-- Writing a .info file moves ctime, and so an aliased birthtime.
local fd = uv.fs_open(omp._sockets_dir .. "/1.sock.info", "w", 384) -- 0o600
assert_true(fd ~= nil, "Could not write probe .info file")
uv.fs_close(fd)
vim.api.nvim_exec_autocmds("BufEnter", {})
assert_true(
  omp._watched_dir() == fingerprint,
  "Writing into the watched directory must not churn the watcher, got " .. tostring(omp._watched_dir())
)
assert_true(omp._watcher_active(), "Watcher should still be live")

-- Accepted cost: with dev+ino only, a recreate reusing the inode (ext4) is invisible.
pinned_ino = real_fs_stat(omp._sockets_dir).ino
vim.fn.delete(raw_dir, "rf")
vim.fn.mkdir(raw_dir, "p", 448) -- 0o700
vim.api.nvim_exec_autocmds("BufEnter", {})
local after_recreate = omp._watched_dir()
vim.uv.fs_stat = real_fs_stat
assert_true(
  after_recreate == fingerprint,
  "Without a usable birthtime a reused inode number is indistinguishable, got " .. tostring(after_recreate)
)

vim.fn.delete(root, "rf")

print("PASS: All birthtime-probe tests passed!")
