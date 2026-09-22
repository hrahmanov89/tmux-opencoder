import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const installer = fileURLToPath(new URL('../bin/install.mjs', import.meta.url));

test('TPM mode installs OpenCode wrapper without editing tmux config', () => {
  const dir = mkdtempSync(join(tmpdir(), 'opencoder-install-'));
  try {
    const result = spawnSync(process.execPath, [installer, '--tpm', 'S'], {
      encoding: 'utf8',
      env: { ...process.env, XDG_CONFIG_HOME: dir, TMUX: '' },
    });
    assert.equal(result.status, 0, result.stderr);
    const wrapper = readFileSync(join(dir, 'opencode/plugins/tmux-opencoder.js'), 'utf8');
    assert.match(wrapper, /Managed by tmux-opencoder installer/);
    assert.match(wrapper, /plugin\/tmux-opencoder\.mjs/);
    assert.match(result.stdout, /prefix \+ S/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
