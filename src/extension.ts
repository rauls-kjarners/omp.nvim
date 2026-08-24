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
// Socket that last delivered activeFile. Only its close may clear the widget:
// any OMP session's stale-socket probe (and any other stray connect) opens and
// immediately closes a connection, which must not wipe a live Nvim's context.
let activeSource: unknown = null;
let server: net.Server | null = null;
let socketPath: string | null = null;
let infoPath: string | null = null;
let activeCtx: PiContext | null = null;

function handleSocketMessage(msg: unknown, ctx: PiContext, source: unknown) {
	if (
		msg &&
		typeof msg === "object" &&
		"type" in msg &&
		msg.type === "active_file"
	) {
		if ("path" in msg && typeof msg.path === "string" && msg.path) {
			activeFile = msg.path;
			activeSource = source;
			ctx.ui.setWidget("nvim-active-file", [msg.path, "⠀"], {
				placement: "aboveEditor",
			});
		} else {
			// Same ownership rule as the close handler: a socket that is not the
			// current owner may not clear another live client's context.
			if (activeSource !== null && activeSource !== source) return;
			activeFile = null;
			activeSource = null;
			ctx.ui.setWidget("nvim-active-file", undefined);
		}
	}
}

function processSocketBuffer(
	buffer: string,
	ctx: PiContext,
	source: unknown,
): string {
	while (true) {
		const newlineIndex = buffer.indexOf("\n");
		if (newlineIndex === -1) break;
		const line = buffer.slice(0, newlineIndex);
		buffer = buffer.slice(newlineIndex + 1);
		try {
			handleSocketMessage(JSON.parse(line), ctx, source);
		} catch {
			// ignore parse errors
		}
	}
	return buffer;
}

type Message = {
	role: string;
	content: string | Array<{ type: string; text?: string }>;
	timestamp?: number;
};

function injectContextDirective(msgs: Message[], file: string) {
	const safeFile = file.replace(/[<>\n]/g, "");
	const directive = `\n\n<system-directive>\nActive file: ${safeFile}\n</system-directive>`;
	const lastUserMsg = msgs
		.slice()
		.reverse()
		.find((m) => m.role === "user");

	if (lastUserMsg) {
		if (Array.isArray(lastUserMsg.content)) {
			lastUserMsg.content.push({ type: "text", text: directive });
		} else if (typeof lastUserMsg.content === "string") {
			lastUserMsg.content += directive;
		}
	} else {
		msgs.push({
			role: "user",
			content: [{ type: "text", text: directive.trim() }],
			timestamp: Date.now(),
		});
	}
}

export default function (pi: ExtensionAPI) {
	pi.on("session_start", async (_event, ctx) => {
		if (server) cleanup();
		if (!ctx.cwd) return;
		activeCtx = ctx;

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
						probe.on("error", (err: NodeJS.ErrnoException) => {
							// Only ECONNREFUSED/ENOENT mean the socket is actually dead (no
							// listener, or the file vanished). Any other error (e.g. a
							// transient failure while the peer is mid-accept) must NOT
							// delete a live peer's files out from under it — that peer
							// would then be undiscoverable until it restarts.
							if (err.code === "ECONNREFUSED" || err.code === "ENOENT") {
								try {
									fs.unlinkSync(sockFile);
								} catch {}
								try {
									fs.unlinkSync(`${sockFile}.info`);
								} catch {}
							}
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
				buffer = processSocketBuffer(buffer, ctx, socket);
			});

			socket.on("error", () => {});

			socket.on("close", () => {
				// Only the pipe that owns the current activeFile may clear it. Probes
				// from other OMP sessions connect+destroy against this same server;
				// clearing on those would blank a live Nvim's context permanently
				// (Nvim dedupes broadcasts, so it never re-sends an unchanged path).
				if (activeSource !== socket) return;
				activeFile = null;
				activeSource = null;
				ctx.ui.setWidget("nvim-active-file", undefined);
			});
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
		if (!activeFile) return undefined;
		const msgs = event.messages as Message[];
		injectContextDirective(msgs, activeFile);
		return { messages: msgs };
	});

	pi.on("session_shutdown", cleanup);

	process.on("exit", cleanup);
}

function cleanup() {
	activeFile = null;
	activeSource = null;
	activeCtx?.ui.setWidget("nvim-active-file", undefined);
	activeCtx = null;
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
