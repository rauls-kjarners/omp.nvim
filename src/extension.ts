import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import type {
	ContextEvent,
	ContextEventResult,
	ExtensionAPI,
	ExtensionContext,
} from "@oh-my-pi/pi-coding-agent";

type ManagedTimer = Timer;
type ContextMessage = ContextEvent["messages"][number];

const MAX_BUFFER_SIZE = 4 * 1024; // 4KB — paths are ~200 bytes
// macOS reaps per-user $TMPDIR contents: com.apple.bsd.dirhelper runs at boot
// and daily at 03:35 with CLEAN_FILES_OLDER_THAN_DAYS=3, and connecting to a
// unix socket never updates its atime — so a busy, healthy socket looks
// untouched and gets deleted out from under the listening server. Existing
// pipes keep working, but the session becomes undiscoverable: no new Nvim can
// connect, and Nvim's own rescan can no longer see the .info file. A timer, not
// a per-message check: an idle session is exactly the one that gets reaped, and
// it emits no events to heal on. The period also rate-limits a failing listen()
// (EACCES on a tmpdir we cannot recreate, a racing peer on the same path).
const HEAL_INTERVAL_MS = 15_000;

interface SharedState {
	activeFile: string | null;
	// Socket that last delivered activeFile. Only its close may clear the widget:
	// any OMP session's stale-socket probe (and any other stray connect) opens and
	// immediately closes a connection, which must not wipe a live Nvim's context.
	activeSource: unknown;
	server: net.Server | null;
	socketPath: string | null;
	infoPath: string | null;
	// Context of the owning session, used for widget updates and timer teardown.
	activeCtx: ExtensionContext | null;
	// SessionManager of the owning session, or null while unclaimed. Compared by
	// reference, never by id: the host re-mints session ids on /new, resume and
	// /tree, while the manager object lives as long as the session and differs
	// per subagent. Every AgentSession in the process — including each subagent —
	// gets session_start and, on dispose, session_shutdown; without this check a
	// finishing subagent ran cleanup() and deleted the interactive session's
	// socket, killing the widget and context injection for the rest of the
	// process.
	owner: unknown;
	// Accepted client pipes. server.close() only stops the listener, so without
	// destroying these the peer never sees EOF: Nvim keeps a dead pipe (and a
	// stale widget path) for the rest of its session.
	clients: Set<net.Socket>;
	healTimer: ManagedTimer | null;
	// True while the socket files are known missing. The heal retries every tick
	// — recovery is the point — but a permanently failing one (read-only runtime
	// dir, a racing peer holding our path) would otherwise log on every tick for
	// the life of the session, so the outage is announced once and its end is
	// announced once.
	healing: boolean;
	// Last failure reported by reportFailure(), as `label\nmessage`. Repeats are
	// dropped; a *different* failure is not, so an outage whose cause changes
	// (EACCES that becomes EADDRINUSE once the directory is writable again)
	// still names its current blocker instead of the stale first one.
	lastFailure: string | null;
	exitHookInstalled: boolean;
}

// The socket path is per process (`${pid}.sock`), but module state is not: the
// host re-imports each extension per session with a cache-busting specifier, so
// a subagent gets its own copy of this module and would see a pristine, unowned
// state — then rebind and later unlink the interactive session's socket. Anchor
// the state on globalThis so every copy in the process shares one owner.
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
			// Same ownership rule as the close handler: a socket that is not the
			// current owner may not clear another live client's context.
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
		} catch {
			// ignore parse errors
		}
	}
	return buffer;
}

// Appended as its own per-call message rather than merged into the last user
// message: `context` messages are a per-request deep copy, and editing the tail
// of persisted history moves the provider's prompt-cache breakpoints, while an
// appended message keeps them rolling (OMP 18.2.1, can1357/oh-my-pi#11897).
function activeFileMessage(file: string): ContextMessage {
	const safeFile = file.replace(/[<>\n]/g, "");
	return {
		role: "user",
		content: [
			{
				type: "text",
				text: `<system-directive>\nActive file: ${safeFile}\n</system-directive>`,
			},
		],
		// Marks it host-injected rather than typed by the user, so the TUI and
		// attribution accounting do not treat it as a real prompt.
		synthetic: true,
		timestamp: Date.now(),
	};
}

// Deduped by content, not by a flag captured when the attempt started: the
// handlers below outlive the call that installs them (a listen error arrives
// asynchronously, and the server that finally binds keeps its handler for the
// rest of the session), so a captured "already reported" boolean would mute a
// later, different failure forever. A permanent failure is retried every heal
// tick, and an error per tick is ~5.7k/day routed to the extension error
// channel; the errno is the whole diagnostic, so novelty is the gate.
function reportFailure(pi: ExtensionAPI, label: string, message: string) {
	const failure = `${label}\n${message}`;
	if (state.lastFailure === failure) return;
	state.lastFailure = failure;
	pi.logger.error(`[omp.nvim] ${label}`, { message });
}

