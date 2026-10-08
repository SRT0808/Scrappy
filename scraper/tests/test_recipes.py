"""Recipe API contract, JSON fingerprints and recovery in a fresh process."""

import io
import json
import os
from pathlib import Path
import subprocess
import sys
from tempfile import TemporaryDirectory
import unittest
from unittest.mock import MagicMock, patch
from urllib.error import HTTPError
from uuid import uuid4

from scrappy.extract import extract
from scrappy.recipes import JsonStorage, RecipeStore

FIXTURES = Path(__file__).parent / "fixtures"
RESTORE = """
import json, sys
from pathlib import Path
from scrappy.extract import extract
from scrappy.recipes import RecipeStore
store = RecipeStore(Path(sys.argv[1]), remote=sys.argv[3] == 'remote')
recipe = store.get(sys.argv[2])
result = extract(Path(sys.argv[4]).read_bytes(), 'https://shop.pe/product', recipe)
assert result.method == 'adaptive', result.to_dict()
assert str(result.price) == '119.90', result.to_dict()
assert not result.ok, 'An adaptive match must still require confirmation'
print(json.dumps({'method':result.method, 'price':str(result.price), 'requires_confirmation':not result.ok}))
"""


class RecipeTests(unittest.TestCase):
    def test_round_trip_fingerprints_in_new_process(self):
        with TemporaryDirectory() as folder:
            path = Path(folder) / "recipes.json"
            recipe = {"price_selector": ".old-selector", "fetch_mode": "http"}
            self.assertTrue(extract((FIXTURES / "recipe_before.html").read_bytes(), "https://shop.pe/product", recipe).ok)
            RecipeStore(path).save("shop.pe", recipe)
            completed = subprocess.run([sys.executable, "-c", RESTORE, str(path), "shop.pe", "local", str(FIXTURES / "recipe_after.html")], text=True, capture_output=True, timeout=20)
            self.assertEqual(completed.returncode, 0, completed.stderr)
            self.assertEqual(json.loads(completed.stdout)["price"], "119.90")

    def test_version_and_product_url_isolation(self):
        state = {"version": "old", "elements": {"stale": {}}}
        storage = JsonStorage("https://shop.pe/other-product", state)
        self.assertIsNone(storage.retrieve(".price"))
        self.assertEqual(state, {"version": "0.4.15", "elements": {}})

    def test_supabase_upsert_keeps_owner_selectors(self):
        with TemporaryDirectory() as folder, patch.dict(os.environ, {"SUPABASE_URL": "https://test.supabase.co", "SUPABASE_SERVICE_ROLE_KEY": "private-key"}):
            response = MagicMock()
            response.__enter__.return_value.read.return_value = b'[{"domain":"shop.pe","fetch_mode":"http","price_selector":".owner","name_selector":"h1","adaptive_state":null}]'
            with patch("scrappy.recipes.urlopen", return_value=response) as open_url:
                store = RecipeStore(Path(folder) / "recipes.json", remote=True)
                recipe = store.get("shop.pe")
                recipe["fetch_mode"] = "dynamic"
                store.save("shop.pe", recipe)
                request = open_url.call_args.args[0]
                self.assertEqual(json.loads(request.data)["price_selector"], ".owner")
                self.assertIn("on_conflict=domain", request.full_url)
                self.assertEqual(request.get_header("Authorization"), "Bearer private-key")

    def test_invalid_endpoint_does_not_send_credentials(self):
        with TemporaryDirectory() as folder, patch.dict(os.environ, {"SUPABASE_URL": "http://test.supabase.co", "SUPABASE_SERVICE_ROLE_KEY": "private-key"}), patch("scrappy.recipes.urlopen") as open_url:
            with self.assertRaises(ValueError):
                RecipeStore(Path(folder) / "recipes.json", remote=True)
            open_url.assert_not_called()

    def test_remote_errors_do_not_expose_credentials(self):
        with TemporaryDirectory() as folder, patch.dict(os.environ, {"SUPABASE_URL": "https://test.supabase.co", "SUPABASE_SERVICE_ROLE_KEY": "private-key"}), patch("scrappy.recipes.urlopen", side_effect=HTTPError("", 401, "private-key", {}, io.BytesIO(b"private-key"))):
            with self.assertRaisesRegex(RuntimeError, "HTTP 401") as caught:
                RecipeStore(Path(folder) / "recipes.json", remote=True)
            self.assertNotIn("private-key", str(caught.exception))

    @unittest.skipUnless(os.environ.get("SCRAPPY_TEST_SUPABASE") == "1", "explicit integration opt-in required")
    def test_supabase_adaptive_round_trip_in_new_process(self):
        domain = f"probe-{uuid4().hex}.invalid"
        with TemporaryDirectory() as folder:
            path = Path(folder) / "recipes.json"
            store = RecipeStore(path, remote=True)
            recipe = {"fetch_mode": "http", "price_selector": ".old-selector"}
            self.assertTrue(extract((FIXTURES / "recipe_before.html").read_bytes(), "https://shop.pe/product", recipe).ok)
            try:
                store.save(domain, recipe)
                completed = subprocess.run([sys.executable, "-c", RESTORE, str(Path(folder) / "fresh.json"), domain, "remote", str(FIXTURES / "recipe_after.html")], text=True, capture_output=True, timeout=30)
                self.assertEqual(completed.returncode, 0, completed.stderr)
                print("Persistencia Supabase en proceso nuevo: " + completed.stdout.strip())
            finally:
                store._request("DELETE", f"?domain=eq.{domain}")


if __name__ == "__main__":
    unittest.main()
