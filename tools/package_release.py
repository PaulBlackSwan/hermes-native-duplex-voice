#!/usr/bin/env python3
"""Build an offline, deterministic public release (stdlib only).

The manifest detects corruption, not malicious replacement: obtain the ZIP and its
SHA256 through a trusted channel. Nothing from a working tree is copied by default.
"""
import argparse
from contextlib import contextmanager
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import stat
import zipfile

COMPONENTS = {
    "gateway": {"id": "grok-voice-oauth", "base": "plugins", "files": {
        "gateway-plugin/plugin.yaml": "plugin.yaml",
        "gateway-plugin/__init__.py": "__init__.py",
        "gateway-plugin/LICENSE": "LICENSE",
        "gateway-plugin/dashboard/manifest.json": "dashboard/manifest.json",
        "gateway-plugin/dashboard/plugin_api.py": "dashboard/plugin_api.py",
    }},
    "desktop": {"id": "grok-native-provider", "base": "desktop-plugins", "files": {
        "desktop-provider/desktop/plugin.js": "plugin.js",
        "desktop-provider/LICENSE": "LICENSE",
        "desktop-provider/voice-grok.LICENSE": "voice-grok.LICENSE",
    }},
}
# Exact public files plus narrowly scoped, single-level documentation/integration
# suffix allowlists. No recursive working-tree copy; diagnostic names stay private.
PUBLIC_FILES = {
    "README.md", "CHANGELOG.md", "SECURITY.md", "LICENSE", "NOTICE", "NOTICE.md", "THIRD_PARTY_NOTICES.md",
    "release.json", "QUALIFICATION.json", "package.json", "tools/install.py", "tools/package_release.py",
    "tools/__init__.py", "tests/test_distribution.py",
    "desktop-provider/README.md", "desktop-provider/package.json", "desktop-provider/scripts/build.mjs",
    "desktop-provider/src/index.ts", "desktop-provider/src/grok.ts",
    "desktop-provider/src/voice-pcm.ts", "desktop-provider/src/voice-grok.LICENSE",
    "desktop-provider/test/entry.test.mjs", "desktop-provider/test/transport.test.mjs",
    "desktop-provider/test/offline-chromium.mjs",
    "desktop-provider/test/voice-pcm.test.ts", "gateway-plugin/tests/test_backend.py",
    "docs/INSTALL.md", "docs/SECURITY.md", "docs/ARCHITECTURE.md",
    "docs/TESTING.md", "docs/RELEASE.md", "docs/COMPATIBILITY.md",
    "docs/installation.md", "docs/security.md", "docs/architecture.md",
    "docs/testing.md", "docs/release.md", "docs/compatibility.md",
    "integration/README.md", "integration/host.patch", "integration/hermes-host.patch",
    "integration/native-duplex-voice.patch", "integration/hermes-native-duplex-voice.patch",
}
for _component in COMPONENTS.values():
    PUBLIC_FILES.update(_component["files"])
PUBLIC_GLOBS = ("docs/*.md", "integration/*.patch", "integration/*.json", "integration/*.py")
PRIVATE_NAME = re.compile(r"(?:debug|diagnostic|verification|private|credential|secret|cache|(?:^|[-_.])logs?(?:[-_.]|$))", re.I)
VERSION_RE = re.compile(r"[0-9]+\.[0-9]+\.[0-9]+(?:-[A-Za-z0-9.-]+)?\Z")


def is_public_name(name):
    if name in PUBLIC_FILES:
        return True
    path = PurePosixPath(name)
    if len(path.parts) != 2 or PRIVATE_NAME.search(path.name):
        return False
    return any(path.match(pattern) for pattern in PUBLIC_GLOBS)


def validate_name(name):
    if not isinstance(name, str) or not name or "\\" in name:
        raise ValueError("unsafe archive path")
    p = PurePosixPath(name)
    if p.is_absolute() or any(x in ("", ".", "..") for x in name.split("/")):
        raise ValueError("unsafe archive path")
    return name


def canonical(value):
    return (json.dumps(value, sort_keys=True, separators=(",", ":")) + "\n").encode()


def sha(data):
    return hashlib.sha256(data).hexdigest()


def no_symlinks(path):
    """Reject every existing ancestor, including the explicitly supplied root."""
    if ".." in Path(path).parts:
        raise ValueError("path traversal refused")
    path = Path(os.path.abspath(path))
    for item in reversed((path, *path.parents)):
        try:
            if stat.S_ISLNK(item.lstat().st_mode):
                raise ValueError("symlink path refused")
        except FileNotFoundError:
            pass
    return path


