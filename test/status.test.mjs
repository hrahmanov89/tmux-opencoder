import test from 'node:test';
import assert from 'node:assert/strict';
import { createTracker } from '../lib/status.mjs';
import plugin, { discoverSessions, selectTuiSession } from '../plugin/tmux-opencoder.mjs';

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
  try { assert.deepEqual(await plugin({ directory: '/tmp' }), {}); }
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
test('session discovery requests all roots and includes idle sessions', async () => {
  const calls = [];
  const client = { session: {
    list: async options => {
      calls.push(['list', options]);
      return { data: [
        { id: 'working', title: 'Working', time: { updated: 2 } },
        { id: 'idle', title: 'Idle', time: { updated: 1 } },
        { id: 'child', parentID: 'working', title: 'Child', time: { updated: 3 } },
      ] };
    },
    status: async options => {
      calls.push(['status', options]);
      return { data: { working: { type: 'busy' }, idle: { type: 'idle' } } };
    },
  } };
  assert.deepEqual(await discoverSessions(client, '/repos/demo'), [
    { id: 'working', title: 'Working', state: 'working', updated: 2 },
    { id: 'idle', title: 'Idle', state: 'idle', updated: 1 },
  ]);
  assert.deepEqual(calls, [
    ['list', { query: { directory: '/repos/demo', roots: true, limit: 1000 } }],
    ['status', { query: { directory: '/repos/demo' } }],
  ]);
});
