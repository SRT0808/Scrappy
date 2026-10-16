"""Reconcile a stopped first-slot acceptance capture without external writes.

Usage: python scripts/verify_acceptance.py BASELINE OBSERVATION OUTPUT
This intentionally verifies successful, native-currency, no-alert evidence only.
"""

import json
import sys
from datetime import datetime, timedelta, timezone
from decimal import Decimal, ROUND_HALF_UP
from pathlib import Path


def require(condition, message):
    if not condition:
        raise ValueError(message)


def timestamp(value):
    result = datetime.fromisoformat(value.replace("Z", "+00:00"))
    require(result.tzinfo is not None, "Timestamp must include timezone")
    return result.astimezone(timezone.utc)


def within(value, start, end, *, github_seconds=False):
    point, lower, upper = map(timestamp, (value, start, end))
    if github_seconds:
        require(lower.microsecond == upper.microsecond == 0, "Expected GitHub seconds")
        return lower <= point < upper + timedelta(seconds=1)
    return lower <= point <= upper


def decimal(value):
    result = Decimal(str(value))
    require(result.is_finite(), "Non-finite decimal")
    return result


def money(value):
    return decimal(value).quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)


def additions(before, after):
    old = {row["id"]: row for row in before}
    current = {row["id"]: row for row in after}
    require(len(old) == len(before) and len(current) == len(after), "Duplicate IDs")
    require(all(current.get(key) == row for key, row in old.items()), "Historical rows changed")
    return [row for row in after if row["id"] not in old]


def verify_snapshot(snapshot):
    require(snapshot["complete"] is True, "Incomplete snapshot")
    lines = snapshot["lines"]
    require(len(lines) == snapshot["item_count"] == snapshot["valid_count"], "Invalid line counts")
    for field in ("stale_count", "unavailable_count", "missing_count", "fx_missing_count"):
        require(snapshot[field] == 0, f"Unexpected {field}")
    require(bool(lines), "Empty snapshot")
    for line in lines:
        require(line["valid"] and not line["stale"] and not line["unavailable"], "Invalid line")
        require(line["currency"] == snapshot["currency"] and line["conversion"] is None,
                "Converted snapshots need separate verification")
        require(decimal(line["quantity"]) > 0, "Invalid quantity")
    reference = money(sum((decimal(line["reference_price"]) * decimal(line["quantity"])
                           for line in lines), Decimal(0)))
    current = money(sum((decimal(line["last_price"]) * decimal(line["quantity"])
                         for line in lines), Decimal(0)))
    require(decimal(snapshot["reference_total"]) == reference, "Reference total mismatch")
    require(decimal(snapshot["current_total"]) == current, "Current total mismatch")
    savings = reference - current
    require(decimal(snapshot["savings"]) == savings, "Savings mismatch")
    require(reference > 0, "Invalid reference total")
    require(decimal(snapshot["savings_percent"]) == money(savings * 100 / reference),
            "Savings percent mismatch")
    return {"id": snapshot["id"], "reference": str(reference), "current": str(current),
            "savings": str(savings), "savingsPercent": str(money(savings * 100 / reference))}