def read_public(root, name):
    path = no_symlinks(root / name)
    directory_flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW
    fd = os.open("/", directory_flags)
    try:
        for part in path.parts[1:-1]:
            child = os.open(part, directory_flags, dir_fd=fd)
            os.close(fd)
            fd = child
        handle = os.open(path.name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=fd)
        try:
            st = os.fstat(handle)
            if not stat.S_ISREG(st.st_mode) or st.st_nlink != 1:
                raise ValueError("public source must be a regular non-hardlinked file")
            with os.fdopen(handle, "rb", closefd=False) as stream:
                data = stream.read(16 * 1024 * 1024 + 1)
            if len(data) > 16 * 1024 * 1024:
                raise ValueError("public source exceeds size limit")
            # Fail closed on developer-machine path leaks, including docs and logs
            # accidentally given an otherwise approved public filename.
            if re.search(rb"/(?:Users|home)/[^\s\"'<>]+|/(?:private/)?var/folders/|[A-Za-z]:\\\\Users\\\\", data):
                raise ValueError("private absolute path in public source: " + name)
            return data
        finally:
            os.close(handle)
    finally:
        os.close(fd)


@contextmanager
def exclusive_output(path):
    flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW
    fd = os.open("/", flags)
    try:
        for part in path.parts[1:-1]:
            child = os.open(part, flags, dir_fd=fd)
            os.close(fd)
            fd = child
        handle = os.open(path.name, os.O_RDWR | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
                         0o644, dir_fd=fd)
    finally:
        os.close(fd)
    with os.fdopen(handle, "w+b") as stream:
        yield stream


def build(root, out, version=None):
    root = no_symlinks(root)
    if version is None:
        version = json.loads(read_public(root, "release.json"))["version"]
    if not isinstance(version, str) or not VERSION_RE.fullmatch(version):
        raise ValueError("invalid release version")
    files = {}
    required = {name for c in COMPONENTS.values() for name in c["files"]}
    required.update({"tools/install.py", "tools/package_release.py"})
    candidates = set(PUBLIC_FILES)
    for pattern in PUBLIC_GLOBS:
        parent_name = pattern.split("/", 1)[0]
        if os.path.lexists(root / parent_name):
            parent = no_symlinks(root / parent_name)
            if not parent.is_dir():
                raise ValueError("public source parent must be a directory")
            candidates.update(p.relative_to(root).as_posix() for p in root.glob(pattern)
                              if is_public_name(p.relative_to(root).as_posix()))
    for name in sorted(candidates):
        validate_name(name)
        path = root / name
        # lexists also catches dangling symlinks; never silently omit those.
        if os.path.lexists(path):
            files[name] = read_public(root, name)
            if name in required and not files[name].strip():
                raise ValueError("required release file is empty: " + name)
        elif name in required:
            raise ValueError("required release file missing: " + name)
    if "release.json" in files:
        metadata = json.loads(files["release.json"])
        if metadata.get("version") != version:
            raise ValueError("release.json version does not match --version")
    manifest = {"schema": 1, "version": version,
                "files": {name: sha(data) for name, data in sorted(files.items())}}
    files["manifest.json"] = canonical(manifest)
    files["SHA256SUMS"] = "".join(f"{sha(data)}  {name}\n" for name, data in sorted(files.items())).encode()
    out = no_symlinks(out)
    if out == root or root in out.parents and is_public_name(out.relative_to(root).as_posix()):
        raise ValueError("output would overwrite public source")
    # Exclusive output: never silently clobber an existing artifact.
    with exclusive_output(out) as stream:
        with zipfile.ZipFile(stream, "w", compression=zipfile.ZIP_STORED) as archive:
            for name, data in sorted(files.items()):
                info = zipfile.ZipInfo(name, (1980, 1, 1, 0, 0, 0))
                info.create_system = 3
                info.external_attr = (stat.S_IFREG | 0o644) << 16
                archive.writestr(info, data)
        stream.flush()
        os.fsync(stream.fileno())
        stream.seek(0)
        digest = sha(stream.read())
    return {"version": version, "files": len(files), "sha256": digest}


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, default=Path(__file__).absolute().parents[1])
    parser.add_argument("--version")
    parser.add_argument("--out", type=Path)
    args = parser.parse_args(argv)
    try:
        version = args.version
        if version is None:
            version = json.loads(read_public(no_symlinks(args.root), "release.json"))["version"]
        if not isinstance(version, str) or not VERSION_RE.fullmatch(version):
            raise ValueError("invalid release version")
        out = args.out or Path.cwd() / ("native-duplex-voice-" + version + ".zip")
        print(json.dumps(build(args.root, out, version), sort_keys=True))
        return 0
    except (OSError, ValueError, KeyError, TypeError) as exc:
        parser.exit(1, "Release refused: " + (str(exc) if isinstance(exc, ValueError) else "invalid or inaccessible source/output") + "\n")


if __name__ == "__main__":
    main()
