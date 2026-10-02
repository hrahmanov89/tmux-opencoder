import test from 'node:test';
import assert from 'node:assert/strict';
import { createTracker } from '../lib/status.mjs';
import plugin, { tmuxOpencoder, discoverSessions, resumedSessionID, selectTuiSession, visibleSessionID } from '../plugin/tmux-opencoder.mjs';

function send(t, type, sessionID, props = {}) {
  t.event({ type, properties: { sessionID, ...props } });
}
test('child completion does not idle parent', () => {
  const t = createTracker();
  t.prompt('parent'); t.prompt('child');
  send(t, 'session.idle', 'child');
  assert.equal(t.state(), 'working');
  send(t, 'session.status', 'parent', { status: { type: 'idle' } });
  assert.equal(t.state(), 'idle');
});
test('multiple permission and question requests survive busy updates', () => {
  const t = createTracker(); t.prompt('parent');
  send(t, 'permission.asked', 'child', { id: 'a' });
  send(t, 'question.v2.asked', 'child', { id: 'b' });
  send(t, 'session.status', 'child', { status: { type: 'busy' } });
  send(t, 'permission.replied', 'child', { requestID: 'a' });
  assert.equal(t.state(), 'needs input');
  send(t, 'question.v2.rejected', 'child', { requestID: 'b' });
  assert.equal(t.state(), 'working');
});
test('error stays visible after idle and clears on next prompt', () => {
  const t = createTracker();
  send(t, 'session.error', 'a'); send(t, 'session.idle', 'a');
  assert.equal(t.state(), 'error');
  t.prompt('b'); assert.equal(t.state(), 'working');
});
test('retry, completion, deletion and unrelated events', () => {
  const t = createTracker();
  send(t, 'session.status', 'a', { status: { type: 'retry' } });
  assert.equal(t.state(), 'retrying');
  send(t, 'permission.v2.asked', 'a', { id: 'p' });
  send(t, 'session.idle', 'a'); assert.equal(t.state(), 'idle');
  send(t, 'session.error', 'a');
  send(t, 'session.deleted', undefined, { info: { id: 'a' } });
  t.event({ type: 'file.edited', properties: { file: 'foo' } });
  assert.equal(t.state(), 'idle');
});
test('plugin is inert outside tmux', async () => {
  const old = process.env.TMUX;
  delete process.env.TMUX;
  try {
    assert.equal(plugin.id, 'tmux-opencoder');
    assert.equal(typeof plugin.setup, 'function');
    assert.equal(plugin.server, tmuxOpencoder);
    assert.deepEqual(await plugin.server({ directory: '/tmp' }), {});
  }
  finally { if (old !== undefined) process.env.TMUX = old; }
});
test('TUI selection uses exact session through legacy SDK transport', async () => {
  const calls = [];
  const client = { tui: { _client: { post: async options => { calls.push(options); return { data: true }; } } } };
  await selectTuiSession(client, '/repos/demo', 'ses_idle');
  assert.deepEqual(calls, [{
    url: '/tui/select-session',
    query: { directory: '/repos/demo' },
    body: { sessionID: 'ses_idle' },
    headers: { 'Content-Type': 'application/json' },
  }]);
  client.tui._client.post = async () => ({ data: false });
  await assert.rejects(selectTuiSession(client, '/repos/demo', 'ses_idle'), /rejected/);
});
test('session discovery keeps active and process-observed idle roots only', async () => {
  const calls = [];
  const client = { session: {
    list: async options => {
      calls.push(['list', options]);
      return { data: [
        { id: 'working', title: 'Working', time: { updated: 2 } },
        { id: 'retry', title: 'Retry', time: { updated: 2 } },
        { id: 'idle', title: 'Idle', time: { updated: 1 } },
        { id: 'historical', title: 'Historical', time: { updated: 0 } },
        { id: 'child', parentID: 'working', title: 'Child', time: { updated: 3 } },
      ] };
    },
    status: async options => {
      calls.push(['status', options]);
      return { data: { working: { type: 'busy' }, retry: { type: 'retry' }, idle: { type: 'idle' } } };
    },
    _client: { get: async options => {
      calls.push(['active', options]);
      return { data: { working: { type: 'running' }, retry: { type: 'running' } } };
    } },
  } };
  const observed = new Set();
  assert.deepEqual(await discoverSessions(client, '/repos/demo', observed, 'content\n        ses_idle\n'), [
    { id: 'working', title: 'Working', state: 'working', updated: 2 },
    { id: 'retry', title: 'Retry', state: 'retrying', updated: 2 },
    { id: 'idle', title: 'Idle', state: 'idle', updated: 1 },
  ]);
  assert.deepEqual(calls, [
    ['list', { query: { directory: '/repos/demo', roots: true, limit: 1000 } }],
    ['status', { query: { directory: '/repos/demo' } }],
    ['active', { url: '/api/session/active' }],
  ]);
  assert.deepEqual([...observed].sort(), ['idle', 'retry', 'working']);
});
test('resumed session ID supports short and long CLI forms', () => {
  assert.equal(resumedSessionID(['opencode', '-s', 'ses_short']), 'ses_short');
  assert.equal(resumedSessionID(['opencode', '--session', 'ses_long']), 'ses_long');
  assert.equal(resumedSessionID(['opencode', '--session=ses_equal']), 'ses_equal');
  assert.equal(resumedSessionID(['opencode']), undefined);
});
test('visible session detection accepts only standalone known root IDs', () => {
  const roots = [{ id: 'ses_current' }, { id: 'ses_other' }];
  assert.equal(visibleSessionID('text ses_other\n          ses_current\n', roots), 'ses_current');
  assert.equal(visibleSessionID('ses_unknown\ntext ses_current', roots), undefined);
});
