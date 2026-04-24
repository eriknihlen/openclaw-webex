# openclaw-webex

OpenClaw channel plugin for Cisco Webex. Multi-agent dispatch, AdaptiveCards, hardened webhook lifecycle, and rich live progress reporting.

---

## What you get

**Multi-agent dispatch.** One OpenClaw gateway can host any number of named Webex bots, each routed to its own agent (`agent: "main"`, `agent: "ops-bot"`, etc.). Inbound messages and card submissions reach the right agent's session via SessionKey prefix routing.

**Resilient webhook lifecycle.** Registration uses `PUT /webhooks/{id}` to refresh existing rows in place rather than `DELETE` + `POST`, which sidesteps Webex's heavy `/webhooks` DELETE rate limit (we observed `Retry-After` up to 755 s in production). Provider lifetime is anchored to `ctx.abortSignal`, so the runtime never thinks a webhook-mode bot has "finished" and restarts it on a loop.

**Rich live progress.** As the agent moves through reasoning → tool calls → writing, the bot shows what's happening in chat:

- **`Reading` `` `/path/to/file` ``**, **`Running` `` `git status` ``**, **`Searching for` `` `pattern` ``**, **`Spawning agent`** *task name*, etc.
- For the first ~8 transitions, **the same message edits in place** (`PUT /messages/{id}`); after that the reporter switches to append so the Webex 10-edit cap can't be hit.
- Reasoning-stream tail can be opt-in streamed live (`progressStreamReasoning: true`), with markdown-aware truncation and stripped backticks/asterisks so a stray token in the model's deliberation can't break the renderer.
- Per-tool argument detail is extracted (file paths, commands, search patterns), so users see "**Running** `git status`" instead of "Running tool `Bash`".

**Webex-aware reply formatting.**

