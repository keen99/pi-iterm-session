import assert from "node:assert/strict";
import {
	mkdirSync,
	mkdtempSync,
	rmSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import itermSession, {
	ITERM_STATE_TYPE,
	formatAge,
	listTabSessions,
	renderHintLines,
} from "../src/index.js";

const TAB = "w41t0p0:BDBCF986-D993-46E2-9B5C-4FFBE89DF9A9";
const OTHER = "w7t1p0:11111111-2222-3333-4444-555555555555";

function sessionFile(
	dir: string,
	name: string,
	lines: unknown[],
	mtime?: Date,
) {
	const path = join(dir, name);
	writeFileSync(
		path,
		lines.map((line) => JSON.stringify(line)).join("\n") + "\n",
	);
	if (mtime) utimesSync(path, mtime, mtime);
	return path;
}
const binding = (tabId: string) => ({
	type: "custom",
	customType: ITERM_STATE_TYPE,
	data: { tabId },
});
const userMessage = (text: string) => ({
	type: "message",
	timestamp: "2026-10-01T12:00:00Z",
	message: { role: "user", content: text },
});

function harness(options: {
	env?: Record<string, string | undefined>;
	branch?: unknown[];
	sessionDir?: string;
	sessionFile?: string;
	cwd?: string;
	hasUI?: boolean;
}) {
	const entries: Array<Record<string, unknown>> = [];
	const notices: string[] = [];
	const widgets: Array<{ key: string; content: unknown; placement?: string }> = [];
	const selectors: string[][] = [];
	let switchTarget: string | undefined;
	let selectAnswer: string | undefined;
	const ctx = {
		hasUI: options.hasUI ?? true,
		sessionManager: {
			getCwd: () => options.cwd ?? "/tmp/proj",
			getSessionDir: () => options.sessionDir ?? "/tmp/nonexistent-sessions",
			getSessionFile: () =>
				options.sessionFile ?? "/tmp/nonexistent-sessions/current.jsonl",
			// Live branch: appendEntry must not mark the session as non-fresh.
			getBranch: () => options.branch ?? entries,
		},
		ui: {
			notify: (text: string) => notices.push(text),
			setWidget: (key: string, content: unknown, options?: { placement?: string }) => {
				widgets.push({ key, content, placement: options?.placement });
			},
			select: async (_title: string, labels: string[]) => {
				selectors.push(labels);
				return selectAnswer;
			},
		},
		switchSession: async (path: string) => {
			switchTarget = path;
			return { cancelled: false };
		},
	};
	let startHandler: (event: unknown, ctx: unknown) => Promise<void>;
	let commandHandler: (args: string, ctx: unknown) => Promise<void>;
	const pi = {
		appendEntry: (customType: string, data: unknown) =>
			entries.push({ customType, data }),
		on: (event: string, handler: never) => {
			if (event === "session_start") startHandler = handler;
		},
		registerCommand: (name: string, command: { handler: never }) => {
			if (name === "iterm-session") commandHandler = command.handler;
		},
	};
	itermSession(pi as never, { env: options.env });
	return {
		entries,
		notices,
		selectors,
		get switchTarget() {
			return switchTarget;
		},
		get widgets() {
			return widgets;
		},
		set selectAnswer(value: string | undefined) {
			selectAnswer = value;
		},
		start: () => startHandler({}, ctx),
		command: (args: string) => commandHandler(args, ctx),
	};
}

function sandbox() {
	return mkdtempSync(join(tmpdir(), "iterm-session-test-"));
}

test("session_start binds tab, hints about history, stays quiet when busy", async () => {
	const dir = sandbox();
	try {
		const sessions = join(dir, "session-dir");
		mkdirSync(sessions);
		sessionFile(sessions, "old.jsonl", [binding(TAB), userMessage("prior work")]);
		const bare = harness({ env: {} });
		await bare.start();
		assert.deepEqual(bare.entries, []);
		const fresh = harness({
			env: { ITERM_SESSION_ID: TAB },
			sessionDir: sessions,
			sessionFile: join(sessions, "current.jsonl"),
		});
		await fresh.start();
		assert.deepEqual(fresh.entries[0], {
			customType: ITERM_STATE_TYPE,
			data: { tabId: TAB, cwd: "/tmp/proj" },
		});
		assert.equal(fresh.widgets.length, 1);
		assert.equal(fresh.widgets[0].key, "iterm-session-hint");
		assert.equal(fresh.widgets[0].placement, "belowEditor");
		const busy = harness({
			env: { ITERM_SESSION_ID: TAB },
			sessionDir: sessions,
			sessionFile: join(sessions, "current.jsonl"),
			branch: [{ type: "message", message: { role: "user", content: "x" } }],
		});
		await busy.start();
		assert.equal(busy.entries.length, 1);
		assert.equal(busy.notices.length, 0);
		const quiet = harness({
			env: { ITERM_SESSION_ID: TAB },
			sessionDir: join(dir, "missing"),
			hasUI: false,
		});
		await quiet.start();
		assert.equal(quiet.notices.length, 0);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("command offers selector, switches on pick, respects new-session and escape", async () => {
	const dir = sandbox();
	try {
		const sessions = join(dir, "session-dir");
		mkdirSync(sessions);
		const older = new Date(Date.now() - 7_200_000);
		const newer = new Date(Date.now() - 60_000);
		sessionFile(sessions, "old.jsonl", [binding(TAB), userMessage("fix auth middleware")], older);
		sessionFile(sessions, "new.jsonl", [binding(TAB), userMessage("refactor storage")], newer);
		sessionFile(sessions, "elsewhere.jsonl", [binding(OTHER), userMessage("unrelated")], newer);
		const app = harness({
			env: { ITERM_SESSION_ID: TAB },
			sessionDir: sessions,
			sessionFile: join(sessions, "current.jsonl"),
		});
		app.selectAnswer = "1m ago · refactor storage";
		await app.command("");
		assert.equal(app.selectors.length, 1);
		assert.deepEqual(app.selectors[0], [
			"1m ago · refactor storage",
			"2h ago · fix auth middleware",
			"Start new session",
		]);
		assert.match(app.switchTarget ?? "", /new\.jsonl$/);
		const declined = harness({
			env: { ITERM_SESSION_ID: TAB },
			sessionDir: sessions,
			sessionFile: join(sessions, "current.jsonl"),
		});
		declined.selectAnswer = undefined;
		await declined.command("");
		assert.equal(declined.switchTarget, undefined);
		const freshPick = harness({
			env: { ITERM_SESSION_ID: TAB },
			sessionDir: sessions,
			sessionFile: join(sessions, "current.jsonl"),
		});
		freshPick.selectAnswer = "Start new session";
		await freshPick.command("");
		assert.equal(freshPick.switchTarget, undefined);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("command without tab, empty tab, and headless listing behave", async () => {
	const dir = sandbox();
	try {
		const sessions = join(dir, "session-dir");
		mkdirSync(sessions);
		sessionFile(sessions, "old.jsonl", [binding(TAB), userMessage("manual pick")]);
		const outside = harness({ env: {} });
		await outside.command("");
		assert.match(outside.notices[0], /no ITERM_SESSION_ID/);
		const empty = harness({
			env: { ITERM_SESSION_ID: OTHER },
			sessionDir: sessions,
			sessionFile: join(sessions, "current.jsonl"),
		});
		await empty.command("");
		assert.match(empty.notices[0], /No sessions bound/);
		const headless = harness({
			env: { ITERM_SESSION_ID: TAB },
			sessionDir: sessions,
			sessionFile: join(sessions, "current.jsonl"),
			hasUI: false,
		});
		await headless.command("");
		assert.match(headless.notices[0], /manual pick/);
		const explicit = harness({
			env: {},
			sessionDir: sessions,
			sessionFile: join(sessions, "current.jsonl"),
			hasUI: false,
		});
		await explicit.command(TAB);
		assert.match(explicit.notices[0], /manual pick/);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("renderHintLines: frame aligned at any width, wraps words, scales with digits", () => {
	const text = "2 prior sessions for this iTerm tab — /iterm-session to resume";
	for (const width of [80, 50, 30, 20, 12]) {
		const lines = renderHintLines(text, width);
		assert.ok(lines.length >= 3);
		assert.equal(new Set(lines.map((line) => line.length)).size, 1, `aligned at ${width}`);
		assert.match(lines[0], /^╭─+╮$/);
		assert.match(lines.at(-1) ?? "", /^╰─+╯$/);
		assert.ok(lines[1].includes("◀"));
		assert.ok((lines.at(-2) ?? "").includes("▶"));
		for (const line of lines.slice(1, -1)) assert.ok(line.startsWith("│") && line.endsWith("│"));
	}
	const single = renderHintLines("1 prior session", 80);
	assert.equal(single.length, 3);
	assert.ok(single[1].includes("1 prior session"));
	// Digit growth grows the frame by exactly the added characters; each stays aligned.
	const nine = renderHintLines("9 prior sessions", 80);
	const ninetyNine = renderHintLines("99 prior sessions", 80);
	assert.equal(new Set(nine.map((l) => l.length)).size, 1);
	assert.equal(new Set(ninetyNine.map((l) => l.length)).size, 1);
	assert.equal(ninetyNine[0].length, nine[0].length + 1);
});

test("scan helpers: formatAge buckets and listTabSessions filtering", async () => {
	assert.equal(formatAge(30_000), "now");
	assert.equal(formatAge(5 * 60_000), "5m ago");
	assert.equal(formatAge(3 * 3_600_000), "3h ago");
	assert.equal(formatAge(2 * 86_400_000), "2d ago");
	const dir = sandbox();
	try {
		const sessions = join(dir, "session-dir");
		mkdirSync(sessions);
		const now = Date.now();
		sessionFile(sessions, "a.jsonl", [binding(TAB), userMessage("alpha beta gamma")], new Date(now - 60_000));
		sessionFile(sessions, "b.jsonl", [binding(OTHER)], new Date(now - 120_000));
		sessionFile(sessions, "c.jsonl", [], new Date(now - 180_000));
		sessionFile(sessions, "current.jsonl", [binding(TAB)], new Date(now));
		const found = await listTabSessions({
			sessionDir: sessions,
			tabId: TAB,
			currentFile: join(sessions, "current.jsonl"),
		});
		assert.deepEqual(
			found.map((session) => session.path.split("/").pop()),
			["a.jsonl"],
		);
		assert.equal(found[0].preview, "alpha beta gamma");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
