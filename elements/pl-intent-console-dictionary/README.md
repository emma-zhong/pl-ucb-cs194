# `pl-intent-console-dictionary` (draft)

This course element uses one LLM pass to map a student's wording through an instructor-authored canonical dictionary, then a second LLM pass to convert the normalized plan into editable SQLite, pandas, or Polars code when the student clicks the element's **Generate** button (labeled **Generate SQL**, **Generate pandas**, or **Generate Polars**). Clicking **Save & Grade** grades the code currently in the editor.

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
2. Add a database-schema JSON file describing every available data table.
3. Add a canonical dictionary defining the allowed operations and modifiers.
4. Add an instructor intent specification describing question-specific rendering behavior, overrides, and failure conditions.
5. Add the element to `question.html`, and set reference code in the selected output language under the name given by `reference-name` in `server.py`.

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

`database-schema`, `dictionary`, and `intent-spec` are filenames relative to `serverFilesQuestion`. Supported `output-mode` values are `sql`, `pandas`, and `polars`.

For `pandas` and `polars`, each configured table is preloaded as a DataFrame variable with the table's exact name. Generated programs contain only simple assignments and must assign the final DataFrame to `result`. Reference code must follow the same contract and use the same output language as the question.

The PrairieLearn Python environment must provide the selected package. The current local image provides pandas but not Polars. For a temporary local Polars test installation in an already-running container:

```bash
docker compose \
  --env-file .devcontainer/.env \
  -f .devcontainer/docker-compose.yml \
  exec prairielearn \
  uv pip install --python /PrairieLearn/.venv/bin/python3 'polars>=1,<2'
```

That installation disappears when the container is recreated. A deployed course using `output-mode="polars"` should install Polars in its PrairieLearn image or Python environment. If a package is unavailable, the element reports a configuration error without executing student code.

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

The element validates the schema before generation and builds the model's backend-appropriate schema context automatically. Instructors do not need to repeat the database definition in the intent specification. For backward compatibility, a one-table question may use `data-source="transactions.csv"` instead of `database-schema`; specify exactly one.

## Canonical dictionary format

Put each canonical phrase under `operations` or `modifiers` and define its meaning in one sentence. Instructors do not need to enumerate synonyms. The first model pass uses these definitions to identify explicit operations and modifiers in the student's plan, cites the exact source spans, and returns the appropriate canonical phrases. It may recognize any unambiguous ordinary-English wording that expresses a listed definition, but it may not infer operations from the assignment, schema, or likely answer.

```yaml
operations:
  group rows by: Divide rows into groups using one or more explicitly named columns.
  compute sum of: Add the values of an explicitly named column or expression.
  filter where: Apply a condition to an explicitly named column or aggregate.

modifiers:
  greater than: Compare whether the left value is larger than the right value.
  keep filtered rows: Confirm that the rows selected by the preceding filter are retained.
```

Use an operation for wording that authorizes a data transformation, such as grouping, aggregation, filtering, sorting, limiting, or joining. Use a modifier only to refine a recognized operation. Keep definitions distinct enough that one explicit phrase does not plausibly match several entries. The server validates the first pass against the instructor's canonical entries, requires exact non-overlapping evidence from the student's plan, and requires at least one recognized operation before making the code-generation call. Unmatched wording is preserved as a possible argument or connector, but it cannot authorize another operation, comparison, or sort direction.

For multi-table questions, include a canonical `join` operation if joins are allowed. The intent specification must require the student to provide both table names and the matching columns.

## Student plan requirements

Table-name requirements depend on the configured schema:

- With one table, the student may omit its name when the question-specific intent specification allows the sole table to be used as backend scaffolding.
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

The element centrally defines standard SQLite, pandas, and Polars rendering for its canonical operations, so question-level intent specifications do not need an `operations:` section. An intent specification should contain only question-specific behavior, interpretations, defaults, overrides, and any conditions that produce `PLAN_ERROR:<REASON>`. Supported reasons cover missing or unsupported operations, tables, columns, comparisons, values, grouping columns, aggregate details, join conditions, sort details, row counts, and ambiguous details.

The mapping pass receives only the instructor's dictionary mappings and the student's English plan. The code-generation pass receives only:

- the schema generated from the configured database;
- the selected output mode;
- the instructor generation specification;
- the validated dictionary-normalized plan;
- exhaustive lists of recognized operations and modifiers; and
- the configured table names explicitly mentioned in the plan.

It does not receive the original unmatched prose as a separate field, dictionary audit entries, assignment question, reference code, expected result, grading outcome, or hidden tests. In SQL mode it must return exactly one complete SQLite `SELECT` or `WITH` statement. In pandas or Polars mode it must return simple assignment statements ending in `result = ...`. It may instead return one controlled plan error.

## Saving, previewing, and grading

The element stores the student's English under `<answers-name>-source` and generated code under `<answers-name>-generated-code`.

- **Generate** (the element's own button) starts a generation through the proxy: it maps
  and normalizes the plan, generates code in the configured output mode, and replaces the
  code in the editor. A mapping that fails validation is retried with the error, up to 3
  mapping calls, and retries do not use up a generation. Slower generations show
  "Generating…" while the page checks back every few seconds.
- **Save** keeps the code in the editor, including the student's edits, and refreshes the preview.
- **Save & Grade** grades the code currently visible in the editor; it never generates code.
- `max-runs` successful generations are allowed per variant. The proxy counts them, so
  students cannot reset the count; failed generations do not count.
- A failed local check, provider request, or model-output check preserves the previous code and does not increment the generation count.

In SQL mode, student and reference queries run against all configured tables in one restricted, in-memory SQLite database, and only read-only `SELECT` or `WITH` queries are accepted. In pandas and Polars modes, CSV-backed DataFrames execute through a restricted AST interpreter: imports, arbitrary functions and methods, callbacks, lambdas, comprehensions, private attributes, cross joins, file access, and network access are rejected. Input, join, syntax-tree, and intermediate-result limits constrain execution. Grading compares result rows and multiplicity rather than exact code; row order and column labels are ignored.

## Server-side diagnostics

Every Generate SQL, Save, and Save & Grade submission emits labeled, multi-line events to
`/tmp/pl-intent-console-dictionary.log` inside the PrairieLearn container. The element
writes directly to this file because PrairieLearn treats stdout or stderr output during
`parse()` as a course error. A logging failure is ignored so diagnostics can never block a
submission.

The log covers input screening, table filtering, both model requests and outputs, the
dictionary-normalized plan and replacements, recognized operations and modifiers, generated
code, preview execution, and grading. Each event has a `trace_id`; parse events for one button
press share one ID, while grading uses its own ID.

The log omits API credentials, authorization headers, system prompts, reference code, and
reference rows. It contains student-authored text, dictionary mappings sent to the first
model pass, normalized plans, and generated code, so production access and retention should follow the
course's student-data policy. Follow it from the repository root with:

```bash
docker compose \
  --env-file .devcontainer/.env \
  -f .devcontainer/docker-compose.yml \
  exec prairielearn tail -f /tmp/pl-intent-console-dictionary.log
```

Set `ENGLISH_TO_SQL_DICTIONARY_LOG_FILE` on the PrairieLearn service to use another writable
path.
