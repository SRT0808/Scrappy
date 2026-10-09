"""Evaluate product URLs with bounded escalation and reproducible evidence."""

import argparse
from collections import Counter, defaultdict, deque
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import random
import re
import sys
import time
from urllib.parse import urlsplit

from scrapling.fetchers import DynamicFetcher, Fetcher, StealthyFetcher

from scrappy.extract import Extraction, extract
from scrappy.recipes import RecipeStore
from scrappy.network import public_proxy, public_url

MODES = ("http", "dynamic", "stealth")
CHALLENGE = re.compile(r"just a moment|verify (?:that )?you are human|access denied|attention required|checking your browser|robot check|captcha challenge|permission denied", re.I)


def ordered_urls(path: Path) -> list[str]:
    groups = defaultdict(deque)
    for line in path.read_text(encoding="utf-8-sig").splitlines():
        url = line.strip()
        if not url or url.startswith("#"):
            continue
        parsed = urlsplit(url)
        if parsed.scheme not in ("http", "https") or not parsed.hostname or parsed.username or parsed.password:
            raise ValueError("La muestra debe contener URLs HTTP(S) sin credenciales.")
        if url not in groups[parsed.hostname]:
            groups[parsed.hostname].append(url)
    result = []
    while any(groups.values()):
        for group in groups.values():
            if group:
                result.append(group.popleft())
    if not result:
        raise ValueError("La muestra está vacía.")
    return result


def fetch(url: str, mode: str, timeout: float):
    public_url(url)
    if mode == "http":
        return Fetcher.get(url, timeout=timeout, retries=1, impersonate="chrome", selector_config={"adaptive": False})
    fetcher = DynamicFetcher if mode == "dynamic" else StealthyFetcher
    with public_proxy(timeout) as proxy:
        return fetcher.fetch(url, headless=True, timeout=int(timeout * 1000), retries=1, wait=1500,
                             network_idle=False, disable_resources=True, locale="es-PE", selector_config={"adaptive": False},
                             proxy=proxy, extra_flags=["--proxy-bypass-list=<-loopback>", "--force-webrtc-ip-handling-policy=disable_non_proxied_udp"])


def evaluate(url: str, store: RecipeStore, evidence: Path, timeout: float = 25, max_mode: str = "stealth", pause=None) -> dict:
    domain = urlsplit(url).hostname
    recipe = store.get(domain)
    preferred = recipe.get("fetch_mode", "http")
    modes = list(MODES[:MODES.index(max_mode) + 1])
    if preferred in modes:
        # Try the remembered mode first, then bounded alternatives if it fails.
        modes.remove(preferred)
        modes.insert(0, preferred)
    attempts = []
    result = Extraction(warnings=["No se pudo obtener una lectura confiable."])
    successful_mode = None
    evidence.mkdir(parents=True, exist_ok=True)
    prefix = hashlib.sha256(url.encode()).hexdigest()[:12]
    for mode in modes:
        if pause:
            pause()
        started = time.monotonic()
        attempt = {"mode": mode}
        try:
            page = fetch(url, mode, timeout)
            body = page.body
            if isinstance(body, str):
                body = body.encode("utf-8")
            title = page.css("title::text").get() or ""
            visible = page.get_all_text()[:2000]
            attempt.update(status=page.status, final_url=str(page.url), bytes=len(body), title=title[:180])
            filename = f"{prefix}-{mode}.html"
            (evidence / filename).write_bytes(body)
            attempt["html"] = filename
            attempt["sha256"] = hashlib.sha256(body).hexdigest()
            if page.status >= 400 or CHALLENGE.search(title) or (len(body) < 40000 and CHALLENGE.search(visible)):
                attempt["reason"] = "bloqueo" if page.status in (403, 429) or CHALLENGE.search(title + visible) else "HTTP sin producto"
            else:
                current = extract(body, url, recipe)
                attempt.update(method=current.method, confidence=current.confidence, extraction=current.to_dict())
                if current.confidence >= result.confidence:
                    result = current
                if current.ok:
                    successful_mode = mode
                    result = current
                else:
                    attempt["reason"] = "sin precio confiable"
        except Exception as exc:
            # Exception messages can include cookies or response contents.
            attempt.update(error=type(exc).__name__, reason="error de obtención o extracción")
        attempt["seconds"] = round(time.monotonic() - started, 2)
        attempts.append(attempt)
        if successful_mode:
            recipe["fetch_mode"] = successful_mode
            store.save(domain, recipe)
            break
    row = {"url": url, "domain": domain, "ok": result.ok, "fetch_mode": successful_mode, "extraction": result.to_dict(), "attempts": attempts}
    (evidence / f"{prefix}.json").write_text(json.dumps(row, ensure_ascii=False, indent=2), encoding="utf-8")
    return row


