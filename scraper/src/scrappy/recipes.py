"""Probe recipe persistence and a JSON adapter for pinned Scrapling fingerprints."""

from datetime import datetime, timezone
import json
import os
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import urlsplit
from urllib.request import Request, urlopen

from scrapling.core.storage import StorageSystemMixin
from scrapling.core.utils import _StorageTools


class JsonStorage(StorageSystemMixin):
    """Store JSON-safe fingerprints, scoped to a product URL and selector."""

    def __init__(self, url: str, state: dict):
        super().__init__(url)
        self.state = state
        if state.get("version") != "0.4.15":
            state.clear()
            state.update(version="0.4.15", elements={})

    def save(self, element, identifier: str) -> None:
        self.state["elements"][self._get_hash(f"{self.url}|{identifier}")] = _StorageTools.element_to_dict(element)

    def retrieve(self, identifier: str) -> dict | None:
        return self.state["elements"].get(self._get_hash(f"{self.url}|{identifier}"))


class RecipeStore:
    def __init__(self, path: Path, remote: bool = False):
        self.path = path
        self.remote = remote
        self.recipes = json.loads(path.read_text(encoding="utf-8")) if path.exists() else {}
        self.url = os.environ.get("SUPABASE_URL", "").strip().rstrip("/")
        self.key = os.environ.get("SUPABASE_SERVICE_ROLE_KEY", "").strip()
        if remote:
            parsed = urlsplit(self.url)
            if not self.key or parsed.scheme != "https" or not parsed.hostname or parsed.username or parsed.path or parsed.query or parsed.fragment:
                raise ValueError("Faltan credenciales válidas de Supabase para persistir recetas.")
            rows = self._request("GET", "?select=domain,fetch_mode,price_selector,name_selector,adaptive_state")
            self.recipes.update({row.pop("domain"): row for row in rows})

    def _request(self, method: str, suffix: str = "", data: object = None):
        request = Request(
            f"{self.url}/rest/v1/domain_recipes{suffix}",
            method=method,
            data=json.dumps(data).encode() if data is not None else None,
            headers={"apikey": self.key, "Authorization": f"Bearer {self.key}", "Content-Type": "application/json", "Prefer": "resolution=merge-duplicates,return=minimal"},
        )
        try:
            with urlopen(request, timeout=15) as response:
                body = response.read()
                return json.loads(body) if body else None
        except HTTPError as exc:
            raise RuntimeError(f"Persistencia de recetas rechazada (HTTP {exc.code}).") from None
        except (URLError, OSError):
            raise RuntimeError("No se pudo conectar con la persistencia de recetas.") from None

    def get(self, domain: str) -> dict:
        return self.recipes.get(domain, {}).copy()

    def save(self, domain: str, recipe: dict) -> None:
        self.recipes[domain] = recipe
        self.path.parent.mkdir(parents=True, exist_ok=True)
        temporary = self.path.with_suffix(".tmp")
        temporary.write_text(json.dumps(self.recipes, ensure_ascii=False, indent=2), encoding="utf-8")
        temporary.replace(self.path)
        if self.remote:
            self._request("POST", "?on_conflict=domain", {"domain": domain, **recipe, "updated_at": datetime.now(timezone.utc).isoformat()})
