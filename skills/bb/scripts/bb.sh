#!/bin/bash
# BullyBuddy CLI wrapper for OpenClaw slash commands
# Usage: bb.sh <subcommand> [args...]

set -e

# Config from env or defaults
BB_URL="${BB_URL:-http://127.0.0.1:18900}"
BB_TOKEN="${BB_TOKEN:-}"

if [[ -z "$BB_TOKEN" ]]; then
  echo "Error: BB_TOKEN not set"
  exit 1
fi

AUTH="Authorization: Bearer $BB_TOKEN"
CT="Content-Type: application/json"

cmd="$1"
shift 2>/dev/null || true

case "$cmd" in
  status|s)
    echo "=== BullyBuddy Status ==="
    curl -sf "$BB_URL/health" -H "$AUTH" | jq -r '"Uptime: \(.data.uptime | floor)s | Sessions: \(.data.sessions)"'
    echo ""
    curl -sf "$BB_URL/api/summary" -H "$AUTH" | jq -r '.data | "Running: \(.running) | Needing attention: \(.sessionsNeedingAttention | length)"'
    ;;
    
  list|ls|l)
    echo "=== Sessions ==="
    curl -sf "$BB_URL/api/sessions" -H "$AUTH" | jq -r '.data[] | "\(.id) [\(.detailedState)] \(.name // "unnamed") - \(.task // "no task")[0:50]"'
    [[ $(curl -sf "$BB_URL/api/sessions" -H "$AUTH" | jq '.data | length') == "0" ]] && echo "(no sessions)"
    ;;
    
  spawn|new|n)
    cwd="${1:-$(pwd)}"
    task="$2"
    group="${3:-default}"
    
    body="{\"cwd\":\"$cwd\",\"group\":\"$group\""
    [[ -n "$task" ]] && body="${body},\"task\":\"$task\""
    body="${body}}"
    
    result=$(curl -sf -X POST "$BB_URL/api/sessions" -H "$AUTH" -H "$CT" -d "$body")
    id=$(echo "$result" | jq -r '.data.id')
    echo "Spawned session: $id"
    echo "State: $(echo "$result" | jq -r '.data.detailedState')"
    ;;
    
  send|input|i)
    id="$1"
    text="$2"
    if [[ -z "$id" || -z "$text" ]]; then
      echo "Usage: bb send <id> <text>"
      exit 1
    fi
    # Append carriage return for PTY
    curl -sf -X POST "$BB_URL/api/sessions/$id/input" -H "$AUTH" -H "$CT" -d "{\"data\":\"$text\\r\"}" > /dev/null
    echo "Sent to $id: $text"
    ;;
    
  output|out|o)
    id="$1"
    lines="${2:-30}"
    if [[ -z "$id" ]]; then
      echo "Usage: bb output <id> [lines]"
      exit 1
    fi
    info=$(curl -sf "$BB_URL/api/sessions/$id" -H "$AUTH")
    state=$(echo "$info" | jq -r '.data.detailedState')
    echo "=== Session $id [$state] ==="
    # Get transcript if available
    curl -sf "$BB_URL/api/sessions/$id/transcript?last=$lines" -H "$AUTH" | jq -r '.data[] | "[\(.role)] \(.content[0:200])"' 2>/dev/null || echo "(no transcript)"
    ;;
    
  kill|k|stop)
    id="$1"
    if [[ -z "$id" ]]; then
      echo "Usage: bb kill <id>"
      exit 1
    fi
    curl -sf -X DELETE "$BB_URL/api/sessions/$id" -H "$AUTH" > /dev/null
    echo "Killed session: $id"
    ;;
    
  audit|a)
    limit="${1:-20}"
    echo "=== Audit Log (last $limit) ==="
    curl -sf "$BB_URL/api/audit?limit=$limit" -H "$AUTH" | jq -r '.data[] | "\(.timestamp[11:19]) \(.action) \(.sessionId // "-") \(.result)"'
    ;;
    
  transcript|t)
    id="$1"
    limit="${2:-50}"
    if [[ -z "$id" ]]; then
      echo "Usage: bb transcript <id> [limit]"
      exit 1
    fi
    echo "=== Transcript $id ==="
    curl -sf "$BB_URL/api/sessions/$id/transcript?last=$limit" -H "$AUTH" | jq -r '.data[] | "[\(.role)] \(.content)"'
    ;;
    
  help|h|"")
    cat << 'EOF'
BullyBuddy Commands:
  status, s          - Server status & summary
  list, ls, l        - List all sessions
  spawn, new, n      - Spawn session [cwd] [task] [group]
  send, input, i     - Send input <id> <text>
  output, out, o     - Show output <id> [lines]
  kill, k, stop      - Kill session <id>
  audit, a           - Audit log [limit]
  transcript, t      - Transcript <id> [limit]
  help, h            - This help

Env: BB_URL, BB_TOKEN
EOF
    ;;
    
  *)
    echo "Unknown command: $cmd"
    echo "Run 'bb help' for usage"
    exit 1
    ;;
esac