- Replies > 7200 bytes auto-chunk on paragraph → sentence → word → hard-slice boundaries; chunks 2..N thread under the first.
- Markdown pipe-tables in agent output are rewritten as aligned monospace code blocks (Webex doesn't render `|`-tables).
- Auto-`@mention` of the requester on the first chunk in group rooms (DMs skip — Webex ignores it there).
- `text` field is always set alongside `markdown` so non-markdown clients get a readable fallback.

**AdaptiveCards builders & button submissions.**

- Three ready-to-use card templates (`factCard`, `statusCard`, `approvalCard`) emit Webex-compatible AdaptiveCards 1.3.
- Local `validateForWebex(card)` rejects elements Webex's server-side validator would reject (`Media`, `Action.Execute`, `verticalContentAlignment`, `height` on `ColumnSet`, > 20 top-level actions) — surfaces violations before the API round-trip.
- Plugin registers `attachmentActions` webhooks. Button presses are fetched via `GET /attachment/actions/{id}`, flattened into a synthetic message, and dispatched to the agent the room is already bound to.
- Optional `__openclawSessionKey` field on a card's submit data routes the response to a specific session — useful for cross-room flows (post a card in one space, route the answer to a session in another).

**Hardened auth path.**

- HMAC-SHA1 webhook signature verification (`webhookSecret`); when configured, an absent `X-Spark-Signature` header is rejected (no silent bypass).
- Length-checked `crypto.timingSafeEqual` so malformed signatures surface as 401 not 500.
- `dmPolicy` defaults to `"deny"`; the allowlist gate applies uniformly to direct *and* group rooms.

**Inbound attachment ingest.** Webex file URLs require the bot token; the plugin downloads them with a MIME allowlist and configurable size cap, surfaces the local path to the agent as `MediaPath` / `MediaPaths`, and reaps temp files after dispatch.

**Async webhook ACK.** Webex retries POSTs that haven't ACKed within ~10 s. The handler responds `200` immediately and dispatches the agent in the background, so a multi-minute reply never causes duplicate work.

---

## Install

Install directly from GitHub:

```bash
npm install github:eriknihlen/openclaw-webex
# or
npm install git+https://github.com/eriknihlen/openclaw-webex.git
```

OpenClaw discovers the plugin via the `openclaw` block in `package.json` — no manifest editing needed.

To run from a checkout:

```bash
git clone https://github.com/eriknihlen/openclaw-webex.git
cd openclaw-webex
npm install
npm run build
./scripts/deploy.sh   # rsync dist/ to ~/.openclaw/extensions/webex/ + restart the gateway
```

`dist/` is committed to the repo, so a clean checkout is runtime-consumable without `npm install` if you only need the built artifacts.

---

## Configure

Minimal single-bot setup in `openclaw.json`:

```jsonc
{
  "channels": {
    "webex": {
      "enabled": true,
      "token": "<bot access token>",
      "webhookUrl": "https://<your-public-host>/webhooks/webex/default",
      "webhookSecret": "<32-byte hex>",
      "dmPolicy": "allowlisted",
      "allowFrom": ["alice@example.com", "bob@example.com"]
    }
  }
}
```

Multi-bot setup with per-bot agent routing:

```jsonc
{
  "channels": {
    "webex": {
      "enabled": true,
      "dmPolicy": "allowlisted",
      "allowFrom": ["alice@example.com", "bob@example.com"],
      "accounts": {
        "ops-bot": {
          "token": "<ops bot token>",
          "webhookUrl": "https://host/webhooks/webex/ops-bot",
          "webhookSecret": "<secret>",
          "agent": "main",
          "progressVerbosity": "detailed",
          "progressStreamReasoning": true
        },
        "report-bot": {
          "token": "<report bot token>",
          "webhookUrl": "https://host/webhooks/webex/report-bot",
          "webhookSecret": "<secret>",
          "agent": "reports",
          "progressVerbosity": "detailed"
        }
      }
    }
  }
}
```

### All config keys

| Key | Type | Default | Meaning |
|---|---|---|---|
| `enabled` | bool | `false` | Master switch for the channel. |
| `token` | string | — | Webex bot access token (`https://developer.webex.com/`). |
| `webhookUrl` | string | — | Public URL Webex posts to. The path suffix (`…/webex/<accountId>`) is significant. |
| `webhookSecret` | string | — | Strong random secret. When set, signatures are verified and unsigned requests are rejected. |
| `dmPolicy` | enum | `"deny"` | `allow` / `deny` / `allowlisted` / `pairing`. Applies to all room types, not just DMs. |
| `allowFrom` | string[] | `[]` | Person IDs or emails permitted to message the bot when `dmPolicy` is `allowlisted`. |
| `apiBaseUrl` | string | `https://webexapis.com/v1` | Override for non-cloud Webex deployments. |
| `maxRetries` | number | `3` | Retry attempts on retryable Webex API failures. |
| `retryDelayMs` | number | `1000` | Base for exponential backoff. |
| `agent` | string | `"main"` | OpenClaw agent id this bot dispatches to. |
| `progressVerbosity` | enum | `"detailed"` | `silent` / `minimal` / `detailed`. |
| `progressPlaceholderText` | string | `"Working on it…"` | First-line text. |
| `progressHeartbeatMs` | number | `300000` | Refresh "still working…" every N ms during long runs. `0` disables. |
| `progressStreamReasoning` | bool | `false` | Stream reasoning-stream tail into the progress message. Opt-in — best-effort secret redaction. |
| `showProgressPlaceholder` | bool | `true` | Off → no progress at all. |

`accounts.<id>.*` keys override the section-level values for a specific bot.

---

## Programmatic use

The plugin's helpers are exported so skills / agent code can build Webex-shaped output directly:

```ts
import {
  factCard,
  statusCard,
  approvalCard,
  validateForWebex,
  splitForWebex,
  escapeMarkdown,
  mentionMarkdown,
  transformMarkdownForWebex,
} from "openclaw-webex";

// A weekly report card
const card = factCard({
  title: "Weekly Status — 2026-04-24",
  subtitle: "Project XYZ",
  facts: [
    { title: "Milestones hit", value: "3 of 4" },
    { title: "Blockers",       value: "1 (cert renewal)" },
    { title: "Next focus",     value: "phase-2 rollout" },
  ],
  actions: [
    { type: "Action.OpenUrl", title: "Open project", url: "https://example.com/proj" },
  ],
});
validateForWebex(card);

// An approval card whose submission routes back to the same room
const approve = approvalCard({
  title: "Approve deployment?",
  body: "Push the new policy to production?",
  includeNotes: true,
  data: { intent: "deploy-approval", releaseId: "v1.4.2" },
});

// Now hand off via OpenClaw's outbound envelope
return {
  to: roomId,
  content: { card },
  parentId,
};
```

When the user clicks **Approve**, the plugin fetches the submission and dispatches it to the agent as a regular message:

```
[card-submission from Alice]
intent: deploy-approval
releaseId: v1.4.2
decision: approve
notes: looks good — proceed
```

`ctxPayload.CardSubmission` exposes the structured `{ actionId, messageId, inputs }` so skills can branch on the raw fields without re-parsing the summary.

---

## Repository layout

```
.
├── src/
│   ├── channel-plugin.ts   # OpenClaw glue, webhook routing, dispatch
│   ├── channel.ts          # WebexChannel high-level wrapper
│   ├── send.ts             # WebexSender REST client + rate limiting
│   ├── webhook.ts          # Signature verify, registration, attachment-actions
│   ├── download.ts         # Inbound attachment download (MIME allowlist)
│   ├── progress.ts         # Hybrid edit-in-place / append progress reporter
│   ├── people-cache.ts     # GET /people/{id} cache
│   ├── card-builder.ts     # AdaptiveCards templates + Webex validator
│   ├── formatters.ts       # Markdown helpers (escape, split, table-rewrite)
│   ├── types.ts            # Shared type defs
│   └── plugin.ts / index.ts
├── dist/                   # Built output (committed; runtime-consumable)
├── scripts/deploy.sh       # build + rsync + restart
├── tsconfig.json
├── package.json
├── openclaw.plugin.json
├── LICENSE
└── README.md
```

---

## Development

```bash
npm install        # dev deps
npm run build      # tsc → dist/
npm run dev        # tsc --watch
npm run deploy     # build + rsync to ~/.openclaw/extensions/webex/ + restart gateway
npm run deploy -- --no-restart   # build + rsync only
npm run deploy -- --no-build     # rsync the existing dist/ only
npm run test       # vitest (when tests are added)
```

`scripts/deploy.sh` targets `$HOME/.openclaw/extensions/webex/` by default; override with `OPENCLAW_WEBEX_TARGET`.

### Verifying a deploy

After `./scripts/deploy.sh`, watch the gateway log for clean registration:

```
[webex] [<account-id>] starting Webex provider (webhook mode)
[webex] [<account-id>] webhooks registered
[webex] [<account-id>] HTTP webhook handler registered at /webhooks/webex/<account-id>
```

No subsequent `auto-restart attempt` lines means the abort-signal lifetime + PUT-in-place webhook registration are both healthy.

The plugin also exposes a health probe:

```bash
curl http://<gateway-host>:18789/webhooks/webex/healthz
# → { "status": "ok", "channel": "webex", "accountCount": 2, "accounts": [...] }
```

---

## License

MIT. See [`LICENSE`](./LICENSE).
