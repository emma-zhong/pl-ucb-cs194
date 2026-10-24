# `pl-intent-console` (draft)

This course element turns a student's English analysis plan into editable SQL when the student clicks **Generate SQL**. Clicking **Save & Grade** grades the SQL currently in the editor.

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

## Instructor authoring quick start

1. Put each source CSV in the question's `serverFilesQuestion` directory.
2. Add a database-schema JSON file in that directory. The schema tells the element which SQL tables exist and which CSV supplies each table.
3. Add an instructor intent specification describing the allowed analysis operations and when the translator should return an error.
4. Add the element to `question.html`.
5. Set the reference SQL named by `reference-name` in `server.py`.

For example:

```html
<pl-intent-console
  answers-name="customer_count_sql"
  database-schema="database_schema.json"
  input-modes="english"
  output-mode="sql"
  intent-spec="query_intents.yml"
  reference-name="reference_sql"
  generated-code-editable="true"
  max-runs="10"
  row-limit="20"
  weight="1">
</pl-intent-console>
```

`database-schema` and `intent-spec` are filenames relative to `serverFilesQuestion`.

## Database schema format

For a one-table question, the smallest schema is:

```json
{
  "tables": [
    {
      "name": "transactions",
      "source": "transactions.csv"
    }
  ]
}
```

For a multi-table question, list every available table. Descriptions and declared column types give the translator additional context:

```json
{
  "tables": [
    {
      "name": "orders",
      "source": "orders.csv",
      "description": "One row per order.",
      "columns": [
        {"name": "order_id", "type": "INTEGER", "description": "Unique order ID."},
        {"name": "customer_id", "type": "TEXT"}
      ]
    },
    {
      "name": "customers",
      "source": "customers.csv",
      "columns": [
        {"name": "customer_id", "type": "TEXT"},
        {"name": "region", "type": "TEXT"}
      ]
    }
  ]
}
```

Schema rules:

- `tables` must be a nonempty array.
- Each table needs a unique, nonempty SQL `name` and a CSV `source`.
- Each source CSV must have a nonempty header with case-insensitively unique column names.
- `description` is optional for tables and columns.
- `columns` is optional. When present, its names must exactly match the CSV header in the same order.
- A declared column `type` may be `INTEGER`, `REAL`, or `TEXT`. When it is omitted, the element infers the type from the CSV values.

The element validates this configuration before generation. It builds the SQL schema sent to the model automatically, including the optional descriptions, so instructors do not need to copy column definitions into the prompt specification.

For backward compatibility, an instructor may use `data-source="transactions.csv"` instead of `database-schema`; the CSV filename becomes the single table name. Specify exactly one of these attributes. All configured CSVs are loaded into the same restricted, in-memory SQLite database. Preview and grading therefore support joins and other multi-table `SELECT` queries while retaining the existing execution limits and result-based comparison.

## Student plan requirements

The plan must state the analysis operations and the details required to perform them: relevant columns, comparisons and values, grouping columns, aggregate functions and inputs, sort expressions and directions, or row counts. Ordinary English is accepted; students do not need to use fixed canonical lines or a fixed operation order.

Table-name requirements depend on the configured schema:

- With one table, the student may omit its name. The element may add that table only as SQL `FROM` scaffolding.
- With multiple tables, the student must name every table the plan uses.
- A join must name both tables and state the matching columns. The translator may not invent an unnamed table or an unstated join.

For example, a one-table transactions question may accept:

```text
For each unique customer_id and unique transaction_id, sum their total dollar
amount on each unique transaction. Filter for the sum to be greater than $200,
then filter year to be equal to 2025.
```

It rejects dataframe code or programming shorthand such as:

```text
df = df[df['year'] == 2023] df.groupby('customer_id')
```

It also rejects question-like input and recognizable prompt-injection attempts before calling the model.

## Intent specification and model boundary

Use `intent-spec` to describe the SQL dialect, supported analysis operations, interpretation rules, and conditions that must produce a controlled `PLAN_ERROR:<REASON>` response. Keep question answers and hidden grading information out of this file. The element supports reasons for missing operations, tables, columns, comparisons, values, grouping columns, aggregate details, join conditions, sort details, row counts, and other ambiguous details.

The model receives only:

- the schema generated from the configured database;
- the instructor intent specification; and
- the student's English plan, plus the configured table names it explicitly mentioned.

The model never receives the assignment question, reference SQL, expected result, grading outcome, or hidden tests. It must return exactly one complete SQLite `SELECT` or `WITH` statement, or one controlled plan error. Prose, Markdown fences, comments, incomplete SQL, and multiple statements are rejected rather than repaired.

## Saving, previewing, and grading

The element stores the student's English under `<answers-name>-source` and SQL under `<answers-name>-generated-code`.

- **Generate SQL** (the element's own button) starts a generation through the proxy and
  replaces the SQL in the editor. Most generations finish within the same request; slower
  ones show "Generating SQL…" while the page checks back every few seconds.
- **Save** keeps the SQL in the editor, including the student's edits, and refreshes the preview.
- **Save & Grade** grades the SQL currently visible in the editor; it never generates SQL.
- `max-runs` successful generations are allowed per variant. The proxy counts them, so
  students cannot reset the count; failed generations do not count.
- A failed local check, provider request, or model-output check preserves the previous SQL and does not increment the generation count.

Student and reference queries run against the same restricted, in-memory SQLite database. Only read-only `SELECT` or `WITH` queries are accepted. Grading compares result rows and multiplicity rather than exact SQL text; row order and column labels are ignored.

## Server-side diagnostics

Every Generate SQL, Save, and Save & Grade submission emits labeled, multi-line events to
`/tmp/pl-intent-console.log` inside the PrairieLearn container. The element writes directly
to this file because PrairieLearn treats any stdout or stderr output during `parse()` as a
course error. A logging failure is ignored so diagnostics can never block a submission.

Each event includes a `trace_id`; the parse events for one button press share one ID, while
grading uses its own ID. The logs include the selected action, each student-input screening
decision, table-name filtering, the exact processed student request sent as the model's user
message, the model's text output, validated SQL, preview execution, and grading status. Save
& Grade is explicitly logged as preserving the editor SQL rather than generating again.

The log deliberately omits the API key, request authorization header, instructor
specification text, complete provider response, reference SQL, and reference rows. It does
contain student-authored text and SQL, so production log access and retention should follow
the course's student-data policy. Follow the file from the repository root with:

```bash
docker compose \
  --env-file .devcontainer/.env \
  -f .devcontainer/docker-compose.yml \
  exec prairielearn tail -f /tmp/pl-intent-console.log
```

Set `ENGLISH_TO_SQL_LOG_FILE` on the PrairieLearn service to use another writable path.
