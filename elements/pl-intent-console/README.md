# `pl-intent-console` (draft)

This course element turns a student's English analysis plan into editable SQL when the student clicks PrairieLearn's **Save** button. Clicking **Save & Grade** preserves and grades the SQL currently in the editor.

## Server configuration

Set these environment variables on the PrairieLearn server. Never put the API key in `question.html`, `server.py`, an element attribute, or a client-side file.

```text
ENGLISH_TO_SQL_API_KEY=...
ENGLISH_TO_SQL_MODEL=...
ENGLISH_TO_SQL_API_URL=https://api.openai.com/v1/chat/completions
ENGLISH_TO_SQL_TIMEOUT_SECONDS=20
```

`ENGLISH_TO_SQL_API_URL` is optional and may point to an OpenAI-compatible chat-completions endpoint. The host running PrairieLearn must allow outbound HTTPS to that endpoint.

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
