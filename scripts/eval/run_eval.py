"""Run the English-analysis-plan test cases through pl-intent-console-dictionary.

Each case in cases/<group>.csv runs through the element's real Generate path (input screening,
dictionary mapping with retries, code generation through the English-to-SQL proxy),
then its code is executed and graded exactly as Save & Grade would. Results go to
scripts/eval/results/<group>-<time>.csv, one CSV per group so each can be pasted into its
own tab of the team's testing sheet, in that sheet's column order.

    python scripts/eval/run_eval.py --dry-run          # no model calls
    python scripts/eval/run_eval.py --repeats 3
    python scripts/eval/run_eval.py --group top-customers --case "forgot per year"

The proxy URL and token come from the environment or .devcontainer/.env, as they do for
the PrairieLearn container. Columns:

- correct?: the code's result matches the question's reference (Save & Grade's score).
- faithful?: the result matches faithful_sql, a hand-written translation of exactly what
  the plan says. Blank when the case has no faithful_sql; those need a human review.
- matches_expected: the outcome matches the case's expect value (pass, fail, error, or
  not_pass, meaning fail or error).
"""

import argparse
import csv
import importlib.util
import os
import sys
import time
import types
from datetime import datetime

REPO = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
EVAL_DIR = os.path.join(REPO, "scripts", "eval")
ELEMENT_DIR = os.path.join(REPO, "elements", "pl-intent-console-dictionary")
GROUPS = {
    "top-customers": [
        "english-to-sql-top-customers-dictionary",
        "english-to-pandas-top-customers-dictionary",
    ],
    "transactions": ["english-to-sql-transactions-dictionary"],
}
RUN_TIMEOUT_SECONDS = 180
RESULT_COLUMNS = [
    "question",
    "student",
    "run",
    "input",
    "ERROR",
    "output",
    "correct?",
    "faithful?",
    "expected",
    "matches_expected",
    "seconds",
    "model_calls",
    "mapping_retries",
]


def load_env():
    """Fill ENGLISH_TO_SQL_* settings from .devcontainer/.env when they are not set."""
    path = os.path.join(REPO, ".devcontainer", ".env")
    if not os.path.exists(path):
        return
    with open(path, encoding="utf-8") as file:
        for line in file:
            key, sep, value = line.strip().partition("=")
            if sep and key.startswith("ENGLISH_TO_SQL_"):
                os.environ.setdefault(key, value.strip().strip('"').strip("'"))


def load_element(log_file):
    # Stand-ins for the PrairieLearn helpers the element uses.
    pl = types.ModuleType("prairielearn")
    pl.get_string_attrib = lambda el, name, *default: el.get(
        name, default[0] if default else None
    )
    pl.get_boolean_attrib = lambda el, name, default=False: (
        el.get(name, str(default)).lower() == "true"
    )
    pl.get_integer_attrib = lambda el, name, default=None: int(el.get(name, default))
    pl.to_json = lambda value: value
    pl.from_json = lambda value: value
    pl.check_answers_names = lambda data, name: None
    sys.modules["prairielearn"] = pl

    os.environ["ENGLISH_TO_SQL_DICTIONARY_LOG_FILE"] = log_file
    spec = importlib.util.spec_from_file_location(
        "pl_intent_console_dictionary",
        os.path.join(ELEMENT_DIR, "pl-intent-console-dictionary.py"),
    )
    element = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(element)
    element.TEMPLATE_FILE = os.path.join(ELEMENT_DIR, element.TEMPLATE_FILE)
    return element


def load_question(name):
    path = os.path.join(REPO, "questions", name)
    with open(os.path.join(path, "question.html"), encoding="utf-8") as file:
        html = file.read()
    start = html.index("<pl-intent-console-dictionary")
    end = html.index("</pl-intent-console-dictionary>") + len(
        "</pl-intent-console-dictionary>"
    )
    spec = importlib.util.spec_from_file_location(
        f"server_{name}", os.path.join(path, "server.py")
    )
    server = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(server)
    correct_answers = {}
    server.generate({"correct_answers": correct_answers, "params": {}})
    return {"name": name, "path": path, "html": html[start:end], "answers": correct_answers}


