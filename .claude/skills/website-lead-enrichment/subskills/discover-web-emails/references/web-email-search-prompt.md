# Web email-search prompt (Codex) — with identity guard

Reusable template for dispatching a bounded open-web email search per person.
Fill the `{{...}}` fields. The IDENTITY CHECK is what stops same-name false
positives (e.g. a same-named professor overseas attached to a local clinician).

```
WEB RESEARCH (not coding). Find a real, publicly-published email for THIS SPECIFIC
person via web search.

PERSON (the ONLY person whose email counts):
- Name:        {{name}}
- Specialty:   {{title}}            e.g. Cardiac Electrophysiologist
- Employer:    {{company}}          e.g. Westmead Hospital / clinic name
- Location:    {{city_state_country}}   e.g. Sydney, NSW, Australia
- Website:     {{website}}
{{optional extra: affiliations, hospitals, sub-specialty}}

IDENTITY CHECK (do this BEFORE accepting any email — this is the most important rule):
This name is common. An email only counts if the page you found it on is about a
person whose SPECIALTY **and** LOCATION **and** EMPLOYER/INSTITUTION match the PERSON
block above. If the source describes a same-named person in a different city or
country, a different specialty, or an unrelated institution, that is a DIFFERENT
PERSON — discard that email and keep looking or return not_found. When you are not
confident the email belongs to THIS exact person, do NOT report it as high confidence.

BUDGET: at most 6 web searches, open at most ~8 pages, then STOP. Check, in order:
(1) the practice/clinic contact page, (2) 1-2 hospital staff pages or medical
directories, (3) one publication or university profile if they are academic. If no
identity-matched email surfaces within budget, return not_found — do NOT keep going.

RULES:
- Only report an email you literally SAW on a real page. Never guess or pattern-generate.
- Give the exact source URL.
- Prefer a personal/institutional address; a clinic inbox (info@/reception@) is
  acceptable but note it.

Return STRICT JSON only:
{
  "person": "{{name}}",
  "email": "<the email, or empty>",
  "source_url": "<url, or empty>",
  "identity_match": "confirmed | uncertain | mismatch",   // did specialty+location+employer match?
  "confidence": "high | medium | low | not_found",
  "notes": "<one line: which matching signals you confirmed, or why not_found>"
}

Confidence rule tied to identity_match:
- identity_match=confirmed  -> high/medium allowed
- identity_match=uncertain  -> at most low, and say what you could NOT confirm
- identity_match=mismatch   -> email MUST be empty and confidence=not_found
```

## The false positive this guard exists for

Names and addresses below are redacted — these were real people.

Our person is a neurologist at a **Melbourne** clinic. A search surfaced a freemail
address belonging to a same-named professor, taken from a stroke paper published in
**Iran** → location and institution both mismatch → `identity_match: "mismatch"` →
email dropped, `not_found`. Without that check it would have been filed as this
clinician's address.

The contrasting case: a cardiologist whose source page matched on all three axes —
same hospital, same city, same sub-specialty → `identity_match: "confirmed"` → kept.
