import { tmuxOpencoder } from './tmux-opencoder.mjs';

export function attachedSessionIDs(ctx) {
  const route = ctx.ui.router.current();
  return new Set([
    ...(route.type === 'session' ? [ctx.data.session.root(route.sessionID)] : []),
    ...(ctx.ui.tabs.enabled() ? ctx.ui.tabs.list().map(tab => tab.sessionID) : []),
  ]);
}

export function normalizeEvent(event) {
  const data = event.data || {};
  if (event.type === 'form.created') return {
    type: 'question.asked', properties: data.form,
  };
  if (event.type === 'form.replied' || event.type === 'form.cancelled') return {
    type: 'question.replied', properties: { sessionID: data.sessionID, requestID: data.id },
  };
  const types = {
    'session.execution.started': 'session.status',
    'session.step.started': 'session.status',
    'session.retry.scheduled': 'session.status',
    'session.execution.succeeded': 'session.idle',
    'session.execution.interrupted': 'session.idle',
    'session.execution.failed': 'session.error',
  };
  const status = event.type === 'session.retry.scheduled' ? 'retry' : 'busy';
  if (types[event.type]) return {
    type: types[event.type], properties: { ...data, status: { type: status } },
  };
  return { type: event.type, properties: data };
}

export async function discoverTuiSessions(ctx, observed, tracker) {
  for (const id of attachedSessionIDs(ctx)) observed.add(id);
  const sessions = ctx.data.session.list().filter(session => !session.parentID && observed.has(session.id));
  // Cache status initializes sessions that were already running when the plugin loaded.
  for (const session of sessions) {
    const running = ctx.data.session.status(session.id) === 'running';
    if (!running || tracker.state(session.id) === 'idle') tracker.event({
      type: 'session.status', properties: { sessionID: session.id, status: { type: running ? 'busy' : 'idle' } },
    });
  }
  return sessions.map(session => ({
    id: session.id, title: session.title,
    state: tracker.state(session.id), updated: session.time.updated,
  }));
}

export function selectTuiSession(ctx, _directory, sessionID) {
  if (ctx.ui.tabs.enabled()) {
    if (ctx.ui.tabs.focus(sessionID) === false) throw new Error('OpenCode rejected session selection');
  }
  else ctx.ui.router.navigate({ type: 'session', sessionID });
}

export default {
  id: 'tmux-opencoder.cli',
  async setup(ctx) {
    const observed = new Set();
    const directory = (ctx.location ?? ctx.data.location.default()).directory;
    const hooks = await tmuxOpencoder({
      client: ctx, directory,
      discover: (_client, _directory, _observed, _screen, tracker) =>
        discoverTuiSessions(ctx, observed, tracker),
      select: selectTuiSession,
    });
    if (!hooks.dispose) return;
    let stop;
    try {
      stop = ctx.data.listen(({ details }) => {
        for (const id of attachedSessionIDs(ctx)) observed.add(id);
        const id = details.data?.sessionID || details.data?.form?.sessionID;
        if (!id || !observed.has(ctx.data.session.root(id))) return;
        if (details.type === 'session.execution.started') void hooks['chat.message']({ sessionID: id });
        void hooks.event({ event: normalizeEvent(details) });
        if (details.type === 'session.deleted') observed.delete(id);
      });
    } catch (error) {
      await hooks.dispose();
      throw error;
    }
    return async () => { stop(); await hooks.dispose(); };
  },
};
