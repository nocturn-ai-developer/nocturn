# Nocturn

A self-hosted personal AI agent. A gateway runs on your computer or server, you control it from the terminal, and you talk to it through Telegram, Discord, Slack or the CLI. It asks before doing anything risky.

## Run

Needs Node 22 or newer.

```bash
npm install -g @morpheapp/nocturn
nocturn onboard
```

On Windows PowerShell, use `npm.cmd install -g @morpheapp/nocturn` and `nocturn.cmd`.

## Commands

```bash
nocturn gateway start        # also: run, stop, restart, status, logs, install
nocturn status
nocturn doctor
nocturn chat
nocturn agent -m "summarize my notes"
nocturn channels add telegram
nocturn pairing list
nocturn pairing approve <code>
nocturn approvals list
nocturn cron add --name brief --cron "0 8 * * 1-5" -m "plan my day" --deliver telegram:<chat>
nocturn message send --to telegram:<chat> -m "hello"
nocturn memory add "I prefer short answers"
nocturn config set model claude-sonnet-5-5
```

`nocturn help` lists everything. Change the port with `NOCTURN_PORT`, the state folder with `NOCTURN_HOME`, and open the control panel with `nocturn dashboard`.

## Mining

```bash
nocturn mine
```

Pick a name, answer the check and it starts hashing SHA-256 on your CPU. Press Ctrl+C to stop. Use `--threads N` to change how much of the CPU it takes. It only runs while that terminal is open.

### 24 hours on a VPS

The check is asked once when mining starts. After that it keeps running for as long as it stays in touch with the pool. If it loses the pool for over 30 minutes, it pauses and asks again. Use `tmux` so it keeps running after you disconnect:

```bash
tmux new -s nocturn
nocturn mine
```

Press Ctrl+B then D to leave it running, and `tmux attach -t nocturn` to come back. If the machine reboots, start it again by hand.

Many hosting providers forbid mining and can suspend your account, so read your provider's terms first.

Balances are in NOCT, a number kept by the pool server. NOCT is not a coin on a blockchain, cannot be withdrawn and has no guaranteed value. Only mine on a machine you own or have permission to use.

To host a pool, run `nocturn pool run` behind an https reverse proxy, then set `nocturn.pool` in `package.json` to its address. With a proxy, add `--trust-proxy` so per-address sign-up limits work.

## Website (nocturnh.com)

```bash
nocturn site build --out site
npx wrangler deploy
```

On Windows PowerShell, use `npx.cmd wrangler deploy`, since PowerShell blocks `npx.ps1` by default.

This exports the landing page with your Trusted by list into `site/`. On the public site there is no gateway: the wallet button only connects to Robinhood Chain and nothing is sent anywhere. `wrangler.jsonc` serves `site/` as a Cloudflare Worker on nocturnh.com and www.nocturnh.com. Set the token contract in `TOKEN.contract` in `public/demo.js` once it is deployed.

## Apps

The same gateway, without a terminal:

- **Nocturn Desktop** for Windows (`.exe`) and macOS (`.dmg`) starts the gateway when it opens, shows the control panel in its own window and keeps running in the tray when the window is closed. It is an Electron app in `desktop/`. Run it from source with `npm run desktop`, build an installer with `npm run desktop:win` or `npm run desktop:mac` (each builds only on its own platform; `.github/workflows/apps.yml` builds all of them on a version tag).
- **Nocturn for Android** (`.apk`, in `mobile/`) and the **web app** (`/panel.html` on your gateway, installable from the browser) are clients for a gateway you run elsewhere. The phone never runs the agent.
- Set the download links on nocturnh.com in `nocturn.downloads` in `package.json`, then rebuild and deploy the site.

To reach a gateway from a phone, put both devices on a private network such as Tailscale, then start the gateway with `NOCTURN_HOST=0.0.0.0` and `NOCTURN_TRUSTED_HOSTS=<the gateway's address on that network>`. The token is still required for every request. Do not expose the gateway to the open internet.

## On a server

```bash
nocturn onboard
nocturn gateway install
loginctl enable-linger $USER
```

The gateway listens on `127.0.0.1` only. To use the optional web panel, tunnel to it from your own computer, then open the link from `nocturn dashboard`:

```bash
ssh -L 18790:127.0.0.1:18790 user@your-server
```

## What it does

- **Models:** Claude through the Anthropic API, or any OpenAI-compatible endpoint such as GPT or Ollama.
- **Tools:** workspace files, shell, web fetch, headless Chrome or Edge, memory, schedules, and sending chat messages.
- **Channels:** Telegram, Discord and Slack.
- **Skills:** `SKILL.md` files in `~/.nocturn/workspace/skills/`, loaded on demand.
- **Schedules:** 5-field cron in server local time, with optional delivery to a chat.

## Safety model

- The gateway listens on `127.0.0.1` only, requires a token, and rejects foreign `Host` and `Origin` headers.
- Shell, file writes, web, browser, schedules and outbound messages need approval by default. Answer in `nocturn chat`, with `nocturn approvals`, or with `/approve` and `/deny` in the chat that started the run.
- Chat senders are blocked until you run `nocturn pairing approve <code>`.
- File tools stay inside `~/.nocturn/workspace`. Web tools block private and loopback addresses.

The shell tool is **not sandboxed**: an approved command runs with your user's full permissions. Read each command before allowing it, and do not set `shell` to "Always allow" on a machine with data you care about.

## Data

Everything lives in `~/.nocturn/`, including config with API keys in plain text. Never commit or share that folder.

## Tests

```bash
npm test
```

The tests use a fake model server, so they need no key and spend nothing.
