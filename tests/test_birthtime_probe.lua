-- The watcher fingerprint may only fold in birthtime where libuv reports a real
-- creation time. Where statx is unavailable (kernels < 4.11, or a seccomp filter
-- that rejects it, after which libuv latches no_statx for the process) libuv's
-- fallback aliases birthtime to ctime — and a directory's ctime advances every
-- time an entry is created or removed inside it, so folding it in would tear
-- down and rebind the live watch every time an OMP session writes its .info
-- file, dropping every event in that window.
--
-- Needs its own Neovim: the probe measures once per session and latches, so the
-- aliasing has to be in place before the first setup(). test_watcher.lua covers
-- the other side — a real birthtime being used to spot a same-path recreate.
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

-- Stand in for libuv's uv__to_stat(), which assigns st_birthtim from st_ctim.
-- Matched by suffix because the module stats both the raw and the
-- realpath-resolved spelling, and scoped to the sockets directory so nothing
-- else in Neovim sees a doctored stat.
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

-- The regression this guards: an OMP session writing its .info file moves the
-- directory's ctime, and therefore an aliased birthtime.
local fd = uv.fs_open(omp._sockets_dir .. "/1.sock.info", "w", 384) -- 0o600
assert_true(fd ~= nil, "Could not write probe .info file")
uv.fs_close(fd)
vim.api.nvim_exec_autocmds("BufEnter", {})
assert_true(
  omp._watched_dir() == fingerprint,
  "Writing into the watched directory must not churn the watcher, got " .. tostring(omp._watched_dir())
)
assert_true(omp._watcher_active(), "Watcher should still be live")

-- Recreate detection is what the aliasing costs: dev+ino is the only identity
-- left, so a same-path recreate is invisible wherever the filesystem also
-- reuses the inode number (ext4). Asserted so the tradeoff stays a decision
-- rather than a surprise.
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
