# openclaw-webex

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)
[![Node >= 22](https://img.shields.io/badge/node-%3E%3D22-brightgreen.svg)](https://nodejs.org)
[![TypeScript](https://img.shields.io/badge/built%20with-TypeScript-3178c6.svg)](https://www.typescriptlang.org)
[![Transport: WebSocket](https://img.shields.io/badge/transport-websocket-orange.svg)](#how-it-works)
[![OpenClaw 2026.8+](https://img.shields.io/badge/openclaw-2026.8%2B-8a2be2.svg)](https://github.com/openclaw/openclaw)

**Cisco Webex channel plugin for OpenClaw.** Connects Webex bots to OpenClaw agents
over an outbound WebSocket — no public URL, no tunnels, no inbound firewall rules.
Multi-agent dispatch, Adaptive Cards, live progress reporting, and a
default-deny sender allowlist.

---

## Highlights

- **Outbound-only transport** — a single `wss://` connection to Cisco's Mercury
  push service on port 443. Works behind strict firewalls (443-egress-only is
  enough). Self-healing: app-level keepalive, jittered exponential backoff, and
  a daily connection refresh that guards against stale registrations.
- **Multi-agent dispatch** — one gateway hosts any number of named bots, each
  routed to its own OpenClaw agent.
- **Live progress in chat** — the bot narrates what the agent is doing
  (*Reading `file`*, *Running `git status`*), editing a single message in place
  and staying under Webex's 10-edit cap. Optional live reasoning stream.
- **Adaptive Cards** — ready-made card builders (`factCard`, `statusCard`,
  `approvalCard`), local validation against Webex's card limits, and button
  submissions dispatched back to the right agent session. Buttons that carry a
  decision rewrite their own card into an audit record and can't be clicked
  twice.
- **Slash commands as cards** — `/status`, `/help`, `/model`, `/think` etc. are
  answered with tap-to-run command cards (the `/model` and `/think` cards are
  interactive pickers), gated by the same sender allowlist.
- **Files both ways** — send a file to the bot and the agent receives it locally;
  the agent can send files and rendered diagrams back into the chat, from a
  sanctioned outbound directory with an extension allowlist.
- **Webex-aware formatting** — replies auto-chunk at safe byte boundaries and
  thread under the first message; markdown tables are rewritten into aligned
  code blocks (Webex renders no pipe tables); group replies @mention the
  requester.
- **Secure by default** — `dmPolicy` defaults to `deny`; the allowlist applies
  uniformly to direct **and** group rooms; outbound files are confined to
  allowlisted directories and extensions; progress output passes best-effort
  secret redaction.

## How it works

```
OpenClaw gateway (this plugin)
    │  1. register device        POST wdm-a.wbx2.com   (bot token)
    │  2. hold open              wss://…wbx2.com:443   ← Cisco pushes events
    │  3. fetch content          GET  webexapis.com    (bot token)
    ▼
agent dispatch → reply → POST webexapis.com/v1/messages
```

Everything is outbound HTTPS/WSS on port 443, authenticated with the bot token.
There is no inbound endpoint: nothing to expose, tunnel, or sign. Event payloads
carry only IDs — message content is always fetched from the Webex API, never
trusted from the push. If the socket drops (or answers pings without delivering
events), the plugin re-registers and reconnects automatically.

## Prerequisites

- **Node.js ≥ 22** — the transport uses the built-in global `WebSocket`/`FormData`.
- **A running OpenClaw gateway (2026.8+)** with at least one agent configured.
- **Outbound HTTPS/WSS on port 443** to `*.wbx2.com` and `webexapis.com`. No
  inbound rules needed.
- **A Webex bot access token** (see below).

Runtime npm dependency: `node-fetch` (installed via `npm install`). Everything
else the plugin uses is built into Node ≥ 22.

### Creating a Webex bot

1. Sign in at **[developer.webex.com](https://developer.webex.com)** with the
   account that should own the bot.
2. Go to **My Webex Apps → Create a New App → Create a Bot**.
3. Give it a name, username, and icon. On creation, Webex shows a **bot access
   token once** — copy it now; it isn't shown again (regenerate later under the
   bot's page if lost). This is the `token` in the config below.
4. **Add the bot to a space:** in the Webex app, open (or create) a space and
   add the bot by its `…@webex.bot` address. In group spaces the bot only sees
   messages that **@mention** it.
5. **Allowlist your users:** put the emails (or person IDs) that may talk to the
   bot in `allowFrom` — the bot ignores everyone else by default.

## Quick start

```bash
git clone https://github.com/eriknihlen/openclaw-webex.git
cd openclaw-webex
npm install
npm run build
./scripts/deploy.sh    # rsync dist/ into ~/.openclaw/extensions/webex/ + restart gateway
```

Minimal configuration in `openclaw.json`:

```jsonc
{
  "channels": {
    "webex": {
      "enabled": true,
      "token": "<bot access token>",          // developer.webex.com → My Apps → Bot
      "dmPolicy": "allowlisted",
      "allowFrom": ["alice@example.com", "bob@example.com"]
    }
  }
}
```

That's the whole setup — no webhook URL, no signing secret, no reverse proxy.

<details>
<summary><b>Multi-bot setup with per-bot agent routing</b></summary>

```jsonc
{
  "channels": {
    "webex": {
      "enabled": true,
      "dmPolicy": "allowlisted",
      "allowFrom": ["alice@example.com"],
      "accounts": {
        "ops-bot":    { "token": "<token>", "agent": "main" },
        "report-bot": { "token": "<token>", "agent": "reports" }
      }
    }
  }
}
```

`accounts.<id>.*` keys override section-level values per bot.

</details>

## Configuration reference

| Key | Type | Default | Description |
|---|---|---|---|
| `enabled` | bool | `false` | Master switch for the channel. |
| `token` | string | — | Webex bot access token. |
| `dmPolicy` | enum | `"deny"` | `allow` · `deny` · `allowlisted` · `pairing`. Applies to all room types. |
| `allowFrom` | string[] | `[]` | Person IDs or emails permitted when `dmPolicy` is `allowlisted`. |
| `agent` | string | `"main"` | OpenClaw agent id this bot dispatches to. |
| `apiBaseUrl` | string | `https://webexapis.com/v1` | Override for non-cloud Webex deployments. |
| `maxRetries` | number | `3` | Retry attempts on retryable API failures. |
| `retryDelayMs` | number | `1000` | Base for exponential backoff. |
| `progressVerbosity` | enum | `"detailed"` | `silent` · `minimal` · `detailed`. |
| `progressPlaceholderText` | string | `"Working on it…"` | Initial progress line. |
| `progressHeartbeatMs` | number | `300000` | "Still working…" refresh interval; `0` disables. |
| `progressStreamReasoning` | bool | `false` | Stream the agent's reasoning tail into the progress message (opt-in). |
| `showProgressPlaceholder` | bool | `true` | `false` disables progress output entirely. |

## Adaptive Cards

```ts
import { approvalCard, validateForWebex } from "openclaw-webex";

const card = approvalCard({
  title: "Approve deployment?",
  body: "Push the new policy to production?",
  includeNotes: true,
  data: { intent: "deploy-approval", releaseId: "v1.4.2" },
});
validateForWebex(card);   // rejects elements Webex's server would refuse

return { to: roomId, content: { card }, parentId };
```

Button presses arrive back at the agent as a structured card-submission message;
`ctxPayload.CardSubmission` exposes the raw `{ actionId, messageId, inputs }`.
An optional `__openclawSessionKey` in the submit data routes the response to a
specific session for cross-room flows.

## Development

```bash
npm run build                    # tsc → dist/
npm run dev                      # tsc --watch
npm run deploy                   # build + rsync + gateway restart
npm run deploy -- --no-restart   # build + rsync only
```

A healthy deploy logs:

```
[webex] [<account>] starting Webex provider (websocket mode)
[webex] [<account>] mercury websocket transport started (no inbound endpoint)
[webex:<account>] mercury websocket connected
```

`scripts/deploy.sh` targets `~/.openclaw/extensions/webex/` by default;
override with `OPENCLAW_WEBEX_TARGET`. `dist/` is committed, so a clean
checkout is runtime-consumable without a build.

## Repository layout

```
src/
├── websocket.ts       Mercury WebSocket transport (device registration,
│                      keepalive, reconnect, daily refresh)
├── webhook.ts         Event validation, allowlist, fetch, normalization
├── channel-plugin.ts  OpenClaw glue: accounts, dispatch, progress wiring
├── send.ts            REST client + rate limiting + message editing
├── progress.ts        Edit-in-place progress reporter
├── card-builder.ts    Adaptive Card templates + Webex validator
├── formatters.ts      Markdown helpers (escape, chunk, table rewrite)
├── download.ts        Inbound attachment download (MIME allowlist, 423 retry)
├── outbound-file-guard.ts  Path/extension gate for files the agent sends out
├── people-cache.ts    People lookup cache
└── types.ts           Shared types
```

## License

[MIT](./LICENSE)

## Acknowledgements

Originally derived from the [`@jimiford/webex`](https://www.npmjs.com/package/@jimiford/webex)
npm package by Jimi Ford (MIT). Since extensively extended and rewritten:
Adaptive Cards, live progress reporting, attachment handling, sender
allowlisting, and the Mercury WebSocket transport are additions of this fork.
