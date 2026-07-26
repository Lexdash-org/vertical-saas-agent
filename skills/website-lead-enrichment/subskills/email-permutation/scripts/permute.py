#!/usr/bin/env python3
"""
Email permutation - predict candidate addresses from a name + domain.

Given first_name, last_name and one or two domains, emit ~18 ranked candidate
email addresses per person. Generation only: no MX lookup, no SMTP probe, no
verification, no network access of any kind.

Domain selection is a STRICT FALLBACK, never a cross-product:
    domain = email_domain or company_domain
If email_domain is populated it wins outright and company_domain is not
permuted at all. If neither is present the row is skipped.

Usage:
    permute.py --in leads.csv --out-wide wide.csv --out-long long.csv

Column names are configurable because lead-export tools disagree on headers.
"""

import argparse
import csv
import json
import os
import re
import sys
import unicodedata

# Honorifics dropped from either name field before pattern expansion.
TITLES = {
    "dr", "mr", "mrs", "ms", "miss", "mx", "prof", "professor",
    "sir", "madam", "rev", "hon",
}

# The pattern table lives in shared/lib/patterns.json and is read by BOTH this script
# and patterns.ts, so generation here and pattern LEARNING on the TypeScript side can
# never drift apart. Ordered by real-world B2B frequency, market-agnostic on purpose.
#
# HARD RULE: dot is the only separator. No underscores, no hyphens.
#
# Each pattern name IS its own formula over {first, last, fi, li} joined by "." or
# nothing, so the builders are derived rather than hand-written. Alternation is
# left-to-right, so listing the long tokens first makes "filast" match fi+last.
_TOKEN = re.compile(r"first|last|fi|li")
_VALID = re.compile(r"^(?:first|last|fi|li)(?:\.?(?:first|last|fi|li))*$")
_TABLE_PATH = os.path.join(
    os.path.dirname(os.path.abspath(__file__)), "..", "..", "..", "shared", "lib", "patterns.json"
)


def _compile(name):
    """Turn a pattern name into its local-part builder. Dots pass through untouched."""
    if not _VALID.match(name):
        raise ValueError(f"patterns.json: {name!r} is not a formula over first|last|fi|li")

    def build(f, l, _name=name):
        pick = {"first": f, "last": l, "fi": f[0], "li": l[0]}
        return _TOKEN.sub(lambda m: pick[m.group()], _name)

    return build


def _load_patterns():
    with open(_TABLE_PATH, encoding="utf-8") as fh:
        names = json.load(fh)["patterns"]
    return [(n, _compile(n)) for n in names]


PATTERNS = _load_patterns()


def normalize(raw, take_last_token=False):
    """Normalize an input name field down to a single lowercase [a-z] token.

    Normalization is an INPUT concern only - it decides what `first` and `last`
    are. It says nothing about separators in the generated address.

    - lowercase, strip accents (Jose <- Jose with acute)
    - drop honorifics
    - hyphens and apostrophes COLLAPSE, they do not split (Mary-Jane -> maryjane)
    - multi-token surnames take the last token (van der Berg -> berg);
      multi-token given names take the first (Anna Maria -> anna)

    Returns "" when nothing usable survives.
    """
    if not raw:
        return ""

    # NFKD splits accented chars into base + combining mark; dropping the marks
    # leaves plain ASCII letters behind.
    decomposed = unicodedata.normalize("NFKD", str(raw))
    stripped = "".join(c for c in decomposed if not unicodedata.combining(c))

    tokens = []
    for token in stripped.lower().split():
        # Collapse rather than split: strip every non a-z character in place.
        cleaned = "".join(c for c in token if "a" <= c <= "z")
        if not cleaned or cleaned in TITLES:
            continue
        tokens.append(cleaned)

    if not tokens:
        return ""
    return tokens[-1] if take_last_token else tokens[0]


