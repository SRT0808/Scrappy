"""Offline child for the local executor: real runner/parser, temporary SQL only."""

from datetime import datetime
import json
from pathlib import Path
import subprocess
import sys

from scrappy.extract import Extraction, extract

config = json.loads(Path("fixture.json").read_text())
namespace = {"__name__": "fixture_runner"}
exec(compile(Path(config["runner"]).read_text(encoding="utf-8"), config["runner"], "exec"), namespace)


def sql(query):
    return subprocess.check_output([config["psql"], *config["args"], "-c", query],
                                   text=True, timeout=20).strip()


def literal(value):
    return "NULL" if value is None else "'" + str(value).replace("'", "''") + "'"


class FixtureDatabase:
    def request(self, method, path, data=None):
        if method == "POST" and path == "runs":
            return [{"id": "00000000-0000-4000-8000-000000000001"}]
        if method == "PATCH" and path.startswith("runs?id=eq."):
            return None
        if method == "GET" and path in ("domain_recipes?select=*", "settings?select=key,value"):
            return []
        raise AssertionError("Unexpected transport: " + path)

    def due_products(self, now, product_id):
        return [json.loads(sql("select row_to_json(p) from products p where id=" + literal(product_id)))]

    def save_review(self, product, checked_at, result, checks):
        sql("begin isolation level serializable; set local role service_role; select public.save_review(" +
            ",".join([literal(product["id"]) + "::uuid", literal(product["last_checked_at"]) + "::timestamptz",
                      literal(checked_at.isoformat()) + "::timestamptz", str(result.accepted).lower(),
                      literal(json.dumps(checks)) + "::jsonb"]) + "); commit")
        if config.get("crash_after_save"):
            raise RuntimeError("fixture stopped after durable review")


# No fetch, FX provider, individual alerts or legacy channel deliveries.
original_review = namespace["review_product"]
namespace["review_product"] = lambda *args, **kwargs: original_review(*args, **kwargs, alerts=lambda *a, **k: None)
namespace["refresh_exchange_rate"] = lambda *args: None
namespace["process_baskets"] = lambda *args: None
html = ('<script type="application/ld+json">' + json.dumps({"@type": "Product", "name": "Fixture",
        "offers": {"@type": "Offer", "price": "10", "priceCurrency": "USD",
                   "availability": "https://schema.org/InStock"}}) + '</script>').encode()
namespace["execute_reviews"](FixtureDatabase(), sys.argv[-1],
    now=lambda: datetime.fromisoformat(config["at"]), sleep=lambda _: None,
    read=lambda product, recipe: extract(html, product["url"]) if config["ok"] else Extraction())
