#!/usr/bin/env node
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createConnection, createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import { basename, resolve } from 'node:path';

const helperPath = fileURLToPath(import.meta.url);
const states = ['needs input', 'error', 'working', 'retrying', 'idle', 'offline'];
const paneFormat = '#{session_id}\t#{window_id}\t#{pane_id}\t#{window_index}.#{pane_index}\t#{@opencode_state}';
const summaryIcon = '\uf108';
export const borderSuffix = '#{?@opencode_status, [#{@opencode_status}],}';

export function statusColor(state) {
  return state === 'working' ? 'yellow' : state === 'idle' ? 'green' : 'red';
}

export function sanitize(value) {
  return String(value).replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, ' ');
}

export function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

export function socketFromTmux(value = '') {
  const match = /^(.*),[^,]+,[^,]+$/.exec(value);
  return match?.[1] || undefined;
}

export function parseArgs(args, env = process.env) {
  const result = { socket: socketFromTmux(env.TMUX), positional: [] };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--header') result.header = true;
    else     if (['--socket', '--client', '--session', '--window', '--bind'].includes(arg)) {
      if (!args[i + 1] || args[i + 1].startsWith('--')) throw new Error(`Missing value for ${arg}`);
      result[arg.slice(2)] = args[++i];
    } else if (arg.startsWith('--')) {
      throw new Error(`Unknown option: ${arg}`);
    } else result.positional.push(arg);
  }
  return result;
}

export function pidAlive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) { return error.code === 'EPERM'; }
}

export function normalizeState(raw, now = Date.now(), alive = pidAlive) {
  let value;
  try { value = JSON.parse(raw); } catch { return null; }
  if (!value || value.version !== 1 || !Number.isSafeInteger(value.pid) || value.pid <= 0
      || !Number.isFinite(value.updated) || value.updated < 0
      || !states.includes(value.state) || typeof value.project !== 'string') return null;
  return {
    ...value,
    project: sanitize(value.project),
    state: now - value.updated > 20_000 || !alive(value.pid) ? 'offline' : value.state,
  };
}

export function parsePaneRows(text, now = Date.now(), alive = pidAlive) {
  const rows = [];
  for (const line of text.split('\n')) {
    const match = /^(\$\d+)\t(@\d+)\t(%\d+)\t(\d+\.\d+)\t(.*)$/.exec(line);
    if (!match) continue;
    const [, session, window, pane, index, raw] = match;
    const state = normalizeState(raw, now, alive);
    if (state) rows.push({ ...state, session, window, pane, index, raw });
  }
  return rows;
}

const sessionsPaneFormat = '#{session_id}\t#{window_id}\t#{pane_id}\t#{window_index}.#{pane_index}\t#{@opencode_sessions}';

export function parseSessionRows(text, now = Date.now(), alive = pidAlive) {
  const rows = [];
  const seen = new Set();
  for (const line of text.split('\n')) {
    const match = /^(\$\d+)\t(@\d+)\t(%\d+)\t(\d+\.\d+)\t(.*)$/.exec(line);
    if (!match) continue;
    const [, tmuxSession, window, pane, index, raw] = match;
    if (!raw) continue;
    try {
      const data = JSON.parse(raw);
      if (!data || data.version !== 1 || !Number.isSafeInteger(data.pid) || data.pid <= 0
          || !Number.isFinite(data.updated) || typeof data.project !== 'string'
          || typeof data.control?.path !== 'string' || typeof data.control?.token !== 'string'
          || !Array.isArray(data.sessions)) continue;
      const offline = now - data.updated > 20_000 || !alive(data.pid);
      const common = {
        session: tmuxSession,
        window,
        pane,
        index,
        project: sanitize(basename(data.project) || data.project),
        pid: data.pid,
        controlPath: data.control.path,
        controlToken: data.control.token,
      };
      for (const s of data.sessions) {
        if (typeof s.id !== 'string' || typeof s.title !== 'string' || !states.includes(s.state)) continue;
        const key = `${pane}\0${s.id}`;
        if (seen.has(key)) continue;
        seen.add(key);
        rows.push({
          ...common,
          sessionID: s.id,
          title: sanitize(s.title),
          state: offline ? 'offline' : s.state,
          updated: s.updated,
        });
      }
    } catch { continue; }
  }
  return rows;
}

