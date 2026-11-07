# Authenticated Relworx wallet — Railway source

## Important: what this package does, and what it cannot do

This is a replacement for the uploaded open payment proxy, not a way to change a Fortebet account's betting balance. It implements a separate, durable UGX payment wallet backed by PostgreSQL. It collects mobile-money deposits and pays withdrawals from that wallet, authenticated per user. No balance is invented. Initiation is not settlement.

**This does not fund Fortebet bets, Fortebet virtual games, or Spribe Aviator.** Those currently launch with Fortebet's account/session and use Fortebet's wallet. Changing the number shown in the header would not change their real-money balance. We found no authorized external wallet adjustment contract in the current project.

For the requested real-game wallet, obtain an authorized operator integration for sportsbook/virtual bets and Spribe (or another authorized casino aggregator). It must define authenticated game launch, player IDs, wallet balance, debit, credit/win, rollback, transaction IDs, signatures, replay protection, settlement and reconciliation. Gaming approval from your payment provider may also be required. This package deliberately has **no fake game-debit/credit endpoint** and returns `gameFundingEnabled: false`.

The existing website has NOT been switched to this service. Deploy it, provide its public URL, then the website's verified sign-in and payment pages must be connected. The game integration remains a separate prerequisite. Do not collect customer funds on the assumption they can be used in those games yet.

## Deploy to Railway

Railway runs projects, not a single pasted script. Keep all files in this ZIP together. You can replace your old backend project's files with these source files, or deploy a separate service first (recommended so the old flow stays intact).

1. Extract the ZIP. Push only its contents to your backend repository; never upload real keys or `.env` files.
2. In Railway create a project, add **PostgreSQL**, and add a service from this repository. Railway should detect `Dockerfile`.
3. Add a `DATABASE_URL` variable referencing the Railway PostgreSQL connection variable. Use Railway's supplied connection URL and TLS settings; do not disable certificate verification.
4. Generate a public HTTPS domain for the payment service in Railway Networking.
5. Add the variables listed below. Keep `ENABLE_PAYOUTS=false` initially.
6. Railway's pre-deploy command is `node migrate.js`; start command is `node server.js`. `railway.json` includes these settings and `/health` checks. On platforms without pre-deploy support, run `npm run migrate` once against the service's database before starting.
7. In the Relworx dashboard configure the webhook URL to the exact HTTPS address `https://YOUR-RAILWAY-DOMAIN/webhooks/relworx`. Copy the webhook key from Relworx into Railway; `RELWORX_WEBHOOK_URL` must be exactly the same URL, with no trailing slash, query or fragment.
8. Confirm `/health` returns HTTP 200 with `{"ok":true,"gameFundingEnabled":false}`. This verifies configuration/database readiness, not that Relworx credentials are valid or your merchant account is approved.
9. Send the public Railway domain back in chat. Do not send secret keys. The website-side sign-in token issuer and payment pages need to be connected before a customer can use the service.

Back up PostgreSQL, use a dedicated database/user for this service, restrict database network access, and retain ledger records for reconciliation. The schema command is repeatable and does not seed funds. Migration runs need table-creation privileges; use narrower runtime database privileges where your Railway setup supports them.

## Railway variables

| Variable | Required value / source |
|---|---|
| `DATABASE_URL` | Railway PostgreSQL connection reference |
| `RELWORX_API_KEY` | Your Relworx API key, entered only in Railway Variables |
| `RELWORX_ACCOUNT_NO` | Your Relworx merchant account number |
| `RELWORX_WEBHOOK_KEY` | Webhook signing key issued/configured by Relworx |
| `RELWORX_WEBHOOK_URL` | Exact public HTTPS `/webhooks/relworx` URL registered with Relworx |
| `AUTH_PUBLIC_KEY` | RS256 PEM public verification key from the trusted website sign-in issuer; actual line breaks or escaped `\n` accepted. **Not a private key.** |
| `AUTH_ISSUER` | Exact issuer identifier configured by that trusted website sign-in issuer |
| `AUTH_AUDIENCE` | Exact audience identifier shared with that issuer, e.g. `relworx-wallet` |
| `FRONTEND_ORIGINS` | Optional comma-separated exact HTTPS website/preview origins, no paths or `*`. Empty is suitable for website-server-to-Railway calls. |
| `ENABLE_PAYOUTS` | `false` initially. Set `true` only after your verified-phone authentication bridge, reconciliation and payout permissions are ready. |
| `PORT` | Supplied by Railway automatically |

No live credentials are included. No invented issuer exists in this package: the website currently has a Fortebet session, not the payment tokens required here. It must verify that session on the server and issue scoped tokens for this service, or use a legitimate identity issuer implementing the same contract. Its private signing key must remain in a secure website-side secret store. The Railway service receives only the public key. Never put private keys or Relworx keys in browser code.

## Authentication contract for the website connection

Every `/v1/*` call requires `Authorization: Bearer <RS256 JWT>` issued only after the website verifies the user server-side. The website must derive identity from the verified account, not accept a user ID, balance or verified phone from request JSON. Forward through the website's server so bearer tokens stay out of browser storage. Protect that website payment action from cross-site request forgery and require explicit customer confirmation.

Required token claims:

