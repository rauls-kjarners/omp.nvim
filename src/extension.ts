import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";

type ManagedTimer = Timer;

const MAX_BUFFER_SIZE = 4 * 1024;
// macOS dirhelper deletes $TMPDIR files whose atime is 3+ days old, and
// connecting to a socket never touches atime. Timer-driven because the idle
// session, the one that gets reaped, emits no events.
const HEAL_INTERVAL_MS = 15_000;

interface SharedState {
	activeFile: string | null;
	// Only the socket that delivered activeFile may clear it: other sessions'
	// stale-socket probes connect and close here, and Nvim never re-sends an
	// unchanged path.
	activeSource: unknown;
	server: net.Server | null;
	socketPath: string | null;
	infoPath: string | null;
	activeCtx: ExtensionContext | null;
	// Owning session's SessionManager, compared by reference: ids change on /new,
	// resume and /tree. Subagents get session_start/session_shutdown too.
	owner: unknown;
	// server.close() leaves accepted pipes open. Nvim needs their EOF: a vanished
	// socket file looks the same as the macOS reap.
	clients: Set<net.Socket>;
	healTimer: ManagedTimer | null;
	// Socket files known missing; the outage and its end are logged once each.
	healing: boolean;
	// Last reported `label\nmessage`; only a changed failure is logged again.
	lastFailure: string | null;
	exitHookInstalled: boolean;
}

// The host imports a fresh module copy per session, subagents included; state
// lives on globalThis so every copy sees one owner.
const STATE_KEY = "__ompNvimSharedState";
const realm = globalThis as Record<string, unknown>;
function sharedState(): SharedState {
	const existing = realm[STATE_KEY] as SharedState | undefined;
	if (existing) return existing;
	const fresh: SharedState = {
		activeFile: null,
		activeSource: null,
		server: null,
		socketPath: null,
		infoPath: null,
		activeCtx: null,
		owner: null,
		clients: new Set(),
		healTimer: null,
		healing: false,
		lastFailure: null,
		exitHookInstalled: false,
	};
	realm[STATE_KEY] = fresh;
	return fresh;
}

const state = sharedState();

function handleSocketMessage(
	msg: unknown,
	ctx: ExtensionContext,
	source: unknown,
) {
	if (
		msg &&
		typeof msg === "object" &&
		"type" in msg &&
		msg.type === "active_file"
	) {
		if ("path" in msg && typeof msg.path === "string" && msg.path) {
			state.activeFile = msg.path;
			state.activeSource = source;
			ctx.ui.setWidget("nvim-active-file", [msg.path, "⠀"], {
				placement: "aboveEditor",
			});
		} else {
			if (state.activeSource !== null && state.activeSource !== source) return;
			state.activeFile = null;
			state.activeSource = null;
			ctx.ui.setWidget("nvim-active-file", undefined);
		}
	}
}

function processSocketBuffer(
	buffer: string,
	ctx: ExtensionContext,
	source: unknown,
): string {
	while (true) {
		const newlineIndex = buffer.indexOf("\n");
		if (newlineIndex === -1) break;
		const line = buffer.slice(0, newlineIndex);
		buffer = buffer.slice(newlineIndex + 1);
		try {
			handleSocketMessage(JSON.parse(line), ctx, source);
		} catch {}
	}
	return buffer;
}

function reportFailure(pi: ExtensionAPI, label: string, message: string) {
	const failure = `${label}\n${message}`;
	if (state.lastFailure === failure) return;
	state.lastFailure = failure;
	pi.logger.error(`[omp.nvim] ${label}`, { message });
}

function markHealthy(pi: ExtensionAPI) {
	state.lastFailure = null;
	if (!state.healing) return;
	state.healing = false;
	pi.logger.info("[omp.nvim] socket restored", {
		socketPath: state.socketPath,
	});
}

function startServer(pi: ExtensionAPI, ctx: ExtensionContext) {
	const sockPath = state.socketPath;
	const infPath = state.infoPath;
	if (!sockPath || !infPath) return;
	// A heal tick can bind during session_start's probe phase; replacing the
	// reference would orphan that listener.
	if (state.server) {
		state.server.close();
		state.server = null;
	}

	try {
		fs.mkdirSync(path.dirname(sockPath), { recursive: true, mode: 0o700 });
		fs.chmodSync(path.dirname(sockPath), 0o700);
	} catch (err) {
		reportFailure(
			pi,
			"cannot prepare sockets directory",
			(err as Error).message,
		);
		return;
	}
	// A live-looking socket left under a reused PID would make listen() fail
	// with EADDRINUSE.
	try {
		fs.unlinkSync(sockPath);
	} catch {}

	const srv = net.createServer((socket) => {
		let buffer = "";
		state.clients.add(socket);
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
			state.clients.delete(socket);
			if (state.activeSource !== socket) return;
			state.activeFile = null;
			state.activeSource = null;
			ctx.ui.setWidget("nvim-active-file", undefined);
		});
	});

	srv.on("error", (err) => {
		reportFailure(pi, "socket server error", err.message);
		// A failed listen() leaves a server with a null handle; drop it so the next
		// heal tick rebuilds.
		if (srv === state.server && !srv.listening) state.server = null;
	});

	srv.listen(sockPath, () => {
		try {
			fs.writeFileSync(infPath, JSON.stringify({ cwd: ctx.cwd }));
			// Marked now: the reaper may delete the files again before the next tick.
			markHealthy(pi);
		} catch (err) {
			// The reaper can remove the directory first; the next heal tick retries.
			reportFailure(
				pi,
				"cannot write socket info file",
				(err as Error).message,
			);
		}
	});
	state.server = srv;
}

