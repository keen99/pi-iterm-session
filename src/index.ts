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
const PREVIEW_LIMIT = 60;
const SCAN_FILE_LIMIT = 8 * 1024 * 1024; // per-file safety cap
const SCAN_CONCURRENCY = 8;

export type TabSessionInfo = {
	path: string;
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
			ctx.ui.notify("No sessions bound to this iTerm tab.", "info");
			return;
		}
		const now = Date.now();
		const labels = sessions.map(
			(session) =>
				`${formatAge(now - session.mtimeMs)} · ${session.preview || "(no user messages)"}`,
		);
		labels.push(NEW_SESSION_LABEL);
		const paths = [...sessions.map((session) => session.path), undefined];
		const chosen = await ctx.ui.select(
			"Sessions from this iTerm tab — resume one?",
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
		pi.appendEntry(ITERM_STATE_TYPE, {
			tabId,
			cwd: ctx.sessionManager.getCwd(),
		});
		if (!ctx.hasUI) return;
		if (ctx.sessionManager.getBranch().length > 0) return;
		const sessions = await listTabSessions({
			sessionDir: ctx.sessionManager.getSessionDir(),
			tabId,
			currentFile: ctx.sessionManager.getSessionFile(),
		});
		if (sessions.length > 0)
			ctx.ui.notify(
				`${sessions.length} prior session(s) for this iTerm tab — /iterm-session to resume.`,
				"info",
			);
	});

	pi.registerCommand("iterm-session", {
		description:
			"Pick a session bound to this iTerm tab and switch to it. With a tab id argument, shows that tab's sessions instead.",
		handler: async (args, ctx) => {
			try {
				const requested = args.trim();
				const tabId =
					requested || env()[ITERM_SESSION_ENV];
				if (!tabId) {
					ctx.ui.notify(
						"Not inside an iTerm tab (no ITERM_SESSION_ID).",
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
											`${formatAge(Date.now() - session.mtimeMs)} · ${session.preview || "(no user messages)"}`,
									)
									.join("\n")}`
							: `No sessions bound to ${tabId}.`,
						"info",
					);
					return;
				}
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

function truncate(text: string): string {
	const flat = text.replace(/\s+/g, " ").trim();
	return flat.length > PREVIEW_LIMIT
		? `${flat.slice(0, PREVIEW_LIMIT - 1)}…`
		: flat;
}

/**
 * One pass over a session file: does it carry a binding for this tab?
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

/** Sessions bound to this iTerm tab in one project session dir, newest first. */
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
			return { path, mtimeMs: fileStat.mtimeMs, preview };
		}),
	);
	infos.sort((left, right) => right.mtimeMs - left.mtimeMs);
	return infos;
}
