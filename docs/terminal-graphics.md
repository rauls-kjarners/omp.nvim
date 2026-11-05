# Experimental terminal graphics relay

## Problem and behavior

OMP can draw attachment thumbnails in a terminal supporting Kitty Unicode
placeholders. Inside Neovim, the placeholder text cells survive but the image
upload APCs are not automatically forwarded to the outer terminal. Forcing OMP's
graphics protocol alone can therefore replace an attachment icon with an empty
rectangle.

With `terminal_graphics.enabled = true` and an explicitly attached terminal
buffer, the plugin handles `TermRequest` events for that buffer. It forwards
direct PNG uploads and virtual placements to the outer TTY. Neovim draws the
colored Unicode cells; the outer terminal supplies the pixels. No OMP extension
changes or additional image plugins are required. See the README for setup.

## Supported scope

- The relay is disabled by default; existing `setup()` calls keep their behavior.
- The graphics path requires Neovim >= 0.12 and a POSIX TUI using LuaJIT FFI.
  Context synchronization still supports Neovim >= 0.10.
- The outer terminal must support both Kitty graphics and Unicode placeholders.
  `terminal_env()` checks host prerequisites, not terminal graphics capabilities.
- Only buffers registered through `attach_terminal(buf)` are relayed. Its return
  value is `true` on attachment, or `false, reason` for an unsupported host path.
- tmux, screen, Zellij, GUI clients, and headless sessions are unsupported.
- Only direct base64 PNG uploads and Unicode virtual placements are supported.
  File/shared-memory transports, direct cursor placements, animation commands,
  and unrelated terminal controls are not forwarded.

## Lifetime and resource handling

Hiding and reopening a terminal window retains the existing job and image data;
the virtual images follow their placeholder text cells. Closing the terminal
buffer or exiting Neovim deletes IDs uploaded by that buffer. A global delete
request from OMP is expanded into scoped deletes so it cannot indiscriminately
erase other stored images. Colliding IDs across attached OMP buffers are rejected
and reported instead of overwriting the other buffer's image.

Limits are 128 tracked image IDs per buffer and 32 MiB of base64 per upload.
Malformed requests are rejected. Write failures are recorded and do not count as
successful uploads or placements.

The writer resolves stdout's device using POSIX `ttyname(1)` via LuaJIT FFI and
opens a separate blocking handle. Neovim's stdout can be nonblocking; writing to
it directly can split an APC at EAGAIN and leave a truncated image. Complete
packet writes avoid that failure, but synchronous output can briefly block the
editor with a slow terminal or large image. This initial implementation is not a
general high-throughput graphics proxy.

Independent image plugins can still choose a colliding ID or clear the outer
terminal's entire image store. Cross-plugin ID coordination is not implemented.
The relay does not promise compatibility with every image plugin or terminal.

## Validation

The user confirmed visible attachment thumbnails with iTerm2 3.7.6, Neovim
0.12.6, and OMP 18.16.0 on macOS. This is one verified environment, not a claim of
visual verification across all terminals, operating systems, scrolling states,
or resize behavior.

The Lua tests cover chunked uploads, rejected transports and commands, scoped
deletion, cleanup, failed-write accounting, and collisions between OMP relays:

```sh
for f in tests/*.lua; do
  nvim --headless -u NONE --cmd 'set rtp+=.' -l "$f"
done
```

The optional real-OMP PTY test requires Python 3, `nvim`, and an already configured
OMP installation with an image-capable model selected. It stages a generated
image without submitting a model request:

```sh
python3 tests/graphics_pty.py
```

It captures the bytes received by the outer PTY, reconstructs and checks every
PNG chunk's CRC, and checks virtual placement, hide/show job retention, and scoped
cleanup. It leaves evidence in a temporary directory printed by the script. This
tests protocol integrity; it is not a visual rendering test. Authentication and
interactive first-run setup are deliberately not automated.
