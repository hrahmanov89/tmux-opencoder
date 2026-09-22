import { mkdir, readFile, writeFile, copyFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { shellQuote } from './tmux-opencoder.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const configHome = process.env.XDG_CONFIG_HOME || join(homedir(), '.config');
const tpm = process.argv[2] === '--tpm';
const config = tpm ? undefined : process.argv[2];
const bindKey = process.argv[3] || 'O';
if (!tpm && !config) throw new Error('Usage: node bin/install.mjs /absolute/path/to/tmux.conf [KEY] | --tpm [KEY]');
const tmuxConfig = config ? resolve(config) : undefined;
const original = tmuxConfig ? await readFile(tmuxConfig, 'utf8') : '';
const pluginDir = join(configHome, 'opencode', 'plugins');
const pluginPath = join(pluginDir, 'tmux-opencoder.js');
const marker = '// Managed by tmux-opencoder installer';
const wrapper = `${marker}\nimport _plugin from ${JSON.stringify(pathToFileURL(join(root, 'plugin/tmux-opencoder.mjs')).href)};\nexport const tmuxOpencoder = _plugin;\n`;
let previous;
try { previous = await readFile(pluginPath, 'utf8'); }
catch (error) { if (error.code !== 'ENOENT') throw error; }
if (previous && !previous.startsWith(marker)) throw new Error(`Refusing to replace ${pluginPath}`);
for (const tool of ['tmux', 'fzf']) {
  const check = spawnSync(tool, [tool === 'tmux' ? '-V' : '--version']);
  if (check.status !== 0) throw new Error(`${tool} must be installed and on PATH`);
}
const helper = join(root, 'bin/tmux-opencoder.mjs');
const command = [process.execPath, helper, 'configure', '--bind', bindKey].map(shellQuote).join(' ');
const line = `run-shell ${JSON.stringify(command)}`;
const begin = '# BEGIN tmux-opencoder';
const end = '# END tmux-opencoder';
const block = `${begin}\n${line}\n${end}`;
if (tmuxConfig && original.includes(begin) && !original.includes(block)) {
  throw new Error('Existing tmux-opencoder block differs; update/remove it manually before reinstalling');
}
await mkdir(pluginDir, { recursive: true });
await writeFile(pluginPath, wrapper);
if (tmuxConfig && !original.includes(block)) {
  const backup = `${tmuxConfig}.opencoder-backup-${Date.now()}`;
  await copyFile(tmuxConfig, backup);
  await writeFile(tmuxConfig, `${original.trimEnd()}\n\n${block}\n`);
  console.log(`Backed up tmux config: ${backup}`);
}
if (process.env.TMUX) {
  const result = spawnSync(process.execPath, [helper, 'configure', '--bind', bindKey], { stdio: 'inherit' });
  if (result.status !== 0) throw new Error('Files installed; live tmux configuration failed');
}
console.log(`Installed plugin: ${pluginPath}\nRestart OpenCode instances. Open picker with prefix + ${bindKey}.`);
