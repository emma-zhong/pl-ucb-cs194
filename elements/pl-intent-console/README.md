# `pl-intent-console` (draft)

This course element turns a student's English analysis plan into editable SQL when the student clicks PrairieLearn's **Save** button. Clicking **Save & Grade** preserves and grades the SQL currently in the editor.

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

PrairieLearn's question lifecycle timeout must be longer than the provider timeout. The local Compose setup loads `.devcontainer/prairielearn-config.json`, which sets `questionTimeoutMilliseconds` to 60 seconds so that one-pass and two-pass generation can finish or report their own provider timeout.
A deployed PrairieLearn administrator must configure an equivalent server-level timeout; this setting cannot be controlled by an individual question.

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

- **Save** generates SQL, overwrites earlier generated or edited SQL, increments the generation count after success, and refreshes the preview.
- **Save & Grade** preserves and grades the SQL currently visible in the editor; it does not regenerate SQL.
- A failed local check, provider request, or model-output check preserves the previous SQL and does not increment the generation count.

Student and reference queries run against the same restricted, in-memory SQLite database. Only read-only `SELECT` or `WITH` queries are accepted. Grading compares result rows and multiplicity rather than exact SQL text; row order and column labels are ignored.
