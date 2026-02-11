---
name: bb
description: BullyBuddy - Control Claude Code sessions via slash command. Use /bb to manage multiple Claude Code instances. Commands: status, list, spawn, send, output, kill, audit, transcript.
user-invocable: true
command-dispatch: tool
command-tool: exec
command-arg-mode: raw
metadata: {"openclaw":{"requires":{"env":["BB_URL","BB_TOKEN"]}}}
---

# BullyBuddy Slash Command

Control BullyBuddy Claude Code session manager directly via `/bb`.

## Setup

Set environment variables in OpenClaw config:
```json
{
  "env": {
    "BB_URL": "http://127.0.0.1:18900",
    "BB_TOKEN": "your-token-here"
  }
}
```

## Usage

```
/bb status          - Server status & session summary
/bb list            - List all sessions  
/bb spawn [cwd] [task] [group] - Create new session
/bb send <id> <text> - Send input to session
/bb output <id> [lines] - Show session output/transcript
/bb kill <id>       - Terminate session
/bb audit [limit]   - View audit log
/bb transcript <id> [limit] - View conversation transcript
/bb help            - Show help
```

## Examples

```
/bb status
/bb list
/bb spawn /home/user/project "Fix the login bug"
/bb send abc123 "yes"
/bb output abc123
/bb kill abc123
```

## Script

When invoked, run:
```bash
{baseDir}/scripts/bb.sh $ARGUMENTS
```
