import { describe, expect, it } from 'vitest';

import { escapeHtml } from './escape';

describe('escapeHtml', () => {
  it.each([
    ['&', '&amp;'],
    ['<', '&lt;'],
    ['>', '&gt;'],
    ['"', '&quot;'],
    ["'", '&#39;'],
  ])('escapes %s', (input, expected) => {
    expect(escapeHtml(input)).toBe(expected);
  });

  it('escapes every occurrence, not just the first', () => {
    expect(escapeHtml('<<>>')).toBe('&lt;&lt;&gt;&gt;');
  });

  it('leaves text without special characters untouched', () => {
    expect(escapeHtml('')).toBe('');
    expect(escapeHtml('Hi I am Mita')).toBe('Hi I am Mita');
    expect(escapeHtml('はじめまして 私はミタ ❤')).toBe('はじめまして 私はミタ ❤');
  });

  it('escapes even if they are not html', () => {
    expect(escapeHtml('I have been watching you in secret >.<')).toBe('I have been watching you in secret &gt;.&lt;');
  });

  // Ampersands are escaped alongside the other characters in a single pass, so an entity
  // in the input survives as literal text instead of being re-interpreted.
  it('escapes the ampersand of an entity already present in the input', () => {
    expect(escapeHtml('&lt;script&gt;')).toBe('&amp;lt;script&amp;gt;');
  });

  it('is not idempotent — escaping twice double-escapes', () => {
    expect(escapeHtml(escapeHtml('<b>'))).toBe('&amp;lt;b&amp;gt;');
  });

  it.each([
    '<script>alert(1)</script>',
    '<img src=x onerror=alert(1)>',
    '<svg><style><!--</style><img src=x onerror=alert(1)>-->',
    '<noscript><p title="</noscript><img src=x onerror=alert(1)>">',
    '<form><math><mtext></form><form><mglyph><style></math><img src onerror=alert(1)>',
    '<iframe srcdoc="&lt;script&gt;alert(1)&lt;/script&gt;">',
    '<a href="javascript:alert(1)">x</a>',
    '<div style="background:url(javascript:alert(1))">',
    '"><script>alert(1)</script>',
    "'><img src=x onerror=alert(1)>",
  ])('renders %s inert', (payload) => {
    const escaped = escapeHtml(payload);

    expect(escaped).not.toMatch(/[<>"']/);
    expect(escaped).toContain('&lt;');
  });

  it('preserves the original text once the entities are decoded', () => {
    const original = '<b>bold</b> & "quoted" & \'single\'';
    const decoded = escapeHtml(original)
      .replaceAll('&lt;', '<')
      .replaceAll('&gt;', '>')
      .replaceAll('&quot;', '"')
      .replaceAll('&#39;', "'")
      .replaceAll('&amp;', '&');

    expect(decoded).toBe(original);
  });
});
