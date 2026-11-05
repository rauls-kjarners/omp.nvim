"""Real OMP draft PNG -> Nvim TermRequest -> outer PTY; no model submission."""
import base64
import fcntl
import json
import os
from pathlib import Path
import pty
import random
import re
import select
import shutil
import signal
import struct
import tempfile
import termios
import time
import zlib

root = Path(__file__).resolve().parents[1]
out = Path(tempfile.mkdtemp(prefix="omp-graphics-pty-"))
nvim = shutil.which("nvim")
omp = shutil.which("omp")
assert nvim and omp, "nvim and omp must be installed"


def chunk(kind, body):
    return (struct.pack(">I", len(body)) + kind + body
            + struct.pack(">I", zlib.crc32(kind + body) & 0xffffffff))


# Noise ensures OMP transmits multiple Kitty chunks rather than one tiny PNG.
rng = random.Random(42)
width, height = 320, 160
raw = b"".join(b"\0" + bytes(rng.randrange(256) for _ in range(width * 3))
               for _ in range(height))
(out / "sample.png").write_bytes(
    b"\x89PNG\r\n\x1a\n"
    + chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0))
    + chunk(b"IDAT", zlib.compress(raw)) + chunk(b"IEND", b""))
lua = (root / "tests/fixtures/graphics_pty.lua").read_text()
(out / "probe.lua").write_text(lua)
pid, fd = pty.fork()
if pid == 0:
    os.environ["TERM"] = "xterm-256color"
    os.environ["OMP_GRAPHICS_TEST_PLUGIN"] = str(root)
    os.environ["OMP_GRAPHICS_TEST_DIR"] = str(out)
    os.environ["OMP_GRAPHICS_TEST_OMP"] = omp
    os.chdir(out)
    os.execv(nvim, [nvim, "-u", "NONE", "-n", "-i", "NONE", "-S", str(out / "probe.lua")])

fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", 40, 140, 1400, 800))
output = bytearray()
deadline = time.monotonic() + 25
try:
    while time.monotonic() < deadline:
        if select.select([fd], [], [], .2)[0]:
            try:
                data = os.read(fd, 1048576)
            except OSError:
                break
            if not data:
                break
            output.extend(data)
    else:
        os.kill(pid, signal.SIGTERM)
        raise AssertionError("PTY test timed out")
finally:
    os.close(fd)
    os.waitpid(pid, 0)
    (out / "terminal.bin").write_bytes(output)

report = json.loads((out / "result.json").read_text())
assert not report.get("error"), report
assert report["uploads"] == 1 and report["placements"] >= 1, report
assert report["retained_hidden"] and report["same_job"] and report["cleaned"], report
assert any("\U0010eeee" in line for line in report.pop("lines"))
packets = re.findall(rb"\x1b_G([^;\x1b]*);?([^\x1b]*)\x1b\\", output)
parts = [data for header, data in packets if b"a=t" in header or header.startswith(b"m=")]
assert len(parts) > 1, "Expected a multi-chunk upload"
png = base64.b64decode(b"".join(parts), validate=True)
assert png.startswith(b"\x89PNG\r\n\x1a\n")
offset = 8
while offset < len(png):
    size = struct.unpack(">I", png[offset:offset + 4])[0]
    kind_and_body = png[offset + 4:offset + 8 + size]
    crc = struct.unpack(">I", png[offset + 8 + size:offset + 12 + size])[0]
    assert zlib.crc32(kind_and_body) & 0xffffffff == crc, "PNG packet corruption"
    offset += 12 + size
assert offset == len(png)
assert any(header.startswith(b"a=p,U=1") for header, _ in packets)
assert any(header.startswith(b"a=d,d=I,i=") for header, _ in packets)
assert not any(header.startswith(b"a=d,d=A") for header, _ in packets)
report.update(png_bytes=len(png), upload_chunks=len(parts), png_crc="PASS", evidence=str(out))
(out / "verification.json").write_text(json.dumps(report, indent=2))
print(json.dumps(report, indent=2))