def summary(rows: list[dict]) -> dict:
    ok = [row for row in rows if row["ok"]]
    methods = Counter(row["extraction"]["method"] for row in ok)
    modes = Counter(row["fetch_mode"] for row in ok)
    return {"total": len(rows), "successful": len(ok), "success_rate": round(len(ok) / len(rows), 4) if rows else 0, "by_method": dict(methods), "by_mode": dict(modes), "failed_domains": sorted({row["domain"] for row in rows if not row["ok"]})}


def markdown(report: dict) -> str:
    data = report["summary"]
    lines = [f"Probe: {report['environment']}", "", f"Lecturas confiables: {data['successful']}/{data['total']} ({data['success_rate']:.1%}).", "", "| URL | Resultado | Estrategia | Precio | Moneda | Confianza | Modo |", "|---|---|---|---|---|---|---|"]
    for row in report["results"]:
        ex = row["extraction"]
        lines.append(f"| {row['url']} | {'OK' if row['ok'] else 'Revisar'} | {ex['method']} | {ex['price']} | {ex['currency']} | {ex['confidence']} | {row['fetch_mode'] or 'falló'} |")
    lines += ["", f"Por estrategia (sobre toda la muestra): {json.dumps(data['by_method'], ensure_ascii=False)}.", f"Modos necesarios: {json.dumps(data['by_mode'], ensure_ascii=False)}.", "La confianza es una estimación; revisar el HTML guardado antes de declarar exactitud del precio."]
    if data["success_rate"] < 0.7:
        lines.append("Puerta de decisión: por debajo del 70%; revisar bloqueos/HTML y proponer ajustes antes del motor.")
    return "\n".join(lines) + "\n"


def main() -> None:
    parser = argparse.ArgumentParser(description="Evaluar el extractor con una muestra de productos")
    parser.add_argument("urls", type=Path)
    parser.add_argument("--output", type=Path, default=Path(".scrappy/probe.json"))
    parser.add_argument("--state", type=Path, default=Path(".scrappy/recipes.json"))
    parser.add_argument("--persist-recipes", action="store_true", help="Leer y guardar domain_recipes en Supabase")
    parser.add_argument("--timeout", type=float, default=25)
    parser.add_argument("--max-mode", choices=MODES, default="stealth")
    parser.add_argument("--compare", type=Path, help="Informe local para comparar con Actions")
    args = parser.parse_args()
    if not 1 <= args.timeout <= 60:
        parser.error("El timeout debe estar entre 1 y 60 segundos.")
    try:
        urls = ordered_urls(args.urls)
        store = RecipeStore(args.state, args.persist_recipes)
        previous = json.loads(args.compare.read_text(encoding="utf-8")) if args.compare else None
        evidence = args.output.parent / (args.output.stem + "-evidence")
        rows = []
        last_request = None

        def pause():
            nonlocal last_request
            if last_request is not None:
                time.sleep(random.uniform(2, 8))
            last_request = time.monotonic()

        started = time.monotonic()
        for index, url in enumerate(urls, 1):
            print(f"[{index}/{len(urls)}] {url}", flush=True)
            row = evaluate(url, store, evidence, args.timeout, args.max_mode, pause)
            rows.append(row)
            ex = row["extraction"]
            print(f"  {'OK' if row['ok'] else 'Revisar'} · {ex['name']} · {ex['price']} {ex['currency']} · {ex['method']} · confianza {ex['confidence']} · {row['fetch_mode'] or 'falló'}", flush=True)
            report = {"created_at": datetime.now(timezone.utc).isoformat(), "environment": "actions" if os.environ.get("GITHUB_ACTIONS") else "local", "seconds": round(time.monotonic() - started, 2), "summary": summary(rows), "results": rows, "recipe_persistence": "supabase" if args.persist_recipes else "local_json"}
            if previous:
                old = {r["url"]: r for r in previous["results"]}
                report["comparison"] = [{"url": r["url"], "local_ok": old[r["url"]]["ok"], "actions_ok": r["ok"], "local_mode": old[r["url"]]["fetch_mode"], "actions_mode": r["fetch_mode"], "local_price": old[r["url"]]["extraction"]["price"], "actions_price": r["extraction"]["price"], "local_currency": old[r["url"]]["extraction"]["currency"], "actions_currency": r["extraction"]["currency"]} for r in rows if r["url"] in old]
            args.output.parent.mkdir(parents=True, exist_ok=True)
            args.output.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
        rendered = markdown(report)
        args.output.with_suffix(".md").write_text(rendered, encoding="utf-8")
        print(rendered, flush=True)
        if summary_file := os.environ.get("GITHUB_STEP_SUMMARY"):
            with open(summary_file, "a", encoding="utf-8") as stream:
                stream.write(rendered)
    except (ValueError, RuntimeError, OSError) as exc:
        print(f"Error del probe: {type(exc).__name__}. Revisa la muestra, las rutas y la persistencia.", file=sys.stderr)
        raise SystemExit(1) from None


if __name__ == "__main__":
    main()
