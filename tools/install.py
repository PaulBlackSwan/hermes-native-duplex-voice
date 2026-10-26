#!/usr/bin/env python3
"""Offline ZIP installer. Dry-run unless --apply; never enables plugins.

Requires an explicit --home for one profile. No environment/profile discovery,
network, auth, microphone, host patching, settings, restart or uninstall actions.
Run only against a trusted release, with no other writer changing the home tree.
Checksums provide integrity, not publisher authentication. Backups are retained.
"""
import argparse
import ctypes
import contextlib
import fcntl
import json
import os
from pathlib import Path
import re
import stat
import sys
import uuid
import zipfile
from typing import Literal, Optional, overload

try:
    from .package_release import COMPONENTS, VERSION_RE, canonical, is_public_name, sha, validate_name
except ImportError:
    from package_release import COMPONENTS, VERSION_RE, canonical, is_public_name, sha, validate_name

RECEIPT = ".native-duplex-receipt.json"
NOFOLLOW = os.O_NOFOLLOW
DIRECTORY = os.O_RDONLY | os.O_DIRECTORY | NOFOLLOW
MAX_FILE = 16 * 1024 * 1024
MAX_TOTAL = 64 * 1024 * 1024


class Refusal(ValueError):
    pass


def strict_json(data):
    def pairs(items):
        result = {}
        for key, value in items:
            if key in result:
                raise Refusal("duplicate JSON key")
            result[key] = value
        return result
    try:
        return json.loads(data, object_pairs_hook=pairs)
    except (ValueError, UnicodeError):
        raise Refusal("invalid JSON") from None


def load_release(archive_path):
    """Read in memory, never extract arbitrary archive members."""
    files = {}
    path = Path(archive_path)
    if ".." in path.parts:
        raise Refusal("archive path traversal refused")
    path = Path(os.path.abspath(path))
    parent = walk_absolute(path.parent)
    if parent is None:
        raise Refusal("archive parent missing")
    try:
        handle = os.open(path.name, os.O_RDONLY | NOFOLLOW | os.O_NONBLOCK, dir_fd=parent)
    finally:
        os.close(parent)
    with contextlib.ExitStack() as stack:
        stream = stack.enter_context(os.fdopen(handle, "rb"))
        st = os.fstat(stream.fileno())
        if not stat.S_ISREG(st.st_mode) or st.st_nlink != 1 or st.st_size > MAX_TOTAL:
            raise Refusal("archive must be a bounded regular single-link file")
        archive = stack.enter_context(zipfile.ZipFile(stream))
        total = 0
        for info in archive.infolist():
            name = validate_name(info.filename)
            mode = info.external_attr >> 16
            if name in files or not (is_public_name(name) or name in {"manifest.json", "SHA256SUMS"}):
                raise Refusal("unknown or duplicate archive member")
            if info.is_dir() or stat.S_IFMT(mode) not in (0, stat.S_IFREG):
                raise Refusal("archive contains non-regular member")
            total += info.file_size
            if info.file_size > MAX_FILE or total > MAX_TOTAL:
                raise Refusal("release exceeds size limit")
            files[name] = archive.read(info)
    if not {"manifest.json", "SHA256SUMS"} <= files.keys():
        raise Refusal("release manifest/checksums missing")
    manifest = strict_json(files["manifest.json"])
    if (not isinstance(manifest, dict) or set(manifest) != {"schema", "version", "files"}
            or type(manifest["schema"]) is not int or manifest["schema"] != 1
            or not isinstance(manifest["version"], str) or not VERSION_RE.fullmatch(manifest["version"])
            or not isinstance(manifest["files"], dict)):
        raise Refusal("unsupported release manifest")
    expected = {name: sha(data) for name, data in files.items() if name not in {"manifest.json", "SHA256SUMS"}}
    if manifest["files"] != expected:
        raise Refusal("release SHA256 manifest mismatch")
    checksums = "".join(f"{sha(data)}  {name}\n" for name, data in sorted(files.items()) if name != "SHA256SUMS").encode()
    if files["SHA256SUMS"] != checksums:
        raise Refusal("release SHA256SUMS mismatch")
    for component in COMPONENTS.values():
        if not component["files"].keys() <= files.keys():
            raise Refusal("release component is incomplete")
    return manifest["version"], files


@overload
def walk_absolute(path, create: Literal[True]) -> int: ...


@overload
def walk_absolute(path, create: Literal[False] = False) -> Optional[int]: ...


def walk_absolute(path, create=False):
    """Anchor all ancestors with no-follow descriptor-relative opens."""
    path = Path(path)
    if not path.is_absolute() or ".." in path.parts:
        raise Refusal("--home must be an absolute path without traversal")
    fd = os.open("/", DIRECTORY)
    try:
        for part in path.parts[1:]:
            try:
                child = os.open(part, DIRECTORY, dir_fd=fd)
            except FileNotFoundError:
                if not create:
                    os.close(fd)
                    return None
                os.mkdir(part, 0o700, dir_fd=fd)
                child = os.open(part, DIRECTORY, dir_fd=fd)
            os.close(fd)
            fd = child
        return fd
    except BaseException:
        os.close(fd)
        raise