// The socket files are in place again. Reports the recovery exactly once, so an
// operator who saw the outage line sees it close instead of guessing.
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
	// Never overwrite a live server: session_start suspends across the stale
	// probe phase, and a heal tick in that window can bind first. Dropping the
	// reference would leave that server listening on an orphaned inode, with its
	// handlers and fd retained and unreachable by cleanup().
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
	// Unconditionally remove our own socket path before listen. Stale-socket
	// probing only unlinks paths it cannot connect to; if a prior process with
	// the same PID left a live-looking socket (PID reuse race), the probe leaves
	// it intact and listen would fail with EADDRINUSE.
	try {
		fs.unlinkSync(sockPath);
	} catch {}

	const srv = net.createServer((socket) => {
		let buffer = "";
		// Tracked so cleanup() can destroy it: server.close() stops the listener
		// only, leaving the peer without EOF.
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
			// Only the pipe that owns the current activeFile may clear it. Probes
			// from other OMP sessions connect+destroy against this same server;
			// clearing on those would blank a live Nvim's context permanently
			// (Nvim dedupes broadcasts, so it never re-sends an unchanged path).
			if (state.activeSource !== socket) return;
			state.activeFile = null;
			state.activeSource = null;
			ctx.ui.setWidget("nvim-active-file", undefined);
		});
	});

	srv.on("error", (err) => {
		reportFailure(pi, "socket server error", err.message);
		// A failed listen() leaves a server object with a null handle. Drop it so
		// state.server keeps meaning "a server we may be listening on"; the next
		// heal tick then rebuilds it instead of finding a corpse.
		if (srv === state.server && !srv.listening) state.server = null;
	});

	srv.listen(sockPath, () => {
		try {
			fs.writeFileSync(infPath, JSON.stringify({ cwd: ctx.cwd }));
			// Marked here, not on a later tick that observes both files: a reaper
			// can delete them again before the next tick runs, and an outage that
			// was never marked over would silence its own report.
			markHealthy(pi);
		} catch (err) {
			// The reaper can delete the directory between mkdir and this callback.
			// Stay listening: existing pipes keep working and the next heal tick
			// re-runs ensureListening().
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

	// Socket intact and we are still bound to it, only the .info file is gone
	// (the write in listen() may also have failed). Rewriting it keeps the
	// listener — and its accepted pipes — alive; closing here would unlink the
	// healthy socket synchronously and then possibly fail to rebuild it.
	// `listening` and not just a non-null server: a failed listen() leaves a
	// server object with a null handle in state.server, and rewriting .info for
	// a socket we do not own would satisfy the guard above forever, so the
	// listener would never be rebuilt.
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
	// startServer() closes the previous server itself. Node unlinks a pipe
	// server's bound path synchronously inside close(), so the old server can
	// never reap the new socket file.
	startServer(pi, ctx);
}

export default function (pi: ExtensionAPI) {
	pi.on("session_start", async (_event, ctx) => {
		// One socket per process, owned by the first session that claims it.
		// Subagents and headless runs get a UI-less context: binding there would
		// repoint the widget at a surface the user never sees, and the session
		// that finishes first would unlink the interactive session's socket.
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
			// Unwritable or absent runtime dir (read-only $XDG_RUNTIME_DIR, or
			// /run/user/<uid> missing). Throwing here rejects the host's awaited
			// session_start.
			pi.logger.error("[omp.nvim] cannot prepare sockets directory", {
				message: (err as Error).message,
			});
			return;
		}

		// Claim only once the directory is usable: a claim taken before this would
		// block every later session from binding while this one never listens, and
		// ensureListening() cannot recover it because socketPath is still null.
		state.activeCtx = ctx;
		state.owner = ctx.sessionManager;

		const sockPath = path.join(socketsDir, `${process.pid}.sock`);
		const infPath = `${sockPath}.info`;
		state.socketPath = sockPath;
		state.infoPath = infPath;

		// Probe each socket; connection refused = orphaned process (probe is more
		// reliable than process.kill — handles PID reuse transparently)
		let existing: string[] = [];
		try {
			existing = fs.readdirSync(socketsDir);
		} catch (err) {
			// ENOENT is the reaper race this self-heal exists to absorb. Anything
			// else (EACCES) leaves stale sockets advertised, so say so.
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
		// session_shutdown can land while this handler is suspended above, in
		// which case cleanup() already ran and the host already dropped this
		// session's managed timers. Binding past that point would leave a server
		// and an interval holding a disposed ctx, with nothing left to clear them.
		if (state.owner !== ctx.sessionManager) return;

		startServer(pi, ctx);
		// Managed timer, not raw setInterval: a throw from a raw one escapes the
		// handler dispatch as a process-fatal uncaughtException and takes the
		// whole session down. This handle is unref'd and cleared on shutdown.
		// Any previous handle is dropped first: a re-entered session_start (the
		// same session claiming again after a failed listen(), where
		// state.server is null and the cleanup() above is skipped) would
		// otherwise overwrite the field and leave the earlier interval running
		// with no handle left to clear it.
		if (state.healTimer !== null) ctx.clearTimer(state.healTimer);
		state.healTimer = ctx.setInterval(
			() => ensureListening(pi, ctx),
			HEAL_INTERVAL_MS,
		);
	});

	pi.on("context", (event: ContextEvent): ContextEventResult | undefined => {
		if (!state.activeFile) return undefined;
		return {
			messages: [...event.messages, activeFileMessage(state.activeFile)],
		};
	});

	pi.on("session_shutdown", (_event, ctx) => {
		// Every AgentSession dispose lands here, subagents included.
		if (state.owner !== ctx.sessionManager) {
			pi.logger.debug("[omp.nvim] ignoring shutdown of non-owner session");
			return;
		}
		cleanup();
	});

	// One listener per process, not per module copy: the host re-imports this
	// module per session, and cleanup() operates on the shared state anyway.
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
	// server.close() only stops the listener. Accepted pipes must be destroyed
	// so the peer sees EOF — otherwise Nvim keeps a dead pipe (and writes into a
	// shut-down session) for the rest of its lifetime, since the socket file
	// disappearing is indistinguishable from the macOS $TMPDIR reap.
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
