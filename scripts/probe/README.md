# Probe Scripts

This directory contains local developer probe scripts for checking high-signal runtime paths.

## Slack Reply Probe

The Slack reply probe verifies a single end-to-end Slack DM path:

1. Open an authenticated Slack DM in Chrome Canary
2. Send one probe message
3. Wait for the bot to post a new reply

This is a local developer probe, not a CI-safe browser test.

### Why Chrome Canary

- Keeps the probe isolated from a normal Chrome profile
- Uses a dedicated repo-local user data directory
- Exposes Chrome DevTools Protocol so the probe can attach to a real authenticated browser session

### Required input

Set the target Slack DM URL at runtime:

```bash
export PROBE_SLACK_URL="https://app.slack.com/client/<team-id>/<dm-id>"
```

Do not commit real workspace or DM URLs into source.

### Basic workflow

Launch Chrome Canary for the probe:

```bash
pnpm probe:slack prepare
```

On the first run:

- Log into Slack in the opened Canary window
- Open the target DM if needed

Run the probe:

```bash
pnpm probe:slack run
```

Expected success output includes:

```text
[probe][info] result=pass
[probe][info] ===== PASS =====
```

### Extra commands

Check whether the page looks ready:

```bash
pnpm probe:slack session
```

Print selector diagnostics for Slack DOM debugging:

```bash
pnpm probe:slack inspect
```

### Useful overrides

```bash
pnpm probe:slack run --message "probe:manual-check"
pnpm probe:slack run --reply-timeout-ms 120000
pnpm probe:slack run --url "https://app.slack.com/client/<team-id>/<dm-id>"
```

### Environment and defaults

- Browser: Chrome Canary
- Default CDP endpoint: `http://127.0.0.1:9222`
- Default profile dir: `.tmp/slack-reply-probe/chrome-canary-profile`
- Optional binary override: `SLACK_PROBE_CANARY_BIN`

### Output levels

- `[probe][info]` - key lifecycle and result lines
- `[probe][debug]` - detailed diagnostics
- `[probe][error]` - failures

### Notes

- This flow is intentionally local-only and assumes a human can complete Slack login in the dedicated Canary profile.
- The probe sends a unique message payload on each run unless `--message` is provided.
