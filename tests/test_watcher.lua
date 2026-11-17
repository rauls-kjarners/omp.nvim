local uv = vim.uv

local function assert_true(cond, msg)
  if not cond then
    print("FAIL: " .. msg)
    os.exit(1)
  end
end

print("Running OMP watcher/discovery tests...")

-- Must precede require("omp"): XDG_RUNTIME_DIR is read at load time.
local root = vim.fn.tempname()
vim.fn.mkdir(root .. "/a", "p")
local link = root .. "/link"
assert_true(uv.fs_symlink(root .. "/a", link), "Could not create symlink")
vim.env.XDG_RUNTIME_DIR = link

local omp = require("omp")
local raw_dir = link .. "/omp-nvim-sockets"

omp.setup()
assert_true(uv.fs_stat(raw_dir) ~= nil, "setup() should create the sockets directory")
assert_true(omp._sockets_dir == uv.fs_realpath(raw_dir), "_sockets_dir should be the resolved path")
assert_true(omp._sockets_dir:find("/a/", 1, true) ~= nil, "_sockets_dir should resolve through the symlink")
assert_true(omp._watcher_active(), "setup() should start the fs_event watcher")
assert_true(
  type(omp._birthtime_reliable()) == "boolean",
  "setup() should measure whether this filesystem reports a usable birthtime"
)

local ok_setup = pcall(omp.setup)
assert_true(ok_setup, "Repeated setup() should not error")
assert_true(omp._watcher_active(), "Repeated setup() should leave a live watcher")

vim.cmd.edit("lua/omp/init.lua")
vim.api.nvim_exec_autocmds("CursorMoved", {})
local current, broadcast = omp._broadcast_state()
assert_true(current == "lua/omp/init.lua:1", "Current path should track the edited buffer, got " .. tostring(current))
assert_true(broadcast == current, "CursorMoved should broadcast the new path, got " .. tostring(broadcast))

omp.setup()
local _, after_setup = omp._broadcast_state()
assert_true(after_setup == nil, "setup() should reset the broadcast dedupe, got " .. tostring(after_setup))

-- Reaped dir: the old watch is attached to the deleted inode.
vim.fn.delete(omp._sockets_dir, "rf")
assert_true(uv.fs_stat(raw_dir) == nil, "Sockets directory should be gone")
vim.api.nvim_exec_autocmds("BufEnter", {})
assert_true(uv.fs_stat(raw_dir) ~= nil, "Buffer event should recreate the reaped sockets directory")
assert_true(omp._watcher_active(), "Watcher should be rebound after the directory is recreated")

-- Retargeted symlink: a stale cached realpath would point at a dir no OMP binds.
vim.fn.mkdir(root .. "/b", "p")
vim.fn.delete(root .. "/a", "rf")
assert_true(uv.fs_unlink(link), "Could not unlink symlink")
assert_true(uv.fs_symlink(root .. "/b", link), "Could not retarget symlink")
vim.api.nvim_exec_autocmds("BufEnter", {})
assert_true(omp._sockets_dir == uv.fs_realpath(raw_dir), "_sockets_dir should be re-resolved after recreate")
assert_true(omp._sockets_dir:find("/b/", 1, true) ~= nil, "_sockets_dir should follow the retargeted symlink")

vim.fn.delete(omp._sockets_dir, "rf")
uv.fs_chmod(root .. "/b", 320) -- 0o500: no write, so mkdir fails
local writable = pcall(vim.fn.mkdir, raw_dir, "p")
if writable then
  print("SKIP: sockets directory parent is writable despite 0o500 (running as root?)")
  vim.fn.delete(raw_dir, "rf")
else
  vim.api.nvim_exec_autocmds("BufEnter", {})
  assert_true(uv.fs_stat(raw_dir) == nil, "mkdir should have failed under a read-only parent")
  assert_true(not omp._watcher_active(), "A failed watcher start must not be reported as running")
end
uv.fs_chmod(root .. "/b", 448)

