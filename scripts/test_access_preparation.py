"""Exercise the installed launcher against the container command boundary."""

import os
from pathlib import Path
import subprocess
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[1]


class AccessPreparationTests(unittest.TestCase):
    def run_launcher(self, arguments: list[str], fails: bool):
        with tempfile.TemporaryDirectory(prefix="flight-finder-prepare-") as temporary:
            directory = Path(temporary)
            binaries = directory / "bin"
            binaries.mkdir()
            log = directory / "commands"
            (directory / "docker-compose.yml").write_text("services: {}\n")
            docker = binaries / "docker"
            docker.write_text(
                '#!/bin/sh\n'
                'printf "%s\\n" "$*" >> "$TEST_COMPOSE_LOG"\n'
                'case "$*" in *SIDEDOOR_PREPARE_ONLY*) '
                'if [ "$TEST_PREPARATION_FAILURE" = 1 ]; then '
                'echo "Preparation rejected" >&2; exit 42; fi;; esac\n'
            )
            docker.chmod(0o755)
            for name in ("open", "xdg-open", "curl"):
                stub = binaries / name
                stub.write_text('#!/bin/sh\nprintf "{}\\n"\n')
                stub.chmod(0o755)
            environment = {
                **os.environ,
                "PATH": f"{binaries}:{os.environ['PATH']}",
                "FLIGHT_FINDER_DIR": str(directory),
                "TEST_COMPOSE_LOG": str(log),
                "TEST_PREPARATION_FAILURE": "1" if fails else "0",
            }
            result = subprocess.run(
                ["bash", str(ROOT / "apps/web/public/flight-finder-cli"), *arguments],
                env=environment, capture_output=True, text=True, timeout=10, check=False,
            )
            return result, log.read_text().splitlines()

    def test_preparation_failure_prevents_both_start_modes(self):
        for arguments in ([], ["start"]):
            with self.subTest(arguments=arguments):
                result, commands = self.run_launcher(arguments, True)
                self.assertNotEqual(result.returncode, 0)
                self.assertIn("Preparation rejected", result.stderr)
                self.assertTrue(any("SIDEDOOR_PREPARE_ONLY=true" in command for command in commands))
                self.assertFalse(any(command.endswith("up -d") for command in commands))

    def test_successful_preparation_precedes_serving_and_preserves_existing_databases(self):
        result, commands = self.run_launcher(["start"], False)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        database = next(index for index, command in enumerate(commands) if command.endswith("up -d --no-recreate db redis"))
        preparation = next(index for index, command in enumerate(commands) if "SIDEDOOR_PREPARE_ONLY=true" in command)
        stopped = next(index for index, command in enumerate(commands) if command.endswith("stop web"))
        serving = next(index for index, command in enumerate(commands) if command.endswith("up -d"))
        self.assertLess(database, preparation)
        self.assertLess(stopped, preparation)
        self.assertLess(preparation, serving)

    def test_local_access_commands_bypass_web_startup_and_health(self):
        result, commands = self.run_launcher(["access", "list"], True)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertTrue(any(command.endswith("run --rm --no-deps --entrypoint node web /app/packages/cli/dist/index.js access list") for command in commands))
        self.assertFalse(any("SIDEDOOR_PREPARE_ONLY" in command or " up " in command for command in commands))


if __name__ == "__main__":
    unittest.main()
