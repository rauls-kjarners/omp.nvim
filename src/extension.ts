import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as net from "node:net";
import * as path from "node:path";

interface PiContext {
	cwd?: string;
	ui: {
		setWidget(
			key: string,
			content: string[] | undefined,
			options?: { placement?: "aboveEditor" | "belowEditor" },
		): void;
	};
}

interface ExtensionAPI {
	on(
		event: "session_start",
		handler: (_event: unknown, ctx: PiContext) => void | Promise<void>,
	): void;
	on(
		event: "context",
		handler: (event: { messages: unknown[] }) => unknown,
	): void;
	on(event: "session_shutdown", handler: () => void | Promise<void>): void;
}

let activeFile: string | null = null;
let server: net.Server | null = null;
let socketPath: string | null = null;
let infoPath: string | null = null;

export default function (pi: ExtensionAPI) {
	pi.on("session_start", async (_event, ctx) => {
		if (server) cleanup(); // Safe for UDS: unlinking the socket file clears the bind synchronously
		if (!ctx.cwd) return;

		const cwdHash = crypto.createHash("md5").update(ctx.cwd).digest("hex");
		const runtimeDir = process.env.XDG_RUNTIME_DIR ?? "/tmp";
		const socketsDir = path.join(runtimeDir, "omp-nvim-sockets");

		if (!fs.existsSync(socketsDir)) {
			fs.mkdirSync(socketsDir, { recursive: true, mode: 0o700 });
		} else {
			fs.chmodSync(socketsDir, 0o700);
		}

		socketPath = path.join(socketsDir, `${cwdHash}-${process.pid}.sock`);
		infoPath = `${socketPath}.info`;

		// Probe each socket file; connection refused = orphaned process (PID check avoids
		// false-positives from PID reuse but process.kill does not — socket probe does)
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

		// Clean up exact match if it somehow exists
		if (socketPath) {
			try {
				fs.unlinkSync(socketPath);
			} catch {}
		}
		server = net.createServer((socket) => {
			let buffer = "";
			const MAX_BUFFER_SIZE = 4 * 1024; // 4KB — paths are ~200 bytes
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
						// Ignore parse errors
					}
				}
			});

			socket.on("error", () => {});
		});
		server.on("error", () => {});

		server.listen(socketPath, () => {
			if (!infoPath) return;
			fs.writeFileSync(
				infoPath,
				JSON.stringify({ cwd: ctx.cwd, pid: process.pid }),
			);
		});
	});

	pi.on("context", async (event) => {
		if (activeFile) {
			const safeFile = activeFile.replace(/[<>\n]/g, "");
			event.messages.push({
				role: "user",
				content: [
					{
						type: "text",
						text: `<system-directive>\nThe user's cursor is currently active in the file: ${safeFile}\n</system-directive>`,
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
	}
	if (infoPath) {
		try {
			fs.unlinkSync(infoPath);
		} catch {}
	}
}