-- Reaper can win the race between mkdir and fs_event start; a scan must re-arm.
assert_true(not writable or omp._watcher_active(), "Skipped read-only case should leave a live watcher")
vim.fn.mkdir(raw_dir, "p", 448)
vim.api.nvim_exec_autocmds("BufEnter", {})
assert_true(omp._watcher_active(), "A successful scan should re-arm a missing watcher")
assert_true(
  omp._sockets_dir == uv.fs_realpath(raw_dir),
  "A successful scan should re-resolve a path left at the unresolved spelling by a failed mkdir"
)

-- Same-path recreate never observed missing: inotify drops the watch on
-- IN_DELETE_SELF while the handle still looks live.
local id_before = omp._watched_dir()
assert_true(id_before ~= nil, "A live watcher should record the directory it bound")
vim.api.nvim_exec_autocmds("BufEnter", {})
assert_true(omp._watched_dir() == id_before, "An unchanged directory must not churn the watcher")
-- ctime (or a ctime-aliased birthtime) must stay out of the fingerprint, else
-- every .info write rebinds the watch.
local churn_probe = io.open(raw_dir .. "/churn.probe", "w")
assert_true(churn_probe ~= nil, "Could not write churn probe file")
churn_probe:close()
vim.api.nvim_exec_autocmds("BufEnter", {})
assert_true(omp._watched_dir() == id_before, "Writing into the watched directory must not churn the watcher")
vim.fn.delete(raw_dir .. "/churn.probe")
vim.fn.delete(raw_dir, "rf")
vim.fn.mkdir(raw_dir, "p", 448)
vim.api.nvim_exec_autocmds("BufEnter", {})
local id_after = omp._watched_dir()
assert_true(omp._watcher_active(), "Watcher should stay live across a same-path recreate")
assert_true(
  id_after ~= nil and id_after ~= id_before,
  "Watcher should be rebound when the watched directory is recreated"
)

-- ext4 reuses the freed inode, so dev+ino can't see the recreate; the stub pins
-- ino and relies on birthtime.
if omp._birthtime_reliable() then
  local real_fs_stat = uv.fs_stat
  local pinned_ino = real_fs_stat(omp._sockets_dir).ino
  vim.uv.fs_stat = function(path)
    local st = real_fs_stat(path)
    if st and path == omp._sockets_dir then
      st.birthtime = { sec = 0, nsec = st.ino }
      st.ino = pinned_ino
    end
    return st
  end
  local pinned_before = omp._watched_dir()
  vim.fn.delete(raw_dir, "rf")
  vim.fn.mkdir(raw_dir, "p", 448)
  vim.api.nvim_exec_autocmds("BufEnter", {})
  local pinned_after = omp._watched_dir()
  -- Restore before asserting so a leaked stub can't affect later tests.
  vim.uv.fs_stat = real_fs_stat
  assert_true(
    pinned_after ~= nil and pinned_after ~= pinned_before,
    "Watcher should be rebound after a recreate that reuses the inode number"
  )
else
  print("SKIP: no usable birthtime, so a reused inode number is indistinguishable")
end

-- Watcher-driven broadcast bypasses the dedupe but must still record the path.
omp.setup()
local _, before_event = omp._broadcast_state()
assert_true(before_event == nil, "Precondition: setup() should clear the dedupe")
local probe = io.open(raw_dir .. "/999.sock.info", "w")
assert_true(probe ~= nil, "Could not write probe info file")
probe:write(vim.json.encode({ cwd = vim.fn.getcwd() }))
probe:close()
local recorded = vim.wait(3000, function()
  local _, sent = omp._broadcast_state()
  return sent ~= nil
end, 20)
local current_path, sent_path = omp._broadcast_state()
assert_true(recorded, "fs_event discovery should broadcast and record the path")
assert_true(sent_path == current_path, "Recorded broadcast should be the path that was sent")

vim.fn.delete(root, "rf")

print("PASS: All watcher/discovery tests passed!")