def candidates(first, last, domain, max_n):
    """Build the ranked candidate list for one person.

    Dedupes while preserving first-seen order, so e.g. "John Jones" (matching
    initials) collapses fi.li/li.fi and yields fewer than max_n. Ranks stay
    contiguous starting at 1.
    """
    seen = set()
    out = []
    for name, build in PATTERNS:
        local = build(first, last)
        if local in seen:
            continue
        seen.add(local)
        out.append((name, f"{local}@{domain}"))
        if len(out) >= max_n:
            break
    return out


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--in", dest="infile", required=True, help="input lead CSV")
    ap.add_argument("--out-wide", required=True,
                    help="output CSV: original row + email_1..email_N columns")
    ap.add_argument("--out-long", required=True,
                    help="output CSV: one row per candidate (source of truth)")
    ap.add_argument("--first-col", default="first_name")
    ap.add_argument("--last-col", default="last_name")
    ap.add_argument("--company-domain-col", default="company_domain")
    ap.add_argument("--email-domain-col", default="email_domain")
    ap.add_argument("--max", type=int, default=18,
                    help="max candidates per lead (default 18 = full table)")
    args = ap.parse_args()

    with open(args.infile, newline="", encoding="utf-8-sig") as fh:
        reader = csv.DictReader(fh)
        rows = list(reader)
        fieldnames = reader.fieldnames or []

    for col in (args.first_col, args.last_col, args.company_domain_col):
        if col not in fieldnames:
            sys.exit(f"error: input CSV has no column {col!r}. "
                     f"Found: {', '.join(fieldnames)}")

    skipped_name = 0
    skipped_domain = 0
    long_rows = []
    # Parallel to `rows`; holds the candidate list for each input row so the
    # wide file is a pivot of the long table rather than a second generation.
    per_row = []

    for row in rows:
        first = normalize(row.get(args.first_col))
        last = normalize(row.get(args.last_col), take_last_token=True)

        email_domain = (row.get(args.email_domain_col) or "").strip().lower()
        company_domain = (row.get(args.company_domain_col) or "").strip().lower()

        # Strict fallback. email_domain wins outright when present.
        if email_domain:
            domain, source = email_domain, "email_domain"
        elif company_domain:
            domain, source = company_domain, "company_domain"
        else:
            skipped_domain += 1
            per_row.append([])
            continue

        if not first or not last:
            skipped_name += 1
            per_row.append([])
            continue

        found = candidates(first, last, domain, args.max)
        per_row.append([email for _, email in found])

        for rank, (pattern, email) in enumerate(found, start=1):
            long_rows.append({
                "first_name": row.get(args.first_col, ""),
                "last_name": row.get(args.last_col, ""),
                "domain": domain,
                "domain_source": source,
                "rank": rank,
                "pattern": pattern,
                "email": email,
            })

    long_cols = ["first_name", "last_name", "domain", "domain_source",
                 "rank", "pattern", "email"]
    with open(args.out_long, "w", newline="", encoding="utf-8") as fh:
        writer = csv.DictWriter(fh, fieldnames=long_cols)
        writer.writeheader()
        writer.writerows(long_rows)

    # Fixed-width email_1..email_N so the header is stable across runs - a
    # varying column count breaks field mapping on import.
    email_cols = [f"email_{i}" for i in range(1, args.max + 1)]
    with open(args.out_wide, "w", newline="", encoding="utf-8") as fh:
        writer = csv.DictWriter(fh, fieldnames=fieldnames + email_cols)
        writer.writeheader()
        for row, emails in zip(rows, per_row):
            out = dict(row)
            for i, col in enumerate(email_cols):
                out[col] = emails[i] if i < len(emails) else ""
            writer.writerow(out)

    print(f"rows in:            {len(rows)}", file=sys.stderr)
    print(f"skipped (no domain):{skipped_domain:>4}", file=sys.stderr)
    print(f"skipped (no name):  {skipped_name:>4}", file=sys.stderr)
    print(f"candidates out:     {len(long_rows)}", file=sys.stderr)
    print(f"wrote {args.out_wide} and {args.out_long}", file=sys.stderr)


if __name__ == "__main__":
    main()
