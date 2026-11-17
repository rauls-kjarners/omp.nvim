// Simulates the host: a module copy per session, a fresh ctx per emit, and
// session events for every AgentSession, subagents included.
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
// Set before the first emit: CI sets XDG_RUNTIME_DIR, which the extension
// prefers over os.tmpdir().
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

let lockedRoot: string | null = null;
let noisyRoot: string | null = null;
process.on("exit", () => {
	for (const root of [lockedRoot, noisyRoot]) {
		if (!root) continue;
		try {
			fs.chmodSync(root, 0o700);
		} catch {}
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

const logCounts = { info: 0, warn: 0, error: 0 };

async function loadExtension(): Promise<Map<string, Handler[]>> {
	const handlers = new Map<string, Handler[]>();
	const pi = {
		logger: {
			// Printed: a failed mkdir or listen otherwise surfaces only as a timeout.
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
	// Cache-busting query: the host loads a module copy per session.
	const mod = await import(`${extensionPath}?load=${loadTag}`);
	mod.default(pi);
	return handlers;
}

function makeSessionManager(id: string) {
	return { id, getSessionId: () => id };
}

// ctx.setInterval callbacks, invoked directly; each is its own handle.
const healTicks: Array<() => void> = [];
// A function, so TS doesn't narrow the length to a literal across assertions.
const timerCount = (): number => healTicks.length;

// Fresh literal per emit, like ExtensionRunner.createContext().
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
		// An omitted period makes the host fire on its shortest interval.
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

const headlessHandlers = await loadExtension();
await emit(
	headlessHandlers,
	"session_start",
	ctxFor(makeSessionManager("subagent-0"), false),
);
await sleep(50);
if (fs.existsSync(sockPath)) fail("a UI-less session claimed the socket");

// Shut down while session_start awaits its stale-socket probes.
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

// A failed listen() nulls state.server, so a second session_start skips cleanup().
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

const owner = makeSessionManager("session-1");
const ownerHandlers = await loadExtension();
await emit(ownerHandlers, "session_start", ctxFor(owner));
await waitFor(
	() => fs.existsSync(sockPath) && fs.existsSync(infoPath),
	"the socket and .info file",
);
const ownerInode = fs.statSync(sockPath).ino;

const client = net.connect(sockPath);
await new Promise((resolve) => client.on("connect", resolve));
let clientClosed = false;
client.on("close", () => {
	clientClosed = true;
});
client.write(
	`${JSON.stringify({ type: "active_file", path: "lua/omp/init.lua:1" })}\n`,
);
await waitFor(() => widget.value?.[0] === "lua/omp/init.lua:1", "the widget");

const subagent = makeSessionManager("session-2");
const subagentHandlers = await loadExtension();
await emit(subagentHandlers, "session_start", ctxFor(subagent));
await sleep(50);
if (!fs.existsSync(sockPath) || fs.statSync(sockPath).ino !== ownerInode) {
	fail("subagent session_start rebound the interactive session's socket");
}

await emit(subagentHandlers, "session_shutdown", ctxFor(subagent));
await sleep(50);
if (!fs.existsSync(sockPath) || !fs.existsSync(infoPath)) {
	fail("subagent session_shutdown deleted the interactive session's socket");
}
if (widget.value?.[0] !== "lua/omp/init.lua:1") {
	fail("subagent session_shutdown cleared the widget");
}

const ownerPrompt = ownerHandlers.get("before_agent_start")?.[0];
const subagentPrompt = subagentHandlers.get("before_agent_start")?.[0];
if (!ownerPrompt || !subagentPrompt) {
	fail("no before_agent_start handler registered");
}
const promptEvent = {
	type: "before_agent_start",
	reason: "prompt",
	prompt: "hi",
	systemPrompt: [],
};
if (subagentPrompt(promptEvent, ctxFor(subagent)) !== undefined) {
	fail("a subagent prompt got the active file");
}
const injected = ownerPrompt(promptEvent, ctxFor(owner)) as
	| { message?: { content: string; display?: boolean; attribution?: string } }
	| undefined;
if (!injected?.message?.content.includes("Active file: lua/omp/init.lua:1")) {
	fail("the owner's prompt did not get the active file");
}
if (injected.message.display !== false) {
	fail("the active-file note is shown in the transcript");
}
// "agent" turns it into a trailing system message on Opus 4.8+ (oh-my-pi#15881).
if (injected.message.attribution === "agent") {
	fail("the active-file note is agent-attributed");
}

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

fs.unlinkSync(infoPath);
heal();
await waitFor(
	() => fs.existsSync(infoPath),
	"the .info file to be rewritten again",
);
if (fs.statSync(sockPath).ino !== ownerInode) {
	fail("repeat self-heal rebuilt the server instead of rewriting .info");
}

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

// An unwritable runtime dir must neither throw nor claim the socket.
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

// Identical heal failures log once; a changed failure, recovery and a later
// outage each log again.
noisyRoot = fs.mkdtempSync(path.join(os.tmpdir(), "omp-nvim-noisy-"));
let noisyLocks = true;
try {
	fs.mkdirSync(path.join(noisyRoot, "probe"));
	fs.chmodSync(noisyRoot, 0o500);
	fs.mkdirSync(path.join(noisyRoot, "probe2"));
	noisyLocks = false;
} catch {}
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

	// A function, so TS doesn't narrow the counters to literals.
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

	// Directory writable again but the socket path occupied: listen() now fails
	// instead of mkdir.
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
