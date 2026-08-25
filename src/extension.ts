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
	// Session identity. Compared by reference only: the host builds a fresh ctx
	// object literal for every event emit, so ctx identity says nothing across
	// events, while the SessionManager behind it lives as long as the session
	// and differs per subagent. Optional so a host without it still loads.
	sessionManager?: unknown;
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
		handler: (_event: unknown, ctx: PiContext) => void | Promise<void>,
	): void;
}

const MAX_BUFFER_SIZE = 4 * 1024; // 4KB — paths are ~200 bytes
// Re-listen attempts are rate limited: if listen() keeps failing (EACCES on a
// tmpdir we cannot recreate, a racing peer on the same path), the socket file
// never appears and every subsequent user message would retry and log again.
const HEAL_COOLDOWN_MS = 30_000;

interface SharedState {
	activeFile: string | null;
	// Socket that last delivered activeFile. Only its close may clear the widget:
	// any OMP session's stale-socket probe (and any other stray connect) opens and
	// immediately closes a connection, which must not wipe a live Nvim's context.
	activeSource: unknown;
	server: net.Server | null;
	socketPath: string | null;
	infoPath: string | null;
	// Context of the owning session, used for widget updates and self-heal.
	activeCtx: PiContext | null;
	// SessionManager of the owning session (see PiContext.sessionManager), or null
	// when nothing has claimed the socket yet. Every AgentSession in the process
	// — including each subagent — gets session_start and, on dispose,
	// session_shutdown. Without this ownership check a finishing subagent ran
	// cleanup() and deleted the interactive session's socket, killing the widget
	// and context injection for the rest of the process.
	owner: unknown;
	// Set once a session has claimed the socket. Distinct from `owner`, which is
	// UNIDENTIFIED on a host that exposes no session identity: without a separate
	// flag, "no owner key" and "no owner" collapse and every later session —
	// subagents included — passes the ownership check again.
	claimed: boolean;
	// ExtensionAPI of the owning session. The self-heal runs from whichever
	// session emitted `context`, and a rebuilt server must not bake a disposed
	// subagent's logger into its long-lived handlers.
	pi: ExtensionAPI | null;
	// Accepted client pipes. server.close() only stops the listener, so without
	// destroying these the peer never sees EOF: Nvim keeps a dead pipe (and a
	// stale widget path) for the rest of its session.
	clients: Set<net.Socket>;
	lastHealMs: number;
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
		claimed: false,
		pi: null,
		clients: new Set(),
		lastHealMs: 0,
		exitHookInstalled: false,
	};
	realm[STATE_KEY] = fresh;
	return fresh;
}

const state = sharedState();

// Sentinel owner key for a host that exposes no session identity, so "claimed
// but unattributable" never compares equal to any ctx.
const UNIDENTIFIED = Symbol.for("omp.nvim.no-session-identity");

// Set on the module copy that claimed the socket. The host imports this module
// once per session, so copy identity substitutes for session identity when the
// ctx has none. Not on SharedState: it is deliberately per copy.
let claimedHere = false;

function ownerKeyOf(ctx: PiContext): unknown {
	return ctx.sessionManager ?? UNIDENTIFIED;
}

function isOwnerSession(ctx: PiContext): boolean {
	// Unclaimed: first session in wins.
	if (!state.claimed) return true;
	// Claimed, but the host gave us no session identity: fall back to the module
	// copy. Everyone else is denied — the process exit hook and the stale-socket
	// probe still reclaim the files, so refusing a teardown is strictly safer
	// than unlinking a live session's socket.
	if (state.owner === UNIDENTIFIED) return claimedHere;
	return ownerKeyOf(ctx) === state.owner;
}

