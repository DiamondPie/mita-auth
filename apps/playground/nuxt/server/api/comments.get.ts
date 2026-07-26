import { listComments } from '~~/lib/comments';
import { redisBackend } from '~~/lib/guard';

export default defineEventHandler(() =>
  Response.json({ comments: listComments(), backend: redisBackend }),
);
