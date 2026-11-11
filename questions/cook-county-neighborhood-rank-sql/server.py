REFERENCE_QUERIES = {
    "task_a": """SELECT COUNT(*) AS property_class_count
FROM (
    SELECT property_class
    FROM cook_county
    WHERE garage_indicator = 1
    GROUP BY property_class
    HAVING COUNT(*) >= 30
       AND AVG(building_sqft) > 2500
) AS qualifying_property_classes;""",
    "task_b": """SELECT COUNT(*) AS neighborhood_count
FROM (
    SELECT neighborhood_code
    FROM cook_county
    WHERE central_air = 1
    GROUP BY neighborhood_code
    HAVING COUNT(*) >= 30
       AND SUM(sale_price) > 200000000
) AS qualifying_neighborhoods;""",
}


def generate(data):
    task = data["preferences"].get("problem_variant", "task_a")
    if task not in REFERENCE_QUERIES:
        raise ValueError(f"Unknown problem_variant: {task!r}")
    data["params"]["task_a"] = task == "task_a"
    data["params"]["task_b"] = task == "task_b"
    data["correct_answers"]["reference_sql"] = REFERENCE_QUERIES[task]
