import * as z from 'zod';

import { MitaError } from './errors';
import { MAX_NONCE_BYTES, MIN_NONCE_BYTES } from './nonce';
import {
  BASE64URL_PATTERN,
  COMPACT_JWT_PATTERN,
  JWK_THUMBPRINT_LENGTH,
  MAX_DPOP_PROOF_LENGTH,
} from './patterns';

const base64urlLength = (bytes: number): number => Math.ceil((bytes * 4) / 3);

// ---------------------------------------------------------------------------
// Protocol schemas — the single source of truth shared by client and server.
// ---------------------------------------------------------------------------

export const nonceSchema = z
  .string()
  .min(base64urlLength(MIN_NONCE_BYTES), 'Nonce is too short to carry sufficient entropy.')
  .max(base64urlLength(MAX_NONCE_BYTES), 'Nonce exceeds the maximum accepted length.')
  .regex(BASE64URL_PATTERN, 'Nonce must be base64url-encoded.');

export const jwkThumbprintSchema = z
  .string()
  .length(JWK_THUMBPRINT_LENGTH, 'A SHA-256 JWK thumbprint is 43 base64url characters.')
  .regex(BASE64URL_PATTERN, 'JWK thumbprint must be base64url-encoded.');

export const dpopProofSchema = z
  .string()
  .max(MAX_DPOP_PROOF_LENGTH, 'DPoP proof exceeds the maximum accepted length.')
  .regex(COMPACT_JWT_PATTERN, 'DPoP proof must be a compact JWT.');

/** Cloudflare caps Turnstile tokens at 2048 characters. */
export const turnstileTokenSchema = z
  .string()
  .min(1, 'Turnstile token must not be empty.')
  .max(2048, 'Turnstile token exceeds the maximum accepted length.');

/**
 * Baseline contract for the security material carried alongside a protected request.
 *
 * Deployments that mandate Turnstile or DPoP tighten it with
 * `securityEnvelopeSchema.required({ turnstileToken: true })`.
 */
export const securityEnvelopeSchema = z.strictObject({
  nonce: nonceSchema,
  dpopProof: dpopProofSchema.optional(),
  turnstileToken: turnstileTokenSchema.optional(),
});

export type SecurityEnvelope = z.infer<typeof securityEnvelopeSchema>;

// ---------------------------------------------------------------------------
// Business schemas — composable through Zod's own combinators.
// ---------------------------------------------------------------------------

const IDENTIFIER_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

const URL_SCHEME_PATTERN = /^[a-z][a-z0-9+.-]*$/i;

const DEFAULT_URL_PROTOCOLS = ['http', 'https'] as const;

/** Allows tab, newline and carriage return; rejects every other control character. */
const hasNoControlCharacters = (value: string): boolean => {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    const isAllowedWhitespace = code === 0x09 || code === 0x0a || code === 0x0d;

    if (!isAllowedWhitespace && (code < 0x20 || code === 0x7f)) {
      return false;
    }
  }

  return true;
};

export interface CommentSchemaOptions {
  /** Minimum length after trimming. Defaults to 1. */
  minContentLength?: number;
  /** Maximum length after trimming. Defaults to 5000. */
  maxContentLength?: number;
  /** Maximum author display name length. Defaults to 64. */
  maxAuthorLength?: number;
  /** Maximum homepage URL length. Defaults to 2048. */
  maxUrlLength?: number;
  /** URL schemes accepted for the homepage field, without the colon. Defaults to http and https. */
  allowedUrlProtocols?: readonly string[];
}

function toProtocolPattern(protocols: readonly string[]): RegExp {
  if (protocols.length === 0) {
    throw new MitaError('config.invalid_url_protocol', 'At least one URL protocol must be allowed.');
  }

  const schemes = protocols.map((protocol) => {
    const scheme = protocol.replace(/:$/, '');

    if (!URL_SCHEME_PATTERN.test(scheme)) {
      throw new MitaError(
        'config.invalid_url_protocol',
        `"${protocol}" is not a valid URL scheme. Expected a bare scheme such as "https".`,
      );
    }

    return scheme;
  });

  return new RegExp(`^(?:${schemes.join('|')})$`, 'i');
}

/**
 * Builds the comment payload schema.
 *
 * Options only tune constraints; the field set is shaped with Zod's own combinators —
 * `.extend()` to add fields, `.omit()` to drop them, `.required({ author: true })` to
 * promote an optional field. `z.strictObject` rejects unknown keys outright, keeping
 * unexpected payload fields from ever reaching storage.
 */
export function createCommentSchema(options: CommentSchemaOptions = {}) {
  const {
    minContentLength = 1,
    maxContentLength = 5000,
    maxAuthorLength = 64,
    maxUrlLength = 2048,
    allowedUrlProtocols = DEFAULT_URL_PROTOCOLS,
  } = options;

  return z.strictObject({
    content: z
      .string()
      .trim()
      .min(minContentLength, `Comment must be at least ${minContentLength} character(s).`)
      .max(maxContentLength, `Comment must be at most ${maxContentLength} characters.`)
      .refine(hasNoControlCharacters, 'Comment must not contain control characters.'),
    author: z
      .string()
      .trim()
      .min(1, 'Author name must not be empty.')
      .max(maxAuthorLength, `Author name must be at most ${maxAuthorLength} characters.`)
      .refine(hasNoControlCharacters, 'Author name must not contain control characters.')
      .optional(),
    email: z.email('Author email is not a valid address.').max(254).optional(),
    url: z
      .url({
        protocol: toProtocolPattern(allowedUrlProtocols),
        error: 'Author URL is not an accepted absolute URL.',
      })
      .max(maxUrlLength)
      .optional(),
    parentId: z
      .string()
      .regex(IDENTIFIER_PATTERN, 'Parent comment id must be a short base64url-safe identifier.')
      .optional(),
  });
}

export const commentSchema = createCommentSchema();

export type CommentSchema = ReturnType<typeof createCommentSchema>;
export type CommentInput = z.infer<CommentSchema>;
