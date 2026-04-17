# LMBR.ai Smoke Tests

End-to-end integration tests for the bid lifecycle. These are
**permanent CI fixtures** — not throwaway scripts. Run before every
prompt that touches ingest, routing, consolidation, vendor dispatch,
comparison, margin, or quote generation.

## Two modes

### Option A — `scripts/smoke-e2e.ts` (service-role offline)

Drives the pipeline via direct helper calls (agents + loaders). Bypasses the
Next.js HTTP layer so you don't need a running dev server. Fastest feedback
(~10s). Catches business-logic bugs.

**Requires:** `.env.local` with `SUPABASE_SERVICE_ROLE_KEY`, `NEXT_PUBLIC_SUPABASE_URL`,
`ANTHROPIC_API_KEY`.

**Run:**

```bash
pnpm tsx scripts/smoke-e2e.ts
```

### Option B — `scripts/smoke-e2e-http.ts` (HTTP route integration)

Hits the real `/api/*` routes through the running dev server. Catches route-
handler bugs, request/response shape drift, and middleware issues that Option A
can't. Slower (~15-20s), and requires manual cookie copy.

**Requires:**

1. `.env.local` (same as Option A), plus `VENDOR_TOKEN_SECRET` (auto-synthesized if missing).
2. Dev server running: `pnpm dev` in one terminal.
3. A logged-in Supabase user in Chrome/Firefox whose role includes `buyer`, `trader_buyer`, `manager`, or `owner`. Step 9 (release) additionally requires `manager` or `owner` — if the user is buyer-only the test reaches Step 9 then fails with HTTP 403, which is still a useful signal.
4. The session cookie exported as `SESSION_COOKIE`.

**Getting the session cookie:**

