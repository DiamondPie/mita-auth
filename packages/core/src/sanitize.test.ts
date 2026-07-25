import { describe, expect, it } from 'vitest';

import {
  COMMENT_SANITIZE_PROFILE,
  MINIMAL_SANITIZE_PROFILE,
  SAFE_LINK_REL,
  SAFE_URI_PATTERN,
  type SanitizeProfile,
} from './sanitize';

const profiles: [name: string, profile: SanitizeProfile][] = [
  ['MINIMAL_SANITIZE_PROFILE', MINIMAL_SANITIZE_PROFILE],
  ['COMMENT_SANITIZE_PROFILE', COMMENT_SANITIZE_PROFILE],
];

describe('SAFE_URI_PATTERN', () => {
  it.each([
    'https://example.com/post',
    'http://example.com',
    'mailto:someone@example.com',
    '/relative/path',
    '#anchor',
    './sibling',
  ])('accepts %s', (uri) => {
    expect(SAFE_URI_PATTERN.test(uri)).toBe(true);
  });

  it.each([
    'javascript:alert(1)',
    'JaVaScRiPt:alert(1)',
    'data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==',
    'vbscript:msgbox(1)',
    'file:///etc/passwd',
  ])('rejects %s', (uri) => {
    expect(SAFE_URI_PATTERN.test(uri)).toBe(false);
  });
});

describe.each(profiles)('%s', (_name, profile) => {
  it('never allows a tag that can execute script', () => {
    const executable = ['script', 'style', 'iframe', 'object', 'embed', 'svg', 'math', 'form'];

    for (const tag of executable) {
      expect(profile.ALLOWED_TAGS).not.toContain(tag);
      expect(profile.FORBID_TAGS).toContain(tag);
    }
  });

  it('never allows an event handler or resource-loading attribute', () => {
    for (const attribute of profile.ALLOWED_ATTR) {
      expect(attribute.startsWith('on')).toBe(false);
    }

    expect(profile.ALLOWED_ATTR).not.toContain('src');
    expect(profile.ALLOWED_ATTR).not.toContain('style');
    expect(profile.FORBID_ATTR).toContain('style');
  });

  it('disables the wildcard attribute families', () => {
    expect(profile.ALLOW_DATA_ATTR).toBe(false);
    expect(profile.ALLOW_ARIA_ATTR).toBe(false);
    expect(profile.ALLOW_UNKNOWN_PROTOCOLS).toBe(false);
  });

  it('constrains URIs with the shared pattern', () => {
    expect(profile.ALLOWED_URI_REGEXP).toBe(SAFE_URI_PATTERN);
  });
});

describe('MINIMAL_SANITIZE_PROFILE', () => {
  it('permits inline formatting only', () => {
    expect(MINIMAL_SANITIZE_PROFILE.ALLOWED_TAGS).not.toContain('a');
    expect(MINIMAL_SANITIZE_PROFILE.ALLOWED_TAGS).not.toContain('p');
    expect(MINIMAL_SANITIZE_PROFILE.ALLOWED_ATTR).toHaveLength(0);
  });
});

describe('COMMENT_SANITIZE_PROFILE', () => {
  it('permits links, lists and code blocks', () => {
    expect(COMMENT_SANITIZE_PROFILE.ALLOWED_TAGS).toEqual(
      expect.arrayContaining(['a', 'p', 'ul', 'ol', 'li', 'pre', 'code', 'blockquote']),
    );
    expect(COMMENT_SANITIZE_PROFILE.ALLOWED_ATTR).toEqual(
      expect.arrayContaining(['href', 'rel', 'target']),
    );
  });
});

describe('SAFE_LINK_REL', () => {
  it('closes the opener hijack and marks user content', () => {
    expect(SAFE_LINK_REL.split(' ')).toEqual(
      expect.arrayContaining(['noopener', 'noreferrer', 'nofollow', 'ugc']),
    );
  });
});
