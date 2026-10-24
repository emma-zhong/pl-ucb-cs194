# `pl-intent-console-two-pass` (draft)

This course element uses two LLM calls when the student clicks **Generate SQL**. The first call converts the English plan into validated, evidence-grounded JSON steps. The second call converts only those steps into editable SQL. Clicking **Save & Grade** preserves and grades the SQL currently in the editor.

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
<pl-intent-console-two-pass
  answers-name="customer_count_sql_two_pass"
  data-source="transactions.csv"
  input-modes="english"
  output-mode="sql"
  parse-intent-spec="parse_intents.yml"
  generate-intent-spec="generate_intents.yml"
  reference-name="reference_sql"
  generated-code-editable="true"
  max-runs="10"
  row-limit="20"
  weight="1">
</pl-intent-console-two-pass>
```

`data-source`, `parse-intent-spec`, and `generate-intent-spec` are resolved inside the question's `serverFilesQuestion` directory. A generation uses two model calls but increments the student's generation count once. The second call runs only when the first call returns an `ok` plan whose operations are supported and whose evidence is copied exactly from the student's input.
Grading executes the student's query and the reference query against the CSV in a restricted, in-memory SQLite database, then compares result rows without requiring a particular SQL spelling.

The element stores the student's English under `<answers-name>-source` and SQL under `<answers-name>-generated-code`. The first call receives only the CSV schema, parsing specification, and student's English. The second receives only the same schema, generation specification, and validated steps. Neither receives the reference query or grading result.

The server accepts ordinary English analysis plans without enforcing exact canonical lines or a fixed operation order. Before the first model call, it rejects question-like input and recognizable prompt-injection attempts; the assignment question is never included in either request.
The first response must ground every typed operation in an exact phrase from the student's plan and use operation-specific argument fields. The second response must be exactly one complete `SELECT` or `WITH` statement. Any safety, request, JSON-shape, or SQL-output failure preserves the previous SQL and does not increment the question's generation count.
