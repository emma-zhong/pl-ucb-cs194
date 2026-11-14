# `pl-intent-console-dictionary` (draft)

This PrairieLearn course element translates an English analysis plan into editable SQLite, pandas, or Polars code. A first LLM pass maps the student's wording to an instructor-authored canonical dictionary; a second generates code from the validated normalized plan.

- **Save** regenerates code, replaces edits, and refreshes the preview.
- **Save & Grade** preserves and grades the code currently shown.

## Local setup

Requirements: Docker with Compose and an API key for an OpenAI-compatible chat-completions endpoint.

```bash
cp .devcontainer/.env.example .devcontainer/.env
```

Set the private, Git-ignored `.devcontainer/.env`:

```text
ENGLISH_TO_SQL_API_KEY=...
ENGLISH_TO_SQL_MODEL=...
ENGLISH_TO_SQL_API_URL=https://generativelanguage.googleapis.com/v1beta/openai/chat/completions
ENGLISH_TO_SQL_TIMEOUT_SECONDS=20
```

Never put credentials in committed files, question parameters, browser code, submitted answers, logs, or feedback. Start PrairieLearn and open <http://localhost:3000>:

```bash
docker compose --env-file .devcontainer/.env -f .devcontainer/docker-compose.yml up
```

Add `-d` to run in the background; replace `up` with `down` to stop and remove the containers. For deployment, configure the same variables through the server's secret manager and allow outbound HTTPS. PrairieLearn's question lifecycle timeout must exceed both provider calls; the local configuration uses 60 seconds.

## Authoring a question

Place the following in `serverFilesQuestion`:

1. One or more source CSV files.
2. A database schema describing the available tables.
3. A canonical dictionary of allowed operations and modifiers.
4. A question-specific intent specification for interpretations, defaults, overrides, and controlled failures.

Set reference code under the `reference-name` key in `server.py`, using the same language as `output-mode`.

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

`database-schema`, `dictionary`, and `intent-spec` are filenames relative to `serverFilesQuestion`. The supported output modes are `sql`, `pandas`, and `polars`. In pandas and Polars modes, each table is preloaded as a DataFrame variable with its exact table name. Programs may contain only simple assignments and must finish with `result = ...`.

The PrairieLearn environment must provide the selected package; the current local image includes pandas but not Polars. For temporary local testing, install Polars in the running container with `uv pip install --python /PrairieLearn/.venv/bin/python3 'polars>=1,<2'`. The installation is lost when the container is recreated; deployments should include Polars in their image. A missing package produces a configuration error without running student code.

## Database schema

```json
{
  "tables": [
    {
      "name": "transactions",
      "source": "transactions.csv",
      "description": "One row per transaction.",
      "columns": [
        {"name": "customer_id", "type": "TEXT"},
        {"name": "total", "type": "REAL"}
      ]
    }
  ]
}
```

- `tables` must be a nonempty array with unique names and CSV sources.
- CSV headers must be nonempty and case-insensitively unique.
- Optional `columns` must match the CSV header and order exactly.
- Column types may be `INTEGER`, `REAL`, or `TEXT`; omitted types are inferred.
- Optional table and column descriptions are included in model context.

For backward compatibility, a single-table question may use `data-source` instead of `database-schema`; specify exactly one.

## Canonical dictionary

Define each canonical phrase and its meaning. Instructors do not need to enumerate synonyms.

```yaml
operations:
  group rows by: Divide rows into groups using explicitly named columns.
  compute sum of: Add values from an explicitly named column or expression.
  filter where: Apply a condition to a named column or aggregate.

modifiers:
  greater than: Compare whether the left value is larger than the right value.
  keep filtered rows: Retain rows selected by the preceding filter.
```

Operations authorize transformations such as grouping, aggregation, filtering, sorting, limiting, or joining. Modifiers only refine recognized operations. Keep definitions distinct. The server requires exact, non-overlapping evidence from the student's plan and at least one operation. Unmatched wording may remain as an argument or connector, but cannot authorize another operation, comparison, or sort direction.

With one configured table, the intent specification may allow students to omit its name. With multiple tables, students must name every table used. Joins must name both tables and their matching columns, and the dictionary must include a `join` operation.

Before contacting the model, the server rejects question-like input, recognizable prompt injection, DataFrame code, and programming shorthand.

The element already defines standard rendering for canonical operations. The intent specification should contain only question-specific interpretations, defaults, overrides, and conditions that return `PLAN_ERROR:<REASON>`; do not duplicate the operation dictionary there.

## Model boundary

The mapping pass receives only the canonical dictionary and the student's English plan. The generation pass receives only:

- the generated schema and selected output mode;
- the instructor intent specification;
- the validated normalized plan and recognized operations/modifiers; and
- configured table names explicitly mentioned in the plan.

Neither pass receives the assignment text, reference code, expected results, grading outcome, or hidden tests. The generation pass also does not receive unmatched original prose or dictionary audit entries. It returns one SQLite `SELECT`/`WITH` query, a restricted pandas/Polars program ending in `result`, or a controlled `PLAN_ERROR`.

## Execution and grading

SQL runs against all configured tables in a restricted in-memory SQLite database; only read-only `SELECT` and `WITH` queries are allowed. pandas and Polars use a restricted AST interpreter that rejects imports, arbitrary functions and methods, callbacks, lambdas, comprehensions, private attributes, cross joins, file access, and network access. Size and execution limits apply in every mode.

Grading compares result values and multiplicity rather than code text. Row order and column labels are ignored. Failed screening, provider requests, or model validation preserve the previous code and do not consume the successful-generation limit, though every Save press counts as a telemetry attempt.

The student's English is stored under `<answers-name>-source`; generated code is stored under `<answers-name>-generated-code`.

## Study telemetry

Set `time-limit-minutes` to show an advisory countdown and record elapsed time. The element stores these hidden answer fields under `answers-name`:

- `telemetry-started-at-ms` and `telemetry-elapsed-ms`;
- `telemetry-save-count`, `telemetry-grade-count`, and `telemetry-generation-failure-count`;
- `telemetry-edit-count`, `telemetry-chars-inserted`, and `telemetry-chars-deleted`.

They appear in submission history and `*_all_submissions.csv`. Combine them with PrairieLearn scores and timestamps to identify time to first correct answer. Edits abandoned without submission cannot be recovered.

## Diagnostics

Each Save and Save & Grade writes labeled events to `/tmp/pl-intent-console-dictionary.log`, including screening, model requests and outputs, normalization, generated code, preview execution, and grading. Events have UTC timestamps and `trace_id` values; parse events for one button press share an ID, while grading uses its own.

The log omits credentials, authorization headers, system prompts, reference code, and reference rows. It does contain student text, dictionary mappings, normalized plans, and generated code; apply the course's student-data access and retention policy.

```bash
docker compose --env-file .devcontainer/.env -f .devcontainer/docker-compose.yml \
  exec prairielearn tail -f /tmp/pl-intent-console-dictionary.log
```

Set `ENGLISH_TO_SQL_DICTIONARY_LOG_FILE` to choose another writable path. Logging failures never block submissions.
