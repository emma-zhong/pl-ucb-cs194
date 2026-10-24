# `pl-intent-console-dictionary` (draft)

This course element uses one LLM pass to map a student's wording through an instructor-authored canonical dictionary, then a second LLM pass to convert the normalized plan into editable SQL when the student clicks PrairieLearn's **Save** button. Clicking **Save & Grade** preserves and grades the SQL currently in the editor.

## Local setup with Docker and Gemini

Prerequisites:

- Docker Desktop, or another running Docker Engine with Docker Compose
- A Gemini API key created in Google AI Studio

From the repository root, copy the committed example configuration:

```bash
cp .devcontainer/.env.example .devcontainer/.env
```

Open `.devcontainer/.env` and replace the placeholder with your own Gemini API key:

```text
ENGLISH_TO_SQL_API_KEY=replace-with-your-own-gemini-api-key
ENGLISH_TO_SQL_MODEL=gemini-3.8-flash
ENGLISH_TO_SQL_API_URL=https://generativelanguage.googleapis.com/v1beta/openai/chat/completions
```

The real `.devcontainer/.env` file is ignored by Git. Never put the key in `question.html`, `server.py`, an element attribute, a client-side file, `.env.example`, or any committed file.

Start PrairieLearn:

```bash
docker compose \
  --env-file .devcontainer/.env \
  -f .devcontainer/docker-compose.yml \
  up
```

Once the logs report that PrairieLearn is ready, open [http://localhost:3000](http://localhost:3000). Keep the terminal open while developing. To run the containers in the background instead, add `-d` after `up`.

Stop PrairieLearn and remove its containers when finished:

```bash
docker compose \
  --env-file .devcontainer/.env \
  -f .devcontainer/docker-compose.yml \
  down
```

The downloaded Docker images and repository files remain available, so the same `up` command will start the environment again later.

To verify that the API key reached the container without displaying it:

```bash
docker compose \
  --env-file .devcontainer/.env \
  -f .devcontainer/docker-compose.yml \
  exec prairielearn \
  sh -c 'test -n "$ENGLISH_TO_SQL_API_KEY" && echo "Gemini key is configured"'
```

For a deployed PrairieLearn server, configure the same environment variables through the deployment's secret-management system. The host must allow outbound HTTPS to the configured endpoint. `ENGLISH_TO_SQL_TIMEOUT_SECONDS` may optionally be set and defaults to `20`.

PrairieLearn's question lifecycle timeout must be long enough for both provider calls. The local Compose setup loads `.devcontainer/prairielearn-config.json`, which sets `questionTimeoutMilliseconds` to 60 seconds so that generation can finish or report its own provider timeout.
A deployed PrairieLearn administrator must configure an equivalent server-level timeout; this setting cannot be controlled by an individual question.

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

- **Save** maps and normalizes the plan, generates SQL, overwrites prior SQL, and refreshes the preview.
- **Save & Grade** preserves and grades the SQL currently visible in the editor; it does not regenerate SQL.
- A failed local check, provider request, or model-output check preserves the previous SQL and does not increment the generation count.

Student and reference queries run against all configured tables in one restricted, in-memory SQLite database. Only read-only `SELECT` or `WITH` queries are accepted. Grading compares result rows and multiplicity rather than exact SQL text; row order and column labels are ignored.

## Server-side diagnostics

Every Save and Save & Grade submission emits labeled, multi-line events to
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
