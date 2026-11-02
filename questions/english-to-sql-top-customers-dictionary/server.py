def generate(data):
    data["correct_answers"][
        "reference_sql"
    ] = """WITH customer_counts AS (
    SELECT year, customer_id, COUNT(transaction_id) AS transaction_count
    FROM raw_df
    GROUP BY year, customer_id
),
ranked_customers AS (
    SELECT
        year,
        customer_id,
        ROW_NUMBER() OVER (
            PARTITION BY year
            ORDER BY transaction_count DESC
        ) AS rank_in_year
    FROM customer_counts
),
top_customers AS (
    SELECT year, customer_id
    FROM ranked_customers
    WHERE rank_in_year <= 10
)
SELECT raw_df.year, raw_df.store_id, SUM(raw_df.amount) AS total_amount
FROM raw_df
JOIN top_customers
  ON raw_df.year = top_customers.year
 AND raw_df.customer_id = top_customers.customer_id
GROUP BY raw_df.year, raw_df.store_id;"""