function handleSocketMessage(msg: unknown, ctx: PiContext, source: unknown) {
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

function startServer(pi: ExtensionAPI, ctx: PiContext) {
	const sockPath = state.socketPath;
	const infPath = state.infoPath;
	if (!sockPath || !infPath) return;
	// Never overwrite a live server: session_start suspends across the stale
	// probe phase, and a context event in that window can heal and bind first.
	// Dropping the reference would leave that server listening on an orphaned
	// inode, with its handlers and fd retained and unreachable by cleanup().
	if (state.server) {
		state.server.close();
		state.server = null;
	}

	try {
		fs.mkdirSync(path.dirname(sockPath), { recursive: true, mode: 0o700 });
		fs.chmodSync(path.dirname(sockPath), 0o700);
	} catch (err) {
		// Called from the context hook too, where a throw would fail the user's
		// message. Without the directory there is nothing to bind; bail quietly.
		pi.logger.error("[omp.nvim] cannot prepare sockets directory", {
			message: (err as Error).message,
		});
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
		pi.logger.error("[omp.nvim] socket server error", {
			message: err.message,
		});
		// A failed listen() leaves a server object with a null handle. Drop it so
		// state.server keeps meaning "a server we may be listening on"; the next
		// context event then rebuilds it instead of finding a corpse.
		if (srv === state.server && !srv.listening) state.server = null;
	});

	srv.listen(sockPath, () => {
		try {
			fs.writeFileSync(infPath, JSON.stringify({ cwd: ctx.cwd }));
		} catch (err) {
			// The reaper can delete the directory between mkdir and this callback.
			// Stay listening: existing pipes keep working and the next context
			// event re-runs ensureListening().
			pi.logger.error("[omp.nvim] cannot write socket info file", {
				message: (err as Error).message,
			});
		}
	});
	state.server = srv;
}

// macOS reaps per-user $TMPDIR contents: com.apple.bsd.dirhelper runs at boot
// and daily at 03:35 with CLEAN_FILES_OLDER_THAN_DAYS=3, and connecting to a
// unix socket never updates its atime — so a busy, healthy socket looks
// untouched and gets deleted out from under the listening server. Existing
// pipes keep working, but the session becomes undiscoverable: no new Nvim can
// connect, and Nvim's own rescan can no longer see the .info file. Re-assert
// both paths instead of relying on a timer.
function ensureListening(pi: ExtensionAPI, ctx: PiContext) {
	if (!state.socketPath || !state.infoPath) return;
	if (fs.existsSync(state.socketPath) && fs.existsSync(state.infoPath)) return;

	const now = Date.now();
	if (now - state.lastHealMs < HEAL_COOLDOWN_MS) return;
	// Socket intact and we are still bound to it, only the .info file is gone
	// (the write in listen() may also have failed). Rewriting it keeps the
	// listener — and its accepted pipes — alive; closing here would unlink the
	// healthy socket synchronously and then possibly fail to rebuild it. The
	// cooldown is deliberately not spent on this path: it exists to rate-limit
	// failing listen() retries, and burning it on a success would leave the
	// session undiscoverable for 30s if the file vanishes again immediately.
	// `listening` and not just a non-null server: a failed listen() leaves a
	// server object with a null handle in state.server, and rewriting .info for
	// a socket we do not own would satisfy the guard above forever, so the
	// listener would never be rebuilt.
	if (state.server?.listening && fs.existsSync(state.socketPath)) {
		try {
			fs.writeFileSync(state.infoPath, JSON.stringify({ cwd: ctx.cwd }));
			return;
		} catch {}
	}
	state.lastHealMs = now;

	pi.logger.info("[omp.nvim] socket files vanished, re-listening", {
		socketPath: state.socketPath,
	});
	// startServer() closes the previous server itself. Node unlinks a pipe
	// server's bound path synchronously inside close(), so the old server can
	// never reap the new socket file.
	startServer(pi, ctx);
}

export default function (pi: ExtensionAPI) {
	pi.on("session_start", async (_event, ctx) => {
		// One socket per process, owned by the first session that claims it.
		// Subagent sessions must not rebind it (that would repoint the widget at
		// a UI-less context) nor tear it down when they finish.
		if (!isOwnerSession(ctx)) return;
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
		state.owner = ownerKeyOf(ctx);
		state.claimed = true;
		claimedHere = true;
		state.pi = pi;

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

		startServer(pi, ctx);
	});

	pi.on("context", (event) => {
		// Cheap self-heal, once per user message (two stats, no timer). Always with
		// the owner's ExtensionAPI: a subagent's `context` event must not bake its
		// soon-disposed logger into the long-lived server's handlers.
		if (state.activeCtx && state.pi) ensureListening(state.pi, state.activeCtx);
		if (!state.activeFile) return undefined;
		const msgs = event.messages as Message[];
		injectContextDirective(msgs, state.activeFile);
		return { messages: msgs };
	});

	pi.on("session_shutdown", (_event, ctx) => {
		// Every AgentSession dispose lands here, subagents included.
		if (!isOwnerSession(ctx)) {
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
	state.activeCtx = null;
	state.owner = null;
	state.claimed = false;
	// Release this copy's local claim too. Without it, on an identity-less host
	// a copy whose session ended keeps claimedHere = true, so isOwnerSession()
	// would grant it teardown rights over whichever session claims next.
	claimedHere = false;
	state.pi = null;
	state.lastHealMs = 0;
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
