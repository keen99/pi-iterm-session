// Test-only probe: records the REAL session_start event shape and the real
// extension ctx capabilities pi hands to extensions on this version. Loaded
// after the extension under test via a second -e flag.
import { appendFileSync } from "node:fs";
export default function probe(pi: any) {
	pi.on("session_start", async (event: any, ctx: any) => {
		appendFileSync(
			process.env.ITERM_PROBE_FILE ?? "/tmp/iterm-probe.jsonl",
			JSON.stringify({
				eventKeys: Object.keys(event ?? {}).sort(),
				reason: event?.reason,
				sm: {
					getBranch: typeof ctx?.sessionManager?.getBranch,
					getEntries: typeof ctx?.sessionManager?.getEntries,
					getSessionDir: typeof ctx?.sessionManager?.getSessionDir,
					getSessionFile: typeof ctx?.sessionManager?.getSessionFile,
					getCwd: typeof ctx?.sessionManager?.getCwd,
				},
				switchSessionOnEventCtx: typeof ctx?.switchSession,
				hasUI: ctx?.hasUI,
			}) + "\n",
		);
	});
}
