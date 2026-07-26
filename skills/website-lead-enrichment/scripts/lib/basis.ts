/**
 * Turn a `best_email_basis` into something a salesperson can act on.
 *
 * The basis vocabulary is precise and unreadable — `learned:filast(ai)(unverified-domain)`
 * is exactly right and means nothing to the person deciding whether to press send. This
 * is the one place that translates it, so the phrasing cannot drift between the CSV
 * columns, the run summary, and whatever the agent says out loud.
 *
 * Full vocabulary: ../PIPELINE-STATE.md
 */

export interface BasisMeaning {
  /** Plain-English send-safety. Empty when the row has no address at all. */
  status: 'Ready to send' | 'Needs verification' | '';
  /** Plain-English provenance — where this address came from. */
  source: string;
  /** True only when the address demonstrably exists: scraped, or sourced with a URL. */
  sendable: boolean;
}

const AI = '(ai)';
const UNVERIFIED = '(unverified-domain)';

/**
 * Peel the optional suffixes off a basis.
 *
 * They compose (`learned:filast(ai)(unverified-domain)`) and are documented as appearing
 * in that order, but stripping in a loop means a future reordering cannot silently fall
 * through to the "unknown" branch.
 */
function parseBasis(basis: string): {
  stem: string;
  ai: boolean;
  unverifiedDomain: boolean;
} {
  let stem = (basis || '').trim();
  let ai = false;
  let unverifiedDomain = false;
  for (;;) {
    if (stem.endsWith(UNVERIFIED)) {
      unverifiedDomain = true;
      stem = stem.slice(0, -UNVERIFIED.length);
      continue;
    }
    if (stem.endsWith(AI)) {
      ai = true;
      stem = stem.slice(0, -AI.length);
      continue;
    }
    break;
  }
  return { stem, ai, unverifiedDomain };
}

export function basisToStatus(basis: string): BasisMeaning {
  const { stem, ai, unverifiedDomain } = parseBasis(basis);

  if (stem === 'known') {
    return { status: 'Ready to send', source: 'Published on their website', sendable: true };
  }

  if (stem.startsWith('web-found:')) {
    const confidence = stem.slice('web-found:'.length) || 'low';
    return {
      status: 'Ready to send',
      source: `Found on the web (${confidence} confidence)`,
      sendable: true,
    };
  }

  if (stem.startsWith('learned:')) {
    const caveat = unverifiedDomain ? ' — mail domain not confirmed' : '';
    return {
      status: 'Needs verification',
      source: `Matches this company's email format${ai ? ' (AI-judged)' : ''}${caveat}`,
      sendable: false,
    };
  }

  if (stem.startsWith('default:')) {
    return {
      status: 'Needs verification',
      source: unverifiedDomain
        ? 'Predicted — mail domain not confirmed'
        : 'Predicted — mail domain confirmed',
      sendable: false,
    };
  }

  // No address at all. These rows reach neither send-facing file; the phrasing exists so
  // the master and the run summary can still explain the gap.
  if (stem === 'no-domain') {
    return { status: '', source: 'No mail domain — nothing to send to', sendable: false };
  }
  if (stem === 'no-name') {
    return { status: '', source: 'No usable name — could not predict an address', sendable: false };
  }

  // An unrecognized basis must never read as sendable. Surfacing the raw value beats
  // inventing a friendly label for something this file does not know about.
  return { status: 'Needs verification', source: basis || 'Unknown', sendable: false };
}