1. Open DevTools -> Application (Chrome) or Storage (Firefox) -> Cookies -> `http://localhost:3000`.
2. Find the cookie named `sb-<project-ref>-auth-token` (or both `sb-access-token` and `sb-refresh-token` on older setups).
3. Copy the full cookie string. A fast way: DevTools -> Network -> any request -> Headers -> Request Headers -> `Cookie:` line -> copy the whole value after `Cookie: `.
4. Export it:

   ```bash
   export SESSION_COOKIE='sb-foo-auth-token=eyJhbGciOi...; other-cookie=...'
   ```

   (Use single quotes so the shell doesn't mangle special chars.)

**Side effects during run:**

- Script temporarily sets the user's company `approval_threshold_dollars` to $10,000 and restores it in cleanup. If your test environment uses this value in production-ish ways, be aware.
- Script inserts one `[SMOKE-TEST-HTTP]`-prefixed vendor in the cookie user's company; removed in cleanup.
- The ingest step uploads one xlsx to Storage under `bids-raw/<company>/...`. The cleanup routine does not delete this object (the `/api/ingest` response doesn't echo the storage path). Storage-GC for orphaned smoke objects is Prompt 12 territory. The bid row and all child records ARE cleaned up.

**Run:**

```bash
pnpm tsx scripts/smoke-e2e-http.ts
```

## What each script covers

| Step | Surface tested | A | B |
|------|---|---|---|
| 1 - Ingest | Excel parse, bid creation, extraction_costs | helper | HTTP (multipart) |
| 2 - Routing | commodity routing, bid_routings persistence | helper | HTTP |
| 3 - Consolidation (HYBRID) | consolidation_agent, source_line_item_ids | helper | HTTP |
| 4 - Vendor dispatch | vendor_token, vendor_bids row | helper | HTTP |
| 5 - Vendor pricing | vendor_bid_line_items ingest | direct insert | HTTP (public token-auth) |
| 6 - Comparison | loadComparison, bestVendorId | helper | HTTP |
| 7 - Margin | pricingAgent, taxes, approval gate | helper | HTTP |
| 8 - PDF | renderQuotePdfBuffer, vendor-leak audit | helper | HTTP (preview) |
| 9 - Quote release | canReleaseQuote, next_quote_number, Storage | helper | HTTP |

## Invariants the smoke suite locks

- **Vendor-free customer PDF (in practice, not just types):** Step 8 parses the rendered PDF text layer with pdf-parse and asserts vendor name / cost literal / field names are absent.
- **HYBRID structure preserved end-to-end:** House 1 / House 2 / House 3 headings must appear in the customer-facing PDF.
- **CA tax applied:** job_state='CA' triggers both CA lumber assessment and state sales tax.
- **Approval gate fires:** margin run on a CA job with $10K threshold pushes the quote to pending_approval.
- **Release gate fires:** Option B Step 9 exercises the real release path — quote number allocated, PDF uploaded, `quotes.pdf_url` populated, `quotes.status='approved'`.
- **Cleanup drains on pass and fail:** both scripts run cleanup in `finally`; the SMOKE prefix makes leaked records identifiable.

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| Step 1 fails "Bid status 'X' does not accept margin stacking" | Bid.status out of expected range. Inspect bid row, confirm routing ran. |
| Step 6 fails "bestVendorId null" | is_consolidated filter regressed — check `loadComparison` in `apps/web/src/lib/compare/load-comparison.ts`. |
| Step 8 fails "vendor name in PDF" | QuotePdfInput type has a vendor field it shouldn't, OR buildQuotePdfInput is passing vendorName through. Audit the diff. |
| Option B fails Preflight 401 | `SESSION_COOKIE` expired or wrong domain — log in again and re-copy. |
| Option B fails Preflight "Cookie doesn't look like a Supabase session" | You copied the wrong cookie. Must contain `sb-...` and a JWT in the access-token position. |
| Option B fails Step 1 with "queued mode" | `REDIS_URL` is set in the dev server environment — unset it so the HTTP path stays inline. Queued mode would need a worker + polling, which is out of scope for smoke. |
| Option B fails Step 4 with "vendor_not_found" | Seed vendor wasn't created for the cookie user's company. Inspect service-role logs. |
| Option B fails Step 7 "needsApproval must be true" | Seed's `approval_threshold_dollars=10000` override didn't stick. Inspect the service-role UPDATE return. |
| Option B fails Step 9 with 403 | Cookie user lacks `manager` or `owner`. Release is gated to those roles. |

## CI integration (future)

Both scripts exit 1 on failure, 0 on success. Option A can be wired into CI today (needs Supabase test project + service-role key as GitHub secret). Option B needs a pre-step that logs in a test user and exports the session cookie — doable via Playwright or a headless auth flow. Not wired yet.

## Manual verification — Outlook webhook (Prompt 08 Step 2)

No automated smoke yet. Graph subscriptions need a publicly reachable HTTPS URL and a live Microsoft 365 mailbox, neither of which we mock. Exercise once per prompt touching `apps/web/src/app/api/webhook/outlook` or `packages/lib/src/outlook.ts`.

**IMPORTANT — account type requirement:**

Graph webhook subscriptions require a Microsoft 365 work/school account. Personal Microsoft accounts (outlook.com, hotmail.com, live.com) are not supported by Graph change notifications. Validation handshake confirmed working (validationToken 200 OK). Subscription creation code is correct — limitation is account type only. For local testing, sign up for a free M365 developer account at: https://developer.microsoft.com/microsoft-365/dev-program

**Prerequisites:**

- Dev server exposed at a public HTTPS URL (ngrok, Cloudflare Tunnel, or deployed preview).
- A test Microsoft 365 mailbox for a user who has completed the `/settings/integrations` OAuth flow (Step 6 lands this page).
- `.env.local` has: `MICROSOFT_*`, `OUTLOOK_TOKEN_ENCRYPTION_KEY`, `OUTLOOK_CLIENT_STATE_SECRET`, `NEXT_PUBLIC_APP_URL` (must match the tunneled HTTPS URL).

**Steps:**

1. Create a subscription:
   ```ts
   import { createSubscription } from '@lmbr/lib';
   await createSubscription(USER_ID, COMPANY_ID, 'test-mailbox@your-tenant.onmicrosoft.com');
   ```
   Expect: a row in `public.outlook_subscriptions` with `status='active'` and `expiration_datetime` ~3 days out. Graph called your webhook with `?validationToken=...`; the creation only succeeds if the 200 text/plain handshake worked.

2. Send a test email to that mailbox with a real lumber list attachment (PDF or XLSX). Use `bids@` convention if you've set it up; otherwise any To: address on the mailbox works.

3. Within ~30 seconds, verify:
   - A row appears in `public.bids` with `message_id` populated and `status` advancing through `'extracting'` → `'received'`.
   - The attachment was uploaded to the `bids-raw` bucket (path: `{companyId}/{uuid}{.ext}`).
   - An auto-reply landed in the sender's inbox, threaded off the original.

4. Resend the same email (or have Graph redeliver the notification — can be forced by PATCHing `expirationDateTime` then waiting). Verify no duplicate bid is created; the logs show `[outlook] duplicate ignored`.

5. Test the renewal endpoint:
   ```
   curl -X POST https://your-host/api/webhook/outlook/renew \
     -H "Authorization: Bearer $OUTLOOK_RENEWAL_SECRET"
   ```
   Expect: `{ scanned, renewed, recreated, failed, errors }`. On an unauthenticated call expect 401 with body `{ "error": "Unauthorized" }` — no leak of whether the secret env var is even set.

6. Tear down:
   ```ts
   import { getGraphClient } from '@lmbr/lib';
   const client = await getGraphClient(USER_ID, COMPANY_ID);
   await client.api(`/subscriptions/${SUBSCRIPTION_ID}`).delete();
   // Then clean the DB row:
   // DELETE FROM outlook_subscriptions WHERE subscription_id = '...';
   ```

**What to look for in logs:**

| Message | Meaning |
|---|---|
| `outlook webhook: unknown subscriptionId=...` | Subscription row missing — cleanup ran out of order, or the webhook was called for a sub we never registered. |
| `outlook webhook: clientState mismatch for subscriptionId=...` | Someone POSTed without the per-sub secret. Treat as an attempted forgery. |
| `[outlook] duplicate ignored: company=... message=...` | Idempotency worked. Graph redelivered and we correctly skipped. |
| `[outlook] skipping attachment '...' with unsupported type=...` | Attachment MIME not in the SUPPORTED_MIME_TYPES allowlist. Expected for email signatures, inline images. |
| `outlook webhook background: ...` | Background bid creation failed after the 202 returned. Surface in ops dashboards — these are silent otherwise. |
| `outlook.createSubscription: row insert failed after Graph create — subscription ... leaked` | Graph has the subscription but our DB doesn't. Manually `DELETE /subscriptions/{id}` at Graph. |
