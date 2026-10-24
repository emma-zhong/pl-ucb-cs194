# `pl-intent-console-regen` (draft)

This course element is a copy of `pl-intent-console` with a different rule for when SQL is regenerated. It turns a student's English analysis plan into editable SQL, but regenerates only when the English changes, and grades only SQL that matches the current English:

- **Generate SQL** regenerates SQL only if the English plan changed (or there is no SQL yet).
  Otherwise it keeps the SQL in the editor, including the student's edits, explains why,
  and uses no generation.
- **Save** keeps the SQL in the editor and refreshes the preview.
- **Save & Grade** grades the SQL in the editor if it was generated from the current plan. If the plan changed, it reports a format error explaining what to do, and nothing is graded.
- **Reset to generated SQL** restores the last generated query in the editor without a new generation.
- Plans that differ only in whitespace count as unchanged.
- Once `max-runs` generations are used (counted by the proxy), the English box is locked so it always matches the SQL; the SQL stays editable.

`pl-intent-console-regen.js` runs Generate SQL and reports which PrairieLearn button was clicked. If it does not run, Save & Grade is not blocked for a changed plan.

The English that produced the current SQL and that SQL are kept server-side in the variant's `params` (under `<answers-name>-job`), so students cannot alter them.

## Local setup

SQL generation goes through the English-to-SQL proxy in `proxy/` (see `proxy/README.md`),
which holds the OpenAI key and enforces the generation limits. The element never sees the
key, and the student's browser never calls the proxy.

1. Start the proxy. In `proxy/`, run `npm install`, copy `.dev.vars.example` to `.dev.vars`,
   fill in your OpenAI key and a course token, then run `npx wrangler dev`.
2. Copy `.devcontainer/.env.example` to `.devcontainer/.env` (Git-ignored) and set
   `ENGLISH_TO_SQL_PROXY_TOKEN` to the same course token.
3. Start PrairieLearn from the repository root and open [http://localhost:3000](http://localhost:3000):

   ```bash
   docker compose --env-file .devcontainer/.env -f .devcontainer/docker-compose.yml up
   ```

The element reads these server-side settings:

| Setting | Default | Purpose |
|---|---|---|
| `ENGLISH_TO_SQL_PROXY_URL` | `http://host.docker.internal:8787` (Compose) | Proxy address |
| `ENGLISH_TO_SQL_PROXY_TOKEN` | required | The proxy's `COURSE_TOKEN` |
| `ENGLISH_TO_SQL_MODEL` | `gpt-4.1-mini` | Must be in the proxy's `ALLOWED_MODELS` |

Hosted PrairieLearn passes no environment variables to question code, so a deployed question
instead reads `serverFilesQuestion/llm_config.json`:

```json
{ "proxy_url": "https://english-to-sql-proxy.<account>.workers.dev", "token": "<COURSE_TOKEN>", "model": "gpt-4.1-mini" }
```

The token only works against the proxy, which enforces per-question, per-student, and
course-wide limits, and it can be rotated with `npx wrangler secret put COURSE_TOKEN`.

## Example

```html
<pl-intent-console-regen
  answers-name="customer_count_sql"
  data-source="transactions.csv"
  input-modes="english"
  output-mode="sql"
  intent-spec="query_intents.yml"
  reference-name="reference_sql"
  generated-code-editable="true"
  max-runs="10"
  row-limit="20"
  weight="1">
</pl-intent-console-regen>
```

Both `data-source` and `intent-spec` are resolved inside the question's `serverFilesQuestion` directory. The current draft accepts a CSV data source and SQL output only. Grading executes the student's query and the reference query against the CSV in a restricted, in-memory SQLite database, then compares result rows without requiring a particular SQL spelling.

The element stores the student's English under `<answers-name>-source` and SQL under `<answers-name>-generated-code`. The LLM receives only the CSV schema, instructor intent specification, and student's English—not the reference query or grading result.

The server accepts ordinary English analysis plans without enforcing exact canonical lines or a fixed operation order. Before any model call, it rejects question-like input and recognizable prompt-injection attempts; the assignment question is never included in the model request. A failed safety check, provider request, or model-output check preserves the previously generated SQL and does not increment the question's generation count. Model output must be exactly one complete `SELECT` or `WITH` statement; prose, Markdown fences, comments, incomplete SQL, and multiple statements are rejected rather than repaired.
