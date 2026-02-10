# Mini-Claw

Lightweight Telegram bot for persistent AI conversations using Pi coding agent.

## Project Goals

- **Simple**: Minimal dependencies, single-purpose
- **Persistent**: Long-running conversations with session management
- **Subscription-friendly**: Use Claude Pro/Max or ChatGPT Plus via OAuth (no API costs)

## Tech Stack

- **Language**: Rust (2021 edition)
- **Build**: Cargo
- **AI Backend**: [@mariozechner/pi-coding-agent](https://github.com/badlogic/pi-mono)
- **Telegram**: [teloxide 0.17](https://github.com/teloxide/teloxide) with rustls
- **Process**: Single long-running binary (systemd/launchd/tmux)

## Architecture

```
┌─────────────┐     ┌─────────────┐     ┌─────────────┐
│  Telegram   │────►│  Mini-Claw  │────►│  Pi Agent   │
│   (User)    │◄────│   (Bot)     │◄────│  (Session)  │
└─────────────┘     └─────────────┘     └─────────────┘
                           │
                           ▼
                    ~/.mini-claw/
                    ├── sessions/
                    │   └── telegram-<chat_id>.jsonl
                    ├── workspaces.json
                    └── active-sessions.json
```

### Key Design Decisions

- **One-shot mode only**: Uses `pi --print` — spawns a new Pi process per message, not interactive RPC.
- **Per-chat locking**: `ChatLocks` (Mutex per chat_id) prevents concurrent Pi executions for the same chat.
- **Session persistence**: Pi handles auto-compaction. Bot just passes `--session <path>`.
- **Pi path resolution**: At startup, resolves pi binary via `PI_PATH` env, `which`, or scanning common Node.js manager locations (fnm, nvm, Volta). Critical for service deployments where fnm/nvm paths aren't on PATH.

### Request Flow (text message)

1. Check access control (`ALLOWED_USERS`)
2. Rate limit check (per-chat cooldown)
3. Snapshot workspace filesystem (for new file detection)
4. Send typing indicator + status message
5. Acquire per-chat lock (prevents concurrent Pi runs)
6. Spawn Pi: `pi --session <path> --print --thinking <level> [images...] <prompt>`
7. Stream stdout line-by-line, detect activity (reading/writing/running/etc)
8. Update status message with activity indicators
9. On completion: send output (split at 4096 chars), extract images from session, detect new files

## Directory Structure

```
├── CLAUDE.md              # This file
├── Cargo.toml             # Dependencies & build config
├── Makefile               # Quick commands
├── .env.example           # Environment template
├── install.sh             # Universal installer (Linux/macOS/Termux)
├── .github/workflows/
│   ├── ci.yml             # Build + test + clippy on PRs
│   └── release.yml        # Cross-platform release builds (5 targets)
└── src/
    ├── main.rs            # Entry point: init tracing, load config, check pi, run dispatcher
    ├── config.rs          # Config struct, env loading, pi path resolution
    ├── error.rs           # MiniClawError enum (Config, PiExecution, PiNotAuthenticated, Session, Workspace, Io, Json, Timeout)
    ├── rate_limiter.rs    # Per-chat rate limiting (HashMap<chat_id, Instant>)
    ├── markdown.rs        # Markdown → Telegram HTML (bold, italic, code, links, strikethrough)
    ├── file_detector.rs   # Detect files in Pi output + workspace snapshot diff
    ├── workspace.rs       # Per-chat working directory (persisted to workspaces.json)
    ├── pi_runner.rs       # Pi execution, activity detection, ChatLocks, image extraction
    ├── sessions.rs        # Session CRUD, archival, title generation, cleanup
    └── bot/
        ├── mod.rs          # AppState (shared state), dispatcher setup, access control
        ├── commands.rs     # /start, /help, /pwd, /cd, /home, /shell, /session, /new, /status
        ├── handlers.rs     # Text message handler, photo handler (with activity streaming)
        ├── callbacks.rs    # Inline keyboard: session:load:<filename>, session:cleanup
        └── util.rs         # split_message (4096 limit), run_shell (bash -c with timeout)
```

## Module Reference

### config.rs
- `Config` struct: all settings from env vars
- `load_config()` → loads .env, resolves paths, resolves pi binary
- `resolve_pi_path()` → PI_PATH env → `which pi` → scan fnm/nvm/volta dirs
- `ThinkingLevel` enum: Low, Medium, High

### pi_runner.rs
- `check_pi_auth(pi_path)` → runs `pi --version`
- `run_pi_with_streaming(config, chat_id, prompt, workspace, on_activity, options)` → spawns pi process, streams output
- `ChatLocks` → per-chat Mutex map for exclusive Pi access
- `detect_activity(line)` → regex matching for Reading/Writing/Running/Searching/Thinking
- `extract_images_from_session(config, chat_id, after_line)` → parses JSONL for base64 images
- `RunResult { output, error }`, `ActivityUpdate { activity_type, detail, elapsed }`

### sessions.rs
- `SessionManager` → tracks active session per chat (persisted to active-sessions.json)
- `archive_session()` → renames with ISO timestamp suffix
- `list_sessions()` → finds all .jsonl files, returns `Vec<SessionInfo>`
- `generate_session_title(path, timeout, pi_path)` → asks Pi for 5-word title
- `cleanup_old_sessions(config, keep_count)` → keeps N most recent per chat

### bot/handlers.rs
- `handle_text()` → main message loop (rate limit → lock → pi → send output → send files)
- `handle_photo()` → downloads photo, passes to Pi with `@/path/to/image.jpg` syntax
- Activity status updates with emoji indicators, debounced at 2s

### bot/commands.rs
- `BotCommand` enum with teloxide derive macros
- Unrecognized `/` commands forwarded to Pi as agent commands (e.g., `/reload`)

### file_detector.rs
- `parse_output_for_files()` → regex for "Created:", "Saved to:", "File:" patterns
- `snapshot_workspace()` / `detect_new_files()` → before/after filesystem diff
- `categorize_files()` → Photo (.png/.jpg/.gif/.webp) vs Document (.pdf/.txt/.md/etc)

### markdown.rs
- `markdown_to_html()` → safe conversion (escapes HTML first, then applies formatting)
- `strip_markdown()` → removes all formatting
- Handles code blocks separately to preserve content

## Environment Variables

```bash
# Required
TELEGRAM_BOT_TOKEN=your_telegram_bot_token

# Optional: Pi binary path (auto-detected if on PATH)
PI_PATH=/path/to/pi

# Optional: Directories
MINI_CLAW_WORKSPACE=/path/to/workspace  # Default: ~/mini-claw-workspace
MINI_CLAW_SESSION_DIR=~/.mini-claw/sessions

# Optional: Pi settings
PI_THINKING_LEVEL=low                   # low | medium | high
BRAVE_API_KEY=your-key                  # For Pi web search skill

# Optional: Access control
ALLOWED_USERS=123,456                   # Comma-separated user IDs (empty = allow all)

# Optional: Timeouts (milliseconds)
RATE_LIMIT_COOLDOWN_MS=5000             # Default: 5 seconds between messages
PI_TIMEOUT_MS=300000                    # Default: 5 minutes
SHELL_TIMEOUT_MS=60000                  # Default: 60 seconds
SESSION_TITLE_TIMEOUT_MS=10000          # Default: 10 seconds
```

## Development

```bash
make dev        # Build & run (debug)
make test       # Run all tests
make clippy     # Lint check
make check      # clippy + tests
make build      # Compile only
make login      # Run pi /login
make status     # Check pi auth
```

### CI

- **ci.yml**: Runs on PRs to main — build, test, clippy (warnings = errors)
- **release.yml**: On tag push (v*) — builds 5 targets, creates GitHub release with tarballs

### Release Targets

| Target | Platform |
|--------|----------|
| `x86_64-unknown-linux-gnu` | Linux x86_64 |
| `aarch64-unknown-linux-gnu` | Linux ARM64 |
| `aarch64-unknown-linux-musl` | Linux ARM64 musl (Termux) |
| `x86_64-apple-darwin` | macOS Intel |
| `aarch64-apple-darwin` | macOS Apple Silicon |

## Deployment

### install.sh (recommended)
Universal installer — detects OS/arch, downloads binary or builds from source, configures .env, sets up system service (systemd/launchd/runit).

### systemd (Linux)
```bash
make install-service
systemctl --user start mini-claw
systemctl --user enable mini-claw
```

### launchd (macOS)
Installed by install.sh to `~/Library/LaunchAgents/com.mini-claw.plist`

### tmux (manual)
```bash
tmux new -s mini-claw && make start
```

## Key Constants

| Constant | Value | File |
|----------|-------|------|
| MAX_MESSAGE_LENGTH | 4096 | bot/util.rs |
| Activity update debounce | 2s | bot/handlers.rs |
| Typing indicator interval | 4s | bot/handlers.rs |
| Periodic "working" updates | 5s | pi_runner.rs |

## Common Issues

### "Pi is not installed or not authenticated"
Pi binary not found on PATH. Set `PI_PATH` in .env to the full path (e.g., from `which pi` in your shell). Common for service deployments where fnm/nvm isn't initialized.

### Session stuck / concurrent messages
Per-chat lock means only one Pi process per chat. If Pi hangs, the chat is blocked until timeout (default 5min). Reduce `PI_TIMEOUT_MS` if needed.

## License

MIT
