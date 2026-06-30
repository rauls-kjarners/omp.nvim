local omp = require("omp")

local function assert_eq(expected, actual, msg)
  if expected ~= actual then
    print(string.format("FAIL: %s | Expected: '%s', Got: '%s'", msg, expected, actual))
    os.exit(1)
  end
end

print("Running OMP tests...")

-- Test: Ignores special buffers
assert_eq("", omp._get_display_path("term://foo", "terminal", 10, 10, "n"), "Should ignore terminal buffers")
assert_eq("", omp._get_display_path("nofile", "nofile", 1, 1, "n"), "Should ignore nofile buffers")

-- Test: Ignores empty buffer names
assert_eq("", omp._get_display_path("", "", 10, 10, "n"), "Should ignore empty buffer names")

-- Test: Formats normal mode correctly
assert_eq("src/main.lua:42", omp._get_display_path("src/main.lua", "", 42, 42, "n"), "Should format single line in normal mode")

-- Test: Formats visual mode ranges
assert_eq("src/main.lua:40-45", omp._get_display_path("src/main.lua", "", 45, 40, "v"), "Should format visual selection bottom-up")
assert_eq("src/main.lua:40-45", omp._get_display_path("src/main.lua", "", 40, 45, "v"), "Should format visual selection top-down")
assert_eq("src/main.lua:40-45", omp._get_display_path("src/main.lua", "", 45, 40, "V"), "Should format line visual selection")

print("PASS: All tests passed!")
