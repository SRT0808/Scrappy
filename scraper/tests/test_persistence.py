"""Optional SQL assertions against installed functions; fixture data is rolled back."""

import json
import os
from pathlib import Path
import unittest
from urllib.error import HTTPError
from urllib.parse import urlsplit
from urllib.request import Request, urlopen


class PersistenceIntegrationTests(unittest.TestCase):
    @unittest.skipUnless(os.environ.get("SCRAPPY_TEST_SQL") == "1", "Optional transactional Supabase SQL test")
    def test_atomic_persistence_selection_boundaries_and_permissions(self):
        token = os.environ.get("SUPABASE_ACCESS_TOKEN", "").strip()
        if not token:
            self.fail("Falta SUPABASE_ACCESS_TOKEN en el entorno local para ejecutar las pruebas SQL.")
        ref = urlsplit(os.environ["SUPABASE_URL"]).hostname.split(".")[0]
        assertions = (Path(__file__).parent / "fixtures/review_persistence.sql").read_text(encoding="utf-8")
        request = Request(
            f"https://api.supabase.com/v1/projects/{ref}/database/query",
            headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
            data=json.dumps({"query": "begin;\n" + assertions + "\nrollback;"}).encode(),
            method="POST",
        )
        try:
            with urlopen(request, timeout=30) as response:
                response.read()
        except HTTPError as exc:
            # Database diagnostics contain only generated fixture data, never credentials.
            message = exc.read().decode()
            message = message.replace(token, "[redacted]")
            self.fail(f"SQL assertions failed (HTTP {exc.code}): {message[:1500]}")


if __name__ == "__main__":
    unittest.main()
