#!/bin/sh
# Imports the exported workflows in /workflows on first start only, so later
# restarts don't overwrite edits or activation state made in n8n.
set -e
MARKER=/home/node/.n8n/.flowdesk-workflows-imported
if [ -f "$MARKER" ]; then
  echo "workflows already imported"
elif ls /workflows/*.json >/dev/null 2>&1; then
  n8n import:workflow --separate --input=/workflows
  touch "$MARKER"
else
  echo "no workflows to import"
fi
