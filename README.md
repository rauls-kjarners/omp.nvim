# omp.nvim

[![CI](https://github.com/rauls-kjarners/omp.nvim/actions/workflows/ci.yml/badge.svg)](https://github.com/rauls-kjarners/omp.nvim/actions/workflows/ci.yml)
[![npm version](https://badge.fury.io/js/omp.nvim.svg)](https://badge.fury.io/js/omp.nvim)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)

A seamless integration bridge between Neovim and the Oh My Pi (OMP) coding agent.

This plugin allows an active OMP terminal session to perfectly track your cursor, active file, and visual selections inside Neovim. It updates the OMP interface dynamically so the AI always knows exactly what you are looking at.

## Features

- **Zero-Config Context:** The AI instantly knows your active file—no need to type out paths.
- **Line-Level Precision:** Sends exact line numbers (e.g., `main.ts:42`).
- **Visual Selection Support:** Highlights exact code blocks (e.g., `main.ts:40-50`).
- **Non-Blocking:** Uses `libuv` Unix sockets for zero impact on editor performance.

## Requirements

- Neovim >= 0.10.0
- Oh My Pi >= 16.2.9

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
       lazy = false,
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

## Under the Hood

The project is split into two halves:

1. **The Neovim Plugin (`lua/omp`):** A lightweight Lua script that hooks into `BufEnter`, `CursorMoved`, and `CursorHold` events. It actively tracks your focused file and broadcasts it via non-blocking `libuv` pipes to matching OMP sockets in `/tmp/omp-nvim-sockets`.
2. **The OMP Extension (`src/extension.ts`):** A native OMP extension that boots up alongside your terminal. It establishes a Unix domain socket and caches its location so Neovim can find it. It intercepts the active context and invisibly injects it into your prompts.

## Development

The OMP extension is written in TypeScript and runs natively on OMP's Bun engine without requiring compilation. Any changes to `src/extension.ts` will take effect the next time you boot or `/reload` an OMP instance. Changes to `lua/omp/init.lua` take effect when Neovim is restarted.