def reconcile(baseline, observation):
    run = observation["firstRun"]
    require(baseline["jobId"] == observation["jobId"], "Job mismatch")
    require(run["sha"] == baseline["sha"] == observation["sha"], "SHA mismatch")
    require(run["event"] == "workflow_dispatch" and run["branch"] == "main", "Unexpected dispatch")
    require(run["status"] == "completed" and run["conclusion"] == "success", "Failed run")
    slots = [s for s in observation["slots"] if json.loads(s["body"])["workflow_run_id"] == run["id"]]
    require(len(slots) == 1, "Ambiguous scheduler response")
    slot = slots[0]
    require(slot["jobId"] == baseline["jobId"] and slot["status"] == 1
            and slot["httpStatus"] == 200, "Failed scheduler slot")
    planned = datetime.fromtimestamp(slot["datePlanned"], timezone.utc)
    require(planned == timestamp(baseline["plannedSlots"][0]), "Not the first planned slot")
    require(len(run["jobs"]) == 1 and run["jobs"][0]["conclusion"] == "success", "Unexpected jobs")
    steps = run["jobs"][0]["steps"]
    processing = next(s for s in steps if s["name"] == "Review products and send notifications")
    heartbeat = next(s for s in steps if s["name"] == "Ping heartbeat")
    require(processing["conclusion"] == heartbeat["conclusion"] == "success", "Failed steps")
    captured = [v for v in observation["verified"] if v["runId"] == run["id"]]
    require(len(captured) == 1, "Ambiguous captured run")
    captured = captured[0]
    pre = [b for b in observation["baselines"] if timestamp(b["capturedAt"]) < planned]
    require(bool(pre), "Missing pre-slot baseline")
    before = max(pre, key=lambda b: timestamp(b["capturedAt"]))
    after = captured["stateAfter"]
    runs = additions(before["tables"]["runs"], after["runs"])
    require(len(runs) == 1 and runs[0] == captured["dbRun"], "Ambiguous database run")
    persisted = runs[0]
    start, end = persisted["started_at"], persisted["finished_at"]
    require(timestamp(start) <= timestamp(end), "Reversed database interval")
    require(all(within(t, processing["started_at"], processing["completed_at"], github_seconds=True)
                for t in (start, end)), "Database run outside GitHub second interval")
    require(persisted["trigger"] == "dispatch", "Unexpected database trigger")
    checks = additions(before["tables"]["price_checks"], after["price_checks"])
    require({c["id"]: c for c in checks} == {c["id"]: c for c in captured["priceChecks"]}
            and len(checks) == len(captured["priceChecks"]), "Captured checks mismatch")
    require(all(within(c["checked_at"], start, end) for c in checks), "Check outside exact DB interval")
    require(len(checks) == persisted["checked"] == persisted["ok_count"] and persisted["fail_count"] == 0
            and all(c["ok"] for c in checks), "Check counters mismatch")
    require(len({c["product_id"] for c in checks}) == len(checks), "Duplicate product checks")
    require({c["product_id"] for c in checks} == {p["id"] for p in before["due"]}, "Due products mismatch")
    require(within(captured["heartbeatReceipt"]["last_ping"], heartbeat["started_at"],
                   heartbeat["completed_at"], github_seconds=True)
            and captured["heartbeatReceipt"]["status"] == "up", "Heartbeat mismatch")
    require(any("RUN_MODE: all" in line for line in observation["firstRunLogEvidence"]), "Missing all mode")
    for table in ("basket_items", "lists", "notifications", "basket_events"):
        require(after[table] == before["tables"][table], f"Unexpected changes in {table}")
    require(all(row["budget"] is None for row in after["lists"]), "Basket alert needs separate verification")
    products = {p["id"]: p for p in after["products"]}
    require(set(products) == {p["id"] for p in before["tables"]["products"]}, "Product IDs changed")
    updated_fields = {"last_price", "last_checked_at", "last_success_at", "last_method",
                      "last_availability", "consecutive_failures"}
    for previous in before["tables"]["products"]:
        current = products[previous["id"]]
        require(previous.keys() == current.keys() and all(current[field] == value
                for field, value in previous.items() if field not in updated_fields),
                "Unexpected product configuration or alert changes")
    for check in checks:
        product = products[check["product_id"]]
        require(decimal(product["last_price"]) == decimal(check["price"])
                and product["currency"] == check["currency"]
                and product["last_method"] == check["method"]
                and product["last_availability"] == check["availability"], "Product result mismatch")
        require(timestamp(product["last_checked_at"]) == timestamp(check["checked_at"])
                == timestamp(product["last_success_at"]), "Product timestamp mismatch")
        require(product["consecutive_failures"] == 0 and product["alert_state"] == "armed",
                "Unexpected product state")
        target = decimal(product["target_price"]) if product["target_type"] == "price" else money(
            decimal(product["reference_price"]) * (1 - decimal(product["target_percent"]) / 100))
        require(decimal(check["price"]) > target, "Eligible product alert needs separate verification")
    snapshots = additions(before["tables"]["basket_snapshots"], after["basket_snapshots"])
    require(len(snapshots) == 1, "Unexpected snapshot count")
    snapshot = snapshots[0]
    require(within(snapshot["calculated_at"], start, end), "Snapshot outside DB interval")
    totals = verify_snapshot(snapshot)
    basket = next(row for row in after["lists"] if row["id"] == snapshot["list_id"])
    require(snapshot["composition_version"] == basket["composition_version"], "Composition mismatch")
    members = [i for i in after["basket_items"] if i["list_id"] == snapshot["list_id"]]
    require({i["product_id"] for i in members} == {l["product_id"] for l in snapshot["lines"]},
            "Snapshot membership mismatch")
    for line in snapshot["lines"]:
        product = products[line["product_id"]]
        require(decimal(line["last_price"]) == decimal(product["last_price"])
                and decimal(line["reference_price"]) == decimal(product["reference_price"]), "Line price mismatch")
        require(timestamp(line["last_checked_at"]) == timestamp(product["last_checked_at"])
                == timestamp(line["last_success_at"]), "Line timestamp mismatch")
        require(decimal(line["quantity"]) == decimal(next(i["quantity"] for i in members
                    if i["product_id"] == line["product_id"])), "Line quantity mismatch")
    key = lambda row: (row["rate_date"], row["from_currency"], row["to_currency"])
    old_fx = {key(row): row for row in before["tables"]["exchange_rates"]}
    new_fx = {key(row): row for row in after["exchange_rates"]}
    require(old_fx.keys() == new_fx.keys(), "FX keys changed")
    refreshed = [row for k, row in new_fx.items() if row != old_fx[k]]
    require(len(refreshed) == 1, "Unexpected FX refresh count")
    fx = refreshed[0]
    require(all(value == old_fx[key(fx)][field] for field, value in fx.items() if field != "fetched_at")
            and within(fx["fetched_at"], start, end), "Unexpected FX changes")
    return {"runId": run["id"], "databaseRunId": persisted["id"], "firstRunReconciled": True,
            "priceChecks": len(checks), "snapshot": totals, "fxRefreshed": len(refreshed),
            "newEvents": 0, "newNotifications": 0, "heartbeatMatched": True,
            "verifiedSlots": 1, "threeSlotsAccepted": False,
            "baselineCapturedAt": before["capturedAt"], "microsecondsPreserved": True}


if __name__ == "__main__":
    baseline_path, observation_path, output_path = map(Path, sys.argv[1:])
    baseline = json.loads(baseline_path.read_text(encoding="utf-8"), parse_float=Decimal)
    observation = json.loads(observation_path.read_text(encoding="utf-8"), parse_float=Decimal)
    result = reconcile(baseline, observation)
    result["checkedAt"] = datetime.now(timezone.utc).isoformat()
    output_path.write_text(json.dumps(result, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(result))
