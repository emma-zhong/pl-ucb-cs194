# `pl-intent-console` (draft)

This course element turns a student's English analysis plan into editable SQL. On either **Save** or **Save & Grade**, the element generates new SQL only if the English plan changed since the SQL on screen was generated; freshly generated SQL is shown for review instead of being graded. If the plan is unchanged, the SQL currently in the editor (including the student's edits) is kept, and **Save & Grade** grades it.

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

## Example

```html
<pl-intent-console
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
</pl-intent-console>
```

Both `data-source` and `intent-spec` are resolved inside the question's `serverFilesQuestion` directory. The current draft accepts a CSV data source and SQL output only. Grading executes the student's query and the reference query against the CSV in a restricted, in-memory SQLite database, then compares result rows without requiring a particular SQL spelling.

The element stores the student's English under `<answers-name>-source` and SQL under `<answers-name>-generated-code`. The LLM receives only the CSV schema, instructor intent specification, and student's English—not the reference query or grading result.

The server accepts ordinary English analysis plans without enforcing exact canonical lines or a fixed operation order. Before any model call, it rejects question-like input and recognizable prompt-injection attempts; the assignment question is never included in the model request. A failed safety check, provider request, or model-output check preserves the previously generated SQL and does not increment the question's generation count. Model output must be exactly one complete `SELECT` or `WITH` statement; prose, Markdown fences, comments, incomplete SQL, and multiple statements are rejected rather than repaired.
