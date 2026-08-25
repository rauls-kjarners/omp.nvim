-- Integration tests for socket-directory discovery: watcher lifecycle, the
-- recreate-and-rebind path taken when the directory is reaped underneath us,
-- and the broadcast dedupe state. Runs against a private XDG_RUNTIME_DIR so it
-- never touches a real OMP session's sockets.
local uv = vim.uv

local function assert_true(cond, msg)
  if not cond then
    print("FAIL: " .. msg)
    os.exit(1)
  end
end

print("Running OMP watcher/discovery tests...")

-- Must be set before requiring omp: the module reads XDG_RUNTIME_DIR once, at
-- load time, to compute its sockets directory.
local root = vim.fn.tempname()
vim.fn.mkdir(root .. "/a", "p")
local link = root .. "/link"
assert_true(uv.fs_symlink(root .. "/a", link), "Could not create symlink")
vim.env.XDG_RUNTIME_DIR = link

local omp = require("omp")
local raw_dir = link .. "/omp-nvim-sockets"

-- Test 1: setup() creates the directory, resolves symlinks, and starts a watcher
omp.setup()
assert_true(uv.fs_stat(raw_dir) ~= nil, "setup() should create the sockets directory")
assert_true(omp._sockets_dir == uv.fs_realpath(raw_dir), "_sockets_dir should be the resolved path")
assert_true(omp._sockets_dir:find("/a/", 1, true) ~= nil, "_sockets_dir should resolve through the symlink")
assert_true(omp._watcher_active(), "setup() should start the fs_event watcher")
assert_true(
  type(omp._birthtime_reliable()) == "boolean",
  "setup() should measure whether this filesystem reports a usable birthtime"
)

-- Test 2: repeated setup() rebinds without error and leaves a live watcher
local ok_setup = pcall(omp.setup)
assert_true(ok_setup, "Repeated setup() should not error")
assert_true(omp._watcher_active(), "Repeated setup() should leave a live watcher")

-- Test 3: broadcast state tracks the current buffer, and setup() clears the
-- dedupe so a reload always re-broadcasts
vim.cmd.edit("lua/omp/init.lua")
vim.api.nvim_exec_autocmds("CursorMoved", {})
local current, broadcast = omp._broadcast_state()
assert_true(current == "lua/omp/init.lua:1", "Current path should track the edited buffer, got " .. tostring(current))
assert_true(broadcast == current, "CursorMoved should broadcast the new path, got " .. tostring(broadcast))

omp.setup()
local _, after_setup = omp._broadcast_state()
assert_true(after_setup == nil, "setup() should reset the broadcast dedupe, got " .. tostring(after_setup))

-- Test 4: a reaped directory is recreated on the next buffer event, and the
-- watcher is rebound (the old handle is attached to the deleted inode)
vim.fn.delete(omp._sockets_dir, "rf")
assert_true(uv.fs_stat(raw_dir) == nil, "Sockets directory should be gone")
vim.api.nvim_exec_autocmds("BufEnter", {})
assert_true(uv.fs_stat(raw_dir) ~= nil, "Buffer event should recreate the reaped sockets directory")
assert_true(omp._watcher_active(), "Watcher should be rebound after the directory is recreated")

-- Test 5: recreation re-resolves the path. Retarget the symlink so the resolved
-- directory changes; a stale cached realpath would leave the watcher and every
-- scandir pointed at a directory no OMP session binds.
vim.fn.mkdir(root .. "/b", "p")
vim.fn.delete(root .. "/a", "rf")
assert_true(uv.fs_unlink(link), "Could not unlink symlink")
assert_true(uv.fs_symlink(root .. "/b", link), "Could not retarget symlink")
vim.api.nvim_exec_autocmds("BufEnter", {})
assert_true(omp._sockets_dir == uv.fs_realpath(raw_dir), "_sockets_dir should be re-resolved after recreate")
assert_true(omp._sockets_dir:find("/b/", 1, true) ~= nil, "_sockets_dir should follow the retargeted symlink")

-- Test 6: when the directory cannot be recreated, the watcher must report as
-- not running rather than holding a handle that never fires.
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

-- Test 7: the reaper can win the race between our mkdir and fs_event start, so
-- no watcher is bound while the directory exists again (OMP recreates it
-- itself). A successful scan must re-arm the watcher; otherwise discovery stays
-- degraded to buffer/idle polling for the rest of the session.
assert_true(not writable or omp._watcher_active(), "Precondition: test 6 left no watcher")
vim.fn.mkdir(raw_dir, "p", 448)
vim.api.nvim_exec_autocmds("BufEnter", {})
assert_true(omp._watcher_active(), "A successful scan should re-arm a missing watcher")
assert_true(
  omp._sockets_dir == uv.fs_realpath(raw_dir),
  "A successful scan should re-resolve a path left at the unresolved spelling by a failed mkdir"
)

-- Test 8: the directory is deleted and recreated at the same path before Nvim
-- ever observes it missing, so scandir succeeds against the new inode. The
-- watcher must be rebound: an inotify watch is inode-bound and is dropped on
-- IN_DELETE_SELF, so the old handle never fires again while still looking live.
local id_before = omp._watched_dir()
assert_true(id_before ~= nil, "A live watcher should record the directory it bound")
vim.api.nvim_exec_autocmds("BufEnter", {})
assert_true(omp._watched_dir() == id_before, "An unchanged directory must not churn the watcher")
-- Anything that only moves when the directory is written to — its own ctime, or
-- a birthtime libuv aliased to ctime because statx was unavailable — must stay
-- out of the fingerprint: an OMP session writing a .info file would otherwise
-- tear down and rebind the live watch, dropping every event in that window.
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

-- Test 8b: same recreate, but with the inode number pinned to its old value —
-- ext4 hands the freed inode straight back to the next mkdir, so dev+ino alone
-- cannot see the recreate and the rebind silently never happens (this passed on
-- macOS and failed on Linux CI). The stub carries the real identity in
-- birthtime, so the case is exercised on every filesystem that reports one
-- instead of only on the ones that happen to reuse inode numbers.
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
  -- Restored before asserting: a failed assert exits, and a leaked stub would
  -- corrupt every test after this one.
  vim.uv.fs_stat = real_fs_stat
  assert_true(
    pinned_after ~= nil and pinned_after ~= pinned_before,
    "Watcher should be rebound after a recreate that reuses the inode number"
  )
else
  print("SKIP: no usable birthtime, so a reused inode number is indistinguishable")
end

-- Test 9: a watcher-driven broadcast must record the path it sent. It bypasses
-- the dedupe on purpose (a newly discovered session has never seen our path),
-- but leaving the dedupe state stale re-sends on the next CursorMoved and makes
-- checkhealth report "Last broadcast: (never)" right after a broadcast.
omp.setup() -- resets the dedupe
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
