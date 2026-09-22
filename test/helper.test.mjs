import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  sanitize, shellQuote, socketFromTmux, parseArgs, normalizeState, parsePaneRows,
  listText, summaryText, resolveSelection, configureFormats, borderSuffix, staleStatusCommand,
  statusColor, parseSessionRows, sessionListText, selectOpenCodeSession,
} from '../bin/tmux-opencoder.mjs';

const helper = fileURLToPath(new URL('../bin/tmux-opencoder.mjs', import.meta.url));
const state = (changes = {}) => JSON.stringify({ version: 1, pid: process.pid,
  updated: Date.now(), state: 'working', project: 'demo', ...changes });
const sessionState = (changes = {}) => JSON.stringify({ version: 1, pid: process.pid,
  updated: Date.now(), project: '/repos/demo', state: 'working',
  control: { path: '/tmp/control.sock', token: 'secret' },
  sessions: [
    { id: 'ses_working', title: 'Working session', state: 'working', updated: Date.now() },
    { id: 'ses_retry', title: 'Retrying session', state: 'retrying', updated: Date.now() },
    { id: 'ses_idle', title: 'Idle session', state: 'idle', updated: Date.now() },
  ], ...changes });

test('socket parsing preserves commas; explicit socket wins', () => {
  assert.equal(socketFromTmux('/tmp/a,b,123,4'), '/tmp/a,b');
  assert.equal(socketFromTmux('invalid'), undefined);
  assert.equal(parseArgs(['--socket', '/tmp/explicit', 'list'], { TMUX: '/tmp/other,1,0' }).socket, '/tmp/explicit');
  assert.throws(() => parseArgs(['--client']), /Missing value/);
  assert.throws(() => parseArgs(['--bad']), /Unknown option/);
});

test('status colors map working, idle and attention states', () => {
  assert.equal(statusColor('working'), 'yellow');
  assert.equal(statusColor('idle'), 'green');
  assert.equal(statusColor('error'), 'red');
  assert.equal(statusColor('needs input'), 'red');
});

test('display sanitization and shell quoting', () => {
  assert.equal(sanitize('a\tb\nc\r\x1b\x7f\x9b\u2028d'), 'a b c     d');
  const value = "a ' $HOME ; $(false)";
  assert.equal(spawnSync('/bin/sh', ['-c', `printf %s ${shellQuote(value)}`], { encoding: 'utf8' }).stdout, value);
});

test('protocol validation, heartbeat threshold and dead processes', () => {
  for (const raw of ['', '{', 'null', '[]', state({ version: 2 }), state({ pid: -1 }),
    state({ pid: 1.5 }), state({ updated: '1' }), state({ state: 'unknown' }), state({ project: null })]) {
    assert.equal(normalizeState(raw), null, raw);
  }
  assert.equal(normalizeState(state({ updated: 1000 }), 21000, () => true).state, 'working');
  assert.equal(normalizeState(state({ updated: 1000 }), 21001, () => true).state, 'offline');
  assert.equal(normalizeState(state({ updated: 1000 }), 1001, () => false).state, 'offline');
  for (const status of ['working', 'needs input', 'retrying', 'idle', 'error', 'offline']) {
    assert.equal(normalizeState(state({ state: status })).state, status);
  }
});

test('list hides stable IDs in first three columns; linked panes count once', () => {
  const raw = state({ project: 'demo\tbad\nname' });
  const rows = parsePaneRows(`$0\t@1\t%2\t0.1\t${raw}\n$1\t@1\t%2\t2.1\t${raw}\n$0\t@2\t%3\t1.0\tbroken`);
  rows.forEach((row, i) => { row.sessionName = `project-${i}`; row.windowName = 'editor'; });
  assert.equal(rows.length, 2);
  assert.equal(listText(rows).split('\n')[0], '$0\t@1\t%2\tworking  project-0  editor:1     demo bad name');
  assert.equal(summaryText(rows), '\uf108 working:1');
  assert.equal(summaryText([]), '');
  assert.equal(resolveSelection(rows, '%2', '$1', '@1'), rows[1]);
  assert.equal(resolveSelection(rows, '%2', '$1', '@9'), rows[1]);
  assert.equal(resolveSelection(rows, '%2', '$9', '@9'), rows[0]);
  assert.equal(resolveSelection(rows, '%99'), undefined);
});

