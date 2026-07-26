export * from './dpop';
export * from './errors';
export * from './headers';
export * from './nonce';
export * from './patterns';

// `internal/sanitize` is deliberately not re-exported: nothing implements those profiles
// yet, and publishing them would freeze five symbols into the semver surface before the
// first real consumer has had a chance to say whether they are the right shape.
//
// `./schemas` is deliberately not re-exported here. It is the only module that needs Zod,
// and this entry is bundled as one file, so a single re-export would put ~16 kB gzip in
// front of every browser that only ever signs a proof. Import it from
// `@mita-auth/core/schemas` when you want the validation.
