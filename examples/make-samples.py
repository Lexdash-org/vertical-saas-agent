#!/usr/bin/env python3
"""Regenerate the shipped sample files from a real run.

Both source files are gitignored — they hold the full run, including tens of thousands
of *predicted* addresses nobody has ever verified. This script is committed so what
ships is auditable.

  1. fixtures/companies.example.csv  - 25 real clinic websites (public business info)
  2. examples/enriched-sample.csv    - 50 VERIFIED emails, basis `known`

What "verified" means here, and what it deliberately excludes:

  INCLUDED  basis `known` — the address was read directly off the company's own
            website, where the company published it themselves. Real and checkable.

  EXCLUDED  `default:*` and `learned:*` — predictions. Guesses assembled from a name
            and a domain; nobody has confirmed they belong to anyone, and shipping
            them would attribute invented addresses to real people.
  EXCLUDED  `web-found:*` — real, but sourced off-domain (a paper, a hospital staff
            register). Personal/institutional rather than published by the employer,
            so they stay out.
"""
import csv, re, collections, pathlib

ROOT = pathlib.Path(__file__).resolve().parent.parent
SRC_LIST = ROOT / "data/australian_private_clinics_not_in_new_priority_josh.csv"
SRC_ENRICHED = ROOT / "ENRICHED-team-emails.csv"
N_COMPANIES = 25
N_EMAILS = 50

# ---------- 1. sample input ----------
# The source lead list is gitignored and may not be present in a clone; the committed
# fixture it produced is. Skip rather than fail.
if not SRC_LIST.exists():
    print(f"fixtures/companies.example.csv: skipped ({SRC_LIST.name} not present)")
    rows = []
else:
    rows = list(csv.DictReader(open(SRC_LIST, encoding="utf-8-sig")))
# Skip listings named after an individual practitioner ("Dr Jane Smith - Cardiologist").
# A clinic-named sample makes the same point without a person's name in the field.
PERSONAL = re.compile(r"^(dr|prof|professor|mr|mrs|ms|a/prof|assoc)\b[. ]", re.I)

seen, picked = set(), []
for r in rows:
    w = (r.get("Website") or "").strip()
    if not w.startswith("http") or PERSONAL.match((r.get("Name") or "").strip()):
        continue
    host = re.sub(r"^https?://(www\.)?", "", w).split("/")[0].lower()
    if host in seen:
        continue
    seen.add(host)
    picked.append({
        "Name": (r.get("Name") or "").strip(),
        "Website": f"https://{host}",
        "Specialty": (r.get("Specialty") or "").strip(),
        "Suburb": (r.get("Suburb") or "").strip(),
        "State": (r.get("State") or "").strip(),
    })
    if len(picked) == N_COMPANIES:
        break

if picked:
    (ROOT / "fixtures").mkdir(exist_ok=True)
    with open(ROOT / "fixtures/companies.example.csv", "w", newline="", encoding="utf-8") as fh:
        w = csv.DictWriter(fh, fieldnames=["Name", "Website", "Specialty", "Suburb", "State"],
                           lineterminator="\n")
        w.writeheader()
        w.writerows(picked)
    print(f"fixtures/companies.example.csv: {len(picked)} companies")

# ---------- 2. verified emails ----------
enr = list(csv.DictReader(open(SRC_ENRICHED, encoding="utf-8-sig")))


def same_domain(addr: str, domain: str) -> bool:
    """The address sits on the company's own domain — i.e. the company published it."""
    at = addr.split("@")[-1].lower().removeprefix("www.")
    bare = (domain or "").lower().removeprefix("www.")
    return bool(bare) and (at == bare or at.endswith("." + bare) or bare.endswith("." + at))


verified = [
    r for r in enr
    if r.get("best_email_basis") == "known"
    and (r.get("email") or "").strip()
    and same_domain(r["email"].strip(), r.get("domain", ""))
]

# Spread across companies rather than 50 people from one large clinic.
by_company = collections.defaultdict(list)
for r in verified:
    by_company[r["domain"]].append(r)

sample, depth = [], 0
while len(sample) < N_EMAILS and depth < 100:
    for dom in sorted(by_company):
        if depth < len(by_company[dom]):
            sample.append(by_company[dom][depth])
            if len(sample) == N_EMAILS:
                break
    depth += 1

COLS = ["company", "domain", "website", "name", "title", "email",
        "email_domain", "mx_provider", "best_email", "best_email_basis"]

(ROOT / "examples").mkdir(exist_ok=True)
with open(ROOT / "examples/enriched-sample.csv", "w", newline="", encoding="utf-8") as fh:
    w = csv.DictWriter(fh, fieldnames=COLS, lineterminator="\n", extrasaction="ignore")
    w.writeheader()
    w.writerows(sample)

print(f"examples/enriched-sample.csv: {len(sample)} verified emails "
      f"across {len(set(r['domain'] for r in sample))} companies")
print(f"  pool of basis=known, same-domain: {len(verified)}")
print(f"  non-verified rows leaked in: "
      f"{sum(1 for r in sample if r['best_email_basis'] != 'known')} (must be 0)")
print(f"  predicted/web-found leaked in: "
      f"{sum(1 for r in sample if r['best_email'] != r['email'])} (must be 0)")
