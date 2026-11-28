#!/usr/bin/env python3
"""Fail when the repository tracks what it must not: anything under a ``.claude/`` folder, or a private name.

Run by CI (the ``quality`` job) and usable by hand: ``python scripts/check_tracked_files.py [ROOT]``. Exit 0 when
clean, 1 with one line per finding otherwise.

* **No tracked file under ``.claude/``**, at the top or in any subfolder: that folder holds a coding agent's private
  notes, worktrees and settings, and is ignored on purpose.
* **No private name, machine name or home path** in any tracked file. The names are not written here: the check knows
  each only as the SHA-256 of its lowercased text, so the repository never names what it guards against, and the list
  can grow the same way. Three kinds, all matched in any case:

  - a **word** is found anywhere inside a run of letters (so inside a longer word, a path, an identifier or a domain);
  - a **phrase** is two whole words with only whitespace between them;
  - a **shape** (a home path, a host name with digits) is a pattern every overlapping window of which is hashed.

  A finding names the file and line, never the text.

The word check reads each distinct run of letters once, so it costs a few seconds over the whole repository.

Source: the same check as Prometheus's scripts/check_tracked_files.py, 2026-11.
"""

from __future__ import annotations

import hashlib
import re
import subprocess
import sys
from collections.abc import Iterable
from pathlib import Path

#: (a lookahead pattern for the shape a forbidden text has, so overlapping windows are all seen; SHA-256 of its text)
FORBIDDEN_SHAPES: tuple[tuple[str, str], ...] = (
    (r"(?=(/home/[a-z0-9._-]{8}))", "ffe4303cabf1f17e5af18fcab9e60b4c05beacece33af423d73399241f47cc2b"),
    (r"(?=([a-z0-9]{3}-[0-9]{4}))", "1f375031bf84eb3455e243dafdf1f6e61b8c9b3ed09d993dff53ea2a77922132"),
)

#: (length, SHA-256 of the lowercased word): found anywhere inside a run of letters.
FORBIDDEN_WORDS: tuple[tuple[int, str], ...] = (
    (7, "c31701e9a4262ba520d6772a237203c074d53af954a20936ceeedb1a4b7f9265"),
    (5, "fcfeb23321ecaa0d4d9ecc95211b800145d04f7094b73d1b453b04cc469acbea"),
    (8, "3d94f4f70e79677ec8bdde1b4f3d48d8dd36fb7c07618c109b649a0e9c45c43d"),
    (18, "ece59ac3d33e8bfb708af0ca116309f279d4323bbd1572e1f6dd49583b635ff3"),
)

#: SHA-256 of "<word> <word>" (lowercased, one space): two whole words with only whitespace between them.
FORBIDDEN_PHRASES: tuple[str, ...] = (
    "2f0e12477b06cee317e1a83c62d18902587f49242cbff71b88023101a6628880",
)

#: A tracked file under a folder of this name is a finding.
PRIVATE_FOLDER = ".claude"

#: Tracked files the name checks do not read, each for a stated reason. ``.mailmap`` maps old commit authors to the
#: project's name; it has to name what it maps, and it changes nothing that ships.
EXEMPT: frozenset[str] = frozenset({".mailmap"})

_LETTERS = re.compile(r"[a-z]+")
_SPACE = re.compile(r"\s+")


def _sha(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def private_folder_findings(paths: Iterable[str]) -> list[str]:
    """The tracked paths that are under a ``.claude/`` folder at any depth."""
    return [p for p in paths if PRIVATE_FOLDER in Path(p).parts[:-1]]


class Checker:
    """The hashed checks, with a memory of every run of letters already judged (most recur across files)."""

    def __init__(self, shapes: tuple[tuple[str, str], ...] = FORBIDDEN_SHAPES,
                 words: tuple[tuple[int, str], ...] = FORBIDDEN_WORDS,
                 phrases: tuple[str, ...] = FORBIDDEN_PHRASES) -> None:
        self.shapes = tuple((re.compile(p), d) for p, d in shapes)
        self.words: dict[int, set[str]] = {}
        for length, digest in words:
            self.words.setdefault(length, set()).add(digest)
        self.phrases = set(phrases)
        self._judged: dict[str, bool] = {}

    def _word_hit(self, run: str) -> bool:
        known = self._judged.get(run)
        if known is not None:
            return known
        hit = False
        for length, digests in self.words.items():
            for i in range(len(run) - length + 1):
                if _sha(run[i:i + length]) in digests:
                    hit = True
                    break
            if hit:
                break
        self._judged[run] = hit
        return hit

    def findings(self, text: str) -> list[int]:
        """The line numbers (1-based) of *text* that hold a forbidden name, each line once."""
        low = text.lower()
        hits: set[int] = set()

        def line_of(pos: int) -> int:
            return low.count("\n", 0, pos) + 1

        for shape, digest in self.shapes:
            for m in shape.finditer(low):
                if _sha(m.group(1)) == digest:
                    hits.add(line_of(m.start()))
        previous: re.Match[str] | None = None
        for m in _LETTERS.finditer(low):
            if self.words and self._word_hit(m.group()):
                hits.add(line_of(m.start()))
            if (self.phrases and previous is not None and _SPACE.fullmatch(low, previous.end(), m.start())
                    and _sha(f"{previous.group()} {m.group()}") in self.phrases):
                hits.add(line_of(previous.start()))
            previous = m
        return sorted(hits)


def text_findings(text: str, checker: Checker | None = None) -> list[int]:
    """The line numbers (1-based) of *text* that hold a forbidden name (the shipped lists unless *checker* says)."""
    return (checker or Checker()).findings(text)


def tracked_files(root: Path) -> list[str]:
    out = subprocess.run(["git", "ls-files", "-z"], cwd=root, capture_output=True, check=True).stdout
    return [p for p in out.decode("utf-8", "surrogateescape").split("\0") if p]


def main(root: Path) -> int:
    findings: list[str] = []
    paths = tracked_files(root)
    checker = Checker()
    for path in private_folder_findings(paths):
        findings.append(f"{path}: tracked under {PRIVATE_FOLDER}/ (that folder is private and ignored)")
    for path in paths:
        file = root / path
        if path in EXEMPT or not file.is_file() or file.is_symlink():
            continue
        try:
            text = file.read_bytes().decode("utf-8", "replace")
        except OSError as exc:
            findings.append(f"{path}: could not be read ({exc.__class__.__name__})")
            continue
        for line in checker.findings(text):
            findings.append(f"{path}:{line}: holds a private name, machine name or home path")
    for finding in findings:
        print(finding)
    if findings:
        print(f"check_tracked_files: {len(findings)} finding(s) in {len(paths)} tracked files", file=sys.stderr)
        return 1
    print(f"check_tracked_files: clean ({len(paths)} tracked files)")
    return 0


if __name__ == "__main__":
    sys.exit(main(Path(sys.argv[1]) if len(sys.argv) > 1 else Path(__file__).resolve().parent.parent))
