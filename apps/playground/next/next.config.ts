import { join } from 'node:path';

import type { NextConfig } from 'next';

const config: NextConfig = {
  turbopack: {
    // Without this Turbopack walks up looking for a lockfile and can settle on one outside
    // the repository. The workspace root is where the packages this demo imports live.
    root: join(import.meta.dirname, '../../..'),
  },
};

export default config;
