import ast
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))
from firstcue_lib.core import ingest, initial_state, now_iso, save_state
from firstcue_lib.parsing import evidence


class PortableCLITests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="firstcue-portable-", dir=os.environ.get("FIRSTCUE_TEST_TMP"))
        self.addCleanup(self.temp.cleanup)
        self.base = Path(self.temp.name)
        self.skill = self.base / "standalone"
        shutil.copytree(ROOT / "scripts", self.skill / "scripts", ignore=shutil.ignore_patterns("*.mjs", "__pycache__", "lib"))
        self.cli = self.skill / "scripts" / "firstcue.py"
        self.env = {k: os.environ[k] for k in ("PATH", "SystemRoot", "TEMP", "TMP") if k in os.environ}

    def run_cli(self, *args, ok=True):
        # -I ignores PYTHONPATH and user site; -S disables all site packages.
        result = subprocess.run([sys.executable, "-I", "-S", "-B", str(self.cli), *args], cwd=self.base, env=self.env, encoding="utf-8", capture_output=True, timeout=30)
        self.assertEqual(result.returncode, 0 if ok else 1, result.stderr + result.stdout)
        return json.loads(result.stdout if ok else result.stderr)

    def test_copy_folder_runs_without_pip_npm_or_site_packages_and_ignores_cwd_env(self):
        (self.base / ".env").write_text("TWITTERAPI_IO_KEY=must-not-load\n", encoding="utf-8")
        doctor = self.run_cli("doctor")
        self.assertTrue(doctor["stdlibOnly"])
        self.assertFalse(doctor["configured"]["x"])
        self.assertTrue(Path(doctor["dataDir"]).is_relative_to(self.skill))
        rule = self.run_cli("rules", "add", "--name", "AI", "--query", "AI coding agents")
        self.assertFalse(rule["notify"])
        self.run_cli("rules", "update", "--id", rule["id"], "--json", '{"notify":true}')
        self.assertEqual(self.run_cli("rules", "list")[0]["query"], "AI coding agents")
        self.run_cli("rules", "pause", "--id", rule["id"])
        self.assertEqual(self.run_cli("collect", "--due")["status"], "skipped")

    def test_env_loading_is_explicit_and_process_environment_wins(self):
        file = self.base / "separate.env"
        file.write_text("TWITTERAPI_IO_KEY=from-file\n", encoding="utf-8")
        self.assertTrue(self.run_cli("status", "--env-file", str(file))["configured"]["x"])
        self.env["TWITTERAPI_IO_KEY"] = ""
        self.assertFalse(self.run_cli("status", "--env-file", str(file))["configured"]["x"])

    def test_crud_file_payload_settings_validation_and_custom_data_directory(self):
        data = self.base / "data"
        config = self.base / "config.json"
        config.write_text('{"searchPerRunLimit":5}', encoding="utf-8-sig")
        value = self.run_cli("config", "set", "--file", str(config), "--data-dir", str(data))
        self.assertEqual(value["searchPerRunLimit"], 5)
        self.run_cli("config", "set", "--json", '{"xDailyLimit":false}', "--data-dir", str(data), ok=False)
        self.assertEqual(self.run_cli("config", "show", "--data-dir", str(data))["xDailyLimit"], 200)
        source = self.run_cli("sources", "add", "--name", "Custom", "--url", "https://example.com/feed")
        self.run_cli("sources", "delete", "--id", source["id"])
        self.run_cli("sources", "delete", "--id", "bing", ok=False)
        self.run_cli("sources", "add", "--name", "Private", "--url", "http://127.0.0.1", ok=False)
        account = self.run_cli("accounts", "add", "--user-name", "@ExampleAI")
        self.assertEqual(account["userName"], "ExampleAI")
        self.run_cli("accounts", "add", "--user-name", "exampleai", ok=False)

    def test_all_runtime_imports_are_standard_library_or_bundled(self):
        for file in self.skill.rglob("*.py"):
            tree = ast.parse(file.read_text(encoding="utf-8"))
            for node in ast.walk(tree):
                names = [a.name for a in node.names] if isinstance(node, ast.Import) else [node.module] if isinstance(node, ast.ImportFrom) and node.level == 0 else []
                for name in names:
                    top = name.split(".")[0]
                    self.assertTrue(top in sys.stdlib_module_names or top == "firstcue_lib", f"External dependency in {file}: {name}")

    def test_report_import_export_and_notification_preview_end_to_end(self):
        state = initial_state()
        item = ingest(state, evidence({"id": "manual", "kind": "web"}, {"url": "https://example.com/release", "title": "Release", "text": "The new model is available with a larger context window.", "contentKind": "article", "publishedAt": now_iso()}))
        save_state(self.skill / ".firstcue", state)
        raw = {"engine": "Host AI", "title": "Digest", "events": [{"title": "Release", "summary": "A new model is available.", "verdict": "confirmed", "importance": "high", "relevance": "direct", "reason": "The original announcement supports this.", "occurredAt": None, "ruleIds": [], "citations": [{"evidenceId": item["id"], "quote": "The new model is available"}]}]}
        file = self.base / "analysis.json"
        file.write_text(json.dumps(raw), encoding="utf-8")
        report = self.run_cli("reports", "record", "--file", str(file))
        self.assertFalse(self.run_cli("reports", "show", "--id", report["id"])["events"][0]["stale"])
        out = self.base / "digest.md"
        self.run_cli("reports", "render", "--id", report["id"], "--out", str(out))
        self.assertIn("https://example.com/release", out.read_text(encoding="utf-8"))
        env_file = self.base / "notify.env"
        env_file.write_text("FEISHU_WEBHOOK_URL=https://open.feishu.cn/open-apis/bot/v2/hook/fake-webhook\n", encoding="utf-8")
        preview = self.run_cli("notify", "preview", "--report", report["id"], "--channel", "feishu", "--env-file", str(env_file))
        self.assertEqual(preview["count"], 1)
        self.assertEqual(preview["status"], "preview")
        self.assertEqual(self.run_cli("notifications", "list"), [])


if __name__ == "__main__":
    unittest.main()
