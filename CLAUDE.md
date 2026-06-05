# CLAUDE.md — Tennis Court Booker

Cloudflare Worker that checks Virgin Active court availability and auto-books via Telegram bot.

## Project layout

```
src/index.js      — single Worker file, all logic
wrangler.toml     — Cloudflare config, KV binding, cron trigger
package.json      — wrangler dev dependency only
```

## Deploy

```bash
npx wrangler deploy
```

No build step. The worker is deployed as-is.

## Secrets (never committed)

Set via `wrangler secret put <NAME>` in a real terminal (not a non-TTY pipe — it will silently store an empty string):

| Secret | Description |
|---|---|
| `VA_USERNAME` | Virgin Active member ID (format: `47p183688`) |
| `VA_PASSWORD` | Virgin Active password |
| `TELEGRAM_BOT_TOKEN` | Bot token from @BotFather |
| `TELEGRAM_GRPCHAT_ID` | Telegram group chat ID to send notifications to |

## KV namespace

Binding name: `STATE`  
ID in `wrangler.toml`: `1d76c77c24a242f2b35773b39b3fa689`

Key reference:

| Key | Contents |
|---|---|
| `auth:token` | Cached JWT + loyalty token + exp (1hr TTL) |
| `next-check-time` | Epoch ms of next scheduled check |
| `last-run` | ISO timestamp of last completed check |
| `booking-pref` | `{from, to, days[]}` active auto-booking preference |
| `slot-log` | Rolling JSON array of last 30 checks that found slots |
| `auth-error-notified` | Set to "1" when auth error Telegram message has been sent |
| `api-error-notified` | Set to "1" when API error Telegram message has been sent |
| `notified:8` / `notified:12` / `notified:20` | Date string of last daily summary sent at that hour |
| `convo:{chatId}` | Multi-step Telegram conversation state with TTL |

## Virgin Active API (private, reverse-engineered via mitmproxy)

Base: `https://vapi.virginactive.com/vapi/2.0.1`

**Login** — `POST /sessions`
```json
{ "memberId": "...", "password": "..." }
```
Returns `{ token, refreshToken }`. The `token` is a JWT with `exp` in its payload.

**Loyalty token** — `GET /member` (with `x-auth-token` header)  
Returns member profile; `member.loyalty` is a JWT used as `x-loyalty` header on all subsequent calls.

**Auth headers on all API calls:**
- `x-auth-token: <token>`
- `x-loyalty: <loyaltyToken>`
- Plus all `STATIC_HEADERS` constants in `src/index.js`

**Court availability** — `GET /clubs/47/activity/41601?date=YYYY-MM-DD`  
Returns array of `{ isAvailable: bool, resourceKey: { club: 47, id: 203 }, time: "HH:MM" }`.  
Checked for each date in the 7-day booking window.

**Get courts for a slot** — `GET /clubs/47/activity/41601/resources?date=DATE&time=HH:MM`  
Returns available courts with names.

**Book** — `POST /clubs/47/activity/41601/resources/{resourceKeyId}/bookings?date=DATE&time=HH:MM`
```json
{ "activityId": 41601, "resourceKey": 203, "date": "YYYY-MM-DD", "startTime": "HH:MM", "duration": "60" }
```
`resourceKey` in the URL and POST body is the **numeric id only** (e.g. `203`), not the full `{club, id}` object.

Club ID for Fulham Pools: `47`  
Activity ID for Play Tennis Outdoors: `41601`

## Scheduling logic

- Cron heartbeat: `*/5 * * * *` (every 5 min) — most ticks are no-ops
- Active window: 07:30–20:30 London time
- Checks run on a randomised 15–45 min delay stored in `next-check-time` KV
- Exception: always runs at 07:30–07:35 London time (booking release window) regardless of random timer

## Notification rules

- **Slots found** → notify immediately
- **Booking made or failed** → notify immediately  
- **No slots found** → notify only at 08:00, 12:00, 20:00 London time (once per window per day)
- **Auth / API error** → notify once per failure window (flag stored in KV, cleared on recovery)

## Telegram bot commands

| Command | What it does |
|---|---|
| `/book` | Interactive flow — inline keyboard for time window + day selection |
| `/book status` | Show active booking preference |
| `/book cancel` | Clear booking preference |
| `/next` | When is the next scheduled check |
| `/last` | When did the last check run |
| `/log` | Last 10 checks that found open slots, with preference and match info |
| `/help` | List all commands |

Webhook path: `/webhook/{TELEGRAM_BOT_TOKEN}` — register with:
```bash
curl "https://api.telegram.org/bot{TOKEN}/setWebhook?url=https://virgin-active-booker.n-saduagkan.workers.dev/webhook/{TOKEN}"
```

## Common tasks

**Clear auth cache to force re-login:**
```bash
npx wrangler kv key delete --binding STATE "auth:token" --remote
```

**Clear auth error flag so Telegram re-notifies on next failure:**
```bash
npx wrangler kv key delete --binding STATE "auth-error-notified" --remote
```

**Check what booking preference is set:**
```bash
npx wrangler kv key get --binding STATE "booking-pref" --remote
```

**Tail live logs:**
```bash
npx wrangler tail --format pretty
```

## Known gotchas

- `wrangler secret put` must be run in a real TTY — piping stdin stores empty strings silently
- The `resourceKey` from the resources endpoint is `{club, id}` — only pass `.id` to the booking URL and body
- The VA app's login endpoint is `vapi.virginactive.com/vapi/2.0.1/sessions`, not the Azure APIM domain that appears in the JWT `iss` claim
- Mitmproxy traffic capture requires the certificate to be trusted at the OS level; Proxyman free tier only shows CONNECT tunnels for HTTPS