function ensureListening(pi: ExtensionAPI, ctx: ExtensionContext) {
	if (!state.socketPath || !state.infoPath) return;
	if (fs.existsSync(state.socketPath) && fs.existsSync(state.infoPath)) {
		markHealthy(pi);
		return;
	}

	// Only .info is gone: rewrite it rather than rebind, which would drop the
	// accepted pipes. `listening`, not non-null: a failed listen() leaves a
	// dead server object behind.
	if (state.server?.listening && fs.existsSync(state.socketPath)) {
		try {
			fs.writeFileSync(state.infoPath, JSON.stringify({ cwd: ctx.cwd }));
			markHealthy(pi);
			return;
		} catch {}
	}

	if (!state.healing) {
		state.healing = true;
		pi.logger.info("[omp.nvim] socket files vanished, re-listening", {
			socketPath: state.socketPath,
		});
	}
	// startServer() closes the old server, and Node unlinks its path inside
	// close(), so it cannot reap the new socket.
	startServer(pi, ctx);
}

export default function (pi: ExtensionAPI) {
	pi.on("session_start", async (_event, ctx) => {
		// UI-less sessions (subagents, print mode) would show the widget nowhere.
		if (!ctx.hasUI) return;
		if (state.owner !== null && state.owner !== ctx.sessionManager) return;
		if (state.server) cleanup();
		if (!ctx.cwd) return;

		const runtimeDir = process.env.XDG_RUNTIME_DIR ?? os.tmpdir();
		const socketsDir = path.join(runtimeDir, "omp-nvim-sockets");
		try {
			fs.mkdirSync(socketsDir, { recursive: true, mode: 0o700 });
			fs.chmodSync(socketsDir, 0o700);
		} catch (err) {
			// A throw would reject the host's awaited session_start.
			pi.logger.error("[omp.nvim] cannot prepare sockets directory", {
				message: (err as Error).message,
			});
			return;
		}

		// Claim only once the directory is usable: a claim that never listens
		// locks out every later session.
		state.activeCtx = ctx;
		state.owner = ctx.sessionManager;

		const sockPath = path.join(socketsDir, `${process.pid}.sock`);
		const infPath = `${sockPath}.info`;
		state.socketPath = sockPath;
		state.infoPath = infPath;

		// Probed rather than process.kill(pid): PIDs get reused.
		let existing: string[] = [];
		try {
			existing = fs.readdirSync(socketsDir);
		} catch (err) {
			// ENOENT is the reaper race; anything else leaves stale sockets listed.
			if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
				pi.logger.warn("[omp.nvim] cannot scan sockets directory", {
					message: (err as Error).message,
				});
			}
		}
		const staleProbes = existing
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
							// Only these prove it dead; others can hit a live peer mid-accept.
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
		// session_shutdown may have run cleanup() while the probes were awaited.
		if (state.owner !== ctx.sessionManager) return;

		startServer(pi, ctx);
		// Managed timer: a throw in a raw setInterval is process-fatal. A
		// re-entered session_start after a failed listen() skips cleanup(), so
		// drop the previous handle first.
		if (state.healTimer !== null) ctx.clearTimer(state.healTimer);
		state.healTimer = ctx.setInterval(
			() => ensureListening(pi, ctx),
			HEAL_INTERVAL_MS,
		);
	});

	// Persisted once after each user prompt: a per-call `context` append ends
	// every tool-loop request on this note. "agent" attribution would make it a
	// trailing system message on Opus 4.8+ (can1357/oh-my-pi#15881).
	pi.on("before_agent_start", (_event, ctx) => {
		if (state.owner !== ctx.sessionManager || !state.activeFile) return;
		const safeFile = state.activeFile.replace(/[<>\n]/g, "");
		return {
			message: {
				customType: "nvim-active-file",
				content: `<system-directive>\nActive file: ${safeFile}\n</system-directive>`,
				display: false,
			},
		};
	});

	pi.on("session_shutdown", (_event, ctx) => {
		if (state.owner !== ctx.sessionManager) {
			pi.logger.debug("[omp.nvim] ignoring shutdown of non-owner session");
			return;
		}
		cleanup();
	});

	if (!state.exitHookInstalled) {
		state.exitHookInstalled = true;
		process.on("exit", cleanup);
	}
}

function cleanup() {
	state.activeFile = null;
	state.activeSource = null;
	state.activeCtx?.ui.setWidget("nvim-active-file", undefined);
	if (state.healTimer !== null) {
		state.activeCtx?.clearTimer(state.healTimer);
		state.healTimer = null;
	}
	state.healing = false;
	state.lastFailure = null;
	state.activeCtx = null;
	state.owner = null;
	for (const socket of state.clients) socket.destroy();
	state.clients.clear();
	if (state.server) {
		state.server.close();
		state.server = null;
	}
	if (state.socketPath) {
		try {
			fs.unlinkSync(state.socketPath);
		} catch {}
		state.socketPath = null;
	}
	if (state.infoPath) {
		try {
			fs.unlinkSync(state.infoPath);
		} catch {}
		state.infoPath = null;
	}
}
