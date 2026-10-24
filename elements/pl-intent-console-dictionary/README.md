# `pl-intent-console-dictionary` (draft)

This course element uses one LLM pass to map a student's wording through an instructor-authored canonical dictionary, then a second LLM pass to convert the normalized plan into editable SQL when the student clicks **Generate SQL**. Clicking **Save & Grade** grades the SQL currently in the editor.

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
2. Add a database-schema JSON file describing every available SQL table.
3. Add a canonical dictionary of accepted student phrases.
4. Add an instructor intent specification describing how recognized operations map to SQL and when generation must fail.
5. Add the element to `question.html`, and set the reference SQL named by `reference-name` in `server.py`.

For example:

```html
<pl-intent-console-dictionary
  answers-name="customer_count_sql_dictionary"
  database-schema="database_schema.json"
  input-modes="english"
  output-mode="sql"
  dictionary="canonical_dictionary.yml"
  intent-spec="query_intents.yml"
  reference-name="reference_sql"
  generated-code-editable="true"
  max-runs="10"
  row-limit="20"
  weight="1">
</pl-intent-console-dictionary>
```

`database-schema`, `dictionary`, and `intent-spec` are filenames relative to `serverFilesQuestion`.

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

For multiple tables, add an entry for each CSV-backed table:

```json
{
  "tables": [
    {
      "name": "orders",
      "source": "orders.csv",
      "description": "One row per order.",
      "columns": [
        {"name": "order_id", "type": "INTEGER"},
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
- Every table needs a unique, nonempty SQL `name` and a CSV `source`.
- Every CSV needs a nonempty header with case-insensitively unique column names.
- Optional `columns` must exactly match the CSV header in the same order.
- Optional column types are `INTEGER`, `REAL`, or `TEXT`; omitted types are inferred.
- Optional table and column descriptions are included in the schema shown to the model.

The element validates the schema before generation and builds the model's SQL schema automatically. Instructors do not need to repeat the database definition in the intent specification. For backward compatibility, a one-table question may use `data-source="transactions.csv"` instead of `database-schema`; specify exactly one.

## Canonical dictionary format

Each entry must be an `operation` or a `modifier`, give one canonical phrase, and list example student phrases that map to it. The first model pass receives these mappings and the student's plan, identifies exact source spans, and returns the appropriate canonical phrases. This means instructors can adjust accepted wording by editing the mapping examples rather than changing server-side regular expressions. Clear ordinary-English paraphrases of the examples may also be mapped; the pass may not infer operations from the assignment, schema, or likely answer.

```yaml
normalizations:
  - canonical: group rows by
    kind: operation
    phrases:
      - for each unique
      - for each
  - canonical: compute sum of
    kind: operation
    phrases:
      - sum their
      - sum the
  - canonical: filter where
    kind: operation
    phrases:
      - filter again for
      - filter for
  - canonical: keep filtered rows
    kind: modifier
    phrases:
      - keep those rows only
      - keep those rows
```

Use an operation for wording that authorizes a SQL action, such as grouping, aggregation, filtering, sorting, limiting, or joining. Use a modifier only to refine a recognized operation. The server validates the first pass against the instructor's canonical entries, requires exact non-overlapping evidence from the student's plan, and requires at least one recognized operation before making the SQL-generation call. Unmatched wording is preserved as a possible argument or connector, but it cannot authorize another SQL operation, comparison, or sort direction.

For multi-table questions, include a canonical `join` operation and appropriate phrases if joins are allowed. The intent specification must require the student to provide both table names and the matching columns.

## Student plan requirements

Table-name requirements depend on the configured schema:

- With one table, the student may omit its name. The element may add that table only as SQL `FROM` scaffolding.
- With multiple tables, the student must name every table used.
- A join must name both tables and state the matching columns. The model may not introduce an unnamed table or invent a join.

The dictionary for a transactions question can accept this English plan even though it does not say `transactions`:

```text
For each unique customer_id and unique transaction_id, sum their total dollar
amount on each unique transaction. Filter for the sum to be greater than $200,
then filter year to be equal to 2025.
```

Before the mapping pass, the server rejects question-like input, recognizable prompt-injection attempts, and dataframe code or programming shorthand such as:

```text
df = df[df['year'] == 2023] df.groupby('customer_id')
```

## Intent specification and model boundary

The intent specification defines how recognized canonical operations map to SQLite and which missing details produce `PLAN_ERROR:<REASON>`. Supported reasons cover missing or unsupported operations, tables, columns, comparisons, values, grouping columns, aggregate details, join conditions, sort details, row counts, and ambiguous details.

The mapping pass receives only the instructor's dictionary mappings and the student's English plan. The SQL-generation pass receives only:

- the schema generated from the configured database;
- the instructor generation specification;
- the validated dictionary-normalized plan;
- exhaustive lists of recognized operations and modifiers; and
- the configured table names explicitly mentioned in the plan.

It does not receive the original unmatched prose as a separate field, dictionary audit entries, assignment question, reference SQL, expected result, grading outcome, or hidden tests. It must return exactly one complete SQLite `SELECT` or `WITH` statement, or one controlled plan error.

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

Student and reference queries run against all configured tables in one restricted, in-memory SQLite database. Only read-only `SELECT` or `WITH` queries are accepted. Grading compares result rows and multiplicity rather than exact SQL text; row order and column labels are ignored.

## Server-side diagnostics

Every Generate SQL, Save, and Save & Grade submission emits labeled, multi-line events to
`/tmp/pl-intent-console-dictionary.log` inside the PrairieLearn container. The element
writes directly to this file because PrairieLearn treats stdout or stderr output during
`parse()` as a course error. A logging failure is ignored so diagnostics can never block a
submission.

The log covers input screening, table filtering, both model requests and outputs, the
dictionary-normalized plan and replacements, recognized operations and modifiers, generated
SQL, preview execution, and grading. Each event has a `trace_id`; parse events for one button
press share one ID, while grading uses its own ID.

The log omits API credentials, authorization headers, system prompts, reference SQL, and
reference rows. It contains student-authored text, dictionary mappings sent to the first
model pass, normalized plans, and SQL, so production access and retention should follow the
course's student-data policy. Follow it from the repository root with:

```bash
docker compose \
  --env-file .devcontainer/.env \
  -f .devcontainer/docker-compose.yml \
  exec prairielearn tail -f /tmp/pl-intent-console-dictionary.log
```

Set `ENGLISH_TO_SQL_DICTIONARY_LOG_FILE` on the PrairieLearn service to use another writable
path.
