/**
 * HTML escaping — the runtime-agnostic stand-in for full sanitization.
 *
 * Escaping never parses the input, so the parse/serialize/reparse round trip that
 * mutation-XSS depends on has no surface to attack. That also makes it the only
 * approach with identical behaviour on Node, Vercel Edge, Cloudflare Workers and the
 * browser: DOMPurify needs a real DOM, and no userland DOM implementation is faithful
 * enough to trust with it.
 *
 * The trade-off is that markup is shown, not rendered. Rich text needs the allowlist
 * sanitizer instead.
 *
 * TODO: ship the DOMPurify-backed allowlist sanitizer as the Node-only
 * `@mita/server/sanitize` subpath export, keeping this module as the universal path.
 */

/** `&#39;` rather than `&apos;`, which HTML 4 never defined. */
const HTML_ENTITIES = new Map([
  ['&', '&amp;'],
  ['<', '&lt;'],
  ['>', '&gt;'],
  ['"', '&quot;'],
  ["'", '&#39;'],
]);

const HTML_ESCAPE_PATTERN = /["&'<>]/g;

/**
 * Escapes the five characters that can break out of an HTML text node or a quoted
 * attribute value.
 *
 * Sufficient for those two contexts only. Unquoted attribute values, `<script>` and
 * `<style>` bodies, `href`/`src` URLs and inline CSS each need their own encoding, and
 * this function does not provide it.
 *
 * The result is meant to be inserted as HTML (`innerHTML`, `v-html`,
 * `dangerouslySetInnerHTML`). Feeding it to a framework's text interpolation — React
 * `{value}`, Vue `{{ value }}` — escapes it a second time and renders `&lt;b&gt;`
 * literally, so escape either on write or on render, never both.
 */
export function escapeHtml(value: string): string {
  return value.replace(
    HTML_ESCAPE_PATTERN,
    (character) => HTML_ENTITIES.get(character) ?? character,
  );
}