export function sessionListText(rows, includeHeader = false) {
  const sorted = rows.toSorted((a, b) => states.indexOf(a.state) - states.indexOf(b.state));
  const headings = ['STATE', 'SESSION', 'FOLDER', 'TITLE'];
  const columns = sorted.map(row => [row.state, sanitize(row.sessionID),
    sanitize(row.project), sanitize(row.title)]);
  const widths = headings.map((heading, i) => Math.max(heading.length, ...columns.map(row => row[i].length)));
  const format = row => row.map((value, i) => i === 3 ? value : value.padEnd(widths[i])).join('  ');
  const lines = sorted.map((row, i) => [row.session, row.window, row.pane, row.sessionID,
    row.controlPath, row.controlToken, format(columns[i])].join('\t'));
  if (includeHeader) lines.unshift(`\t\t\t\t\t\t${format(headings)}`);
  return lines.join('\n');
}

export function selectOpenCodeSession(row, timeout = 2000) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let response = '';
    const finish = error => {
      if (settled) return;
      settled = true;
      connection.destroy();
      error ? reject(error) : resolve();
    };
    const connection = createConnection(row.controlPath);
    connection.setEncoding('utf8');
    connection.setTimeout(timeout, () => finish(new Error('OpenCode session selection timed out')));
    connection.once('error', finish);
    connection.on('data', chunk => {
      response += chunk;
      const newline = response.indexOf('\n');
      if (newline < 0) return;
      try {
        const result = JSON.parse(response.slice(0, newline));
        finish(result.ok ? undefined : new Error(result.error || 'OpenCode session selection failed'));
      } catch {
        finish(new Error('Invalid response from OpenCode plugin'));
      }
    });
    connection.once('connect', () => {
      connection.write(`${JSON.stringify({ token: row.controlToken, sessionID: row.sessionID })}\n`);
    });
  });
}

export function listText(rows, includeHeader = false) {
  const sorted = rows.toSorted((a, b) => states.indexOf(a.state) - states.indexOf(b.state));
  const headings = ['STATE', 'SESSION', 'WINDOW:PANE', 'PROJECT'];
  const columns = sorted.map(row => [row.state, sanitize(row.sessionName),
    `${sanitize(row.windowName)}:${row.index.split('.')[1]}`, sanitize(row.project)]);
  const widths = headings.map((heading, i) => Math.max(heading.length, ...columns.map(row => row[i].length)));
  const format = row => row.map((value, i) => i === 3 ? value : value.padEnd(widths[i])).join('  ');
  const lines = sorted.map((row, i) => [row.session, row.window, row.pane, format(columns[i])].join('\t'));
  if (includeHeader) lines.unshift(`\t\t\t${format(headings)}`);
  return lines.join('\n');
}

export function summaryText(rows, colored = false) {
  const unique = [...new Map(rows.map(row => [row.pane, row])).values()];
  const counts = states.map(state => [state, unique.filter(row => row.state === state).length]);
  return unique.length ? `${summaryIcon} ${counts.filter(([, count]) => count).map(([state, count]) => {
    const value = `${state}:${count}`;
    return colored ? `#[fg=${statusColor(state)}]${value}#[default]` : value;
  }).join(' | ')}` : '';
}

export function resolveSelection(rows, pane, session, window) {
  return rows.find(row => row.pane === pane && row.session === session && row.window === window)
    || rows.find(row => row.pane === pane && row.session === session)
    || rows.find(row => row.pane === pane);
}

export function configureFormats(status, border, summaryCommand) {
  const prefix = `#(${summaryCommand})`;
  return {
    status: status.includes(prefix) ? status : `${prefix}${status ? ` ${status}` : ''}`,
    border: border.includes(borderSuffix) ? border : `${border}${borderSuffix}`,
  };
}

