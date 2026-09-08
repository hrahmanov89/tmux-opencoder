const priority = ['needs input', 'error', 'working', 'retrying', 'idle'];

// Each session keeps its own lifecycle: a child going idle cannot idle its parent.
export function createTracker() {
  const sessions = new Map();
  function get(id) {
    if (!sessions.has(id)) sessions.set(id, { state: 'idle', pending: new Set() });
    return sessions.get(id);
  }
  return {
    state() {
      const states = [...sessions.values()].map(s => s.pending.size ? 'needs input' : s.state);
      return priority.find(state => states.includes(state)) || 'idle';
    },
    prompt(id) {
      // A new user turn acknowledges errors from the previous turn.
      for (const s of sessions.values()) if (s.state === 'error') s.state = 'idle';
      if (id) get(id).state = 'working';
    },
    event(event) {
      const p = event.properties || {};
      const id = p.sessionID || p.info?.id;
      if (!id) return;
      if (event.type === 'session.deleted') { sessions.delete(id); return; }
      const s = get(id);
      if (event.type === 'session.status') {
        const state = { busy: 'working', retry: 'retrying', idle: 'idle' }[p.status?.type];
        if (state && !(state === 'idle' && s.state === 'error')) s.state = state;
        if (state === 'idle') s.pending.clear();
      } else if (event.type === 'session.idle') {
        if (s.state !== 'error') s.state = 'idle';
        s.pending.clear();
      } else if (event.type === 'session.error') {
        s.state = 'error';
        s.pending.clear();
      } else if (/^(permission|question)(\.v2)?\.asked$/.test(event.type)) {
        if (p.id) s.pending.add(`${event.type.split('.')[0]}:${p.id}`);
      } else if (/^(permission|question)(\.v2)?\.(replied|rejected)$/.test(event.type)) {
        s.pending.delete(`${event.type.split('.')[0]}:${p.requestID}`);
      }
    },
  };
}
