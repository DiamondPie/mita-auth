import { commentSchema } from '@mita-auth/core';

import { addComment } from '~~/lib/comments';
import { guard } from '~~/lib/guard';

export default defineEventHandler(async (event) => {
  // The one line of glue this side needs. Read the body off this `Request` rather than
  // through `readBody(event)`: the conversion hands the Node stream to the `Request`, and
  // h3's own reader then waits forever on a stream it no longer owns.
  const request = toWebRequest(event);

  const check = await guard.verify(request);

  // The limiter owes background work on both outcomes — a denied request is exactly the
  // one whose analytics are worth keeping — so it is handed over before any early return.
  event.waitUntil(check.pending);

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
});
