---
name: bb
description: BullyBuddy - Control Claude Code sessions via slash command. Use /bb to manage multiple Claude Code instances. Commands: status, list, spawn, send, output, kill, audit, transcript.
user-invocable: true
command-dispatch: tool
command-tool: exec
command-arg-mode: raw
metadata:
  {
    "openclaw":
      {
        "homepage": "https://github.com/ChenKuanSun/openclaw-bullybuddy",
        "requires": { "bins": ["bullybuddy", "claude", "jq"] },
        "install":
          [
            {
              "id": "node",
              "kind": "node",
              "package": "openclaw-bullybuddy",
              "bins": ["bullybuddy"],
            },
          ],
      },
  }
---

# BullyBuddy Slash Command

Control BullyBuddy Claude Code session manager directly via `/bb`.

## Setup

1. Install BullyBuddy:

```bash
npm install -g openclaw-bullybuddy
```

2. Start the server:

```bash
bullybuddy server
```

Connection info is auto-saved to `~/.bullybuddy/connection.json` on startup. The `/bb` command reads it automatically — no env vars needed.

For remote access, start with `bullybuddy server --tunnel`. The tunnel URL is available via `/bb url`.

## Usage

```
/bb status          - Server status & session summary
/bb list            - List all sessions
/bb spawn [cwd] [task] [group] - Create new session
/bb send <id> <text> - Send input to session
/bb output <id> [lines] - Show session output/transcript
/bb kill <id>       - Terminate session
/bb url             - Show dashboard URL (local + tunnel)
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
