/**
 * How an address is classified, declared exactly once.
 *
 * These four tests decide whether a scraped address is the company's front desk, a website
 * vendor's, a template placeholder, or a free mailbox. Stages 3, 4 and 4b all need them, and
 * each used to carry its own copy — which is the duplication CLAUDE.md names under "Never",
 * for the reason on display when this file was written: the copies had already drifted.
 *
 * `reception1@` matched in stage 3 and not in stage 4, so the same address was the company's
 * primary inbox to one stage and an ordinary address to the next. It reached the list because
 * someone met a real clinic using it and patched the copy in front of them. That is now
 * `reception\d*`, which covers the family the patch was reaching for.
 *
 * Adding a term here changes every stage at once. That is the point.
 */

/**
 * A generic mailbox rather than a person: `info@`, `reception@`, `bookings@`.
 *
 * Anchored to the whole address, because it answers "is this address a role inbox" — the
 * question stages 3 and 4 ask when deciding what a company's contact address is, and when
 * ranking a role address ahead of a personal one on the same domain.
 */
export const ROLE =
  /^(?:info|reception\d*|admin|contact|enquir(?:y|ies)|office|hello|mail|practice|booking(?:s)?|appointment(?:s)?|referral(?:s)?|account(?:s)?|hr|careers?|frontdesk|desk|clinic|rooms|secretary|pa|welcome|team|support|general)@/i;

/**
 * The same idea, asked of a local part alone and cast deliberately wider — **not** a
 * duplicate of `ROLE`, and not to be merged with it.
 *
 * Stage 7 learns a company's email format from addresses it has already confirmed. A single
 * role address poisons that: `sales@clinic.com.au` would teach it the pattern `{first}`.
 * So the question there is not "is this the front desk" but "is this anything other than a
 * person", and the cost of a false negative (a bad pattern learned for every employee) far
 * exceeds a false positive (one address skipped). Hence `sales`, `marketing`, `webmaster`,
 * `doctor`, `nurse` — words that are perfectly good contact inboxes but are never a name.
 */
export const ROLE_LOCALPART =
  /^(info|reception|admin|contact|enquir|office|hello|mail|practice|booking|appointment|referral|account|hr|careers?|frontdesk|desk|clinic|rooms|secretary|welcome|team|support|general|no-?reply|feedback|sales|marketing|patients?|appts|webmaster|manager|education|doctor|nurse)/i;

/** The booking platform's or web agency's own address, picked up from a widget or footer. */
export const VENDOR =
  /@(?:.*\.)?(?:myhealth1st|healthengine|hotdoc|automedsystems|cliniko|marketingsweet|wixpress|sentry|squarespace|godaddy|wordpress|shopify|mailchimp|hubspot|constantcontact|example|schema|w3|sentry-next|mhtml|blink)\b/i;

/** Theme boilerplate nobody replaced — `your@email.com`, `name@domain.com`. */
export const PLACEHOLDER =
  /^(?:user|test|name|email|yourname|firstname|your)@|@(?:domain|email|yourdomain|company|website)\.(?:com|net)$/i;

/** A free mailbox. Real, and often a small clinic's only address — never discard it. */
export const FREEMAIL =
  /@(?:gmail|outlook|hotmail|yahoo|bigpond|live|icloud|me|optusnet|iinet|internode)\.[a-z.]+$/i;
