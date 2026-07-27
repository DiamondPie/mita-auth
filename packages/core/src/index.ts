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
// and a subentry is the one boundary this package can promise: whether the bundler splits a
// chunk, and whether the consumer's own bundler then shakes the unused half back out, is not
// something a library gets to guarantee. Keeping the two entries apart is what puts ~16 kB
// gzip out of reach of a browser that only ever signs a proof, rather than merely likely to
// be. Import it from `@mita-auth/core/schemas` when you want the validation.
