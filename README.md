# tmux-opencoder

I vibecoded this to track the OpenCode instances I have open in tmux and to switch
between them without hunting through windows and panes.

It adds a searchable fzf popup showing current root OpenCode sessions, their status,
folder, and title. Select a session and tmux-opencoder switches the existing OpenCode
TUI to that exact session, then jumps to its pane.

```text
STATE    SESSION       FOLDER          TITLE
working  ses_abc123    api             Add authentication
idle     ses_def456    istio-adoption  Review migration plan
```

## Features

- Search sessions by status, ID, folder, or title.
- Track `working`, `idle`, and `retrying` session states, plus pane attention/offline status.
- Show root sessions only. Subagents and unrelated historical sessions stay hidden.
- Switch the existing OpenCode TUI instead of starting another process.
- Jump across tmux sessions, windows, and panes.
- Refresh with `Ctrl-R` without losing the current query.
- Keep existing tmux themes, status commands, and foreign key bindings intact.
- Show an instance summary in `status-right`.

Default key: `prefix + O`.

## Requirements

- Node.js 22+
- tmux 3.2+
- fzf 0.48+
- OpenCode
- Nerd Font or Font Awesome-compatible font for the status icon

## Install With TPM

Add this before the TPM initialization line in `.tmux.conf`:

```tmux
set -g @plugin 'tmux-plugins/tpm'
set -g @plugin 'hrahmanov89/tmux-opencoder'

run '~/.tmux/plugins/tpm/tpm'
```

Reload tmux, then press `prefix + I` to install plugins.

TPM installs the OpenCode plugin wrapper under `~/.config/opencode/plugins/` and
configures the picker in the current tmux server. Restart existing OpenCode processes
once after installation so they load the plugin.

To change the picker key:

```tmux
set -g @tmux-opencoder-key S
set -g @plugin 'hrahmanov89/tmux-opencoder'
```

Then use `prefix + S`.

## Manual Install

```sh
git clone https://github.com/hrahmanov89/tmux-opencoder.git ~/src/tmux-opencoder
cd ~/src/tmux-opencoder
node bin/install.mjs ~/.tmux.conf
```

For XDG-style tmux configuration:

```sh
node bin/install.mjs ~/.config/tmux/tmux.conf
```

Pass a custom key as the second argument:

```sh
node bin/install.mjs ~/.tmux.conf S
```

The manual installer backs up the tmux config, adds a marked configuration block,
installs the OpenCode plugin wrapper, and configures the live server when run inside
tmux. Restart existing OpenCode processes afterward.

## Usage

1. Run OpenCode normally inside tmux panes.
2. Press `prefix + O`.
3. Search the session list.
4. Press Enter to switch OpenCode and jump to its pane.
5. Press `Ctrl-R` to refresh or Esc to close.

If the key already belongs to another command, tmux-opencoder leaves it alone. Open
the popup directly with:

```sh
node bin/tmux-opencoder.mjs popup --client "$(tmux display-message -p '#{client_name}')"
```

## How It Works

The OpenCode plugin publishes pane-local session snapshots and status heartbeats to
tmux. An authenticated process-local Unix socket routes an fzf selection back to the
correct OpenCode process. The helper asks that TUI to select the session and then moves
the current tmux client to its pane.

The plugin recognizes active, explicitly resumed, previously observed, and currently
visible root sessions. It ignores subagents and untouched historical sessions. A
five-second heartbeat and 20-second timeout mark dead processes offline.

Only one foreground OpenCode process per pane is supported. Multiple tmux servers are
independent.

## Update

With TPM, press `prefix + U`, then restart OpenCode processes. For manual installs:

```sh
git pull
node bin/tmux-opencoder.mjs configure
```

## Development

```sh
npm test
node bin/tmux-opencoder.mjs sessions
node bin/tmux-opencoder.mjs summary
```
