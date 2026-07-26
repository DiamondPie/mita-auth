<script setup lang="ts">
import { commentSchema } from '@mita-auth/core';
import { MitaTurnstile, useIsAuthenticated, useTurnstileStatus } from '@mita-auth/vue';
import { onMounted, ref } from 'vue';

import { getApi } from '~~/lib/api';
import { TURNSTILE_SITE_KEYS, type TurnstileMode } from '~~/lib/config';
import { describeFailure } from '~~/lib/failure';
import type { Comment, CommentsResponse } from '~~/lib/types';

const isAuthenticated = useIsAuthenticated();
const turnstileStatus = useTurnstileStatus();

const comments = ref<Comment[]>([]);
const backend = ref('…');
const mode = ref<TurnstileMode>('autoPass');
const author = ref('');
const content = ref('');
const error = ref<string | null>(null);
const pending = ref(false);

onMounted(() => {
  // Reading the list needs no proof, so it goes over plain fetch — the guard protects
  // writes, and pretending otherwise would overstate what Mita does.
  void fetch('/api/comments')
    .then((response) => response.json() as Promise<CommentsResponse>)
    .then((loaded) => {
      comments.value = loaded.comments;
      backend.value = loaded.backend;
    });
});

const submit = async () => {
  // The same schema the server API parses with, so the two cannot drift apart.
  const parsed = commentSchema.safeParse({
    content: content.value,
    ...(author.value === '' ? {} : { author: author.value }),
  });

  if (!parsed.success) {
    error.value = parsed.error.issues[0]?.message ?? 'That comment is not valid.';
    return;
  }

  pending.value = true;
  error.value = null;

  try {
    const { comment } = await getApi()
      .post('/api/comments', { json: parsed.data })
      .json<{ comment: Comment }>();

    comments.value = [comment, ...comments.value];
    content.value = '';
  } catch (cause) {
    error.value = await describeFailure(cause);
  } finally {
    pending.value = false;
  }
};
</script>

<template>
  <div class="badges">
    <span class="badge">
      session <strong>{{ isAuthenticated ? 'active' : 'idle' }}</strong>
    </span>
    <span class="badge">
      turnstile <strong>{{ turnstileStatus }}</strong>
    </span>
    <span class="badge">
      redis <strong>{{ backend }}</strong>
    </span>
  </div>

  <form class="panel" @submit.prevent="submit">
    <label>
      Turnstile test key
      <select v-model="mode">
        <option value="autoPass">1x…AA — solves itself</option>
        <option value="interactive">3x…FF — waits for a click</option>
      </select>
    </label>

    <MitaTurnstile :site-key="TURNSTILE_SITE_KEYS[mode]" />

    <label>
      Name
      <input v-model="author" >
    </label>

    <label>
      Comment
      <textarea v-model="content" />
    </label>

    <button type="submit" :disabled="pending">
      {{ pending ? 'Posting…' : 'Post comment' }}
    </button>

    <p v-if="error !== null" class="error">{{ error }}</p>
  </form>

  <ul class="comments">
    <li v-for="comment in comments" :key="comment.id" class="comment">
      <header>
        <strong>{{ comment.author }}</strong>
        <time :datetime="comment.createdAt">{{ comment.createdAt.slice(0, 19) }}</time>
      </header>
      <!-- The server escaped this on the way in, so markup in a comment renders as the
           text it is. Rendering it as HTML is the point: it shows the payload survived as
           characters rather than being executed or silently stripped. -->
      <div class="comment-body" v-html="comment.content" />
    </li>
  </ul>
</template>