@overload
def directory(parent, name, create: Literal[True]) -> int: ...


@overload
def directory(parent, name, create: Literal[False] = False) -> Optional[int]: ...


def directory(parent, name, create=False):
    try:
        return os.open(name, DIRECTORY, dir_fd=parent)
    except FileNotFoundError:
        if not create:
            return None
        os.mkdir(name, 0o700, dir_fd=parent)
        return os.open(name, DIRECTORY, dir_fd=parent)


def read_file(fd, name):
    handle = os.open(name, os.O_RDONLY | NOFOLLOW | os.O_NONBLOCK, dir_fd=fd)
    try:
        st = os.fstat(handle)
        if not stat.S_ISREG(st.st_mode) or st.st_nlink != 1 or st.st_size > MAX_FILE:
            raise Refusal("installed file must be regular, single-link and bounded")
        with os.fdopen(handle, "rb", closefd=False) as stream:
            return stream.read(MAX_FILE + 1)
    finally:
        os.close(handle)


def snapshot(fd, prefix=""):
    result = {}
    for name in sorted(os.listdir(fd)):
        st = os.stat(name, dir_fd=fd, follow_symlinks=False)
        key = prefix + name
        if stat.S_ISDIR(st.st_mode):
            child = directory(fd, name)
            if child is None:
                raise Refusal("installed directory disappeared")
            try:
                nested = snapshot(child, key + "/")
                if not nested:
                    raise Refusal("unknown empty directory in installed component")
                result.update(nested)
            finally:
                os.close(child)
        else:
            if not stat.S_ISREG(st.st_mode):
                raise Refusal("installed tree contains a symlink or special file")
            result[key] = read_file(fd, name)
    return result


def exists(fd, name):
    try:
        os.stat(name, dir_fd=fd, follow_symlinks=False)
        return True
    except FileNotFoundError:
        return False


def inspect(home_fd, selected, version, release):
    plans = []
    if home_fd is not None:
        legacy = directory(home_fd, "desktop-plugins")
        if legacy is not None:
            try:
                if exists(legacy, "grok-voice-oauth"):
                    raise Refusal("Legacy desktop-plugins/grok-voice-oauth detected. Manually review and move the legacy frontend outside plugin discovery before retrying; nothing was disabled or deleted.")
            finally:
                os.close(legacy)
        # Validate backup ancestors even for a dry run.
        backups = directory(home_fd, "backups")
        if backups is not None:
            try:
                private = directory(backups, "native-duplex-voice")
                if private is not None:
                    os.close(private)
            finally:
                os.close(backups)
    for name in selected:
        component = COMPONENTS[name]
        wanted = {dest: release[src] for src, dest in component["files"].items()}
        hashes = {key: sha(data) for key, data in sorted(wanted.items())}
        receipt = canonical({"id": component["id"], "version": version, "hashes": hashes})
        wanted[RECEIPT] = receipt
        old = None
        if home_fd is not None:
            base = directory(home_fd, component["base"])
            if base is not None:
                try:
                    target = directory(base, component["id"])
                    if target is not None:
                        try:
                            old = snapshot(target)
                        finally:
                            os.close(target)
                finally:
                    os.close(base)
        if old is not None:
            if RECEIPT not in old:
                raise Refusal("Unknown installed copy: move it outside plugin discovery after manual review; installer will not take ownership.")
            previous = strict_json(old[RECEIPT])
            actual = {key: sha(data) for key, data in sorted(old.items()) if key != RECEIPT}
            allowed = set(component["files"].values())
            if (not isinstance(previous, dict) or set(previous) != {"id", "version", "hashes"}
                    or previous.get("id") != component["id"]
                    or not isinstance(previous.get("version"), str)
                    or not VERSION_RE.fullmatch(previous["version"])
                    or set(actual) != allowed or previous.get("hashes") != actual):
                raise Refusal("User-modified or unknown installed copy: preserve/reconcile it manually outside discovery before retrying.")
        action = "create" if old is None else "unchanged" if old == wanted else "update"
        plans.append({"component": name, "action": action, "wanted": wanted, "old": old})
    return plans


def write_tree(fd, files):
    for path, data in sorted(files.items()):
        parts = path.split("/")
        parent = os.dup(fd)
        try:
            for part in parts[:-1]:
                child = directory(parent, part, True)
                os.close(parent)
                parent = child
            handle = os.open(parts[-1], os.O_WRONLY | os.O_CREAT | os.O_EXCL | NOFOLLOW, 0o644, dir_fd=parent)
            with os.fdopen(handle, "wb") as stream:
                stream.write(data)
                stream.flush()
                os.fsync(stream.fileno())
        finally:
            os.close(parent)


def rename_exclusive(src_fd, src, dst_fd, dst):
    """Atomic directory publication without overwriting a racing destination."""
    libc = ctypes.CDLL(None, use_errno=True)
    if sys.platform == "darwin":
        call = libc.renameatx_np
        flag = 0x00000004  # RENAME_EXCL
    elif sys.platform.startswith("linux"):
        call = libc.renameat2
        flag = 1  # RENAME_NOREPLACE
    else:
        raise Refusal("exclusive rename unsupported on this platform")
    call.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_int, ctypes.c_char_p, ctypes.c_uint]
    call.restype = ctypes.c_int
    if call(src_fd, os.fsencode(src), dst_fd, os.fsencode(dst), flag) != 0:
        raise OSError(ctypes.get_errno(), "exclusive rename failed")


