# English-to-SQL proxy

A Cloudflare Worker that sits between PrairieLearn and OpenAI. It holds the OpenAI key,
limits how many generations each student and the course can use, and runs each model call
in the background so PrairieLearn never waits on OpenAI.

## API

Every request needs `Authorization: Bearer <COURSE_TOKEN>`.

| Call | Body | Response |
|---|---|---|
| `POST /v1/jobs/<variant_key>` | `{seq, user, model, messages}` | `202` pending; `200` with the stored job if this `seq` was already sent |
| `GET /v1/jobs/<variant_key>` | none | `{status: none\|pending\|done\|error, seq, text?, error?, generations_used, generations_left}` |

`variant_key` is 8–64 letters, digits, `-` or `_`, one per PrairieLearn variant.

Request errors: `401 unauthorized`, `400 bad_request`, `400 model_not_allowed`,
`409 busy` (another `seq` is still pending), `409 stale_seq` (an older `seq` was retried),
`429 generation_limit`, `429 user_daily_limit`, `429 course_daily_limit`.

Job errors (returned by GET): `provider_quota` (OpenAI is out of credits),
`provider_rate_limit`, `provider_auth` (bad OpenAI key), `provider_unavailable`,
`provider_rejected` (OpenAI returned 400) and `timeout`. Failed calls don't count against
any limit.

Limits and the model allow-list are `vars` in `wrangler.jsonc`.

## Run locally

```bash
npm install
cp .dev.vars.example .dev.vars   # then fill in both values
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"   # COURSE_TOKEN
npx wrangler dev
```

Try it:

```bash
curl -s -X POST localhost:8787/v1/jobs/test-variant-1 -H "Authorization: Bearer $TOKEN" \
  -d '{"seq":1,"user":"angie","model":"gpt-4.1-mini","messages":[{"role":"user","content":"Reply OK"}]}'
curl -s localhost:8787/v1/jobs/test-variant-1 -H "Authorization: Bearer $TOKEN"
```

## Test

```bash
npm test
```

This starts a fake OpenAI (`test/fake-openai.mjs`) and a local proxy pointed at it, then
checks auth, retries, limits, the model guard, error types and budget refunds. It needs no
key and spends no credits. Stop any other `wrangler dev` on port 8787 first.

## Deploy

```bash
npx wrangler secret put OPENAI_API_KEY
npx wrangler secret put COURSE_TOKEN
npx wrangler deploy
npx wrangler tail      # one JSON log line per OpenAI call
```

Also set a monthly spending limit in OpenAI billing as a backstop.
