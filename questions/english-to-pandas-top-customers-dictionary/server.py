def generate(data):
    data["correct_answers"][
        "reference_pandas"
    ] = """customer_counts = raw_df.groupby(
    ["year", "customer_id"], as_index=False
).agg(transaction_count=("transaction_id", "count"))
ranked_customers = customer_counts.sort_values(
    ["year", "transaction_count"], ascending=[True, False]
)
top_customers = ranked_customers.groupby("year", as_index=False).head(10)
selected_transactions = raw_df.merge(
    top_customers[["year", "customer_id"]],
    on=["year", "customer_id"],
    how="inner",
)
result = selected_transactions.groupby(
    ["year", "store_id"], as_index=False
).agg(total_amount=("amount", "sum"))"""
