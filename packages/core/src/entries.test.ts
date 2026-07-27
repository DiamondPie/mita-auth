/**
 * Bundles each entry point the way an application would, and asserts which of them can
 * reach Zod.
 *
 * A single re-export of `schemas.ts` from `index.ts` would put all of Zod — around 16 kB
 * gzip — in front of every browser that does nothing but sign a proof: a chain like
 * `z.string().max().regex()` is not provably side-effect free, so nothing downstream is
 * obliged to shake it back out. That is why the entry points are the boundary and this test
 * measures them as one. Importing the source directly, as every other test here does,
 * cannot see it; only a bundler can.
 *
 * The second case is the control. Without it, the first would keep passing if the
 * assertion stopped matching anything at all.
 *
 * Free of Node APIs on purpose, like the rest of the package: `@types/node` is absent so
 * that a Node-only call fails to compile rather than passing review.
 */
import { rolldown } from 'rolldown';
import { describe, expect, it } from 'vitest';

/** Dependencies stay external, so a mention of one in the output means the graph reached it. */
async function bundle(input: string): Promise<string> {
  const build = await rolldown({ input, platform: 'browser', external: ['jose', 'zod'] });

  try {
    const { output } = await build.generate({ format: 'esm' });

    return output[0].code;
  } finally {
    await build.close();
  }
}

describe('entry points', () => {
  it(
    'keeps Zod out of the main entry',
    async () => {
      expect(await bundle('src/index.ts')).not.toMatch(/["']zod["']/);
    },
    60_000,
  );

  it(
    'reaches Zod from the schemas entry',
    async () => {
      expect(await bundle('src/schemas.ts')).toMatch(/["']zod["']/);
    },
    60_000,
  );
});