def new_data(question):
    return {
        "options": {"question_path": question["path"]},
        "params": {},
        "correct_answers": dict(question["answers"]),
        "submitted_answers": {},
        "raw_submitted_answers": {},
        "format_errors": {},
        "partial_scores": {},
        "panel": "question",
        "editable": True,
    }


def canonical(rows):
    def cell(value):
        try:
            return repr(round(float(value), 6))
        except (TypeError, ValueError):
            return str(value)

    return sorted(tuple(cell(value) for value in row) for row in rows)


def result_rows(element, data, attrs, code, output_mode):
    query_attrs = dict(attrs, output_mode=output_mode)
    return element._run_query(data, query_attrs, code, element.MAX_GRADE_ROWS)[1]


def check_case(element, question, case):
    """Dry run: validate a case without model calls. Returns a problem string or ''."""
    data = new_data(question)
    attrs = element._attributes(question["html"])
    element.prepare(question["html"], data)
    reference = data["correct_answers"][attrs["reference_name"]]
    try:
        result_rows(element, data, attrs, reference, attrs["output_mode"])
        if case["faithful_sql"] not in ("", "REFERENCE"):
            result_rows(element, data, attrs, case["faithful_sql"], "sql")
    except ValueError as exc:
        return f"reference or faithful_sql does not run: {exc}"
    if case["plan"] and case["expect"] == "error":
        try:
            element._screen_student_input(case["plan"])
        except ValueError as exc:
            return f"(screening rejects it before any model call: {exc})"
    return ""


