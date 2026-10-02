import test from 'node:test';
import assert from 'node:assert/strict';
import plugin, { attachedSessionIDs, discoverTuiSessions, normalizeEvent, selectTuiSession } from '../plugin/tui.mjs';
import { createTracker } from '../lib/status.mjs';
import { spawnSync } from 'node:child_process';
import { access } from 'node:fs/promises';
import { createConnection } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';

function context() {
  const sessions = [
    { id: 'root', title: 'Root', time: { updated: 1 } },
    { id: 'other', title: 'Other TUI', time: { updated: 2 } },
    { id: 'child', parentID: 'root', time: { updated: 3 } },
  ];
  return {
    data: { session: {
      list: () => sessions,
      root: id => id === 'child' ? 'root' : id,
      status: () => 'running',
    } },
    ui: {
      router: { current: () => ({ type: 'session', sessionID: 'child' }) },
      tabs: { enabled: () => true, list: () => [{ sessionID: 'root' }] },
    },
  };
}

test('V2 definition is inert outside tmux', async () => {
  const old = process.env.TMUX;
  delete process.env.TMUX;
  try {
    assert.equal(plugin.id, 'tmux-opencoder.cli');
    assert.equal(await plugin.setup({ location: { directory: '/repos/demo' } }), undefined);
  } finally { if (old !== undefined) process.env.TMUX = old; }
});

test('V2 discovery includes only attached or previously viewed roots', async () => {
  const ctx = context();
  const tracker = createTracker();
  const observed = new Set();
  assert.deepEqual([...attachedSessionIDs(ctx)], ['root']);
  assert.deepEqual(await discoverTuiSessions(ctx, observed, tracker), [
    { id: 'root', title: 'Root', state: 'working', updated: 1 },
  ]);
  ctx.ui.router.current = () => ({ type: 'home' });
  ctx.ui.tabs.list = () => [];
  assert.equal((await discoverTuiSessions(ctx, observed, tracker))[0].id, 'root');
});

test('V2 events preserve retries, failures, permissions, and forms', async () => {
  const tracker = createTracker();
  const event = (type, data = { sessionID: 'root' }) => tracker.event(normalizeEvent({ type, data }));
  event('session.execution.started');
  assert.equal(tracker.state(), 'working');
  event('session.retry.scheduled');
  assert.equal((await discoverTuiSessions(context(), new Set(), tracker))[0].state, 'retrying');
  event('permission.asked', { sessionID: 'root', id: 'p' });
  event('form.created', { form: { sessionID: 'root', id: 'f' } });
  event('permission.replied', { sessionID: 'root', requestID: 'p' });
  assert.equal(tracker.state(), 'needs input');
  event('form.cancelled', { sessionID: 'root', id: 'f' });
  event('session.step.started');
  assert.equal(tracker.state(), 'working');
  event('session.execution.failed');
  const ctx = context();
  ctx.data.session.status = () => 'idle';
  assert.equal((await discoverTuiSessions(ctx, new Set(), tracker))[0].state, 'error');
  tracker.prompt('root');
  event('session.execution.succeeded');
  assert.equal(tracker.state(), 'idle');
  event('session.execution.started');
  event('session.execution.interrupted');
  assert.equal(tracker.state(), 'idle');
  event('session.deleted');
  assert.equal(tracker.state(), 'idle');
});

test('V2 selection uses local tabs or router, never the server TUI endpoint', () => {
  const ctx = context();
  const calls = [];
  ctx.ui.tabs.focus = id => calls.push(['tab', id]);
  ctx.ui.router.navigate = route => calls.push(['route', route]);
  selectTuiSession(ctx, '/ignored', 'root');
  ctx.ui.tabs.enabled = () => false;
  selectTuiSession(ctx, '/ignored', 'root');
  assert.deepEqual(calls, [['tab', 'root'], ['route', { type: 'session', sessionID: 'root' }]]);
});

test('V2 CLI publishes to its pane, filters shared-server events, selects and cleans up', async () => {
  const name = `opencoder-v2-test-${process.pid}`;
  const tmux = (...args) => {
    const result = spawnSync('tmux', ['-L', name, ...args], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  const old = { TMUX: process.env.TMUX, TMUX_PANE: process.env.TMUX_PANE };
  let cleanup;
  try {
    tmux('new-session', '-d', '-s', 'test');
    const socket = tmux('display-message', '-p', '#{socket_path}');
    const pane = tmux('display-message', '-p', '#{pane_id}');
    process.env.TMUX = `${socket},1,0`;
    process.env.TMUX_PANE = pane;
    const ctx = context();
    ctx.location = { directory: '/repos/demo' };
    let listener;
    let stopped = false;
    ctx.data.listen = fn => { listener = fn; return () => { stopped = true; }; };
    const selections = [];
    ctx.ui.tabs.focus = id => { selections.push(id); return true; };
    cleanup = await plugin.setup(ctx);
    const snapshot = async (key, predicate) => {
      for (let attempt = 0; attempt < 100; attempt++) {
        const raw = tmux('show-options', '-pqv', '-t', pane, key);
        if (raw) {
          const value = JSON.parse(raw);
          if (predicate(value)) return value;
        }
        await delay(20);
      }
      assert.fail(`Timed out waiting for ${key}`);
    };
    const sessions = await snapshot('@opencode_sessions', value => value.sessions.length === 1);
    assert.equal(sessions.sessions[0].id, 'root');
    listener({ details: { type: 'session.execution.failed', data: { sessionID: 'other' } } });
    await snapshot('@opencode_state', value => value.state === 'working');
    listener({ details: { type: 'session.retry.scheduled', data: { sessionID: 'root' } } });
    await snapshot('@opencode_state', value => value.state === 'retrying');
    const reply = await new Promise((resolve, reject) => {
      const connection = createConnection(sessions.control.path);
      let input = '';
      connection.setEncoding('utf8');
      connection.setTimeout(3000, () => connection.destroy(new Error('Control timeout')));
      connection.on('error', reject);
      connection.on('connect', () => connection.write(`${JSON.stringify({
        token: sessions.control.token, sessionID: 'root',
      })}\n`));
      connection.on('data', chunk => { input += chunk; });
      connection.on('end', () => resolve(JSON.parse(input)));
    });
    assert.deepEqual(reply, { ok: true });
    assert.deepEqual(selections, ['root']);
    await cleanup();
    cleanup = undefined;
    assert.equal(stopped, true);
    assert.equal(tmux('show-options', '-pqv', '-t', pane, '@opencode_state'), '');
    assert.equal(tmux('show-options', '-pqv', '-t', pane, '@opencode_sessions'), '');
    await assert.rejects(access(sessions.control.path), { code: 'ENOENT' });
  } finally {
    if (cleanup) await cleanup();
    for (const [key, value] of Object.entries(old)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    spawnSync('tmux', ['-L', name, 'kill-server']);
  }
});
