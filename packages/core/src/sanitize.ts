/**
 * Sanitization rules as pure data.
 *
 * `@mita/core` never imports DOMPurify — the rules live here so that client and server
 * agree on one allowlist, while the actual DOM traversal stays in `@mita/server`, which
 * spreads a profile straight into `DOMPurify.sanitize(html, { ...profile })`.
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
 * `rel` value `@mita/server` forces onto every surviving anchor: `noopener`/`noreferrer`
 * close the `window.opener` hijack, `nofollow`/`ugc` mark user-submitted links for crawlers.
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