def run_case(element, question, case, run):
    data = new_data(question)
    attrs = element._attributes(question["html"])
    element.prepare(question["html"], data)
    name = attrs["name"]
    posts = []
    real_proxy_call = element._proxy_call

    def counting_proxy_call(data_, job, method, body=None):
        if method == "POST":
            posts.append(job.get("stage"))
        return real_proxy_call(data_, job, method, body)

    element._proxy_call = counting_proxy_call
    started = time.monotonic()
    code = ""
    action = "generate"
    try:
        while True:
            # Each Generate or poll is a fresh submission, as in PrairieLearn.
            data["submitted_answers"] = {}
            data["format_errors"] = {}
            data["raw_submitted_answers"] = {
                attrs["source_name"]: case["plan"],
                attrs["code_name"]: code,
                attrs["action_name"]: action,
            }
            element.parse(question["html"], data)
            code = data["submitted_answers"].get(attrs["code_name"], "")
            job = data["params"].get(attrs["job_name"], {})
            if not job.get("pending"):
                break
            if time.monotonic() - started > RUN_TIMEOUT_SECONDS:
                data["format_errors"][name] = "eval: generation did not finish in time"
                break
            action = "poll"
    finally:
        element._proxy_call = real_proxy_call
    seconds = round(time.monotonic() - started, 1)
    error = data["format_errors"].get(name, "")

    correct = faithful = ""
    if not error and code:
        element.grade(question["html"], data)
        score = data["partial_scores"].get(name, {}).get("score")
        correct = "TRUE" if score == 1 else "FALSE"
        if case["faithful_sql"] == "REFERENCE":
            faithful = correct
        elif case["faithful_sql"]:
            try:
                generated = result_rows(element, data, attrs, code, attrs["output_mode"])
                intended = result_rows(element, data, attrs, case["faithful_sql"], "sql")
                faithful = "TRUE" if canonical(generated) == canonical(intended) else "FALSE"
            except ValueError as exc:
                faithful = f"FALSE ({exc})"

    expect = case["expect"]
    if expect == "pass":
        matches = correct == "TRUE"
    elif expect == "fail":
        matches = correct == "FALSE"
    elif expect == "not_pass":
        matches = correct != "TRUE"
    else:
        matches = bool(error) and case["expect_error"].lower() in error.lower()
    if faithful.startswith("FALSE"):
        matches = False

    return {
        "question": question["name"],
        "student": case["case"],
        "run": run,
        "input": case["plan"],
        "ERROR": error,
        "output": code,
        "correct?": correct,
        "faithful?": faithful,
        "expected": expect + (f": {case['expect_error']}" if case["expect_error"] else ""),
        "matches_expected": "TRUE" if matches else "FALSE",
        "seconds": seconds,
        "model_calls": len(posts),
        "mapping_retries": max(0, posts.count(1) - 1),
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--repeats", type=int, default=1)
    parser.add_argument("--group", choices=sorted(GROUPS))
    parser.add_argument("--question", help="run only this question directory")
    parser.add_argument("--case", help="run only cases with this name")
    parser.add_argument("--dry-run", action="store_true", help="validate cases; no model calls")
    args = parser.parse_args()

    cases = []
    for group in GROUPS:
        if args.group and group != args.group:
            continue
        with open(os.path.join(EVAL_DIR, "cases", f"{group}.csv"), encoding="utf-8",
                  newline="") as file:
            cases += [
                dict(case, group=group)
                for case in csv.DictReader(file)
                if not args.case or case["case"] == args.case
            ]
    stamp = datetime.now().strftime("%Y-%m-%d-%H%M%S")
    results_dir = os.path.join(EVAL_DIR, "results")
    os.makedirs(results_dir, exist_ok=True)
    load_env()
    element = load_element(os.path.join(results_dir, f"{stamp}.log"))
    questions = {
        name: load_question(name)
        for group in GROUPS.values()
        for name in group
        if not args.question or name == args.question
    }
    work = [
        (questions[name], case)
        for case in cases
        for name in GROUPS[case["group"]]
        if name in questions
    ]

    if args.dry_run:
        problems = 0
        for question, case in work:
            note = check_case(element, question, case)
            problems += bool(note) and not note.startswith("(")
            print(f"{'ok ' if not note or note.startswith('(') else 'BAD'} "
                  f"{question['name']:45} {case['case']:28} {note}")
        print(f"\n{len(work)} case runs per repeat, {len(work) * args.repeats} in all; "
              f"{problems} problem(s).")
        return 1 if problems else 0

    if not os.environ.get("ENGLISH_TO_SQL_PROXY_TOKEN"):
        print("ENGLISH_TO_SQL_PROXY_TOKEN is not set (environment or .devcontainer/.env).")
        return 1
    out_paths = {
        group: os.path.join(results_dir, f"{group}-{stamp}.csv")
        for group in dict.fromkeys(case["group"] for _, case in work)
    }
    files = {group: open(path, "w", encoding="utf-8", newline="")
             for group, path in out_paths.items()}
    writers = {group: csv.DictWriter(file, fieldnames=RESULT_COLUMNS)
               for group, file in files.items()}
    for writer in writers.values():
        writer.writeheader()
    rows = []
    try:
        for run in range(1, args.repeats + 1):
            for question, case in work:
                row = run_case(element, question, case, run)
                writers[case["group"]].writerow(row)
                files[case["group"]].flush()
                rows.append(row)
                print(f"{'ok  ' if row['matches_expected'] == 'TRUE' else 'MISS'} "
                      f"{row['question']:45} {row['student']:28} run {run}  "
                      f"{row['seconds']:>5}s  {row['model_calls']} calls  "
                      f"{row['ERROR'][:60]}")
    finally:
        for file in files.values():
            file.close()

    print("\nSummary (cases matching expected, per question):")
    for name in questions:
        mine = [row for row in rows if row["question"] == name]
        if mine:
            hits = sum(row["matches_expected"] == "TRUE" for row in mine)
            calls = sum(row["model_calls"] for row in mine)
            print(f"  {name:45} {hits}/{len(mine)}   {calls} model calls")
    review = [row for row in rows if row["matches_expected"] == "FALSE"]
    if review:
        print("\nReview these (unexpected outcome or unfaithful result):")
        for row in review:
            print(f"  {row['question']}  {row['student']}  run {row['run']}: "
                  f"correct?={row['correct?'] or '-'} faithful?={row['faithful?'] or '-'} "
                  f"{row['ERROR'][:80]}")
    print()
    for path in out_paths.values():
        print(f"Wrote {path}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
