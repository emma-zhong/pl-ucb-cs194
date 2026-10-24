# Displaying and Autograding SQL Query Results

This guide describes a straightforward way to display the result of a SQL query and grade it automatically. It assumes that both the student's SQL and an instructor-written reference query run against the same dataset.

The central idea is simple: **grade the result table, not the text of the SQL query**. Two queries can be written very differently and still be equally correct.

## Overall flow

```text
Student SQL
    |
    v
Run in a restricted database
    |
    +--> Preview: show a limited number of rows in an HTML table
    |
    +--> Grading: compare its full result with the reference result
```

## 1. Create the database

For a small assignment, the dataset can be loaded into a fresh in-memory SQLite database each time a query is evaluated.

For example, if the data comes from a CSV file:

1. Read the CSV header to determine the column names.
2. Infer or declare a SQLite type for each column.
3. Create an in-memory table.
4. Insert all CSV rows into that table.

Using a fresh database for each execution makes student and reference queries independent. It also prevents one query from affecting a later query.

```python
import sqlite3

connection = sqlite3.connect(":memory:")
connection.execute(
    "CREATE TABLE transactions "
    "(transaction_id INTEGER, customer_id INTEGER, year INTEGER, total REAL)"
)
connection.executemany(
    "INSERT INTO transactions VALUES (?, ?, ?, ?)",
    dataset_rows,
)
```

In production code, quote table and column identifiers safely instead of inserting untrusted names directly into SQL strings.

## 2. Execute the SQL and collect a result table

Execute the submitted query and collect two things:

- Column names from `cursor.description`.
- Rows returned by the cursor.

```python
cursor = connection.execute(student_sql)

if cursor.description is None:
    raise ValueError("The query did not return a table.")

columns = [description[0] for description in cursor.description]
rows = cursor.fetchall()
```

Keep the database values in their original types for grading. Create a separate display representation when rendering the preview. This avoids accidentally treating the integer `6` as equivalent to the text value `"6"` unless that is an intentional grading rule.

## 3. Display a preview

The preview should show the query's column names and a limited number of rows. Limiting only the preview keeps the page responsive without changing the result used for grading.

```python
PREVIEW_LIMIT = 20

preview_rows = rows[:PREVIEW_LIMIT]
preview_was_truncated = len(rows) > PREVIEW_LIMIT

def display_value(value):
    return "NULL" if value is None else str(value)

display_rows = [
    [display_value(value) for value in row]
    for row in preview_rows
]
```

The web template can render the result using the column names as table headers and the returned values as table cells:

```html
<table>
  <thead>
    <tr>
      <!-- Render one escaped <th> for each column name. -->
    </tr>
  </thead>
  <tbody>
    <!-- Render one <tr> per row and one escaped <td> per value. -->
  </tbody>
</table>
```

Always use the template engine's normal HTML escaping for column names and values. Query results should be treated as data, never as trusted HTML.

If the result exceeds the preview limit, show a message such as “Preview limited to 20 rows.” Do not silently imply that the preview is the entire result.

## 4. Run the reference query

The instructor stores a trusted reference query on the server. It must not be sent to the browser as part of the question or placed in student-editable fields.

During grading:

1. Create a fresh database containing the assignment dataset.
2. Run the student's submitted SQL.
3. Create another fresh database with the same dataset.
4. Run the instructor's reference SQL.
5. Compare the two result tables.

The grader should use the SQL currently submitted by the student. It should not replace or regenerate the query immediately before grading.

## 5. Compare result tables

First decide what “equivalent results” means for the assignment. A common policy is:

- Ignore row order unless the assignment specifically tests ordering.
- Preserve duplicate rows, because SQL results can contain meaningful duplicates.
- Ignore column names if only the returned values matter.
- Preserve column order, because values in each row are positional.
- Compare database values using a deliberate type policy.

For order-insensitive grading, sort or count the result rows before comparing them:

```python
from collections import Counter

def canonical_rows(rows):
    return Counter(tuple(row) for row in rows)

is_correct = canonical_rows(student_rows) == canonical_rows(reference_rows)
```

Using `Counter` makes the duplicate-row behavior explicit. For example, one copy of `(1, 2)` is different from two copies of `(1, 2)`.

If column names or column order are part of the assignment, compare those separately before comparing the rows.

### Example

Suppose the reference query returns:

| customer_count |
| ---: |
| 6 |

Any student query that returns the same one-cell result can receive credit, even if it uses different joins, subqueries, or common table expressions.

A valid query that returns `2` should receive no credit because its result does not match the reference result.

## 6. Return useful feedback

A basic all-or-nothing grader can report:

- **Correct:** “Your SQL returned the expected result.”
- **Incorrect result:** “Your SQL ran, but its result did not match the expected result.”
- **No query:** “No SQL query was submitted.”
- **Execution failure:** Return a safe, understandable SQL error.
- **Safety limit exceeded:** Explain that the query or result exceeded the allowed limit.

Avoid revealing the hidden reference SQL or its full output in ordinary grading feedback. Otherwise, repeated submissions can expose the intended solution.

## 7. Restrict student SQL

Never run arbitrary student SQL against a production database. A grading database should contain only the data needed for the question and should have no network, filesystem, or production credentials available to it.

At minimum:

- Accept only one `SELECT` or `WITH` statement.
- Reject multiple statements.
- Deny writes and schema changes using SQLite's authorizer API.
- Limit SQL length, value length, and column count.
- Interrupt queries that exceed an execution-step or time limit.
- Limit the maximum number of grading rows.
- Close the database connection after every execution.

A prefix check by itself is not a sufficient sandbox. Use the database engine's authorization and resource-limit features as well.

## 8. Keep preview and grading limits separate

Previewing and grading have different needs:

| Purpose | Typical behavior |
| --- | --- |
| Preview | Show only the first 20 rows. |
| Grading | Read enough rows to compare the complete result, up to a larger safety limit. |

Do not grade only the preview rows. Two queries could share the same first 20 rows while differing later.

If either the student or reference result exceeds the grading safety limit, stop and report that the result is too large to grade safely. Do not award credit based on a partial comparison.

## Minimal grading pseudocode

```python
def grade_sql(student_sql, reference_sql, dataset):
    if not student_sql.strip():
        return 0, "No SQL query was submitted."

    try:
        student_rows = run_restricted_query(
            sql=student_sql,
            dataset=dataset,
            maximum_rows=10_000,
        )
        reference_rows = run_restricted_query(
            sql=reference_sql,
            dataset=dataset,
            maximum_rows=10_000,
        )
    except SafeQueryError as error:
        return 0, str(error)

    if canonical_rows(student_rows) == canonical_rows(reference_rows):
        return 1, "Your SQL returned the expected result."

    return 0, "Your SQL ran, but its result did not match the expected result."
```

This design accepts logically equivalent SQL, gives students an immediate visual preview, and keeps the execution environment isolated from the rest of the application.
