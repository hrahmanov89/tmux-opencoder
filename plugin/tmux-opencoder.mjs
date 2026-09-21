import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { chmod, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { createTracker } from '../lib/status.mjs';

const exec = promisify(execFile);

export async function selectTuiSession(client, directory, sessionID) {
  const result = await client.tui._client.post({
    url: '/tui/select-session',
    query: { directory },
    body: { sessionID },
    headers: { 'Content-Type': 'application/json' },
  });
  if (result.data !== true) throw new Error('OpenCode rejected session selection');
}

export async function discoverSessions(client, directory) {
  const [listRes, statusRes] = await Promise.all([
    client.session.list({ query: { directory, roots: true, limit: 1000 } }),
    client.session.status({ query: { directory } }),
  ]);
  return (listRes.data || []).filter(session => !session.parentID).map(session => {
    const status = statusRes.data?.[session.id];
    return {
      id: session.id,
      title: session.title,
      state: status?.type === 'busy' ? 'working'
        : status?.type === 'retry' ? 'retrying'
        : 'idle',
      updated: session.time.updated,
    };
  });
}

export default async function tmuxOpencoder({ client, directory }) {
  const pane = process.env.TMUX_PANE;
  const socket = /^(.*),[^,]+,[^,]+$/.exec(process.env.TMUX || '')?.[1];
  if (!socket || !/^%\d+$/.test(pane || '')) return {};
  const tracker = createTracker();
  const owner = randomUUID();
  const token = randomUUID();
  const controlPath = `/tmp/tmux-opencoder-${process.pid}-${owner.slice(0, 8)}.sock`;
  const tmux = (...args) => exec('tmux', ['-S', socket, ...args], { timeout: 2000 });
  let disposed = false;
  let queue = Promise.resolve();
  let sessionQueue = Promise.resolve();
  let lastState;
  let lastStatus;
  let sessions = [];

  await rm(controlPath, { force: true });
  const control = createServer(connection => {
    connection.setEncoding('utf8');
    connection.setTimeout(3000, () => connection.destroy());
    let input = '';
    let handled = false;
    connection.on('data', chunk => {
      if (handled) return;
      input += chunk;
      if (input.length > 8192) {
        handled = true;
        connection.end(`${JSON.stringify({ ok: false, error: 'Request too large' })}\n`);
        return;
      }
      const newline = input.indexOf('\n');
      if (newline < 0) return;
      handled = true;
      void (async () => {
        try {
          const request = JSON.parse(input.slice(0, newline));
          if (request.token !== token || typeof request.sessionID !== 'string') {
            throw new Error('Invalid control request');
          }
          if (!sessions.some(session => session.id === request.sessionID)) {
            throw new Error('Session is not available in this OpenCode process');
          }
          await selectTuiSession(client, directory, request.sessionID);
          connection.end(`${JSON.stringify({ ok: true })}\n`);
        } catch (error) {
          connection.end(`${JSON.stringify({ ok: false, error: error.message || String(error) })}\n`);
        }
      })();
    });
  });
  await new Promise((resolve, reject) => {
    control.once('error', reject);
    control.listen(controlPath, resolve);
  });
  await chmod(controlPath, 0o600);

  const publishSessions = () => {
    sessionQueue = sessionQueue.then(async () => {
      if (disposed) return;
      try {
        sessions = await discoverSessions(client, directory);
        const snapshot = JSON.stringify({ version: 1, owner, pid: process.pid,
          updated: Date.now(), project: directory, control: { path: controlPath, token }, sessions });
        await tmux('set-option', '-p', '-t', pane, '@opencode_sessions', snapshot);
      } catch {
        // Session discovery must never block an agent turn or surface errors to it.
      }
    }).catch(() => {});
    return sessionQueue;
  };

  const publish = (heartbeat = false) => {
    const state = tracker.state();
    if (disposed || (!heartbeat && lastState === state)) return queue;
    lastState = state;
    queue = queue.then(async () => {
      if (disposed) return;
      const snapshot = JSON.stringify({ version: 1, owner, pid: process.pid,
        updated: Date.now(), state, project: directory });
      try {
        const args = ['set-option', '-p', '-t', pane, '@opencode_state', snapshot];
        if (lastStatus !== state) {
          args.push(';', 'set-option', '-p', '-t', pane, '@opencode_status', state);
        }
        await tmux(...args);
        lastStatus = state;
      } catch (e) {
        lastState = undefined;
        lastStatus = undefined;
      }
    }).catch(() => { lastState = undefined; });
    // Status integration must never block an agent turn or surface tmux errors to it.
    return queue;
  };
  void publish(true);
  void publishSessions();
  const timer = setInterval(() => { void publish(true); void publishSessions(); }, 5000);
  timer.unref();
  return {
    async event({ event }) { tracker.event(event); void publish(); void publishSessions(); },
    async 'chat.message'({ sessionID }) { tracker.prompt(sessionID); void publish(); void publishSessions(); },
    async dispose() {
      disposed = true;
      clearInterval(timer);
      await Promise.all([queue, sessionQueue]);
      await new Promise(resolve => control.close(resolve));
      await rm(controlPath, { force: true });
      try {
        // Do not clear status belonging to a newer instance in the same pane.
        await tmux('if-shell', '-F', '-t', pane,
          `#{m:*${owner}*,#{@opencode_state}}`,
          `set-option -pu -t ${pane} @opencode_state ; set-option -pu -t ${pane} @opencode_status ; set-option -pu -t ${pane} @opencode_sessions`);
      } catch { /* Pane/server may already be gone. */ }
    },
  };
}
