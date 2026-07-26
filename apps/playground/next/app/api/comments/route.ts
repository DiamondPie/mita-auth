import { commentSchema } from '@mita-auth/core';
import { after } from 'next/server';

import { addComment, listComments } from '@/lib/comments';
import { guard, redisBackend } from '@/lib/guard';

/** The list lives in memory and changes per request, so nothing here may be prerendered. */
export const dynamic = 'force-dynamic';

export function GET(): Response {
  return Response.json({ comments: listComments(), backend: redisBackend });
}

export async function POST(request: Request): Promise<Response> {
  const check = await guard.verify(request);

  // The limiter owes background work on both outcomes — a denied request is exactly the
  // one whose analytics are worth keeping — so it is handed over before any early return.
  after(check.pending);

  if (!check.success) {
    return check.response;
  }

  const parsed = commentSchema.safeParse(await request.json().catch(() => null));

  // `check.headers` carries the next DPoP-Nonce. Dropping it here would leave a visitor who
  // made a typo unable to sign anything afterwards.
  if (!parsed.success) {
    return Response.json(
      { error: 'invalid_comment', issues: parsed.error.issues.map((issue) => issue.message) },
      { status: 422, headers: check.headers },
    );
  }

  return Response.json(
    { comment: addComment(parsed.data) },
    { status: 201, headers: check.headers },
  );
}
