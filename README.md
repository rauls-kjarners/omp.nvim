# omp.nvim

[![CI](https://github.com/rauls-kjarners/omp.nvim/actions/workflows/ci.yml/badge.svg)](https://github.com/rauls-kjarners/omp.nvim/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/omp.nvim.svg)](https://www.npmjs.com/package/omp.nvim)

A seamless integration bridge between Neovim and the Oh My Pi (OMP) coding agent.

This plugin allows an active OMP terminal session to perfectly track your cursor, active file, and visual selections inside Neovim. It updates the OMP interface dynamically so the AI always knows exactly what you are looking at.

## Features

- **Zero-Config Context:** The AI instantly knows your active file—no need to type out paths.
- **Line-Level Precision:** Sends exact line numbers (e.g., `src/main.ts:42`).
- **Visual Selection Support:** Highlights exact code blocks (e.g., `src/main.ts:40-50`).
- **Non-Blocking:** Uses `libuv` Unix sockets for zero impact on editor performance.

## Requirements

- Neovim >= 0.10.0
- Oh My Pi >= 18.2.1

## Installation & Setup

1. **Install the OMP extension:**

   ```bash
   omp plugin install omp.nvim
   ```

2. **Configure Neovim (LazyVim / lazy.nvim):**
   Add the following to your Neovim plugin configuration (e.g., `~/.config/nvim/lua/plugins/omp.lua`):

   ```lua
   return {
     {
       "rauls-kjarners/omp.nvim",
       event = "VeryLazy",
       config = function()
         require("omp").setup()
       end,
     }
   }
   ```

3. **Add a Keymap:**
   If using `Snacks.terminal` (included in LazyVim), you can spawn OMP in a perfectly styled side-panel. Add this to `~/.config/nvim/lua/config/keymaps.lua`:

   ```lua
   vim.keymap.set("n", "<leader>ao", function()
     Snacks.terminal.toggle("omp", {
       win = {
         position = "right",
         width = 0.4
       }
     })
   end, { desc = "Toggle Oh My Pi" })
   ```

## Agent Behavior

This plugin injects your active file path into the chat as passive background context — no extra setup required.

If you want to further tune how your agent handles this (or any other injected context), you
can add your own rule to `~/.omp/agent/AGENTS.md`, but it's optional.

## Under the Hood

The project is split into two halves:

1. **The Neovim Plugin (`lua/omp`):** A lightweight Lua script that hooks into `BufEnter`, `CursorMoved`, and `CursorHold` events. It actively tracks your focused file and broadcasts it via non-blocking `libuv` pipes to matching OMP sockets in `$XDG_RUNTIME_DIR/omp-nvim-sockets` (Linux) or the system temp directory (macOS).
2. **The OMP Extension (`src/extension.ts`):** A native OMP extension that boots up alongside your terminal. It establishes a Unix domain socket and caches its location so Neovim can find it. It intercepts the active context and invisibly injects it into your prompts.

Run `:checkhealth omp` inside Neovim to verify the integration is working correctly.

## Optional attachment thumbnails (experimental)

OMP can display attachment thumbnails inside a Neovim terminal by forwarding
Kitty PNG uploads and virtual placements to the outer terminal. This is opt-in;
the existing context bridge and its Neovim >= 0.10 requirement are unchanged.
Graphics require Neovim >= 0.12, a POSIX TUI with LuaJIT, and an outer terminal
supporting Kitty Unicode placeholders. tmux, screen, Zellij, GUI clients, and
headless sessions are not supported by this relay.

```lua
require("omp").setup({ terminal_graphics = { enabled = true } })

-- Example using Snacks; any terminal integration can explicitly attach a buffer.
local terminal = Snacks.terminal.toggle("omp", {
  cwd = vim.fn.getcwd(),
  env = require("omp").terminal_env(),
  win = { position = "right", width = 0.4 },
})
require("omp").attach_terminal(terminal.buf)
```

Enable this only after verifying the outer terminal supports that graphics mode.
`terminal_env()` enables OMP's Kitty placeholders on supported host paths and
disables images when the relay is disabled or the host path is unsupported. It
does not probe the outer terminal's graphics capabilities. `:checkhealth omp`
reports unsupported host paths, upload/placement counters, and write failures.

See [terminal graphics](docs/terminal-graphics.md) for limits and validation.

## Development

The OMP extension is written in TypeScript and runs natively on OMP's Bun engine without requiring compilation. Any changes to `src/extension.ts` will take effect the next time you boot or `/reload` an OMP instance. Changes to `lua/omp/init.lua` take effect when Neovim is restarted.
