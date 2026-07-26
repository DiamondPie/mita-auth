// Every export here is a hook or a client component. The per-module directives do not
// survive bundling — rolldown merges the sources into one chunk and keeps only the
// directive on the entry — so this one is what actually reaches `dist`, and without it a
// React Server Component importing this package fails at build time.
'use client';

export * from './hooks';
export * from './MitaTurnstile';
