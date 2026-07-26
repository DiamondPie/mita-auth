// https://nuxt.com/docs/api/configuration/nuxt-config
export default defineNuxtConfig({
  compatibilityDate: '2026-07-26',
  devtools: { enabled: false },
  css: ['~/assets/globals.css'],

  // Note what is *not* here: `vue.compilerOptions.isCustomElement`. A template writing
  // `<mita-turnstile>` by hand would need it, because Vue's compiler would otherwise treat
  // the tag as an unresolved component. `<MitaTurnstile>` from @mita-auth/vue is a render
  // function, so the tag never reaches the compiler — which is a large part of why the
  // wrapper component exists at all.
});
