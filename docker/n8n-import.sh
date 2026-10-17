#!/bin/sh
# Imports the exported workflows in /workflows on first start only, so later
# restarts don't overwrite edits or activation state made in n8n.
set -e
MARKER=/home/node/.n8n/.flowdesk-workflows-imported
if [ -f "$MARKER" ]; then
  echo "workflows already imported"
elif ls /workflows/*.json >/dev/null 2>&1; then
  n8n import:workflow --separate --input=/workflows
  # Import leaves workflows unpublished; publish each so n8n activates its
  # webhook on start.
  for file in /workflows/*.json; do
    id=$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).id)' "$file")
    n8n publish:workflow --id="$id"
  done
  touch "$MARKER"
else
  echo "no workflows to import"
fi
