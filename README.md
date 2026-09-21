# tmux-opencoder

Current-process OpenCode root sessions, with statuses and a searchable fzf switcher.
Works with plain `opencode` started inside each pane; no sessionizer changes.

## Interface

Press **prefix + O** to open the popup. Root sessions active, resumed, or previously
observed by each running OpenCode process are visible, including owned idle sessions.
The current TUI sidebar session is also recognized. Untouched historical sessions and
subagent sessions are hidden.

```text
STATE    SESSION       FOLDER  TITLE
working  ses_abc123    api     Add API authentication
retrying ses_def456    api     Investigate timeout
```

- Search session ID, title, status, or final folder name.
- Enter selects that exact session in its existing OpenCode TUI, then jumps to its pane.
- Ctrl-R refreshes while preserving the query.
- Picker has no preview pane and opens without a modal border.
- Status-right summarizes all instances on that tmux server. Pane-border placement is not changed.
- Attention states sort first. Existing session names, tmux theme, status commands, and foreign `o` binding are preserved.

## Install

Requires:

- Node.js 22 or newer.
- tmux 3.2 or newer with popup support.
- fzf 0.48 or newer with `--listen` and `--track` support.
- A Nerd Font or Font Awesome-compatible terminal font for the status icon (``).

Examples for macOS with Homebrew:

```sh
brew install node tmux fzf
```

Clone this repository, enter the checkout, and run the installer. Pass the path to
your tmux configuration file:

```sh
git clone <repository-url> ~/src/tmux-opencoder
cd ~/src/tmux-opencoder
node bin/install.mjs ~/.tmux.conf
```

Use `~/.config/tmux/tmux.conf` instead if that is where your tmux configuration
lives. The optional second argument changes the prefix key; default is `O`:

```sh
node bin/install.mjs ~/.tmux.conf S
```

Installer creates a global OpenCode plugin entry, backs up tmux config, and appends
a marked configuration block. Keep this checkout in place: installation references
its absolute path and the current Node executable. Reinstall/update the block if
moving the checkout or removing that Node version.

Restart existing OpenCode instances after installation. New instances register
automatically. Existing instances do not appear until restarted.

The installer also configures the live tmux server when run from inside tmux. To
apply configuration changes later without reinstalling:

```sh
node bin/tmux-opencoder.mjs configure
```

Restart OpenCode after updating this checkout so running instances load new plugin
code.

If `prefix + O` already belongs to another command, it is left unchanged. Use:

```sh
node bin/tmux-opencoder.mjs popup --client "$(tmux display-message -p '#{client_name}')"
```

Put the installer block after theme/plugin loading. The plugin preserves your existing
tmux theme, `status-right`, and pane-border settings. It adds only its summary and
picker binding. Themes that asynchronously replace `status-right` later can hide the
summary; rerun `configure` after they finish.

The picker is borderless, 45% high, and has no preview pane. It inherits fzf theme
settings from `FZF_DEFAULT_OPTS`, while explicitly disabling preview and borders.

## Usage

1. Start `opencode` normally inside a tmux pane.
2. Press tmux prefix plus `O` to open the session picker.
3. Type to search by status, session ID, title, or final folder name.
4. Press Enter to select that session in OpenCode and switch to its pane.
5. Press `Ctrl-R` to refresh results without losing the query.
6. Press Esc to close the picker.

Status colors in the tmux status bar are yellow for `working`, green for `idle`,
and red for `error`, `needs input`, `retrying`, or `offline`.

## Status Semantics

`working`, `needs input`, `retrying`, `idle`, `error`, `offline` derive from OpenCode
session, permission, and question events. A busy session is not necessarily thinking;
idle is not proof of successful completion. Errors remain visible until a new prompt.
Concurrent sessions and subagents are tracked independently and aggregated per pane.
Completion of a child cannot mark a busy parent idle.

State lives in pane-local `@opencode_state`, `@opencode_sessions`, and
`@opencode_status`, scoped to the launching tmux socket and stable pane ID. A
process-local authenticated Unix socket routes picker selections to the owning
OpenCode TUI; it is removed on normal disposal. A five-second heartbeat and 20-second
staleness threshold detect crashed or unreachable instances. Normal plugin disposal
clears owned state. Crashed instances remain marked offline until pane closure or restart.
Status refresh follows tmux's existing `status-interval` (normally five seconds).

Only one foreground OpenCode process per pane is supported. Shared `opencode attach`
servers and remote clients need explicit mapping and are not supported. Multiple
tmux servers are independent; `--socket PATH` selects one, not a combined dashboard.
Plugin does nothing outside tmux. No network service except an ephemeral,
API-key-protected localhost fzf refresh listener while the picker is open.

## Development

```sh
npm test
node bin/tmux-opencoder.mjs list
node bin/tmux-opencoder.mjs sessions
node bin/tmux-opencoder.mjs summary
```

Tests use isolated tmux servers; no live user panes are created or switched.

## Update

Pull changes into the existing checkout, reapply live tmux configuration, and restart
OpenCode instances:

```sh
git pull
node bin/tmux-opencoder.mjs configure
```

## Remove

Remove `~/.config/opencode/plugins/tmux-opencoder.js` and the marked block from your
tmux config, then restart OpenCode. Existing live tmux formats/binding remain until
restored or the tmux server restarts; use the installer backup to recover original
settings without overwriting any later edits.
