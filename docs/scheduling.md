# Scheduling

ace ships first-class subcommands to install a recurring renderer on macOS (launchd), Linux (systemd user units), or anywhere with cron. All three share the same install/uninstall semantics and the same flag surface.

## Shared flags

| Flag                 | Notes                                                                       |
| -------------------- | --------------------------------------------------------------------------- |
| `--at <HH:MM>`       | Daily run at given local time.                                              |
| `--every <duration>` | E.g. `15m`, `1h`. Interval-style scheduling.                                |
| `--cron-minute <N>`  | Every hour at minute `N`.                                                   |
| `--label <name>`     | Idempotency tag. Default `dev.ace.render`.                                  |
| `--log <path>`       | Where to redirect stdout/stderr. Platform default if omitted.               |
| `--run-now`          | Kickstart immediately after install.                                        |
| `--dry-run`          | Print artifact + commands; do nothing.                                      |
| `--verbose`          | Verbose render inside the scheduled job.                                    |

**Idempotency**: re-running `ace install …` with the same `--label` replaces the prior install. `ace uninstall <kind> --label <name>` removes it. The `ace` bin path is resolved to absolute at install time — launchd, systemd, and cron all run with a stripped PATH.

## launchd (macOS)

| | |
| - | - |
| Generated artifact | `~/Library/LaunchAgents/<label>.plist` |
| Install commands   | `launchctl bootout` (tolerant) → `bootstrap` → `enable` → optional `kickstart -k` |
| Default log        | `~/Library/Logs/ace.log` |
| Schedule mapping   | `--cron-minute N` → `StartCalendarInterval { Minute: N }` (hourly at :N) · `--at HH:MM` → `StartCalendarInterval { Hour, Minute }` · `--every Ns` → `StartInterval` (seconds) |

```sh
ace install launchd --cron-minute 48 --label dev.ace.render --run-now
ace uninstall launchd --label dev.ace.render
```

## systemd (Linux user units)

| | |
| - | - |
| Generated artifacts | `~/.config/systemd/user/<label>.service`, `~/.config/systemd/user/<label>.timer` |
| Install commands    | `systemctl --user daemon-reload && systemctl --user enable --now <label>.timer` |
| Default log         | `~/.local/state/ace/ace.log` |
| Persistence         | `Persistent=true` so missed runs catch up after suspend / reboot. |
| Headless boxes      | If the user isn't logged in, run `loginctl enable-linger $USER` once so user units fire without an active login session. ace does not run this for you, but `doctor` hints at it. |

```sh
ace install systemd --cron-minute 48 --label dev.ace.render --run-now
ace uninstall systemd --label dev.ace.render
```

## cron (universal fallback)

| | |
| - | - |
| Mechanism | Read `crontab -l`, strip lines tagged `# agent-md:<label>`, append a new tagged entry, pipe back via `crontab -`. |
| Idempotency tag | `# agent-md:<label>` at the end of the line. Easy to grep, easy to remove. |
| Default log | Wherever you redirect stdout. ace defaults to `~/.local/state/ace/ace.log` (Linux) or `~/Library/Logs/ace.log` (macOS). |

```sh
ace install cron --cron-minute 48 --label dev.ace.render
ace uninstall cron --label dev.ace.render
```

## Logs

| Platform | Default path                       |
| -------- | ---------------------------------- |
| macOS    | `~/Library/Logs/ace.log`           |
| Linux    | `~/.local/state/ace/ace.log` (XDG) |

Format: one line per run start/end, with timestamp + per-source rendered/skipped counts. Errors include stack traces.

ace does **not** rotate logs. Use platform tools:

- macOS: [`newsyslog`](https://www.unix.com/man-page/osx/5/newsyslog.conf/) — config goes in `/etc/newsyslog.d/`.
- Linux: [`logrotate`](https://linux.die.net/man/8/logrotate) or `journalctl --user`.

`ace logs` resolves the path; `ace logs --tail` follows it.

## Worked example: Drive output + launchd at :48

The full setup, from zero to scheduled hourly renders into a Google Drive folder:

```sh
# 1. Generate a starter config.
npx @mjaverto/ace init

# 2. Edit ace.config.yaml and point output at your Drive folder, e.g.:
#    output: ~/Library/CloudStorage/GoogleDrive-<account>/My Drive/_Brain/agent-conversations
#
#    Save and close.

# 3. Validate. doctor probes mtime preservation on the Drive FS — if it's
#    rounded or reset, doctor will recommend `--strategy index`.
npx @mjaverto/ace doctor

# 4. Install the launchd schedule. Hourly at minute 48; immediate first run.
npx @mjaverto/ace install launchd \
  --cron-minute 48 \
  --label dev.ace.render \
  --run-now

# 5. Watch the first run.
npx @mjaverto/ace logs --tail
```

To stop:

```sh
npx @mjaverto/ace uninstall launchd --label dev.ace.render
```

This is documentation, not behavior — ace doesn't bake in a Drive path. The example just illustrates the end-to-end pattern. Substitute Dropbox, iCloud, a local SSD, an SSH-mounted FS, anywhere your other notes already live.
