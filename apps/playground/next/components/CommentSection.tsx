'use client';

import { commentSchema } from '@mita-auth/core';
import { MitaTurnstile, useIsAuthenticated, useTurnstileStatus } from '@mita-auth/react';
import { useEffect, useState, type FormEvent } from 'react';

import { getApi } from '@/lib/api';
import { TURNSTILE_SITE_KEYS, type TurnstileMode } from '@/lib/config';
import { describeFailure } from '@/lib/failure';
import type { Comment, CommentsResponse } from '@/lib/types';

export function CommentSection() {
  const isAuthenticated = useIsAuthenticated();
  const turnstileStatus = useTurnstileStatus();

  const [comments, setComments] = useState<Comment[]>([]);
  const [backend, setBackend] = useState('…');
  const [mode, setMode] = useState<TurnstileMode>('autoPass');
  const [author, setAuthor] = useState('');
  const [content, setContent] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  useEffect(() => {
    // Reading the list needs no proof, so it goes over plain fetch — the guard protects
    // writes, and pretending otherwise would overstate what Mita does.
    void fetch('/api/comments')
      .then((response) => response.json() as Promise<CommentsResponse>)
      .then((loaded) => {
        setComments(loaded.comments);
        setBackend(loaded.backend);
      });
  }, []);

  const submit = async (event: FormEvent) => {
    event.preventDefault();

    // The same schema the Route Handler parses with, so the two cannot drift apart.
    const parsed = commentSchema.safeParse({
      content,
      ...(author === '' ? {} : { author }),
    });

    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? 'That comment is not valid.');
      return;
    }

    setPending(true);
    setError(null);

    try {
      const { comment } = await getApi()
        .post('/api/comments', { json: parsed.data })
        .json<{ comment: Comment }>();

      setComments((current) => [comment, ...current]);
      setContent('');
    } catch (cause) {
      setError(describeFailure(cause));
    } finally {
      setPending(false);
    }
  };

  return (
    <>
      <div className="badges">
        <span className="badge">
          session <strong>{isAuthenticated ? 'active' : 'idle'}</strong>
        </span>
        <span className="badge">
          turnstile <strong>{turnstileStatus}</strong>
        </span>
        <span className="badge">
          redis <strong>{backend}</strong>
        </span>
      </div>

      <form className="panel" onSubmit={submit}>
        <label>
          Turnstile test key
          <select value={mode} onChange={(event) => setMode(event.target.value as TurnstileMode)}>
            <option value="autoPass">1x…AA — solves itself</option>
            <option value="interactive">3x…FF — waits for a click</option>
          </select>
        </label>

        <MitaTurnstile siteKey={TURNSTILE_SITE_KEYS[mode]} />

        <label>
          Name
          <input value={author} onChange={(event) => setAuthor(event.target.value)} />
        </label>

        <label>
          Comment
          <textarea value={content} onChange={(event) => setContent(event.target.value)} />
        </label>

        <button type="submit" disabled={pending}>
          {pending ? 'Posting…' : 'Post comment'}
        </button>

        {error === null ? null : <p className="error">{error}</p>}
      </form>

      <ul className="comments">
        {comments.map((comment) => (
          <li key={comment.id} className="comment">
            <header>
              <strong>{comment.author}</strong>
              <time dateTime={comment.createdAt}>{comment.createdAt.slice(0, 19)}</time>
            </header>
            {/* The server escaped this on the way in, so markup in a comment renders as the
                text it is. Rendering it as HTML is the point: it shows the payload survived
                as characters rather than being executed or silently stripped. */}
            <div className="comment-body" dangerouslySetInnerHTML={{ __html: comment.content }} />
          </li>
        ))}
      </ul>
    </>
  );
}
