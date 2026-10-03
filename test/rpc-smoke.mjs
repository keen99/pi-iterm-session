#!/usr/bin/env node
// Deep pinned-pi smoke. Proves, against a real pi process:
//  1. extension loads, /iterm-session registers
//  2. real session_start refires after RPC switch_session to a fixture
//     session that already contains an assistant message (so pi flushes
//     immediately) — and the binding entry lands ON DISK with our tab id
//  3. the real event/ctx shape pi hands extensions matches what the
//     extension code reads (via test/probe.ts capture)
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const dir = mkdtempSync(join(tmpdir(), 'iterm-deep-'));
const agentDir = join(dir, 'agent');
const sessions = join(agentDir, 'sessions', '--tmp-proj--');
mkdirSync(sessions, { recursive: true });
const TAB = 'w41t0p0:BDBCF986-D993-46E2-9B5C-4FFBE89DF9A9';
const probeFile = join(dir, 'probe.jsonl');
const line = (obj) => JSON.stringify(obj) + '\n';
const hex = (n) => Array.from({ length: n }, () => Math.floor(Math.random() * 16).toString(16)).join('');
const uuid = () => `${hex(8)}-${hex(4)}-${hex(4)}-${hex(4)}-${hex(12)}`;

// Fixture session bound to TAB, with an assistant message so pi considers
// the file flushed and persists new entries immediately.
const sessionId = uuid();
let parentId = null;
const entry = (e) => { e.id = e.id ?? hex(8); e.parentId = parentId; parentId = e.id; return line(e); };
writeFileSync(join(sessions, `fixture_${sessionId}.jsonl`),
  line({ type: 'session', version: 3, id: sessionId, timestamp: new Date().toISOString(), cwd: '/tmp' }) +
  line({ type: 'model_change', timestamp: new Date().toISOString(), provider: 'zai', modelId: 'glm-5.3-flash' }) +
  line({ type: 'message', timestamp: new Date().toISOString(), message: { role: 'user', content: [{ type: 'text', text: 'prior tab work' }], timestamp: Date.now() } }) +
  line({ type: 'message', timestamp: new Date().toISOString(), message: { role: 'assistant', content: [{ type: 'text', text: 'done' }], timestamp: Date.now() }, usage: { input: 1, output: 1, cost: { total: 0 } } }) +
  entry({ type: 'custom', customType: 'iterm-session/v1', data: { tabId: TAB } }));

writeFileSync(join(agentDir, 'settings.json'), JSON.stringify({ packages: [] }));
writeFileSync(probeFile, '');

const child = spawn(
  process.env.PI_TEST_BIN ?? join(dirname(process.execPath), 'pi'),
  [
    '--mode', 'rpc', '--no-extensions',
    '-e', join(root, 'src', 'index.ts'),
    '-e', join(root, 'test', 'probe.ts'),
    '--session-dir', sessions,
  ],
  { env: { ...process.env, PI_CODING_AGENT_DIR: agentDir, ITERM_SESSION_ID: TAB, ITERM_PROBE_FILE: probeFile }, cwd: dir },
);
const killTimer = setTimeout(() => child.kill('SIGKILL'), 60_000);
let out = '';
let switched = false;
const fixturePath = () => join(sessions, `fixture_${sessionId}.jsonl`);
function bindingCount() {
  try {
    return readFileSync(fixturePath(), 'utf8').trim().split('\n').filter((l) => l.includes('iterm-session/v1')).length;
  } catch { return 0; }
}
child.stdout.on('data', (d) => {
  out += d;
  if (!switched && out.includes('"commands"') && out.includes('"iterm-session"')) {
    switched = true;
    child.stdin.write(JSON.stringify({ type: 'switch_session', id: 'deep-2', sessionPath: fixturePath() }) + '\n');
    // Early exit: once the refired session_start persists the binding to the
    // real fixture file, everything is proven — don't burn 60s per version.
    const poll = setInterval(() => {
      if (bindingCount() >= 2) {
        clearInterval(poll);
        child.kill('SIGTERM');
      }
    }, 200);
  }
});
child.stderr.on('data', (d) => { out += d; });
child.on('exit', () => {
  clearTimeout(killTimer);
  try {
    const responseLine = out.split('\n').find((l) => l.includes('"commands"'));
    assert2(responseLine, `no commands response; raw=${out.slice(0, 3000)}`);
    const commands = JSON.parse(responseLine).data.commands;
    assert2(commands.some((c) => c.name === 'iterm-session'), '/iterm-session registered');

    const switchLine = out.split('\n').find((l) => l.includes('"switch_session"'));
    assert2(switchLine, `no switch_session response; raw tail=${out.slice(-2500)}`);
    assert2(JSON.parse(switchLine).success === true, 'switch_session succeeded');

    // Binding appended to the fixture session by the refired session_start.
    const fixture = readFileSync(join(sessions, `fixture_${sessionId}.jsonl`), 'utf8');
    const bindingLines = fixture.trim().split('\n').filter((l) => l.includes('iterm-session/v1'));
    assert2(bindingLines.length >= 2, `binding persisted post-switch (found ${bindingLines.length})`);
    const parsed = JSON.parse(bindingLines.at(-1));
    assert2(parsed.data.tabId === TAB, 'fresh binding carries the tab id');

    // Real shapes pi handed to extensions on this version.
    const probes = readFileSync(probeFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert2(probes.length >= 2, `session_start fired ${probes.length}x (startup + post-switch)`);
    for (const p of probes) {
      assert2(p.sm.getBranch === 'function' && p.sm.getSessionDir === 'function' && p.sm.getSessionFile === 'function' && p.sm.getCwd === 'function', `ctx.sessionManager surface: ${JSON.stringify(p.sm)}`);
      assert2(p.switchSessionOnEventCtx === 'undefined', 'switchSession must stay command-ctx-only (design assumption)');
    }
    assert2(probes.at(-1).reason === 'switch' || probes.at(-1).reason === 'reload' || probes.at(-1).reason !== undefined, `post-switch reason present: ${JSON.stringify(probes.at(-1))}`);

    console.log('Deep smoke PASS: load, real switch_session, binding persisted to real session file, real event shapes verified.');
  } catch (e) {
    console.error('FAIL', e.message);
    process.exitCode = 1;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
child.stdin.write(JSON.stringify({ type: 'get_commands', id: 'deep-1' }) + '\n');
function assert2(cond, msg) { if (!cond) throw new Error(msg); }