test('table sorts by urgency without mutating rows; headers align and names are searchable', () => {
  const order = ['needs input', 'error', 'working', 'retrying', 'idle', 'offline'];
  const rows = order.toReversed().map((state, i) => ({ state, session: `$${i}`, window: `@${i}`,
    pane: `%${i}`, index: '0.1', sessionName: 'actual-folder-name\t\n', windowName: 'editor\tname', project: '/elsewhere' }));
  const text = listText(rows, true);
  const lines = text.split('\n');
  assert.equal(lines.length, 7);
  const headings = lines.shift().split('\t')[3];
  assert.match(headings, /^STATE\s+SESSION\s+WINDOW:PANE\s+PROJECT$/);
  lines.forEach((line, i) => {
    const fields = line.split('\t');
    assert.equal(fields.length, 4);
    assert.equal(fields[2], `%${5 - i}`);
    assert.ok(fields[3].startsWith(order[i]));
    assert.equal(fields[3].indexOf('actual-folder-name'), headings.indexOf('SESSION'));
    assert.equal(fields[3].indexOf('editor name:1'), headings.indexOf('WINDOW:PANE'));
    assert.equal(fields[3].indexOf('/elsewhere'), headings.indexOf('PROJECT'));
  });
  assert.equal(rows[0].state, 'offline');
  if (spawnSync('fzf', ['--version']).status === 0) {
    const result = spawnSync('fzf', ['--delimiter=\t', '--with-nth=4..', '--filter=actual-folder-name'], {
      input: listText(rows), encoding: 'utf8', env: { ...process.env, FZF_DEFAULT_OPTS: '', FZF_DEFAULT_OPTS_FILE: '' },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trimEnd().split('\n').length, 6);
  }
});

test('session rows render working and idle roots once per linked pane', () => {
  const snapshot = sessionState();
  const rows = parseSessionRows(`$0\t@1\t%2\t0.1\t${snapshot}\n$1\t@1\t%2\t2.1\t${snapshot}`, Date.now(), () => true);
  assert.equal(rows.length, 3);
  assert.deepEqual(rows.map(row => [row.sessionID, row.state]), [
    ['ses_working', 'working'], ['ses_retry', 'retrying'], ['ses_idle', 'idle'],
  ]);
  const lines = sessionListText(rows, true).split('\n');
  assert.match(lines[0].split('\t')[6], /^STATE\s+SESSION\s+FOLDER\s+TITLE$/);
  assert.match(lines[1], /demo/);
  assert.doesNotMatch(lines[1], /\/repos\/demo/);
  assert.match(lines[1], /ses_working.*Working session/);
  assert.match(lines[2], /ses_retry.*Retrying session/);
  assert.match(lines[3], /ses_idle.*Idle session/);
});

test('session selection sends exact ID and reports plugin rejection', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'opencoder-control-'));
  const path = join(dir, 'control.sock');
  const requests = [];
  const server = createServer(connection => {
    connection.setEncoding('utf8');
    connection.once('data', chunk => {
      const request = JSON.parse(chunk.trim());
      requests.push(request);
      connection.end(`${JSON.stringify(request.token === 'secret' ? { ok: true } : { ok: false, error: 'denied' })}\n`);
    });
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(path, resolve); });
  try {
    await selectOpenCodeSession({ controlPath: path, controlToken: 'secret', sessionID: 'ses_idle' });
    assert.deepEqual(requests[0], { token: 'secret', sessionID: 'ses_idle' });
    await assert.rejects(
      selectOpenCodeSession({ controlPath: path, controlToken: 'wrong', sessionID: 'ses_working' }),
      /denied/,
    );
  } finally {
    await new Promise(resolve => server.close(resolve));
    rmSync(dir, { recursive: true, force: true });
  }
});