- `sub`: stable, unique player identity; never use a mutable username or phone as identity.
- `iss` and `aud`: match `AUTH_ISSUER` and `AUTH_AUDIENCE`.
- `iat`, `exp`: maximum lifetime 300 seconds; present and validated.
- `jti`: unique token identifier.
- `scope`: exactly `wallet:read wallet:pay`.
- `phone_number`: verified registered mobile number in `+256…` form.
- `phone_verified`: boolean `true` from the trusted account verification source before withdrawals are allowed. Do not infer verification merely because a phone field exists on a profile.

Tokens are short-lived and are not one-use payment keys. Payment replay prevention uses the durable idempotency record. Browser logout/revocation must stop the website issuer from issuing more tokens; any already-issued token can remain valid for its remaining lifetime. Keep this maximum lifetime short.

Do not send raw Fortebet session cookies or passwords to Railway. Do not add an open endpoint that mints tokens for a supplied username. Public-key rotation requires coordination with the issuer; this version verifies one key.

## Endpoints

| Endpoint | Behavior |
|---|---|
| `GET /health` | Public configuration/database readiness; no secrets or merchant balance |
| `GET /v1/wallet` | Authenticated user's `available`, `reserved`, currency and explicit wallet-only scope |
| `POST /v1/deposits` | Initiate one collection from registered or another supported Uganda mobile number |
| `POST /v1/withdrawals` | Reserve funds and initiate one payout to the verified registered phone only; disabled by default |
| `GET /v1/payments/:id` | Own payment only, reconciles provider status when possible |
| `GET /v1/payments?cursor=…` | Own payment history, 50 per page; use returned `nextCursor` |
| `POST /webhooks/relworx` | Relworx-signed callback, verified before processing |

Payment body (JSON):

```json
{"amount":5000,"phone":"0779000001","confirmed":true}
```

The phone shown is an example, not a number to pay. Never submit it for testing. Amount is a whole UGX number between **1,000 and 5,000,000**. These are conservative application limits, not a guarantee of provider approval. `phone` is optional if the issuer supplies the registered number. Deposits may use another number; withdrawals cannot. Both requests require `confirmed:true`, a bearer token and a stable `Idempotency-Key` header (16–100 letters, digits, `_` or `-`). Generate a new key for a newly confirmed payment and retain that same key on any retry. Never retry with a fresh key because a response was lost.

The response uses HTTP 202 and the durable payment state. It does not promise payment success. Keep the slip/receipt and check the same payment ID. Only show deposit success after state `success` and read the wallet again.

## Payment states and safeguards

- `created`: durable payment exists but has not been dispatched.
- `dispatching`: attempt committed before the external call.
- `pending`: Relworx reference obtained, terminal outcome not yet confirmed.
- `unknown`: timeout/error/unconfirmed initiation; not a failure and **never automatically resubmitted**.
- `review`: conflicting monetary fields/status; no automatic credit/refund.
- `success` / `failed`: authoritative terminal settlement, applied once.

Each payout reserves available funds inside a database transaction. Concurrent payouts cannot overdraw. A successful payout consumes the reservation; a verified failed payout returns it once. Unknown payouts keep it reserved. Collection credits are issued only after a direct Relworx status read confirms matching reference, internal reference, amount, phone and UGX currency. Callback amount or user-supplied balance is never trusted. Callback signatures follow Relworx's documented URL + timestamp + alphabetically sorted signed fields, with a 10-minute timestamp window and constant-time comparison. Replayed callbacks cannot duplicate wallet effects.

A 30-second sweep reconciles up to 50 referenced unsettled payments per cycle; multiple service replicas are safe because settlement is serialized with wallet/payment locks. There is no automatic repeat of an uncertain collection or payout. Reference-less unknown payments and crashed `dispatching` attempts require operator review using the recorded customer reference and Relworx dashboard/support. Never guess a failure or release a payout reservation because time elapsed. There is intentionally no public refund, balance edit, merchant balance, payout-any-number, or manual settlement endpoint. A production operator review workflow is not included; verify provider evidence and use an audited operational process before making any manual changes.

Server-side rates limit collections per phone and payment requests per user. Relworx may enforce stricter sliding-window limits than this service's fixed-window limits. Provider refusals without an authoritative settlement are kept uncertain for review, not credited or automatically resent.

## Run and test locally

Requires Node 22+ and a local PostgreSQL instance.

```text
npm ci
# Set DATABASE_URL and other required variables in your private environment.
npm run migrate
npm start
```

Tests erase payment tables, so use a dedicated database whose name ends in `_test` and set `TEST_DATABASE_URL` to it before running `npm test`. Never point tests at production. The test suite uses ephemeral locally generated test keys and a simulated Relworx provider; it never submits real money.

Verified before delivery: **25 passing checks**, including authenticated HTTP deposits/withdrawals, real database persistence, duplicate and simultaneous submissions, concurrent overdraft prevention, successful/failed settlement, uncertain payouts, callback signature checks, cross-user isolation, provider payloads and process-recreation persistence. Railway deployment, real Relworx merchant approval, real collections/payouts and real-game integration remain unverified.

## Provider documentation

- https://payments.relworx.com/docs/mobile_money/request_payment/
- https://payments.relworx.com/docs/mobile_money/send_payment/
- https://payments.relworx.com/docs/mobile_money/check_request_status/
- https://payments.relworx.com/docs/webhooks/
- https://payments.relworx.com/docs/webhooks/authenticate_webhook_requests/

This package intentionally focuses on Uganda mobile money. The uploaded backend's card, merchant information and other-country proxy endpoints are not exposed: they were unnecessary to the requested authenticated wallet and would broaden sensitive access.
