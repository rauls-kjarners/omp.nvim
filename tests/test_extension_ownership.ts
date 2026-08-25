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
process.on("exit", () => {
	if (lockedRoot) {
		try {
			fs.chmodSync(lockedRoot, 0o700);
		} catch {
			// Already gone or never chmodded; the rmSync below is what matters.
		}
		fs.rmSync(lockedRoot, { recursive: true, force: true });
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
async function loadExtension(): Promise<Map<string, Handler[]>> {
	const handlers = new Map<string, Handler[]>();
	const pi = {
		logger: {
			// Surfaced, not swallowed: a failed mkdir or listen is otherwise
			// invisible and the test dies on an unexplained timeout.
			error: (msg: string, meta?: unknown) =>
				console.log(`  logger.error: ${msg} ${JSON.stringify(meta ?? {})}`),
			warn: (msg: string) => console.log(`  logger.warn: ${msg}`),
			info: () => {},
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

// Fresh literal per emit, like ExtensionRunner.createContext().
function ctxFor(sessionManager: object) {
	return {
		cwd: process.cwd(),
		sessionManager,
		ui: {
			setWidget: (_key: string, content: Widget) => {
				widget.value = content;
			},
		},
	};
}

// Same shape minus session identity, for a host that exposes no sessionManager.
function ctxWithoutIdentity() {
	return {
		cwd: process.cwd(),
		ui: {
			setWidget: (_key: string, content: Widget) => {
				widget.value = content;
			},
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

// Context injection works from any module copy, because the state is shared.
const msgs = [{ role: "user", content: "hi" }];
const contextHandler = subagentHandlers.get("context")?.[0];
if (!contextHandler) fail("no context handler registered");
const injected = contextHandler({ messages: msgs }, undefined) as
	| { messages: { content: string }[] }
	| undefined;
if (
	!injected?.messages[0]?.content.includes("Active file: lua/omp/init.lua:1")
) {
	fail("context hook did not inject the active file");
}

// The owner's own shutdown must still clean up after the host re-mints its
// session id (/new, resume, /tree all do this on a live session).
owner.getSessionId = () => "session-1-branched";
await emit(ownerHandlers, "session_shutdown", ctxFor(owner));
await sleep(50);
if (fs.existsSync(sockPath) || fs.existsSync(infoPath)) {
	fail("owner session_shutdown skipped cleanup after its session id changed");
}
if (widget.value !== undefined) {
	fail("owner session_shutdown left the widget up");
}
await waitFor(() => clientClosed, "the client pipe to see EOF on cleanup");

// A host that exposes no session identity must degrade to first-claim-wins,
// not to "everybody owns it": otherwise every subagent may rebind and unlink
// the interactive session's socket, which is the bug ownership exists to fix.
const blindOwnerHandlers = await loadExtension();
await emit(blindOwnerHandlers, "session_start", ctxWithoutIdentity());
await waitFor(
	() => fs.existsSync(sockPath) && fs.existsSync(infoPath),
	"the socket and .info file for the identity-less host",
);
const blindInode = fs.statSync(sockPath).ino;

const blindSubagentHandlers = await loadExtension();
await emit(blindSubagentHandlers, "session_start", ctxWithoutIdentity());
await sleep(50);
if (!fs.existsSync(sockPath) || fs.statSync(sockPath).ino !== blindInode) {
	fail("identity-less subagent rebound the claimed socket");
}
await emit(blindSubagentHandlers, "session_shutdown", ctxWithoutIdentity());
await sleep(50);
if (!fs.existsSync(sockPath) || !fs.existsSync(infoPath)) {
	fail("identity-less subagent deleted the claimed socket");
}

// Self-heal, .info-only case (macOS reaps $TMPDIR files while the server still
// listens). Rewriting the info file must keep the listener and its accepted
// pipes; closing and re-listening would unlink the healthy socket first.
fs.unlinkSync(infoPath);
const blindContext = blindOwnerHandlers.get("context")?.[0];
if (!blindContext) fail("no context handler registered");
blindContext({ messages: [] }, undefined);
await waitFor(() => fs.existsSync(infoPath), "the .info file to be rewritten");
if (fs.statSync(sockPath).ino !== blindInode) {
	fail("self-heal rebuilt the server for a missing .info file");
}
if (JSON.parse(fs.readFileSync(infoPath, "utf8")).cwd !== process.cwd()) {
	fail("rewritten .info file has the wrong cwd");
}

// The cooldown exists to rate-limit *failing* re-listen attempts, so a
// successful .info rewrite must not consume it: the reaper (or another OMP's
// stale probe) can delete the file again seconds later, and returning early for
// 30s would leave this session undiscoverable by any new Nvim.
fs.unlinkSync(infoPath);
blindContext({ messages: [] }, undefined);
await waitFor(
	() => fs.existsSync(infoPath),
	"the .info file to be rewritten again inside the heal cooldown",
);
if (fs.statSync(sockPath).ino !== blindInode) {
	fail("repeat self-heal rebuilt the server instead of rewriting .info");
}

// The claiming session still tears down its own socket.
await emit(blindOwnerHandlers, "session_shutdown", ctxWithoutIdentity());
await sleep(50);
if (fs.existsSync(sockPath) || fs.existsSync(infoPath)) {
	fail("identity-less owner shutdown skipped cleanup");
}

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
client.destroy();
console.log("PASS: All extension ownership tests passed!");
process.exit(0);
