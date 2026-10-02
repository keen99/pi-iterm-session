#!/usr/bin/env node
// Real pinned-pi smoke: isolated agent dir + fake session files, extension
// loaded via -e. Verifies the extension loads and /iterm-session registers.
// Session-file binding is covered by unit tests: pi lazily persists session
// files until the first assistant message, so an RPC smoke cannot observe the
// binding entry on disk without making a model call.
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const dir = mkdtempSync(join(tmpdir(), 'iterm-rpc-'));
const agentDir = join(dir, 'agent');
const sessions = join(agentDir, 'sessions', '--tmp-proj--');
mkdirSync(sessions, { recursive: true });
const TAB = 'w41t0p0:BDBCF986-D993-46E2-9B5C-4FFBE89DF9A9';
const line = (obj) => JSON.stringify(obj) + '\n';
writeFileSync(
  join(sessions, 'old.jsonl'),
  line({ type: 'custom', customType: 'iterm-session/v1', data: { tabId: TAB } }) +
    line({ type: 'message', timestamp: '2026-10-01T12:00:00Z', message: { role: 'user', content: 'prior tab work' } }),
);
writeFileSync(join(agentDir, 'settings.json'), JSON.stringify({ packages: [] }));

const child = spawn(
  process.env.PI_TEST_BIN ?? join(dirname(process.execPath), 'pi'),
  ['--mode', 'rpc', '--no-extensions', '-e', join(root, 'src', 'index.ts'), '--session-dir', sessions],
  { env: { ...process.env, PI_CODING_AGENT_DIR: agentDir, ITERM_SESSION_ID: TAB }, cwd: '/tmp' },
);
const killTimer = setTimeout(() => child.kill('SIGKILL'), 30_000);

let out = '';
child.stdout.on('data', (d) => {
  out += d;
  if (out.includes('"commands"') && !child.killed) child.kill('SIGTERM');
});
child.stderr.on('data', (d) => { out += d; });
child.on('exit', () => {
  clearTimeout(killTimer);
  try {
    const responseLine = out.split('\n').find((l) => l.includes('"commands"'));
    assert2(responseLine, `no commands response; raw=${out.slice(0, 4000)}`);
    const commands = JSON.parse(responseLine).data.commands;
    assert2(commands.some((c) => c.name === 'iterm-session'), '/iterm-session registered');
    console.log('Pinned-pi RPC smoke PASS: extension loads, /iterm-session registered.');
  } catch (e) {
    console.error('FAIL', e.message);
    process.exitCode = 1;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
child.stdin.write(JSON.stringify({ type: 'get_commands', id: 'smoke-1' }) + '\n');
function assert2(cond, msg) { if (!cond) throw new Error(msg); }