test('format updates preserve theme and continuum, idempotently', () => {
  const original = '#[fg=red]clock #{continuum_status} #(continuum_save.sh)';
  const first = configureFormats(original, '#{pane_index}', "'/absolute/node' '/helper' summary");
  assert.ok(first.status.endsWith(original));
  assert.equal(first.border, `#{pane_index}${borderSuffix}`);
  assert.deepEqual(configureFormats(first.status, first.border, "'/absolute/node' '/helper' summary"), first);
});

test('isolated tmux integration', async t => {
  if (spawnSync('tmux', ['-V']).status !== 0) return t.skip('tmux unavailable');
  const dir = mkdtempSync(join(tmpdir(), 'opencoder-test-'));
  const socket = join(dir, 'tmux.sock');
  const env = { ...process.env, TMUX: '', TMUX_PANE: '' };
  function tmux(...args) {
    const result = spawnSync('tmux', ['-S', socket, ...args], { encoding: 'utf8', env });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trimEnd();
  }
  function cli(...args) {
    return spawnSync(process.execPath, [helper, '--socket', socket, ...args], { encoding: 'utf8', env });
  }
  const bindingText = () => tmux('list-keys', '-T', 'prefix').split('\n')
    .find(line => /^bind-key\s+(?:-\S+\s+)*-T prefix\s+O\s/.test(line));
  const clientValue = (client, format) => tmux('list-clients', '-F', `#{client_name}\t${format}`)
    .split('\n').find(line => line.startsWith(`${client}\t`))?.split('\t')[1];
  async function waitFor(check, timeout = 4000) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      if (check()) return;
      await new Promise(yes => setTimeout(yes, 100));
    }
    assert.fail('Timed out waiting for tmux/fzf');
  }
  const clients = [];
  async function attach(session) {
    const before = tmux('list-clients', '-F', '#{client_name}').split('\n');
    const client = spawn('tmux', ['-S', socket, '-C', 'attach-session', '-t', session],
      { env, stdio: ['pipe', 'pipe', 'pipe'] });
    clients.push(client);
    client.stdout.resume();
    client.stderr.resume();
    let name;
    await waitFor(() => {
      name = tmux('list-clients', '-F', '#{client_name}').split('\n').find(value => value && !before.includes(value));
      return name;
    });
    return name;
  }
  try {
    await t.test('summary without a tmux server is silent success', () => {
      const result = cli('summary');
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stdout, '');
      assert.equal(result.stderr, '');
    });
    tmux('-f', '/dev/null', 'new-session', '-d', '-s', 'one', '-x', '100', '-y', '30', 'sleep 120');
    const pane = tmux('display-message', '-p', '-t', 'one', '#{pane_id}');
    const window = tmux('display-message', '-p', '-t', 'one', '#{window_id}');
    const session = tmux('display-message', '-p', '-t', 'one', '#{session_id}');
    await t.test('lists fresh state, sanitizes project, derives socket', () => {
      tmux('set-option', '-p', '-t', pane, '@opencode_state', state({ project: 'hello\tworld\n!' }));
      tmux('set-option', '-p', '-t', pane, '@opencode_status', 'plugin-owned');
      tmux('rename-window', '-t', window, 'editor');
      const result = cli('list');
      assert.equal(result.status, 0, result.stderr);
      assert.deepEqual(result.stdout.split('\t').slice(0, 3), [session, window, pane]);
      assert.match(result.stdout.split('\t')[3], /^working +one +editor:0 +hello world !\n$/);
      assert.equal(tmux('show-options', '-p', '-v', '-t', pane, '@opencode_status'), 'plugin-owned');
      const derived = spawnSync(process.execPath, [helper, 'summary'], {
        encoding: 'utf8', env: { ...env, TMUX: `${socket},123,0` },
      });
      assert.equal(derived.stdout, '\uf108 #[fg=yellow]working:1#[default]');
    });
    await t.test('stale and dead PID states update border; malformed ignored', () => {
      tmux('set-option', '-p', '-t', pane, '@opencode_state', state({ updated: Date.now() - 21000 }));
      assert.equal(cli('summary').stdout, '\uf108 #[fg=red]offline:1#[default]');
      assert.equal(tmux('show-options', '-p', '-v', '-t', pane, '@opencode_status'), 'offline');
      tmux('set-option', '-p', '-t', pane, '@opencode_state', state({ pid: 2147483647 }));
      assert.match(cli('list').stdout, /\toffline +/);
      tmux('set-option', '-p', '-t', pane, '@opencode_state', '{broken');
      assert.equal(cli('list').stdout, '');
      tmux('set-option', '-p', '-t', pane, '@opencode_state', state());
    });
    await t.test('stale write compares exact snapshot and never replaces a newer heartbeat', () => {
      const raw = state({ updated: Date.now() - 21000, project: 'commas, braces } #{pane_id} "quotes"\t\n' });
      const row = parsePaneRows(`${session}\t${window}\t${pane}\t0.0\t${raw}`)[0];
      const command = staleStatusCommand(row);
      tmux('set-option', '-p', '-t', pane, '@opencode_state', raw);
      tmux('set-option', '-p', '-t', pane, '@opencode_status', 'working');
      tmux(...command);
      assert.equal(tmux('show-options', '-p', '-v', '-t', pane, '@opencode_status'), 'offline');
      tmux('set-option', '-p', '-t', pane, '@opencode_state', state({ state: 'needs input' }));
      tmux('set-option', '-p', '-t', pane, '@opencode_status', 'needs input');
      tmux(...command);
      assert.equal(tmux('show-options', '-p', '-v', '-t', pane, '@opencode_status'), 'needs input');
      cli('list');
      cli('summary');
      assert.equal(tmux('show-options', '-p', '-v', '-t', pane, '@opencode_status'), 'needs input');
      tmux('set-option', '-p', '-t', pane, '@opencode_state', state());
    });
    await t.test('session and window names preserve spaces and quotes without breaking row boundaries', () => {
      try {
        tmux('rename-session', '-t', session, 'folder "with spaces"');
        tmux('rename-window', '-t', window, 'editor "with spaces"');
        const result = cli('list');
        assert.equal(result.status, 0, result.stderr);
        assert.equal(result.stdout.trimEnd().split('\n').length, 1);
        assert.equal(result.stdout.trimEnd().split('\t').length, 4);
        assert.match(result.stdout, /folder "with spaces"/);
        assert.match(result.stdout, /editor "with spaces":0/);
      } finally {
        tmux('rename-session', '-t', session, 'one');
        tmux('rename-window', '-t', window, 'editor');
      }
    });
    await t.test('linked windows retain session context without double counting', () => {
      tmux('new-session', '-d', '-s', 'two', 'sleep 120');
      tmux('link-window', '-s', `${session}:${window}`, '-t', 'two:5');
      const rows = cli('list').stdout.trimEnd().split('\n');
      assert.equal(rows.length, 2);
      assert.notEqual(rows[0].split('\t')[0], rows[1].split('\t')[0]);
      assert.match(rows[0], /working +one +editor:0/);
      assert.match(rows[1], /working +two +editor:0/);
      assert.equal(cli('summary').stdout, '\uf108 #[fg=yellow]working:1#[default]');
    });
    await t.test('configure preserves foreign binding, theme and border settings', () => {
      tmux('bind-key', '-T', 'prefix', 'O', 'display-message', 'foreign');
      const foreign = bindingText();
      assert.match(foreign, /foreign/);
      const theme = '#[fg=blue]theme #{continuum_status} #(continuum_save.sh)';
      tmux('set-option', '-g', 'status-right', theme);
      tmux('set-option', '-g', 'pane-border-format', '#{pane_index}');
      tmux('set-option', '-g', 'pane-border-status', 'off');
      assert.equal(cli('configure').status, 0);
      assert.equal(bindingText(), foreign);
      const status = tmux('show-options', '-g', '-v', 'status-right');
      const border = tmux('show-options', '-g', '-v', 'pane-border-format');
      assert.ok(status.endsWith(theme));
      assert.ok(status.includes(process.execPath));
      assert.equal(border, `#{pane_index}${borderSuffix}`);
      assert.equal(tmux('show-options', '-g', '-v', 'pane-border-status'), 'off');
      tmux('unbind-key', '-T', 'prefix', 'O');
      assert.equal(cli('configure').status, 0);
      const binding = bindingText();
      assert.ok(binding.includes(helper), binding);
      assert.ok(binding.includes(process.execPath));
      assert.ok(binding.includes('#{client_name}'));
      assert.match(binding, /-s bg=terminal/);
      tmux('set-option', '-g', 'pane-border-status', 'bottom');
      assert.equal(cli('configure').status, 0);
      assert.equal(bindingText(), binding);
      assert.equal(tmux('show-options', '-g', '-v', 'status-right'), status);
      assert.equal(tmux('show-options', '-g', '-v', 'pane-border-format'), border);
      assert.equal(tmux('show-options', '-g', '-v', 'pane-border-status'), 'bottom');
      tmux('bind-key', '-T', 'prefix', '-N', 'foreign', 'O', 'display-popup', '-E', `echo ${helper}`);
      const lookalike = bindingText();
      assert.equal(cli('configure').status, 0);
      assert.equal(bindingText(), lookalike);
    });
    await t.test('preview uses stable ID, bounds output, handles disappearance', async () => {
      const command = [process.execPath, '-e', 'for(let i=0;i<150;i++) console.log(`preview-line-${i}`); setTimeout(()=>{},120000)']
        .map(shellQuote).join(' ');
      const previewPane = tmux('new-window', '-d', '-t', 'one', '-P', '-F', '#{pane_id}', command);
      await waitFor(() => tmux('capture-pane', '-p', '-t', previewPane).includes('preview-line-149'));
      const result = cli('preview', previewPane);
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stdout.replace(/\n$/, '').split('\n').length, 100);
      assert.match(result.stdout, /preview-line-149/);
      assert.doesNotMatch(result.stdout, /preview-line-0\n/);
      tmux('kill-pane', '-t', previewPane);
      assert.match(cli('preview', previewPane).stdout, /no longer exists/);
      assert.match(cli('preview', '%999999').stdout, /no longer exists/);
      assert.notEqual(cli('preview', '0').status, 0);
      assert.match(cli('switch', pane).stderr, /requires --client/);
      assert.match(cli('switch', '%999999', '--client', 'missing').stderr, /no longer exists/);
      assert.match(cli('popup').stderr, /requires --client/);
      assert.match(cli('picker').stderr, /requires --client/);
    });
    const client = await attach('one');
    const other = await attach('one');
    await t.test('explicit client switches into selected linked session', () => {
      const two = tmux('display-message', '-p', '-t', 'two', '#{session_id}');
      const result = cli('switch', pane, '--client', client, '--session', two, '--window', window);
      assert.equal(result.status, 0, result.stderr);
      assert.equal(clientValue(client, '#{session_id}'), two);
      assert.equal(clientValue(other, '#{session_id}'), session);
      assert.equal(clientValue(client, '#{pane_id}'), pane);
    });
    await t.test('selection follows a moved pane, even with stale session/window IDs', () => {
      tmux('new-window', '-d', '-t', 'one', 'sleep 120');
      tmux('new-session', '-d', '-s', 'three', 'sleep 120');
      tmux('join-pane', '-d', '-s', pane, '-t', 'three:0');
      const result = cli('switch', pane, '--client', client, '--session', session, '--window', window);
      assert.equal(result.status, 0, result.stderr);
      assert.equal(clientValue(client, '#{session_name}'), 'three');
      assert.equal(clientValue(client, '#{pane_id}'), pane);
      assert.equal(clientValue(other, '#{session_id}'), session);
    });
    await t.test('switch unzooms another pane but retains zoom on the requested pane', () => {
      const otherPane = tmux('list-panes', '-t', 'three:0', '-F', '#{pane_id}').split('\n').find(id => id !== pane);
      tmux('resize-pane', '-Z', '-t', otherPane);
      assert.equal(tmux('display-message', '-p', '-t', pane, '#{window_zoomed_flag}:#{pane_active}'), '1:0');
      const result = cli('switch', pane, '--client', client);
      assert.equal(result.status, 0, result.stderr);
      assert.equal(tmux('display-message', '-p', '-t', pane, '#{window_zoomed_flag}:#{pane_active}'), '0:1');
      tmux('resize-pane', '-Z', '-t', pane);
      assert.equal(cli('switch', pane, '--client', client).status, 0);
      assert.equal(tmux('display-message', '-p', '-t', pane, '#{window_zoomed_flag}:#{pane_active}'), '1:1');
      tmux('resize-pane', '-Z', '-t', pane);
    });
    await t.test('live fzf refresh selects exact OpenCode session and pane', async t => {
      if (spawnSync('fzf', ['--version']).status !== 0) return t.skip('fzf unavailable');
      tmux('set-option', '-p', '-t', pane, '@opencode_state', state({ project: '/different-project' }));
      tmux('rename-session', '-t', 'three', 'needle-folder');
      const controlPath = join(dir, 'picker-control.sock');
      const selected = [];
      const control = createServer(connection => {
        connection.setEncoding('utf8');
        connection.once('data', chunk => {
          selected.push(JSON.parse(chunk.trim()).sessionID);
          connection.end(`${JSON.stringify({ ok: true })}\n`);
        });
      });
      await new Promise((resolve, reject) => { control.once('error', reject); control.listen(controlPath, resolve); });
      const sessions = currentState => sessionState({
        project: '/different-project', control: { path: controlPath, token: 'picker-secret' },
        sessions: [
          { id: 'ses_working', title: 'other session', state: 'working', updated: Date.now() },
          { id: 'ses_idle', title: 'needle session', state: currentState, updated: Date.now() },
        ],
      });
      tmux('set-option', '-p', '-t', pane, '@opencode_sessions', sessions('working'));
      tmux('resize-window', '-t', 'one', '-x', '180', '-y', '30');
      const command = [process.execPath, helper, '--socket', socket, 'picker', '--client', client].map(shellQuote).join(' ');
      const pickerPane = tmux('new-window', '-d', '-t', 'one', '-P', '-F', '#{pane_id}', command);
      const screen = () => tmux('capture-pane', '-p', '-t', pickerPane);
      try {
        tmux('resize-window', '-t', pickerPane, '-x', '180', '-y', '30');
        await waitFor(() => screen().includes('needle session'));
        assert.match(screen(), /STATE +SESSION +FOLDER +TITLE/);
        tmux('send-keys', '-t', pickerPane, '-l', 'needle');
        tmux('set-option', '-p', '-t', pane, '@opencode_sessions', sessions('idle'));
        tmux('send-keys', '-t', pickerPane, 'C-r');
        await waitFor(() => /idle/.test(screen()));
        assert.match(screen(), /> needle/);
        tmux('send-keys', '-t', pickerPane, 'Enter');
        await waitFor(() => selected.length === 1);
        await waitFor(() => !tmux('list-panes', '-a', '-F', '#{pane_id}').split('\n').includes(pickerPane));
        assert.deepEqual(selected, ['ses_idle']);
        assert.equal(clientValue(client, '#{pane_id}'), pane);
      } finally {
        await new Promise(resolve => control.close(resolve));
      }
    });
    await t.test('summary after server shutdown is silent success', () => {
      tmux('kill-server');
      const result = cli('summary');
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stdout, '');
      assert.equal(result.stderr, '');
    });
  } finally {
    for (const client of clients) client.kill();
    spawnSync('tmux', ['-S', socket, 'kill-server'], { env });
    rmSync(dir, { recursive: true, force: true });
  }
});
