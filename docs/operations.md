# LMBR.ai Operations Runbook

Ops reference for running LMBR.ai in production. Covers the cron-driven
back-office jobs. Kept deliberately short — the code is authoritative,
this file tells you what to wire up and how to verify it's alive.

## Scheduled Jobs

LMBR.ai has two scheduled back-office targets. Both are plain HTTP
endpoints with a shared-secret Bearer token. Run them with whatever
scheduler your deploy target supports (Vercel Cron, system crontab,
GitHub Actions, Cloud Scheduler, etc). Both endpoints are idempotent —
re-runs are safe.

| Endpoint                          | Cadence    | Secret                    | Purpose                                                   |
|-----------------------------------|------------|---------------------------|-----------------------------------------------------------|
| `POST /api/market/aggregate`      | Daily      | `MARKET_AGGREGATE_SECRET` | Roll up the day's vendor bids into the Cash Market Index. |
| `POST /api/webhook/outlook/renew` | Every 6h   | `OUTLOOK_RENEWAL_SECRET`  | Renew Graph change-notification subscriptions.            |

### Why these cadences

- **Market aggregate — daily, after midnight UTC.** The aggregation reads
  that calendar day's `vendor_bid_line_items` rows and writes one row
  per snapshot slice. Running more often than once a day wastes writes
  with no new signal. Running less than daily delays the Cash Index.
- **Outlook renew — every 6 hours.** Graph change-notification
  subscriptions expire after ~72 hours. The renewer only touches
  subscriptions within 48h of expiry, so the effective schedule is
  "wake up 4× a day and top up anything that's close." Less frequent
  is risky — a missed wake-up plus a slow re-schedule could strand a
  subscription past expiry, silently killing the bids@ inbox webhook.

### Bearer token setup (one-time, per environment)

Both targets expect `Authorization: Bearer ${SECRET}` and compare in
constant time. Generate the secrets once per environment:

```bash
# 32-byte hex (preferred — matches other LMBR secrets)
openssl rand -hex 32

# Node one-liner, equivalent
node -e 'console.log(require("crypto").randomBytes(32).toString("hex"))'
```

Put them in the app runtime env:

```bash
# apps/web/.env.local (dev) / Vercel env (prod) / etc.
MARKET_AGGREGATE_SECRET=<hex-32>
OUTLOOK_RENEWAL_SECRET=<hex-32>
```

The cron config that calls these endpoints needs the same values.
Configure them once, keep them in a vault, rotate by shipping a new
hex value to **both** the app env and the cron config in the same
window.

### Vercel Cron (recommended for Vercel deploys)

Vercel Cron hits your endpoints on a `vercel.json` schedule. It sends
an `Authorization: Bearer $CRON_SECRET` header using a secret you set
in the Vercel dashboard. The trick: Vercel Cron uses a single
`CRON_SECRET` for every job, so set our two targets to validate
against the same secret rather than two separate ones. Either:

**Option A — unify on `CRON_SECRET`:**

```json
// vercel.json
{
  "crons": [
    { "path": "/api/market/aggregate",      "schedule": "15 2 * * *" },
    { "path": "/api/webhook/outlook/renew", "schedule": "0 */6 * * *" }
  ]
}
```

Then in the Vercel project env:

```
CRON_SECRET=<hex-32>
MARKET_AGGREGATE_SECRET=$CRON_SECRET
OUTLOOK_RENEWAL_SECRET=$CRON_SECRET
```

Vercel's env reference expansion populates both app-side variables
from the same source of truth.

**Option B — keep secrets distinct (preferred for multi-host):**

Use an external scheduler (GitHub Actions, Cloud Scheduler, a plain
crontab on a bastion) and set each job's Authorization header from
its own secret. See the next section.

### Plain crontab (self-hosted, GitHub Actions, GCP Cloud Scheduler)

Every scheduler that can issue an HTTP POST with headers works. Core
pattern for any of them:

