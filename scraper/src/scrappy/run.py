"""Command-line entry point for the initial workflow scaffold."""

import argparse


def main() -> None:
    parser = argparse.ArgumentParser(description="Scrappy price tracker")
    parser.add_argument(
        "--mode", choices=("all", "product", "test_notification"), default="all"
    )
    parser.add_argument("--product-id", default="")
    args = parser.parse_args()
    if args.mode == "product" and not args.product_id.strip():
        parser.error("--product-id es obligatorio para --mode product")
    print(f"Cimientos verificados: modo {args.mode}. Motor pendiente de implementar.")


if __name__ == "__main__":
    main()
