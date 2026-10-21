def generate(data):
    data["correct_answers"][
        "reference_sql"
    ] = """SELECT COUNT(*) AS customer_count
FROM (
    SELECT customer_id
    FROM transactions
    WHERE year = 2025
    GROUP BY customer_id
    HAVING SUM(total) > 200
) AS qualifying_customers;"""