function tmuxRunner(socket) {
  return (args, optional = false) => {
    const result = spawnSync('tmux', [...(socket ? ['-S', socket] : []), ...args], { encoding: 'utf8' });
    if (result.error || result.status !== 0) {
      if (optional === true || (optional === 'no-server' && /no server running|(?:error|failed) connecting to .*[:(] ?(?:No such file or directory|Connection refused)/i.test(result.stderr || ''))) return null;
      throw result.error || new Error(result.stderr.trim() || `tmux ${args[0]} failed`);
    }
    return result.stdout.replace(/\n$/, '');
  };
}

function commandLine(options, command, extra = []) {
  return [process.execPath, helperPath, ...(options.socket ? ['--socket', options.socket] : []), command, ...extra]
    .map(shellQuote).join(' ');
}

export function staleStatusCommand(row) {
  // Escape tmux format delimiters, not shell syntax. Compare inside the server
  // immediately before writing so a newer heartbeat invalidates this snapshot.
  const expected = row.raw.replace(/[#},]/g, char => `#${char}`);
  return ['if-shell', '-F', '-t', row.pane, `#{==:#{@opencode_state},${expected}}`,
    `set-option -p -t ${row.pane} @opencode_status offline`];
}

function readPanes(tmux, summary = false) {
  const text = tmux(['list-panes', '-a', '-F', paneFormat], summary ? 'no-server' : false);
  if (text === null) return [];
  const rows = parsePaneRows(text);
  // Linked windows appear in multiple sessions, but share pane options.
  for (const row of new Map(rows.map(row => [row.pane, row])).values()) {
    if (row.state === 'offline' && JSON.parse(row.raw).state !== 'offline') {
      tmux(staleStatusCommand(row), true);
    }
  }
  if (!summary) {
    const names = new Map();
    for (const row of rows) {
      for (const [id, field, format] of [[row.session, 'sessionName', '#{session_name}'],
        [row.window, 'windowName', '#{window_name}']]) {
        if (!names.has(id)) names.set(id, sanitize(tmux(['display-message', '-p', '-t', id, format], true) ?? ''));
        row[field] = names.get(id);
      }
    }
  }
  return rows;
}

function switchPane(tmux, options, pane) {
  if (!options.client) throw new Error('switch requires --client');
  if (!/^%\d+$/.test(pane || '')) throw new Error('switch requires a stable pane ID (%N)');
  // Re-resolve after a concurrent move; never fall back to a numeric pane index.
  for (let attempt = 0; attempt < 2; attempt++) {
    const rows = tmux(['list-panes', '-a', '-F', '#{session_id}\t#{window_id}\t#{pane_id}'])
      .split('\n').map(line => {
        const [session, window, pane] = line.split('\t');
        return { session, window, pane };
      });
    const row = resolveSelection(rows, pane, options.session, options.window);
    if (!row) throw new Error(`Pane ${pane} no longer exists`);
    if (tmux(['select-window', '-t', `${row.session}:${row.window}`], true) === null) continue;
    tmux(['if-shell', '-F', '-t', row.pane, '#{&&:#{window_zoomed_flag},#{!:#{pane_active}}}',
      `resize-pane -Z -t ${row.pane}`], true);
    if (tmux(['select-pane', '-t', row.pane], true) === null) continue;
    const location = tmux(['display-message', '-p', '-t', row.pane, '#{window_id}'], true);
    if (location !== row.window) continue;
    tmux(['switch-client', '-c', options.client, '-t', row.session]);
    return;
  }
  throw new Error(`Pane ${pane} moved or disappeared; refresh and try again`);
}

async function picker(tmux, options) {
  if (!options.client) throw new Error('picker requires --client');
  const input = sessionListText(readSessions(tmux), true);
  const reload = commandLine(options, 'sessions', ['--header']);
  // Let the OS choose a local port. fzf rejects a race for that port safely.
  const server = createServer();
  await new Promise((yes, no) => { server.once('error', no); server.listen(0, '127.0.0.1', yes); });
  const port = server.address().port;
  await new Promise(yes => server.close(yes));
  const key = randomBytes(32).toString('hex');
  const child = spawn('fzf', [
    '--delimiter=\t', '--with-nth=7..', '--header-lines=1', '--no-sort', '--track',
    '--layout=reverse', '--no-preview', '--border=none',
    '--header=OpenCode | Ctrl-R refresh | Esc cancel',
    '--bind', `ctrl-r:reload(${reload})`, `--listen=127.0.0.1:${port}`,
  ], { env: { ...process.env, FZF_API_KEY: key }, stdio: ['pipe', 'pipe', 'inherit'] });
  let output = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', chunk => { output += chunk; });
  child.stdin.on('error', () => {});
  child.stdin.end(input ? `${input}\n` : '');
  // Reload leaves fzf's current query intact, unlike restarting the picker.
  let code;
  code = await new Promise((yes, no) => { child.once('error', no); child.once('close', yes); });
  if (code === 1 || code === 130) return;
  if (code !== 0) throw new Error(`fzf exited with status ${code}`);
  const [session, window, pane, sessionID, controlPath, controlToken] = output.trimEnd().split('\t');
  if (!/^\$\d+$/.test(session) || !/^@\d+$/.test(window) || !/^%\d+$/.test(pane)
      || !sessionID || !controlPath || !controlToken) throw new Error('Invalid picker selection');
  await selectOpenCodeSession({ sessionID, controlPath, controlToken });
  switchPane(tmux, { ...options, session, window }, pane);
}

function configure(tmux, options) {
  const bindKey = options.bind || 'O';
  const socket = options.socket || socketFromTmux(process.env.TMUX);
  // display-popup doesn't expand #{client_name} format variables.
  // Inside the popup shell, $TMUX contains the socket path. Use list-clients
  // to find the client that owns the original session.
  const helperCmd = [
    shellQuote(process.execPath), shellQuote(helperPath),
    ...(socket ? ['--socket', shellQuote(socket)] : []),
    'picker',
  ].join(' ');
  const clientScript = `SOCKET=$(echo "$TMUX" | cut -d, -f1); ` +
    `client=$(tmux -S "$SOCKET" list-clients -F '#{client_name}' | head -1) && ` +
    `${helperCmd} --client "$client"`;
  const owner = `tmux-opencoder:${helperPath}`;
  const binding = tmux(['list-keys', '-T', 'prefix', '-F', '#{key_string}\t#{key_note}']).split('\n')
    .find(line => line.startsWith(`${bindKey}\t`));
  // A note marks ownership; mentioning our path in a foreign command is not enough.
  if (!binding || binding === `${bindKey}\t${owner}`) {
    tmux(['bind-key', '-T', 'prefix', '-N', owner, bindKey, 'display-popup',
      '-B', '-w', '90%', '-h', '45%', '-E', 'sh', '-c', clientScript]);
  }
  const status = tmux(['show-options', '-g', '-v', 'status-right']);
  const border = tmux(['show-options', '-g', '-v', 'pane-border-format']);
  const formats = configureFormats(status, border, commandLine(options, 'summary'));
  if (formats.status !== status) tmux(['set-option', '-g', 'status-right', formats.status]);
  if (formats.border !== border) tmux(['set-option', '-g', 'pane-border-format', formats.border]);
}

function readSessions(tmux) {
  const text = tmux(['list-panes', '-a', '-F', sessionsPaneFormat], false);
  if (text === null) return [];
  return parseSessionRows(text);
}

export async function main(args = process.argv.slice(2), env = process.env) {
  const options = parseArgs(args, env);
  const [command, pane] = options.positional;
  const tmux = tmuxRunner(options.socket);
  switch (command) {
    case 'list': {
      const text = listText(readPanes(tmux), options.header);
      if (text) process.stdout.write(`${text}\n`);
      break;
    }
    case 'sessions': {
      const text = sessionListText(readSessions(tmux), options.header);
      if (text) process.stdout.write(`${text}\n`);
      break;
    }
    case 'summary': process.stdout.write(summaryText(readPanes(tmux, true), true)); break;
    case 'preview': {
      if (!/^%\d+$/.test(pane || '')) throw new Error('preview requires a stable pane ID (%N)');
      const text = tmux(['capture-pane', '-p', '-t', pane, '-S', '-100'], true);
      process.stdout.write(text === null ? `Pane ${pane} no longer exists\n` : `${text.split('\n').slice(-100).join('\n')}\n`);
      break;
    }
    case 'switch': switchPane(tmux, options, pane); break;
    case 'picker': await picker(tmux, options); break;
    case 'popup':
      if (!options.client) throw new Error('popup requires --client');
      tmux(['display-popup', '-B', '-c', options.client, '-w', '90%', '-h', '45%', '-E',
        commandLine(options, 'picker', ['--client', options.client])]);
      break;
    case 'configure': configure(tmux, options); break;
    default: throw new Error('Usage: node tmux-opencoder.mjs [--socket PATH] list|sessions|summary|preview %N|switch %N --client CLIENT [--session $N --window @N]|picker --client CLIENT|popup --client CLIENT|configure');
  }
}

if (process.argv[1] && resolve(process.argv[1]) === helperPath) {
  main().catch(error => { process.stderr.write(`tmux-opencoder: ${error.message}\n`); process.exitCode = 1; });
}
