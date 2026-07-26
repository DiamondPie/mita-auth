/**
 * Sanitization rules as pure data, reserved for a rich-text path that does not exist yet.
 *
 * **Nothing consumes these.** `@mita-auth/server` sanitizes by escaping — `escapeHtml` turns
 * markup into text and never parses it — so no allowlist is consulted anywhere today. The
 * profiles are shaped for DOMPurify's option object, to be spread into
 * `DOMPurify.sanitize(html, { ...profile })` by a future Node-only subpath export; the
 * DOMPurify + linkedom combination that would have backed it on Edge was removed in Phase 2
 * after it turned out to silently pass every XSS case through.
 *
 * They stay internal until that lands. Publishing them would put five symbols with no
 * implementation behind them into the package's semver surface, where the first real
 * consumer could only adjust them by way of a breaking change.
 */
export interface SanitizeProfile {
  readonly ALLOWED_TAGS: readonly string[];
  readonly ALLOWED_ATTR: readonly string[];
  readonly ALLOWED_URI_REGEXP: RegExp;
  readonly FORBID_TAGS: readonly string[];
  readonly FORBID_ATTR: readonly string[];
  readonly ALLOW_DATA_ATTR: boolean;
  readonly ALLOW_ARIA_ATTR: boolean;
  readonly ALLOW_UNKNOWN_PROTOCOLS: boolean;
}

/**
 * Accepts http(s), mailto, fragments and relative paths; rejects every other scheme,
 * `javascript:` and `data:` included.
 */
export const SAFE_URI_PATTERN = /^(?:(?:https?|mailto):|[^a-z]|[a-z+.-]+(?:[^a-z+.:-]|$))/i;

/**
 * `rel` value to force onto every surviving anchor once anchors survive anything:
 * `noopener`/`noreferrer` close the `window.opener` hijack, `nofollow`/`ugc` mark
 * user-submitted links for crawlers.
 */
export const SAFE_LINK_REL = 'noopener noreferrer nofollow ugc';

/**
 * Tags that stay dangerous even when an allowlist already excludes them — listed
 * explicitly so that a widened `ALLOWED_TAGS` can never accidentally re-admit them.
 */
const ALWAYS_FORBIDDEN_TAGS = [
  'script',
  'style',
  'iframe',
  'object',
  'embed',
  'form',
  'input',
  'button',
  'textarea',
  'base',
  'link',
  'meta',
  'svg',
  'math',
] as const;

const ALWAYS_FORBIDDEN_ATTR = ['style', 'srcset', 'formaction', 'ping'] as const;

/** Inline formatting only. For single-line fields such as display names or bios. */
export const MINIMAL_SANITIZE_PROFILE: SanitizeProfile = {
  ALLOWED_TAGS: ['b', 'strong', 'i', 'em', 'u', 's', 'del', 'code', 'br'],
  ALLOWED_ATTR: [],
  ALLOWED_URI_REGEXP: SAFE_URI_PATTERN,
  FORBID_TAGS: ALWAYS_FORBIDDEN_TAGS,
  FORBID_ATTR: ALWAYS_FORBIDDEN_ATTR,
  ALLOW_DATA_ATTR: false,
  ALLOW_ARIA_ATTR: false,
  ALLOW_UNKNOWN_PROTOCOLS: false,
};

/** Default profile for comment bodies: block-level structure, lists, code and links. */
export const COMMENT_SANITIZE_PROFILE: SanitizeProfile = {
  ALLOWED_TAGS: [
    'p',
    'br',
    'hr',
    'b',
    'strong',
    'i',
    'em',
    'u',
    's',
    'del',
    'ins',
    'mark',
    'sub',
    'sup',
    'code',
    'pre',
    'blockquote',
    'ul',
    'ol',
    'li',
    'a',
  ],
  ALLOWED_ATTR: ['href', 'title', 'lang', 'dir', 'rel', 'target'],
  ALLOWED_URI_REGEXP: SAFE_URI_PATTERN,
  FORBID_TAGS: ALWAYS_FORBIDDEN_TAGS,
  FORBID_ATTR: ALWAYS_FORBIDDEN_ATTR,
  ALLOW_DATA_ATTR: false,
  ALLOW_ARIA_ATTR: false,
  ALLOW_UNKNOWN_PROTOCOLS: false,
};
