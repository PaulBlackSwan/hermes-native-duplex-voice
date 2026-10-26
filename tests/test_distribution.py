"""Offline distribution tests; all payloads are explicitly synthetic fixtures."""
import hashlib
import json
import os
from pathlib import Path
import stat
import subprocess
import sys
import tempfile
import unittest
from unittest import mock
import zipfile

ROOT = Path(__file__).absolute().parents[1]
sys.path.insert(0, str(ROOT))
from tools import install as installer
from tools import package_release as packager

# Resolve the chosen scratch root so macOS temporary-directory symlinks do not
# interfere with the installer's deliberate no-symlink destination checks.
SCRATCH = Path(os.environ.get("TMPDIR", tempfile.gettempdir())).resolve()


class DistributionTests(unittest.TestCase):
    def setUp(self):
        SCRATCH.mkdir(parents=True, exist_ok=True)
        self.temp = tempfile.TemporaryDirectory(prefix="synthetic-distribution-", dir=SCRATCH)
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.source = self.root / "synthetic-source"
        self.source.mkdir()
        for name in sorted({n for c in packager.COMPONENTS.values() for n in c["files"]} |
                           {"tools/install.py", "tools/package_release.py"}):
            path = self.source / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(("synthetic test fixture: " + name + "\n").encode())
        (self.source / "release.json").write_text(json.dumps({"version": "0.2.0-rc.1"}))
        self.archive = self.root / "release.zip"
        packager.build(self.source, self.archive)
        self.home = self.root / "synthetic-home"

    def run_install(self, component="both", apply=False, archive=None):
        return installer.install(archive or self.archive, self.home, component, apply)

    def target(self, component):
        c = packager.COMPONENTS[component]
        return self.home / c["base"] / c["id"]

    def tree(self, path):
        return {str(p.relative_to(path)): p.read_bytes() for p in path.rglob("*") if p.is_file()}

    def test_dry_run_does_not_create_home(self):
        with mock.patch.object(installer, "apply", side_effect=AssertionError("write attempted")):
            result = self.run_install()
        self.assertEqual(result["mode"], "dry-run")
        self.assertFalse(self.home.exists())
        self.assertEqual([x["action"] for x in result["changes"]], ["create", "create"])

    def test_cli_requires_explicit_home_and_component(self):
        script = ROOT / "tools/install.py"
        result = subprocess.run([sys.executable, str(script), "--archive", str(self.archive)], capture_output=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse(self.home.exists())

    def test_cli_default_dry_run_and_apply_json(self):
        command = [sys.executable, str(ROOT / "tools/install.py"), "--archive", str(self.archive),
                   "--home", str(self.home), "--component", "both"]
        for apply in (False, True):
            result = subprocess.run(command + (["--apply"] if apply else []), capture_output=True, text=True)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(result.stderr, "")
            self.assertEqual(json.loads(result.stdout)["mode"], "apply" if apply else "dry-run")
            self.assertEqual(self.home.exists(), apply)

    def test_empty_home_both_install_verified_and_repeat_unchanged(self):
        self.home.mkdir()
        self.run_install(apply=True)
        before = self.tree(self.home)
        for name, c in packager.COMPONENTS.items():
            target = self.target(name)
            expected = {dst: (self.source / src).read_bytes() for src, dst in c["files"].items()}
            receipt = json.loads((target / installer.RECEIPT).read_bytes())
            self.assertEqual(set(receipt), {"id", "version", "hashes"})
            self.assertEqual(receipt["hashes"], {k: packager.sha(v) for k, v in expected.items()})
            self.assertEqual(set(self.tree(target)), set(expected) | {installer.RECEIPT})
            self.assertNotIn(str(self.home).encode(), (target / installer.RECEIPT).read_bytes())
        result = self.run_install(apply=True)
        self.assertTrue(all(x["action"] == "unchanged" for x in result["changes"]))
        self.assertEqual(before, self.tree(self.home))
        self.assertFalse((self.home / "desktop-plugins/grok-voice-oauth").exists())
        self.assertFalse((self.home / "config.yaml").exists())

    def test_each_component_is_scoped(self):
        self.run_install("gateway", True)
        self.assertTrue(self.target("gateway").exists())
        self.assertFalse((self.home / "desktop-plugins").exists())
        self.run_install("desktop", True)
        self.assertTrue(self.target("desktop").exists())

    def upgraded_archive(self):
        (self.source / "release.json").write_text(json.dumps({"version": "0.2.0-rc.2"}))
        for path in ("gateway-plugin/__init__.py", "desktop-provider/desktop/plugin.js"):
            (self.source / path).write_text("synthetic updated fixture\n")
        archive = self.root / "update.zip"
        packager.build(self.source, archive)
        return archive

    def test_controlled_update_retains_verified_old_copies_outside_discovery(self):
        self.run_install(apply=True)
        old = {name: self.tree(self.target(name)) for name in packager.COMPONENTS}
        archive = self.upgraded_archive()
        result = self.run_install(apply=True, archive=archive)
        self.assertTrue(all(x["action"] == "update" for x in result["changes"]))
        backups = list((self.home / "backups/native-duplex-voice").glob("backup-*"))
        self.assertEqual(len(backups), 2)
        self.assertCountEqual([self.tree(p) for p in backups], list(old.values()))
        self.assertTrue(all(x["action"] == "unchanged" for x in self.run_install(archive=archive)["changes"]))

    def test_unknown_copy_rejected_without_takeover(self):
        target = self.target("gateway")
        target.mkdir(parents=True)
        (target / "user.txt").write_text("preserve me")
        before = self.tree(self.home)
        with self.assertRaisesRegex(installer.Refusal, "Unknown installed copy"):
            self.run_install(apply=True)
        self.assertEqual(before, self.tree(self.home))
        self.assertFalse((self.home / "backups").exists())

    def test_modified_unknown_extra_and_malformed_receipt_fail_closed(self):
        for mutation in ("changed", "extra", "receipt", "empty-dir", "hardlink"):
            with self.subTest(mutation=mutation):
                self.home = self.root / ("home-" + mutation)
                self.run_install(apply=True)
                target = self.target("gateway")
                if mutation == "changed":
                    (target / "__init__.py").write_text("user modification")
                elif mutation == "extra":
                    (target / "unknown.py").write_text("unknown")
                elif mutation == "empty-dir":
                    (target / "unknown").mkdir()
                elif mutation == "hardlink":
                    os.link(target / "__init__.py", self.root / "hardlink")
                else:
                    (target / installer.RECEIPT).write_text("{}")
                before = self.tree(self.home)
                with self.assertRaises((installer.Refusal, OSError)):
                    self.run_install(apply=True, archive=self.archive)
                self.assertEqual(before, self.tree(self.home))

    def test_symlink_home_ancestors_target_parents_and_backups_refused(self):
        for attack in ("home", "ancestor", "plugins", "desktop-plugins", "target", "file", "backups", "backup-store"):
            with self.subTest(attack=attack):
                self.home = self.root / ("home-" + attack)
                outside = self.root / ("outside-" + attack)
                outside.mkdir()
                (outside / "sentinel").write_text("untouched")
                if attack == "home":
                    self.home.symlink_to(outside, target_is_directory=True)
                elif attack == "ancestor":
                    parent = self.root / "alias"
                    parent.symlink_to(outside, target_is_directory=True)
                    self.home = parent / "child"
                else:
                    self.home.mkdir()
                    mapping = {"plugins": "plugins", "desktop-plugins": "desktop-plugins",
                               "target": "plugins/grok-voice-oauth", "backups": "backups",
                               "backup-store": "backups/native-duplex-voice",
                               "file": "plugins/grok-voice-oauth/__init__.py"}
                    link = self.home / mapping[attack]
                    link.parent.mkdir(parents=True, exist_ok=True)
                    link.symlink_to(outside, target_is_directory=True)
                before = self.tree(outside)
                for apply in (False, True):
                    with self.assertRaises((OSError, ValueError)):
                        self.run_install(apply=apply)
                self.assertEqual(before, self.tree(outside))

    def test_legacy_frontend_refuses_even_gateway_only(self):
        legacy = self.home / "desktop-plugins/grok-voice-oauth"
        legacy.mkdir(parents=True)
        (legacy / "plugin.js").write_text("legacy synthetic fixture")
        before = self.tree(self.home)
        for component in ("both", "gateway", "desktop"):
            with self.assertRaisesRegex(installer.Refusal, "Manually review"):
                self.run_install(component, True)
        self.assertEqual(before, self.tree(self.home))

    def test_partial_publication_failure_rolls_back_fresh_install(self):
        original = installer.rename_exclusive
        count = 0
        def fail_second(*args):
            nonlocal count
            count += 1
            if count == 2:
                raise OSError("synthetic publication failure")
            return original(*args)
        with mock.patch.object(installer, "rename_exclusive", side_effect=fail_second):
            with self.assertRaises(OSError):
                self.run_install(apply=True)
        self.assertFalse(self.target("gateway").exists())
        self.assertFalse(self.target("desktop").exists())

    def test_partial_update_failure_restores_both_exact_copies(self):
        self.run_install(apply=True)
        before = {name: self.tree(self.target(name)) for name in packager.COMPONENTS}
        archive = self.upgraded_archive()
        original = installer.rename_exclusive
        count = 0
        def fail_fourth(*args):
            nonlocal count
            count += 1
            if count == 4:
                raise OSError("synthetic second component failure")
            return original(*args)
        with mock.patch.object(installer, "rename_exclusive", side_effect=fail_fourth):
            with self.assertRaises(OSError):
                self.run_install(apply=True, archive=archive)
        self.assertEqual(before, {name: self.tree(self.target(name)) for name in packager.COMPONENTS})

    def test_verification_failure_rolls_back(self):
        original = installer.snapshot
        def corrupt_readback(fd, prefix=""):
            result = original(fd, prefix)
            # Only discovery targets, not staging copies.
            st = os.fstat(fd)
            for name in packager.COMPONENTS:
                target = self.target(name)
                if target.exists() and target.stat().st_ino == st.st_ino:
                    return {**result, "synthetic-corruption": b"test"}
            return result
        with mock.patch.object(installer, "snapshot", side_effect=corrupt_readback):
            with self.assertRaisesRegex(installer.Refusal, "read-back"):
                self.run_install(apply=True)
        self.assertFalse(self.target("gateway").exists())
        self.assertFalse(self.target("desktop").exists())

    def test_deterministic_archive_manifest_checksums_and_allowlist(self):
        for name in (".git/private", "node_modules/token", "logs/debug.log", "verification/private.json",
                     "docs/debug-diagnostic.md", "integration/private.env", "desktop-provider/verification/private.tap"):
            path = self.source / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text("excluded private fixture")
        other = self.root / "repeat.zip"
        packager.build(self.source, other)
        self.assertEqual(self.archive.read_bytes(), other.read_bytes())
        with zipfile.ZipFile(other) as z:
            files = {n: z.read(n) for n in z.namelist()}
            self.assertEqual(z.namelist(), sorted(z.namelist()))
            self.assertTrue(all(i.date_time == (1980, 1, 1, 0, 0, 0) for i in z.infolist()))
        manifest = json.loads(files["manifest.json"])
        self.assertEqual(manifest["files"], {n: hashlib.sha256(v).hexdigest() for n, v in files.items()
                                            if n not in ("manifest.json", "SHA256SUMS")})
        self.assertEqual(files["SHA256SUMS"], "".join(f"{packager.sha(v)}  {n}\n" for n, v in sorted(files.items())
                                                       if n != "SHA256SUMS").encode())
        self.assertTrue(set(files) <= packager.PUBLIC_FILES | {"manifest.json", "SHA256SUMS"})
        installer.load_release(other)

    def rewrite_archive(self, mutate):
        with zipfile.ZipFile(self.archive) as z:
            files = [(i, z.read(i)) for i in z.infolist()]
        target = self.root / "malicious.zip"
        with zipfile.ZipFile(target, "w") as z:
            for info, data in mutate(files):
                z.writestr(info, data)
        return target

    def test_tampered_payload_and_metadata_rejected_before_home_write(self):
        for name in ("manifest.json", "SHA256SUMS", "gateway-plugin/__init__.py"):
            with self.subTest(name=name):
                archive = self.rewrite_archive(lambda files: [(i, b"tampered" if i.filename == name else d) for i, d in files])
                with self.assertRaises((ValueError, OSError)):
                    self.run_install(apply=True, archive=archive)
                self.assertFalse(self.home.exists())
                archive.unlink()

    def test_archive_traversal_unknown_and_symlink_refused(self):
        for name in ("../escape", "/absolute", "x/../escape", "x\\escape", "unexpected.txt", "plugins/"):
            archive = self.rewrite_archive(lambda files: files + [(name, b"synthetic attack")])
            with self.assertRaises(ValueError):
                self.run_install(apply=True, archive=archive)
            self.assertFalse(self.home.exists())
            archive.unlink()
        def symlink(files):
            info, data = files[0]
            info.external_attr = (stat.S_IFLNK | 0o777) << 16
            return [(info, data)] + files[1:]
        with self.assertRaises(ValueError):
            self.run_install(apply=True, archive=self.rewrite_archive(symlink))
        self.assertFalse(self.home.exists())

    def test_source_symlink_parent_output_symlink_and_missing_files_refused(self):
        path = self.source / "gateway-plugin/__init__.py"
        path.unlink()
        path.symlink_to(self.source / "release.json")
        with self.assertRaises(ValueError):
            packager.build(self.source, self.root / "refused.zip")
        path.unlink()
        with self.assertRaises(ValueError):
            packager.build(self.source, self.root / "refused.zip")
        path.write_text("synthetic replacement")
        alias = self.root / "source-alias"
        alias.symlink_to(self.source, target_is_directory=True)
        with self.assertRaises(ValueError):
            packager.build(alias, self.root / "refused.zip")
        out = self.root / "out-alias"
        out.symlink_to(self.archive)
        before = self.archive.read_bytes()
        with self.assertRaises(ValueError):
            packager.build(self.source, out)
        self.assertEqual(before, self.archive.read_bytes())

    def test_public_docs_integration_allowlist_is_single_level_and_not_installed(self):
        allowed = ("CHANGELOG.md", "SECURITY.md", "docs/operator-guide.md", "integration/compat.patch",
                   "integration/compat.json", "integration/verify_compat.py", "desktop-provider/README.md")
        excluded = ("docs/nested/private.md", "integration/debug.json", "integration/diagnostic.py",
                    "integration/verification.json", "integration/nested/compat.patch")
        for name in allowed + excluded:
            path = self.source / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text("synthetic public/selection fixture\n")
        archive = self.root / "with-docs.zip"
        packager.build(self.source, archive)
        with zipfile.ZipFile(archive) as z:
            self.assertTrue(set(allowed) <= set(z.namelist()))
            self.assertFalse(set(excluded) & set(z.namelist()))
        self.run_install(apply=True, archive=archive)
        self.assertFalse((self.home / "integration").exists())
        self.assertFalse((self.home / "docs").exists())
        self.assertTrue((self.target("desktop") / "plugin.js").is_file())
        self.assertFalse((self.target("desktop") / "desktop").exists())

    def test_archive_source_symlink_and_special_file_refused(self):
        alias = self.root / "archive-alias.zip"
        alias.symlink_to(self.archive)
        with self.assertRaises((ValueError, OSError)):
            self.run_install(apply=True, archive=alias)
        alias.unlink()
        os.mkfifo(alias)
        with self.assertRaises((ValueError, OSError)):
            self.run_install(apply=True, archive=alias)
        self.assertFalse(self.home.exists())

    def test_required_runtime_files_missing_or_empty_refused(self):
        path = self.source / "desktop-provider/desktop/plugin.js"
        path.write_bytes(b"")
        with self.assertRaisesRegex(ValueError, "empty"):
            packager.build(self.source, self.root / "empty.zip")
        path.unlink()
        with self.assertRaisesRegex(ValueError, "missing"):
            packager.build(self.source, self.root / "missing.zip")
        self.assertFalse((self.root / "empty.zip").exists())
        self.assertFalse((self.root / "missing.zip").exists())

    def test_private_absolute_paths_in_allowlisted_public_source_refused(self):
        (self.source / "README.md").write_bytes(b"private location: /" + b"Users/PRIVATE-SYNTHETIC/project")
        with self.assertRaisesRegex(ValueError, "private absolute path"):
            packager.build(self.source, self.root / "private-refused.zip")
        self.assertFalse((self.root / "private-refused.zip").exists())

    def test_exclusive_publish_preserves_racing_unknown_copy(self):
        original = installer.rename_exclusive
        injected = False
        def race(src_fd, src, dst_fd, dst):
            nonlocal injected
            if not injected:
                injected = True
                os.mkdir(dst, dir_fd=dst_fd)
                fd = os.open(dst, installer.DIRECTORY, dir_fd=dst_fd)
                try:
                    installer.write_tree(fd, {"unknown.txt": b"synthetic racing user data"})
                finally:
                    os.close(fd)
            return original(src_fd, src, dst_fd, dst)
        with mock.patch.object(installer, "rename_exclusive", side_effect=race):
            with self.assertRaises(OSError):
                self.run_install(apply=True)
        self.assertEqual(self.tree(self.target("gateway")), {"unknown.txt": b"synthetic racing user data"})
        self.assertFalse(self.target("desktop").exists())

    def test_failed_rollback_reports_manual_recovery_and_preserves_backup(self):
        self.run_install(apply=True)
        archive = self.upgraded_archive()
        original = installer.rename_exclusive
        count = 0
        def fail_publish_and_rollback(*args):
            nonlocal count
            count += 1
            if count in (4, 5):
                raise OSError("synthetic rollback failure")
            return original(*args)
        with mock.patch.object(installer, "rename_exclusive", side_effect=fail_publish_and_rollback):
            with self.assertRaisesRegex(installer.Refusal, "Rollback incomplete"):
                self.run_install(apply=True, archive=archive)
        self.assertTrue(list((self.home / "backups/native-duplex-voice").glob("backup-*")))

    def test_explicit_version_without_release_json_and_cli_packaging(self):
        (self.source / "release.json").unlink()
        result = subprocess.run([sys.executable, str(ROOT / "tools/package_release.py"),
                                 "--root", str(self.source), "--version", "0.2.0-rc.1",
                                 "--out", str(self.root / "cli.zip")], capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout)["version"], "0.2.0-rc.1")
        installer.load_release(self.root / "cli.zip")
        with self.assertRaises(ValueError):
            packager.build(self.source, self.root / "invalid.zip", "../../private")


if __name__ == "__main__":
    unittest.main()
