# Security Policy

## Reporting a vulnerability

Email **<mohan@lexdash.app>**. Do not open a public issue.

Include what you found, how to reproduce it, and what an attacker could do with it. If a
credential is involved, say which provider — but **do not send the credential itself**.

Expect an acknowledgement within 3 working days. We will tell you whether we consider it
a vulnerability, and when a fix will land. Please give us a chance to ship a fix before
disclosing publicly.

## Supported versions

Only the latest release. This project is pre-1.0 in practice; there are no backports.

## What counts as a vulnerability here

This is an agent skill that runs local scripts against third-party APIs. The things worth
reporting:

- **Credential exposure** — a path where a key reaches disk unencrypted outside `.env`,
  gets logged, is printed back to the user, or lands in output the user would share.
- **Committed secrets** — anything key-shaped in the repository or its git history.
- **Command or prompt injection** — scraped page content reaching a shell command, or
  reaching a model in a position where it can redirect what the pipeline does. Every
  stage feeds attacker-controlled web content to an LLM, so this is the sharpest edge in
  the project.
- **Path traversal** — a crafted CSV or domain causing a write outside the output
  directory.
- **Supply chain** — a malicious or compromised dependency.

## What is not a vulnerability

- **Predicted addresses being wrong.** That is the documented behaviour. Anything with a
  `learned:` or `default:` basis is an unverified guess, and the pipeline says so in
  `best_email_basis` and by writing those rows to a separate file.
- **Scraping a site that did not want to be scraped.** That is a legal and ethical matter
  for the operator, not a defect in the code. See the data and privacy notes in the
  README.
- **Cost overruns** from a large run. Scope is confirmed with the user before a batch
  starts; check what you approved.

## If you leaked a key while using this

Rotate it at the provider first — deleting a file does not un-leak it. Then check
`git log -p` for it. If it reached a public commit, assume it is compromised regardless of
what happened to the commit afterwards.

`.env` is gitignored, and CI fails if it ever becomes tracked.

## Handling contact data

This tool collects business contact details about identifiable people. Pipeline output is
gitignored and must never be committed, attached to an issue, or pasted into a pull
request. The only contact data in this repository is `examples/output/enriched-sample.csv` — 50
addresses each published by the company itself, on its own domain, with the filter that
produced them committed alongside as `.github/scripts/make-samples.ts` so it is auditable.
