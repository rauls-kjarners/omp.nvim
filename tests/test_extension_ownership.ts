// Host simulation for the extension's socket ownership rules.
//
// The real host re-imports each extension per session with a cache-busting
// specifier, mints a fresh ctx object literal for every event emit, and hands
// session_start/session_shutdown to every AgentSession in the process —
// subagents included. All three matter: module-scoped state is therefore
// per-session, ctx identity is meaningless across events, and a subagent's
// shutdown must not unlink the interactive session's socket.
//
// Run: node tests/test_extension_ownership.ts
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const extensionPath = path.join(
	path.dirname(fileURLToPath(import.meta.url)),
	"..",
	"src",
	"extension.ts",
);
// Private runtime dir, exported before the first emit: the extension resolves
// XDG_RUNTIME_DIR ?? os.tmpdir() inside session_start, and CI sets
// XDG_RUNTIME_DIR (/run/user/1001 on ubuntu-latest), so deriving the expected
// paths from os.tmpdir() watches a directory nothing ever binds and every wait
// times out. Also keeps the test off a real OMP session's sockets.
const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-nvim-test-"));
process.env.XDG_RUNTIME_DIR = runtimeDir;
const sockPath = path.join(
	runtimeDir,
	"omp-nvim-sockets",
	`${process.pid}.sock`,
);
const infoPath = `${sockPath}.info`;

type Handler = (event: unknown, ctx: unknown) => unknown;
type Widget = string[] | undefined;

const widget: { value: Widget } = { value: undefined };
let loadTag = 0;

// Single cleanup site: covers fail(), the success tail, and an uncaught throw.
// process.exit() still runs exit handlers, so nothing needs to duplicate this.
let lockedRoot: string | null = null;
let noisyRoot: string | null = null;
process.on("exit", () => {
	for (const root of [lockedRoot, noisyRoot]) {
		if (!root) continue;
		try {
			fs.chmodSync(root, 0o700);
		} catch {
			// Already gone or never chmodded; the rmSync below is what matters.
		}
		fs.rmSync(root, { recursive: true, force: true });
	}
	fs.rmSync(runtimeDir, { recursive: true, force: true });
});

