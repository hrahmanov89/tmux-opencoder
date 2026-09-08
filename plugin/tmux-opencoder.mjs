import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { createTracker } from '../lib/status.mjs';

const exec = promisify(execFile);

export default async function tmuxOpencoder({ directory }) {
  const pane = process.env.TMUX_PANE;
  const socket = /^(.*),[^,]+,[^,]+$/.exec(process.env.TMUX || '')?.[1];
  if (!socket || !/^%\d+$/.test(pane || '')) return {};
  const tracker = createTracker();
  const owner = randomUUID();
  const tmux = (...args) => exec('tmux', ['-S', socket, ...args], { timeout: 2000 });
  let disposed = false;
  let queue = Promise.resolve();
  let lastState;
  let lastStatus;
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
  const timer = setInterval(() => { void publish(true); }, 5000);
  timer.unref();
  return {
    async event({ event }) { tracker.event(event); void publish(); },
    async 'chat.message'({ sessionID }) { tracker.prompt(sessionID); void publish(); },
    async dispose() {
      disposed = true;
      clearInterval(timer);
      await queue;
      try {
        // Do not clear status belonging to a newer instance in the same pane.
        await tmux('if-shell', '-F', '-t', pane,
          `#{m:*${owner}*,#{@opencode_state}}`,
          `set-option -pu -t ${pane} @opencode_state ; set-option -pu -t ${pane} @opencode_status`);
      } catch { /* Pane/server may already be gone. */ }
    },
  };
}
