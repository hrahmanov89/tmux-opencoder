#!/usr/bin/env bash

CURRENT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BIND_KEY="$(tmux show-option -gqv @tmux-opencoder-key)"
BIND_KEY="${BIND_KEY:-O}"
NODE="$(command -v node || true)"

if [[ -z "$NODE" ]]; then
  tmux display-message "tmux-opencoder: Node.js 22+ is required"
  exit 1
fi

"$NODE" "$CURRENT_DIR/bin/install.mjs" --tpm "$BIND_KEY"