function fail(message: string): never {
	console.log(`FAIL: ${message}`);
	process.exit(1);
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(predicate: () => boolean, label: string) {
	for (let i = 0; i < 200; i += 1) {
		if (predicate()) return;
		await sleep(10);
	}
	fail(`timed out waiting for ${label}`);
}

// One module instance per session, like loadLegacyPiModule's `?mtime=` tag.
// Dynamic import is the point of this test: it reproduces the host's per-session
// module loading, which a static import cannot express.
const logCounts = { info: 0, warn: 0, error: 0 };

async function loadExtension(): Promise<Map<string, Handler[]>> {
	const handlers = new Map<string, Handler[]>();
	const pi = {
		logger: {
			// Surfaced, not swallowed: a failed mkdir or listen is otherwise
			// invisible and the test dies on an unexplained timeout. Counted too,
			// so the heal's log volume during an outage is assertable.
			error: (msg: string, meta?: unknown) => {
				logCounts.error += 1;
				console.log(`  logger.error: ${msg} ${JSON.stringify(meta ?? {})}`);
			},
			warn: (msg: string) => {
				logCounts.warn += 1;
				console.log(`  logger.warn: ${msg}`);
			},
			info: () => {
				logCounts.info += 1;
			},
			debug: () => {},
		},
		on(event: string, handler: Handler) {
			const list = handlers.get(event) ?? [];
			list.push(handler);
			handlers.set(event, list);
		},
	};
	loadTag += 1;
	const mod = await import(`${extensionPath}?load=${loadTag}`);
	mod.default(pi);
	return handlers;
}

// Stable per session, distinct per subagent, and its session id is re-minted by
// /new, resume and /tree — hence ownership keys on the object, not the id.
function makeSessionManager(id: string) {
	return { id, getSessionId: () => id };
}

// Managed timers registered through ctx.setInterval. The self-heal runs on one
// of these, so a test drives it by invoking the callback instead of waiting out
// the real period. The callback doubles as its own handle, like a Timer.
const healTicks: Array<() => void> = [];
// Read through a function: comparing `healTicks.length` directly lets the
// compiler narrow it to the literal one assertion proved, after which the next
// assertion looks unreachable.
const timerCount = (): number => healTicks.length;

// Fresh literal per emit, like ExtensionRunner.createContext(). hasUI is false
// for subagents, print mode and other headless runs — that is what keeps them
// off the socket.
function ctxFor(sessionManager: object, hasUI = true) {
	return {
		cwd: process.cwd(),
		hasUI,
		sessionManager,
		ui: {
			setWidget: (_key: string, content: Widget) => {
				widget.value = content;
			},
		},
		// The period is asserted, not ignored: an omitted `ms` makes the real host
		// fire on its shortest interval forever, and a test that only counts
		// registrations would stay green through that.
		setInterval: (callback: () => void, ms?: number) => {
			if (typeof ms !== "number" || ms < 1_000) {
				fail(`heal timer registered with an unusable period: ${ms}`);
			}
			healTicks.push(callback);
			return callback;
		},
		clearTimer: (timer: () => void) => {
			const index = healTicks.indexOf(timer);
			if (index !== -1) healTicks.splice(index, 1);
		},
	};
}

async function emit(
	handlers: Map<string, Handler[]>,
	event: string,
	ctx: unknown,
) {
	for (const handler of handlers.get(event) ?? []) await handler({}, ctx);
}

console.log("Running OMP extension ownership tests...");

// A UI-less session (subagent, print mode, an RPC host without UI) must not
// claim the socket: the widget would point at a surface the user never sees,
// and whichever such session finished first would unlink the socket.
const headlessHandlers = await loadExtension();
await emit(
	headlessHandlers,
	"session_start",
	ctxFor(makeSessionManager("subagent-0"), false),
);
await sleep(50);
if (fs.existsSync(sockPath)) fail("a UI-less session claimed the socket");

// session_start suspends across the stale-socket probes, so a session that is
// disposed in that window resumes after its own cleanup() — and after the host
// has already dropped its managed timers. Binding there leaves a server and a
// heal interval holding a disposed ctx that nothing can clear: the next tick
// rebuilds the socket against the dead session, whose widget then swallows the
// live session's active file.
const abortedSession = makeSessionManager("aborted-1");
const abortedHandlers = await loadExtension();
const abortedCtx = ctxFor(abortedSession);
const abortedStart = abortedHandlers.get("session_start")?.[0]?.(
	{},
	abortedCtx,
);
await emit(abortedHandlers, "session_shutdown", abortedCtx);
await abortedStart;
await sleep(50);
if (timerCount() !== 0) {
	fail("session_start bound a heal timer after its session was disposed");
}
if (fs.existsSync(sockPath)) {
	fail("session_start claimed the socket after its session was disposed");
}

// A failed listen() nulls state.server asynchronously, so the same session
// claiming again skips the cleanup() at the top of session_start. Without
// dropping the old handle first, the second claim overwrites state.healTimer
// and the first interval keeps ticking with nothing left to clear it.
fs.mkdirSync(sockPath, { recursive: true }); // occupy the path: listen() fails
const reclaimer = makeSessionManager("reclaim-1");
const reclaimHandlers = await loadExtension();
const reclaimCtx = ctxFor(reclaimer);
await emit(reclaimHandlers, "session_start", reclaimCtx);
await sleep(50); // let the listen error land and null state.server
await emit(reclaimHandlers, "session_start", reclaimCtx);
await sleep(50);
if (timerCount() !== 1) {
	fail(`re-entered session_start left ${timerCount()} heal timers, expected 1`);
}
await emit(reclaimHandlers, "session_shutdown", reclaimCtx);
fs.rmSync(sockPath, { recursive: true, force: true });
fs.rmSync(infoPath, { force: true });
if (timerCount() !== 0) fail("reclaim shutdown left a heal timer running");

// Interactive session claims the socket.
const owner = makeSessionManager("session-1");
const ownerHandlers = await loadExtension();
await emit(ownerHandlers, "session_start", ctxFor(owner));
await waitFor(
	() => fs.existsSync(sockPath) && fs.existsSync(infoPath),
	"the socket and .info file",
);
const ownerInode = fs.statSync(sockPath).ino;

// An Nvim-like client publishes its active file.
const client = net.connect(sockPath);
await new Promise((resolve) => client.on("connect", resolve));
// cleanup() must destroy accepted pipes: server.close() stops the listener
// only, so without it Nvim never sees EOF and keeps writing to a dead session.
let clientClosed = false;
client.on("close", () => {
	clientClosed = true;
});
client.write(
	`${JSON.stringify({ type: "active_file", path: "lua/omp/init.lua:1" })}\n`,
);
await waitFor(() => widget.value?.[0] === "lua/omp/init.lua:1", "the widget");

// A subagent session, with its own copy of the module, must not rebind...
const subagent = makeSessionManager("session-2");
const subagentHandlers = await loadExtension();
await emit(subagentHandlers, "session_start", ctxFor(subagent));
await sleep(50);
if (!fs.existsSync(sockPath) || fs.statSync(sockPath).ino !== ownerInode) {
	fail("subagent session_start rebound the interactive session's socket");
}

// ...nor tear down the socket, .info file or widget when it finishes.
await emit(subagentHandlers, "session_shutdown", ctxFor(subagent));
await sleep(50);
if (!fs.existsSync(sockPath) || !fs.existsSync(infoPath)) {
	fail("subagent session_shutdown deleted the interactive session's socket");
}
if (widget.value?.[0] !== "lua/omp/init.lua:1") {
	fail("subagent session_shutdown cleared the widget");
}

// Context injection works from any module copy, because the state is shared,
// and appends its own message instead of editing the user's — rewriting the
// tail of persisted history moves the provider's prompt-cache breakpoints.
const userMsg = { role: "user", content: "hi" };
const contextHandler = subagentHandlers.get("context")?.[0];
if (!contextHandler) fail("no context handler registered");
const injected = contextHandler({ messages: [userMsg] }, undefined) as
	| { messages: { role: string; content: { text: string }[] }[] }
	| undefined;
if (injected?.messages.length !== 2) {
	fail("context hook did not append a message");
}
if (userMsg.content !== "hi") {
	fail("context hook mutated the user's message");
}
if (
	!injected.messages[1]?.content[0]?.text.includes(
		"Active file: lua/omp/init.lua:1",
	)
) {
	fail("context hook did not inject the active file");
}

// Self-heal, .info-only case (macOS reaps $TMPDIR files while the server still
// listens). Rewriting the info file must keep the listener and its accepted
// pipes; closing and re-listening would unlink the healthy socket first.
const heal = healTicks[0];
if (!heal) fail("session_start registered no heal timer");
fs.unlinkSync(infoPath);
heal();
await waitFor(() => fs.existsSync(infoPath), "the .info file to be rewritten");
if (fs.statSync(sockPath).ino !== ownerInode) {
	fail("self-heal rebuilt the server for a missing .info file");
}
if (JSON.parse(fs.readFileSync(infoPath, "utf8")).cwd !== process.cwd()) {
	fail("rewritten .info file has the wrong cwd");
}

// The heal runs on a timer so an idle session stays discoverable; a repeat reap
// seconds later must be repaired too, with no rate limit to burn.
fs.unlinkSync(infoPath);
heal();
await waitFor(
	() => fs.existsSync(infoPath),
	"the .info file to be rewritten again",
);
if (fs.statSync(sockPath).ino !== ownerInode) {
	fail("repeat self-heal rebuilt the server instead of rewriting .info");
}

// The owner's own shutdown must still clean up after the host re-mints its
// session id (/new, resume and /tree all do this on a live session).
owner.getSessionId = () => "session-1-branched";
await emit(ownerHandlers, "session_shutdown", ctxFor(owner));
await sleep(50);
if (fs.existsSync(sockPath) || fs.existsSync(infoPath)) {
	fail("owner session_shutdown skipped cleanup after its session id changed");
}
if (widget.value !== undefined) {
	fail("owner session_shutdown left the widget up");
}
if (timerCount() !== 0) {
	fail("owner session_shutdown left the heal timer running");
}
await waitFor(() => clientClosed, "the client pipe to see EOF on cleanup");

// An unwritable runtime dir (read-only $XDG_RUNTIME_DIR, or /run/user/<uid>
// missing) must not throw out of session_start — the host awaits it — and must
// not claim the socket either: a claim without a listener locks out every later
// session, and ensureListening() cannot recover one whose socketPath is null.
lockedRoot = fs.mkdtempSync(path.join(os.tmpdir(), "omp-nvim-locked-"));
fs.chmodSync(lockedRoot, 0o500);
let writable = true;
try {
	fs.mkdirSync(path.join(lockedRoot, "probe"));
} catch {
	writable = false;
}
if (writable) {
	console.log("SKIP: runtime dir is writable despite 0o500 (running as root?)");
} else {
	process.env.XDG_RUNTIME_DIR = lockedRoot;
	const lockedHandlers = await loadExtension();
	await emit(lockedHandlers, "session_start", ctxFor(makeSessionManager("s3")));
	await sleep(50);

	// Same process, working runtime dir again: the refused session left nothing
	// claimed, so this one must bind normally.
	process.env.XDG_RUNTIME_DIR = runtimeDir;
	const recovered = makeSessionManager("s4");
	const recoveredHandlers = await loadExtension();
	await emit(recoveredHandlers, "session_start", ctxFor(recovered));
	await waitFor(
		() => fs.existsSync(sockPath) && fs.existsSync(infoPath),
		"a later session to claim the socket after a refused one",
	);
	await emit(recoveredHandlers, "session_shutdown", ctxFor(recovered));
}

// A heal that can never succeed (read-only runtime dir, a peer holding our
// path) still retries every tick, but an identical failure must be reported
// once, not once per tick: at a 15s period that is ~5.7k/day on the extension
// error channel. A *different* failure still reports, recovery reports, and a
// later outage is not silenced by the earlier one.
noisyRoot = fs.mkdtempSync(path.join(os.tmpdir(), "omp-nvim-noisy-"));
let noisyLocks = true;
try {
	fs.mkdirSync(path.join(noisyRoot, "probe"));
	fs.chmodSync(noisyRoot, 0o500);
	fs.mkdirSync(path.join(noisyRoot, "probe2"));
	noisyLocks = false;
} catch {
	// 0o500 denies us, which is what this test needs.
}
fs.chmodSync(noisyRoot, 0o700);
if (!noisyLocks) {
	console.log("SKIP: runtime dir is writable despite 0o500 (running as root?)");
} else {
	process.env.XDG_RUNTIME_DIR = noisyRoot;
	const noisySockets = path.join(noisyRoot, "omp-nvim-sockets");
	const noisySock = path.join(noisySockets, `${process.pid}.sock`);
	const noisy = makeSessionManager("noisy-1");
	const noisyHandlers = await loadExtension();
	await emit(noisyHandlers, "session_start", ctxFor(noisy));
	await waitFor(() => fs.existsSync(noisySock), "the noisy session to bind");
	const noisyTick = healTicks[healTicks.length - 1];
	if (!noisyTick) fail("the noisy session registered no heal timer");

	const outage = () => {
		fs.rmSync(noisySockets, { recursive: true, force: true });
		fs.chmodSync(noisyRoot as string, 0o500);
	};
	const drive = async (ticks: number) => {
		for (let i = 0; i < ticks; i += 1) {
			noisyTick();
			await sleep(20);
		}
	};

	// Snapshotted through a function: reading the counter fields directly lets
	// the compiler narrow them to the literal the first assertion proved, and
	// the second assertion then looks unreachable.
	const totals = (): { info: number; error: number } => ({
		info: logCounts.info,
		error: logCounts.error,
	});

	logCounts.info = 0;
	logCounts.error = 0;
	outage();
	await drive(5);
	const first = totals();
	if (first.info !== 1 || first.error !== 1) {
		fail(
			`a 5-tick outage logged info=${first.info} error=${first.error}, expected 1 and 1`,
		);
	}

	// Same outage, different blocker: the directory becomes writable but the
	// socket path is occupied, so listen() now fails where mkdir used to. A
	// dedupe keyed on "already reported this outage" would hide the errno that
	// actually describes the session's current state.
	fs.chmodSync(noisyRoot, 0o700);
	fs.mkdirSync(noisySock, { recursive: true });
	await drive(2);
	const changed = totals();
	if (changed.error !== 2) {
		fail(
			`a changed failure inside one outage logged error=${changed.error}, expected 2`,
		);
	}
	if (changed.info !== 1) {
		fail(`a changed failure re-announced the outage: info=${changed.info}`);
	}

	fs.rmSync(noisySock, { recursive: true, force: true });
	await drive(1);
	await waitFor(() => fs.existsSync(noisySock), "the noisy session to recover");
	const healed = totals();
	if (healed.info !== 2) {
		fail(`recovery logged info=${healed.info}, expected 2`);
	}

	outage();
	await drive(3);
	const second = totals();
	if (second.info !== 3 || second.error !== 3) {
		fail(
			`a second outage logged info=${second.info} error=${second.error}, expected 3 and 3`,
		);
	}

	fs.chmodSync(noisyRoot, 0o700);
	await emit(noisyHandlers, "session_shutdown", ctxFor(noisy));
	process.env.XDG_RUNTIME_DIR = runtimeDir;
}
client.destroy();
console.log("PASS: All extension ownership tests passed!");
process.exit(0);
