# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [1.1.2] - 2026-07-02

### Changed

- **Agent behavior:** Tightened the injected system directive to explicitly instruct the agent that the active file is passive background context, stopping the AI from proactively asking what to do with it.

## [1.1.1] - 2026-07-02

### Added

- `lua/omp/health.lua`: `:checkhealth omp` support — verifies Neovim version, `vim.uv` availability, sockets directory, and active sessions
- `stylua.toml`, `.luacheckrc`, `.luarc.json`: Lua tooling config
- CI: stylua check + luacheck lint steps
- Integration tests for socket-matching layer (`tests/test_socket_matching.lua`)

### Changed

- **macOS fix:** `handle_buf_change` now calls `sync_sockets()` before broadcasting, fixing OMP sessions started after Neovim never being discovered (FSEvents doesn't reliably report filenames)
- **Perf fix:** `check_and_add_socket` now caches each `.info` file's mtime and skips re-reading/re-parsing it while unchanged. Without this, the macOS fix above would re-parse JSON and re-run `fs_realpath` for every `.info` file (including dead ones left by crashed OMP processes) on every cursor move. `sync_sockets` prunes cache entries for `.info` files that no longer exist.
- fs_event watcher callback hardens macOS fallback: when `filename` is nil/non-matching, does a full `sync_sockets()` instead of returning early
- Watcher lifecycle: `active_watcher` tracked at module scope; repeated `setup()` stops the previous watcher to prevent handle leaks
- Native `vim.json.decode`/`vim.json.encode` replace `vim.fn.json_decode`/`vim.fn.json_encode` (faster, no VimL bridge)
- `uv.os_tmpdir()` replaces `vim.uv.os_tmpdir()` for consistency with the existing `local uv = vim.uv` alias
- TS: `pi.logger.error` replaces the silent `server.on("error", () => {})` so socket bind failures are surfaced
- TS: explicit `fs.unlinkSync(sockPath)` before `server.listen()` defends against PID-reuse leaving a live-looking stale socket
- TS: `cleanup()` nulls `socketPath`/`infoPath` after unlink (prevents double-unlink on repeated calls)
- `.editorconfig`: added `[*.lua]` override (`indent_style = space`, `indent_size = 2`) resolving contradiction with actual Lua indentation
- `.gitignore`: removed stale `/tmp/omp-nvim-sockets` entry (sockets now use `$XDG_RUNTIME_DIR` / system tmpdir, outside the repo)

## [1.1.0] - 2026-07-01

### Added

- Widget UI above the OMP editor showing the active Neovim file and line

### Changed

- Socket names simplified from `<cwd-hash>-<pid>.sock` to `<pid>.sock`
- Info file now stores only `{ cwd }` (removed redundant `pid` field)
- Stale socket probe covers all `.sock` files in the directory
- `XDG_RUNTIME_DIR` fallback uses `os.tmpdir()` / `uv.os_tmpdir()` on both sides instead of hard-coded `/tmp`

## [1.0.0] - 2026-06-01

### Added

- Initial release: Neovim plugin tracking active file/line via libuv Unix sockets
- OMP extension injecting active file context into prompts
- Visual selection range support (`file:start-end`)
- CWD-based matching for multi-project session isolation
- CI workflow with TypeScript typecheck, Biome lint, and Lua test

[Unreleased]: https://github.com/rauls-kjarners/omp.nvim/compare/v1.1.2...HEAD
[1.1.2]: https://github.com/rauls-kjarners/omp.nvim/compare/v1.1.1...v1.1.2
[1.1.1]: https://github.com/rauls-kjarners/omp.nvim/compare/v1.1.0...v1.1.1
[1.1.0]: https://github.com/rauls-kjarners/omp.nvim/compare/v1.0.0...v1.1.0
[1.0.0]: https://github.com/rauls-kjarners/omp.nvim/releases/tag/v1.0.0