```bash
# Daily at 02:15 UTC — Cash Index aggregation
15 2 * * * curl -sS -X POST \
  -H "Authorization: Bearer ${MARKET_AGGREGATE_SECRET}" \
  "https://app.lmbr.ai/api/market/aggregate" \
  >> /var/log/lmbr-cron.log 2>&1

# Every 6 hours at :00 — Outlook subscription renewal
0 */6 * * * curl -sS -X POST \
  -H "Authorization: Bearer ${OUTLOOK_RENEWAL_SECRET}" \
  "https://app.lmbr.ai/api/webhook/outlook/renew" \
  >> /var/log/lmbr-cron.log 2>&1
```

The cron cadences:

- `15 2 * * *` — 02:15 UTC every day (offsets from midnight so upstream
  data has settled)
- `0 */6 * * *` — 00:00, 06:00, 12:00, 18:00 UTC every day

### GitHub Actions (zero-infra fallback)

If you don't have a scheduler, a pair of workflow files works fine.
Store the secrets as repository secrets (`MARKET_AGGREGATE_SECRET`,
`OUTLOOK_RENEWAL_SECRET`) and reference them in the workflow.

```yaml
# .github/workflows/market-aggregate.yml
name: Market aggregate
on:
  schedule:
    - cron: '15 2 * * *'
jobs:
  run:
    runs-on: ubuntu-latest
    steps:
      - run: |
          curl -sS -X POST \
            -H "Authorization: Bearer ${{ secrets.MARKET_AGGREGATE_SECRET }}" \
            "${{ secrets.APP_URL }}/api/market/aggregate"
```

```yaml
# .github/workflows/outlook-renew.yml
name: Outlook subscription renew
on:
  schedule:
    - cron: '0 */6 * * *'
jobs:
  run:
    runs-on: ubuntu-latest
    steps:
      - run: |
          curl -sS -X POST \
            -H "Authorization: Bearer ${{ secrets.OUTLOOK_RENEWAL_SECRET }}" \
            "${{ secrets.APP_URL }}/api/webhook/outlook/renew"
```

### Verifying the wiring

**Market aggregate** — POST it manually with the secret and inspect
the response:

```bash
curl -sS -X POST \
  -H "Authorization: Bearer ${MARKET_AGGREGATE_SECRET}" \
  "https://app.lmbr.ai/api/market/aggregate" | jq
```

Healthy response on a fresh install:

```json
{ "success": true, "sampleDate": "2026-04-20", "slicesWritten": 0,
  "slicesBelowFloor": 7, "durationMs": 312 }
```

`slicesBelowFloor` is informational — it tells you how many slices
have bid data but aren't yet above the 3-buyer anonymization floor
(the Cash Index won't surface them until they cross it).

**Outlook renew** — same pattern, different secret:

```bash
curl -sS -X POST \
  -H "Authorization: Bearer ${OUTLOOK_RENEWAL_SECRET}" \
  "https://app.lmbr.ai/api/webhook/outlook/renew" | jq
```

Healthy response:

```json
{ "scanned": 4, "renewed": 2, "recreated": 0, "failed": 0, "errors": [] }
```

If `failed > 0`, inspect `errors[]` — usually a re-auth is needed on
the affected tenant's Outlook connection.

### What NOT to do

- Don't run either target on `5xx` retry. They're idempotent but a
  retry storm against an already-degraded DB makes things worse. Both
  routes return `200 { success: false }` on internal failure for
  exactly this reason — the only non-2xx is the auth gate.
- Don't leak the secret into client-side code or git history. If a
  secret is exposed, generate a new one, update app env, and update
  the scheduler in the same window.
- Don't skip renewing on dev environments. The M365 Graph subscription
  tied to your dev ngrok URL will die after 72h and stop delivering
  webhook notifications — you'll assume the ingest code is broken when
  the upstream subscription is actually just expired.
