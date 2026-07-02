import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";

interface PiLogger {
	error(message: string, context?: Record<string, unknown>): void;
	warn(message: string, context?: Record<string, unknown>): void;
	info(message: string, context?: Record<string, unknown>): void;
	debug(message: string, context?: Record<string, unknown>): void;
}

interface PiContext {
	cwd: string;
	ui: {
		setWidget(
			key: string,
			content: string[] | undefined,
			options?: { placement?: "aboveEditor" | "belowEditor" },
		): void;
	};
}

interface ExtensionAPI {
	logger: PiLogger;
	on(
		event: "session_start",
		handler: (_event: unknown, ctx: PiContext) => void | Promise<void>,
	): void;
	on(
		event: "context",
		handler: (event: { messages: unknown[] }) => unknown,
	): void;
	on(
		event: "session_shutdown",
		handler: (_event: unknown, _ctx: unknown) => void | Promise<void>,
	): void;
}

const MAX_BUFFER_SIZE = 4 * 1024; // 4KB — paths are ~200 bytes

let activeFile: string | null = null;
let server: net.Server | null = null;
let socketPath: string | null = null;
let infoPath: string | null = null;

export default function (pi: ExtensionAPI) {
	pi.on("session_start", async (_event, ctx) => {
		if (server) cleanup();
		if (!ctx.cwd) return;

		const runtimeDir = process.env.XDG_RUNTIME_DIR ?? os.tmpdir();
		const socketsDir = path.join(runtimeDir, "omp-nvim-sockets");

		fs.mkdirSync(socketsDir, { recursive: true, mode: 0o700 });
		fs.chmodSync(socketsDir, 0o700);

		const sockPath = path.join(socketsDir, `${process.pid}.sock`);
		const infPath = `${sockPath}.info`;
		socketPath = sockPath;
		infoPath = infPath;

		// Probe each socket; connection refused = orphaned process (probe is more
		// reliable than process.kill — handles PID reuse transparently)
		const staleProbes = fs
			.readdirSync(socketsDir)
			.filter((f) => f.endsWith(".sock"))
			.map(
				(file) =>
					new Promise<void>((resolve) => {
						const sockFile = path.join(socketsDir, file);
						const probe = net.connect(sockFile);
						probe.on("connect", () => {
							probe.destroy();
							resolve();
						});
						probe.on("error", () => {
							try {
								fs.unlinkSync(sockFile);
							} catch {}
							try {
								fs.unlinkSync(`${sockFile}.info`);
							} catch {}
							resolve();
						});
					}),
			);
		await Promise.all(staleProbes);

		// Unconditionally remove our own socket path before listen.
		// The probe above only unlinks paths it cannot connect to; if a prior
		// process with the same PID left a live-looking socket (PID reuse race),
		// the probe leaves it intact and listen would fail with EADDRINUSE.
		try {
			fs.unlinkSync(sockPath);
		} catch {}

		server = net.createServer((socket) => {
			let buffer = "";
			socket.setEncoding("utf8");
			socket.on("data", (data: string) => {
				buffer += data;
				if (buffer.length > MAX_BUFFER_SIZE) {
					socket.destroy();
					return;
				}
				while (true) {
					const newlineIndex = buffer.indexOf("\n");
					if (newlineIndex === -1) break;
					const line = buffer.slice(0, newlineIndex);
					buffer = buffer.slice(newlineIndex + 1);
					try {
						const msg = JSON.parse(line);
						if (msg && typeof msg === "object" && msg.type === "active_file") {
							if (typeof msg.path === "string" && msg.path) {
								activeFile = msg.path;
								ctx.ui.setWidget("nvim-active-file", [msg.path, "⠀"], {
									placement: "aboveEditor",
								});
							} else {
								activeFile = null;
								ctx.ui.setWidget("nvim-active-file", undefined);
							}
						}
					} catch {
						// ignore parse errors
					}
				}
			});

			socket.on("error", () => {});
		});

		server.on("error", (err) => {
			pi.logger.error("[omp.nvim] socket server error", {
				message: err.message,
			});
		});

		server.listen(sockPath, () => {
			fs.writeFileSync(infPath, JSON.stringify({ cwd: ctx.cwd }));
		});
	});

	pi.on("context", (event) => {
		if (activeFile) {
			const safeFile = activeFile.replace(/[<>\n]/g, "");
			event.messages.push({
				role: "user",
				content: [
					{
						type: "text",
						text: `<system-directive>\nThe user's cursor is currently active in the file: ${safeFile}\nThis is passive background context, not a request. Do not acknowledge, comment on, or ask what to do with it unless the user explicitly references it (e.g. "this file", "here").\n</system-directive>`,
					},
				],
				timestamp: Date.now(),
			});
			return { messages: event.messages };
		}
		return undefined;
	});

	pi.on("session_shutdown", cleanup);

	process.on("exit", cleanup);
}

function cleanup() {
	if (server) {
		server.close();
		server = null;
	}
	if (socketPath) {
		try {
			fs.unlinkSync(socketPath);
		} catch {}
		socketPath = null;
	}
	if (infoPath) {
		try {
			fs.unlinkSync(infoPath);
		} catch {}
		infoPath = null;
	}
}
