import type { CommentInput } from '@mita-auth/core';
import { escapeHtml } from '@mita-auth/server';

import type { Comment } from './types';

/** One process's memory. Nothing here is meant to outlive the dev server. */
const comments: Comment[] = [
  {
    id: 'seed',
    author: 'mita',
    content: escapeHtml('Try posting <img src=x onerror=alert(1)> and read what comes back.'),
    createdAt: '2026-07-26T00:00:00.000Z',
  },
];

export function listComments(): readonly Comment[] {
  return comments;
}

/**
 * Escaping happens once, on the way in, so every reader downstream is safe by construction.
 *
 * `escapeHtml` turns markup into text rather than filtering it — there is no parser here,
 * so there is no mutation-XSS surface either. The stored string is what gets rendered.
 *
 * Only `content` is escaped, because only `content` is rendered as HTML. `author` reaches
 * the page through ordinary text interpolation, which escapes on its own; escaping it here
 * as well would show `A &amp; B` to a visitor who typed `A & B`.
 *
 * A production comment board more often stores the original text and escapes at render
 * time, which keeps the stored value usable by readers that are not HTML — a JSON API, a
 * mobile client, an email notification. This demo escapes on write on purpose, so that a
 * payload stays visible in the response body.
 */
export function addComment(input: CommentInput): Comment {
  const comment: Comment = {
    id: crypto.randomUUID(),
    author: input.author ?? 'anonymous',
    content: escapeHtml(input.content),
    createdAt: new Date().toISOString(),
  };

  comments.unshift(comment);

  return comment;
}
