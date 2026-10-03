import { open, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";

export const ITERM_STATE_TYPE = "iterm-session/v1";
const MARKER = `"${ITERM_STATE_TYPE}"`;
const ITERM_SESSION_ENV = "ITERM_SESSION_ID";
const NEW_SESSION_LABEL = "Start new session";
const HINT_WIDGET_KEY = "iterm-session-hint";
/** Metadata entries (headers, labels, other extensions' custom pins) don't
 *  count; real conversation history does. Fresh = zero of these. */
const CONTENT_ENTRY_TYPES = new Set(["message", "custom_message", "compaction"]);
const PREVIEW_LIMIT = 60;
const SCAN_FILE_LIMIT = 8 * 1024 * 1024; // per-file safety cap
const SCAN_CONCURRENCY = 8;

export type TabSessionInfo = {
	path: string;
	id: string;
	mtimeMs: number;
	preview: string;
};

type EnvLike = Record<string, string | undefined>;

export type ItermSessionDependencies = {
	agentDir?: string;
	env?: EnvLike;
};

/**
 * pi 0.75.4 hands session_start a base ctx without switchSession (command
 * ctx only), so startup binds the tab and hints; switching is command-only.
 */
export default function itermSession(
	pi: ExtensionAPI,
	dependencies: ItermSessionDependencies = {},
): void {
	const env = () => dependencies.env ?? process.env;

	async function offerSelector(
		ctx: ExtensionCommandContext,
		tabId: string,
	): Promise<void> {
		const manager = ctx.sessionManager;
		const sessions = await listTabSessions({
			sessionDir: manager.getSessionDir(),
			tabId,
			currentFile: manager.getSessionFile(),
		});
		if (sessions.length === 0) {
			ctx.ui.notify("No sessions bound to this iTerm session.", "info");
			return;
		}
		const now = Date.now();
		const labels = sessions.map(
			(session) =>
				`${formatAge(now - session.mtimeMs)} · ${session.id} · ${session.preview || "(no user messages)"}`,
		);
		labels.push(NEW_SESSION_LABEL);
		const paths = [...sessions.map((session) => session.path), undefined];
		const chosen = await ctx.ui.select(
			"Sessions from this iTerm session — resume one?",
			labels,
		);
		if (chosen === undefined) return;
		const index = labels.indexOf(chosen);
		const target = index >= 0 ? paths[index] : undefined;
		if (!target) return; // "Start new session"
		await ctx.switchSession(target);
	}

	pi.on("session_start", async (_event, ctx) => {
		const tabId = env()[ITERM_SESSION_ENV];
		if (!tabId) return;
		// Read freshness BEFORE binding: our own custom entry would mark the
		// session as having content and suppress the hint forever.
		const hasContent = ctx.sessionManager
			.getBranch()
			.some((entry) => CONTENT_ENTRY_TYPES.has(entry.type));
		pi.appendEntry(ITERM_STATE_TYPE, {
			tabId,
			cwd: ctx.sessionManager.getCwd(),
		});
		if (!ctx.hasUI) return;
		if (hasContent) return;
		const sessions = await listTabSessions({
			sessionDir: ctx.sessionManager.getSessionDir(),
			tabId,
			currentFile: ctx.sessionManager.getSessionFile(),
		});
		if (sessions.length > 0) showHint(ctx, sessions.length);
	});

	/** Bottom callout: accent-framed, dismissed by use or first turn. */
	function showHint(ctx: ExtensionContext, count: number): void {
		const noun = count === 1 ? "session" : "sessions";
		const text = `${count} prior ${noun} for this iTerm session — /iterm-session to resume`;
		ctx.ui.setWidget(
			HINT_WIDGET_KEY,
			(tui, theme) => ({
				render: (width: number) =>
					renderHintLines(text, width).map((line) =>
						theme.fg("accent", line),
					),
				invalidate: () => {},
			}),
			{ placement: "belowEditor" },
		);
	}

	function clearHint(ctx: ExtensionContext): void {
		try {
			ctx.ui.setWidget(HINT_WIDGET_KEY, undefined);
		} catch {
			/* already gone */
		}
	}

	pi.on("before_agent_start", async (_event, ctx) => {
		clearHint(ctx);
	});

	pi.registerCommand("iterm-session", {
		description:
			"Pick a session bound to this iTerm session and switch to it. With a session id argument, shows that session's sessions instead.",
		handler: async (args, ctx) => {
			try {
				const requested = args.trim();
				const tabId =
					requested || env()[ITERM_SESSION_ENV];
				if (!tabId) {
					ctx.ui.notify(
						"Not inside an iTerm session (no ITERM_SESSION_ID).",
						"info",
					);
					return;
				}
				if (!ctx.hasUI) {
					const sessions = await listTabSessions({
						sessionDir: ctx.sessionManager.getSessionDir(),
						tabId,
						currentFile: ctx.sessionManager.getSessionFile(),
					});
					ctx.ui.notify(
						sessions.length
							? `Sessions for ${tabId}:\n${sessions
									.map(
										(session) =>
											`${formatAge(Date.now() - session.mtimeMs)} · ${session.id} · ${session.preview || "(no user messages)"}`,
									)
									.join("\n")}`
							: `No sessions bound to ${tabId}.`,
						"info",
					);
					return;
				}
				clearHint(ctx);
				await offerSelector(ctx, tabId);
			} catch (error) {
				ctx.ui.notify(
					error instanceof Error ? error.message : String(error),
					"error",
				);
			}
		},
	});
}

export function formatAge(ms: number): string {
	const minutes = Math.floor(Math.max(0, ms) / 60_000);
	if (minutes < 1) return "now";
	if (minutes < 60) return `${minutes}m ago`;
	const hours = Math.round(minutes / 60);
	if (hours < 24) return `${hours}h ago`;
	const days = Math.round(hours / 24);
	if (days < 7) return `${days}d ago`;
	return `${Math.round(days / 7)}w ago`;
}

/**
 * Frame the hint for a viewport width, wrapping words across framed lines
 * when they do not fit. All frame lines share one measured width, so digits
 * in the count and narrow terminals stay in sync. First line carries ◀,
 * last carries ▶; continuation lines indent under the ◀.
 */
export function renderHintLines(text: string, width: number): string[] {
	const maxInner = Math.max(4, width - 2);
	// " ◀ " prefix on the first line and " ▶ " suffix on the last: reserve 6.
	const wrapWidth = Math.max(1, maxInner - 6);
	const wrapped: string[] = [];
	let current = "";
	for (const word of text.split(" ")) {
		let piece = word;
		// Hard-split words longer than the wrap width.
		while (piece.length > wrapWidth) {
			if (current) {
				wrapped.push(current);
				current = "";
			}
			wrapped.push(piece.slice(0, wrapWidth));
			piece = piece.slice(wrapWidth);
		}
		if (!piece) continue;
		if (!current) current = piece;
		else if (current.length + 1 + piece.length <= wrapWidth)
			current += ` ${piece}`;
		else {
			wrapped.push(current);
			current = piece;
		}
	}
	if (current) wrapped.push(current);
	if (wrapped.length === 0) wrapped.push("");
	const content = wrapped.map((line, index) => {
		const prefix = index === 0 ? " ◀ " : "   ";
		const suffix = index === wrapped.length - 1 ? " ▶ " : "   ";
		return prefix + line + suffix;
	});
	const innerWidth = Math.min(
		maxInner,
		Math.max(...content.map((line) => line.length)),
	);
	const bar = "─".repeat(innerWidth);
	return [
		`╭${bar}╮`,
		...content.map(
			(line) => `│${line}${" ".repeat(innerWidth - line.length)}│`,
		),
		`╰${bar}╯`,
	];
}

function truncate(text: string): string {
	const flat = text.replace(/\s+/g, " ").trim();
	return flat.length > PREVIEW_LIMIT
		? `${flat.slice(0, PREVIEW_LIMIT - 1)}…`
		: flat;
}

/** Session files are `<timestamp>_<uuid>.jsonl`; short id = first 8 hex. */
function shortSessionId(path: string): string {
	const stem = basename(path).replace(/\.jsonl$/i, "");
	const uuid = stem.match(/([0-9a-fA-F-]{36})$/)?.[1] ?? stem;
	return uuid.replace(/-/g, "").slice(0, 8);
}

/**
 * One pass over a session file: does it carry a binding for this iTerm session?
 * Streams raw chunks and only JSON-parses lines once the marker appears,
 * so unbound files cost a cheap substring scan.
 */
async function readTabBinding(
	path: string,
	tabId: string,
): Promise<boolean> {
	const handle = await open(path, "r");
	try {
		const chunkSize = 256 * 1024;
		const buffer = Buffer.alloc(chunkSize);
		let position = 0;
		let carry = "";
		let markerSeen = false;
		for (;;) {
			const { bytesRead } = await handle.read(buffer, 0, chunkSize, position);
			if (bytesRead === 0) return false;
			const chunk = buffer.toString("utf8", 0, bytesRead);
			if (!markerSeen && chunk.includes(MARKER)) markerSeen = true;
			if (markerSeen) {
				const text = carry + chunk;
				const lines = text.split("\n");
				carry = lines.pop() ?? "";
				for (const line of lines) {
					if (!line.includes(MARKER)) continue;
					try {
						const entry = JSON.parse(line) as {
							customType?: string;
							data?: { tabId?: unknown };
						};
						if (
							entry.customType === ITERM_STATE_TYPE &&
							entry.data?.tabId === tabId
						)
							return true;
					} catch {
						/* torn or foreign line */
					}
				}
			}
			position += bytesRead;
			if (position > SCAN_FILE_LIMIT) return false;
		}
	} finally {
		await handle.close();
	}
}

/** First user text message; usually within the first chunks. */
async function readPreview(path: string): Promise<string> {
	const handle = await open(path, "r");
	try {
		const chunkSize = 256 * 1024;
		const buffer = Buffer.alloc(chunkSize);
		let position = 0;
		let carry = "";
		for (;;) {
			const { bytesRead } = await handle.read(buffer, 0, chunkSize, position);
			if (bytesRead === 0) return "";
			const text = carry + buffer.toString("utf8", 0, bytesRead);
			const lines = text.split("\n");
			carry = lines.pop() ?? "";
			for (const line of lines) {
				try {
					const entry = JSON.parse(line) as {
						type?: string;
						message?: { role?: string; content?: unknown };
					};
					if (entry.type !== "message" || entry.message?.role !== "user")
						continue;
					const content = entry.message.content;
					const value =
						typeof content === "string"
							? content
							: Array.isArray(content)
								? content
										.map((block) =>
											typeof block === "object" &&
											block !== null &&
											(block as { type?: string }).type === "text"
												? (block as { text?: string }).text ?? ""
												: "",
										)
										.join(" ")
								: "";
					const flat = value.replace(/\s+/g, " ").trim();
					if (flat) return truncate(flat);
				} catch {
					/* ignore non-JSON lines */
				}
			}
			position += bytesRead;
			if (position > SCAN_FILE_LIMIT) return "";
		}
	} finally {
		await handle.close();
	}
}

/** Sessions bound to this iTerm session in one project session dir, newest first. */
export async function listTabSessions(options: {
	sessionDir: string;
	tabId: string;
	currentFile?: string;
}): Promise<TabSessionInfo[]> {
	let names: string[];
	try {
		names = await readdir(options.sessionDir);
	} catch {
		return [];
	}
	const currentBase = options.currentFile
		? basename(options.currentFile)
		: undefined;
	const files = names
		.filter((name) => name.endsWith(".jsonl") && name !== currentBase)
		.map((name) => join(options.sessionDir, name));
	const candidates: string[] = [];
	let next = 0;
	await Promise.all(
		Array.from(
			{ length: Math.min(SCAN_CONCURRENCY, files.length) },
			async () => {
				for (;;) {
					const file = files[next++];
					if (file === undefined) return;
					if (await readTabBinding(file, options.tabId))
						candidates.push(file);
				}
			},
		),
	);
	const infos = await Promise.all(
		candidates.map(async (path) => {
			const [fileStat, preview] = await Promise.all([
				stat(path),
				readPreview(path),
			]);
			return { path, id: shortSessionId(path), mtimeMs: fileStat.mtimeMs, preview };
		}),
	);
	infos.sort((left, right) => right.mtimeMs - left.mtimeMs);
	return infos;
}
