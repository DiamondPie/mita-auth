import { commentSchema } from '@mita-auth/core';
import { toWebRequest } from 'h3';

import { addComment } from '~~/lib/comments';
import { guard } from '~~/lib/guard';

export default defineEventHandler(async (event) => {
  // The one line of glue this side needs: Nitro 2 runs on h3 v1, whose event wraps a Node
  // request rather than a web one. Imported explicitly rather than auto-imported, because
  // an h3 v2 release candidate is installed alongside and Nuxt's generated auto-imports
  // resolve to it — and that build dropped `toWebRequest` entirely.
  //
  // Read the body off this `Request` too: the conversion hands it the Node stream, and
  // `readBody(event)` would then wait forever on a stream it no longer owns.
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
