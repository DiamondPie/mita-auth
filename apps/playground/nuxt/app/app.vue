<script setup lang="ts">
import CommentSection from '~/components/CommentSection.vue';

useHead({ title: 'Mita playground — Nuxt' });
</script>

<template>
  <main>
    <header>
      <h1>Mita playground</h1>
      <p class="subtitle">Nuxt · @mita-auth/vue</p>
    </header>
    <CommentSection />
  </main>
</template>
