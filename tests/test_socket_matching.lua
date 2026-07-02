-- Integration tests for the socket-matching layer (check_and_add_socket).
-- Exercises cwd matching, realpath normalization, and error resilience
-- without requiring a running OMP process or real Unix sockets.
local omp = require("omp")

local function assert_true(cond, msg)
  if not cond then
    print("FAIL: " .. msg)
    os.exit(1)
  end
end

print("Running OMP socket-matching tests...")

local uv = vim.uv
local cwd = vim.fn.getcwd()
local real_cwd = uv.fs_realpath(cwd) or cwd

local function clear_sockets()
  for k in pairs(omp._active_sockets) do
    omp._active_sockets[k] = nil
  end
end

-- Temp dir for fake .info files (no actual sockets needed for these tests)
local tmpdir = vim.fn.tempname()
vim.fn.mkdir(tmpdir, "p")

-- Test 1: matching cwd registers the socket path
local info1 = tmpdir .. "/10001.sock.info"
local f1 = io.open(info1, "w")
assert_true(f1 ~= nil, "Could not create temp info file")
f1:write(vim.json.encode({ cwd = real_cwd }))
f1:close()

clear_sockets()
omp._check_and_add_socket(info1)
local sock1 = info1:gsub("%.info$", "")
assert_true(omp._active_sockets[sock1] == true, "Matching cwd should register socket")

-- Test 2: non-matching cwd does NOT register socket
local info2 = tmpdir .. "/10002.sock.info"
local f2 = io.open(info2, "w")
assert_true(f2 ~= nil, "Could not create temp info file 2")
f2:write(vim.json.encode({ cwd = "/totally/nonexistent/path/xyz123" }))
f2:close()

clear_sockets()
omp._check_and_add_socket(info2)
local sock2 = info2:gsub("%.info$", "")
assert_true(omp._active_sockets[sock2] == nil, "Non-matching cwd should NOT register socket")

-- Test 3: malformed JSON does not crash
local info3 = tmpdir .. "/10003.sock.info"
local f3 = io.open(info3, "w")
assert_true(f3 ~= nil, "Could not create temp info file 3")
f3:write("{this is not json{{{{")
f3:close()

clear_sockets()
local ok3 = pcall(omp._check_and_add_socket, info3)
assert_true(ok3, "Malformed info file should not crash check_and_add_socket")
local sock3 = info3:gsub("%.info$", "")
assert_true(omp._active_sockets[sock3] == nil, "Malformed info file should not register socket")

-- Test 4: info file without cwd field does not register socket
local info4 = tmpdir .. "/10004.sock.info"
local f4 = io.open(info4, "w")
assert_true(f4 ~= nil, "Could not create temp info file 4")
f4:write(vim.json.encode({ pid = 12345 }))
f4:close()

clear_sockets()
omp._check_and_add_socket(info4)
local sock4 = info4:gsub("%.info$", "")
assert_true(omp._active_sockets[sock4] == nil, "Info without cwd field should not register socket")

-- Test 5: missing info file does not crash
clear_sockets()
local ok5 = pcall(omp._check_and_add_socket, tmpdir .. "/nonexistent.sock.info")
assert_true(ok5, "Missing info file should not crash")

-- Test 6: mtime cache prevents re-adding a manually-removed (dead) socket.
-- Mirrors what broadcast_active_file does on a failed connect: it removes the
-- entry from active_sockets. As long as the .info file's mtime is unchanged,
-- a second check_and_add_socket call must not re-parse and re-add it.
local info6 = tmpdir .. "/10006.sock.info"
local f6 = io.open(info6, "w")
assert_true(f6 ~= nil, "Could not create temp info file 6")
f6:write(vim.json.encode({ cwd = real_cwd }))
f6:close()

clear_sockets()
omp._check_and_add_socket(info6)
local sock6 = info6:gsub("%.info$", "")
assert_true(omp._active_sockets[sock6] == true, "First call should register socket")

omp._active_sockets[sock6] = nil -- simulate dead-socket removal
omp._check_and_add_socket(info6) -- same mtime — cache should skip re-parse/re-add
assert_true(omp._active_sockets[sock6] == nil, "Cached mtime should prevent re-adding a removed dead socket")

-- Cleanup
os.remove(info1)
os.remove(info2)
os.remove(info3)
os.remove(info4)
os.remove(info6)

print("PASS: All socket-matching tests passed!")