def apply(home_fd, plans):
    changed = [p for p in plans if p["action"] != "unchanged"]
    if not changed:
        return
    backups = directory(home_fd, "backups", True)
    try:
        store = directory(backups, "native-duplex-voice", True)
    finally:
        os.close(backups)
    lock = os.open(".lock", os.O_RDWR | os.O_CREAT | NOFOLLOW, 0o600, dir_fd=store)
    bases = []
    transactions = []
    try:
        if not stat.S_ISREG(os.fstat(lock).st_mode) or os.fstat(lock).st_nlink != 1:
            raise Refusal("unsafe install lock")
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        # Re-read the full approved snapshots after obtaining the writer lock.
        for plan in changed:
            component = COMPONENTS[plan["component"]]
            base = directory(home_fd, component["base"], True)
            bases.append(base)
            target = directory(base, component["id"])
            if target is None:
                now = None
            else:
                try:
                    now = snapshot(target)
                finally:
                    os.close(target)
            if now != plan["old"]:
                raise Refusal("installed copy changed since planning; retry")
            token = uuid.uuid4().hex
            stage = "stage-" + token
            os.mkdir(stage, 0o700, dir_fd=store)
            stage_fd = directory(store, stage)
            if stage_fd is None:
                raise Refusal("staging directory disappeared")
            try:
                write_tree(stage_fd, plan["wanted"])
                if snapshot(stage_fd) != plan["wanted"]:
                    raise Refusal("staging verification failed")
            finally:
                os.close(stage_fd)
            transactions.append({"plan": plan, "base": base, "id": component["id"],
                                 "stage": stage, "backup": "backup-" + token,
                                 "moved_old": False, "published": False})
        for tx in transactions:
            if tx["plan"]["old"] is not None:
                rename_exclusive(tx["base"], tx["id"], store, tx["backup"])
                tx["moved_old"] = True
            rename_exclusive(store, tx["stage"], tx["base"], tx["id"])
            tx["published"] = True
        # Verify every selected target, including components already unchanged.
        for plan in plans:
            component = COMPONENTS[plan["component"]]
            base = directory(home_fd, component["base"])
            if base is None:
                raise Refusal("installed read-back verification failed")
            try:
                target = directory(base, component["id"])
                if target is None:
                    raise Refusal("installed read-back verification failed")
                try:
                    if snapshot(target) != plan["wanted"]:
                        raise Refusal("installed read-back verification failed")
                finally:
                    os.close(target)
            finally:
                os.close(base)
    except BaseException:
        failures = []
        for tx in reversed(transactions):
            try:
                if tx["published"]:
                    rename_exclusive(tx["base"], tx["id"], store, tx["stage"])
                if tx["moved_old"]:
                    rename_exclusive(store, tx["backup"], tx["base"], tx["id"])
                    restored = directory(tx["base"], tx["id"])
                    if restored is None:
                        raise Refusal("rollback verification failed")
                    try:
                        if snapshot(restored) != tx["plan"]["old"]:
                            raise Refusal("rollback verification failed")
                    finally:
                        os.close(restored)
            except (OSError, ValueError):
                failures.append(tx["id"])
        if failures:
            raise Refusal("Rollback incomplete: stop and manually recover preserved copies under backups/native-duplex-voice; do not rerun blindly.") from None
        raise
    finally:
        for fd in bases:
            os.close(fd)
        os.close(lock)
        os.close(store)


def install(archive, home, component, do_apply=False):
    version, release = load_release(archive)
    selected = ["gateway", "desktop"] if component == "both" else [component]
    if any(name not in COMPONENTS for name in selected):
        raise Refusal("unknown component")
    home_fd = walk_absolute(home)
    try:
        plans = inspect(home_fd, selected, version, release)
        if do_apply:
            if home_fd is None:
                home_fd = walk_absolute(home, True)
            apply(home_fd, plans)
        return {"schema": 1, "mode": "apply" if do_apply else "dry-run", "version": version,
                "changes": [{"component": p["component"], "action": p["action"]} for p in plans]}
    finally:
        if home_fd is not None:
            os.close(home_fd)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--archive", required=True, type=Path)
    parser.add_argument("--home", required=True, type=Path)
    parser.add_argument("--component", required=True, choices=["gateway", "desktop", "both"])
    parser.add_argument("--apply", action="store_true")
    args = parser.parse_args(argv)
    try:
        print(json.dumps(install(args.archive, args.home, args.component, args.apply), sort_keys=True))
        return 0
    except (OSError, ValueError, KeyError, TypeError, zipfile.BadZipFile, RuntimeError) as exc:
        message = str(exc) if isinstance(exc, ValueError) else "invalid/inaccessible archive or destination; no settings were changed"
        print("Install refused: " + message, file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
