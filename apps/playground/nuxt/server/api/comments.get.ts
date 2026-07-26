import { listComments } from '~~/lib/comments';
import { storeBackend } from '~~/lib/guard';

export default defineEventHandler(() =>
  Response.json({ comments: listComments(), backend: storeBackend }),
);
