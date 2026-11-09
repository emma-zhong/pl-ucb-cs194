#!/usr/bin/env python3
"""Build the deterministic teaching subset used by the Cook County SQL study."""

import argparse
import csv


COLUMNS = [
    ("PIN", "property_id"),
    ("Property Class", "property_class"),
    ("Neighborhood Code", "neighborhood_code"),
    ("Building Square Feet", "building_sqft"),
    ("Sale Price", "sale_price"),
    ("Modeling Group", "modeling_group"),
    ("Sale Year", "sale_year"),
    ("Garage Indicator", "garage_indicator"),
    ("Central Air", "central_air"),
]

INTEGER_OUTPUTS = {
    "property_class",
    "neighborhood_code",
    "sale_year",
    "garage_indicator",
    "central_air",
}


def normalized_value(value, output_name):
    if value == "" or output_name not in INTEGER_OUTPUTS:
        return value
    return str(int(float(value)))


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("source", help="Path to cook_county_train.csv")
    parser.add_argument("destination", help="Path for the reduced CSV")
    args = parser.parse_args()

    with open(args.source, newline="", encoding="utf-8") as source_file, open(
        args.destination, "w", newline="", encoding="utf-8"
    ) as destination_file:
        reader = csv.DictReader(source_file)
        writer = csv.DictWriter(
            destination_file,
            fieldnames=[output for _, output in COLUMNS],
            lineterminator="\n",
        )
        writer.writeheader()
        for index, row in enumerate(reader):
            if index % 4 != 0:
                continue
            writer.writerow(
                {
                    output: normalized_value(row[source], output)
                    for source, output in COLUMNS
                }
            )


if __name__ == "__main__":
    main()
