// ─────────────────────────────────────────────────────────────────────────────
// DRAFT — wire the `x-cache-variant` normalization CloudFront Function into the
// distribution. NOT referenced by bin/ or the stack; paste into
// lib/aws-website-cdn-cdk-stack.mjs deliberately, then `cdk deploy` (yours to run).
//
// WHAT IT DOES
//   Adds a viewer-request CloudFront Function (code = lib/cf-normalize.draft.mjs) that
//   writes the `x-cache-variant` token, associates it on the default cache behavior,
//   and adds `x-cache-variant` to the cache-key header allowlist. Design + token spec:
//   lib/cf-normalize.draft.mjs and projects/aws-website-cdn-cdk/decisions § Tier 1.
//
// DEPLOY-SAFE STANDALONE (before the Lambda consumption branch ships)
//   Content stays correct without the Lambda change: the Lambda ignores the token and
//   falls back to raw headers — webp is still read from `Accept`, encodings from the
//   CloudFront-normalized `Accept-Encoding`. The cache is correctly bucketed by the
//   token. The ONLY thing that waits for the Lambda branch is zstd delivery (the token
//   is the only carrier that survives CloudFront's Accept-Encoding normalization).
//   So this can deploy first; expect a one-day re-warm (the key changes → old entries
//   orphan) and a briefly redundant cache (buckets that will diverge once zstd is served).
//
// APPLY
//   1. `import {readFileSync} from 'node:fs';` at the top of the stack (cloudfront is
//      already imported). Paste the CfnFunction block below BEFORE the CfnDistribution
//      (its ARN is referenced in the behavior).
//   2. In the CfnDistribution `defaultCacheBehavior`, add `functionAssociations` and
//      widen `forwardedValues.headers` — see the diff at the bottom.
//   3. `cdk diff` — expect exactly: +1 CfnFunction, and the distribution modified with
//      one added function association + one added cache-key header. Nothing else.
//   4. `aws cloudfront test-function` on the DEVELOPMENT stage with captured
//      Chrome / Firefox / Safari / curl headers; confirm the emitted `x-cache-variant`
//      matches the registry (e.g. Chrome → `bgwz`, Safari → `bgw`, curl → `g`).
//   5. `cdk deploy`. Measure hot-path hit ratio day+1 (learnings § hot-path).
//
// FUNCTION CODE = code-only slice, NOT the whole draft. CloudFront caps function code at
//   10 KB; the draft's banner is ~7.5 KB of spec (redundant with the vault decision), so
//   we ship only the executable slice between the `// ── begin function code ──` and
//   `// ── test seam` markers (~1.8 KB — huge headroom as reserved slots activate).
// ─────────────────────────────────────────────────────────────────────────────

import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import {readFileSync} from 'node:fs';

// --- paste inside the stack constructor, BEFORE `new cloudfront.CfnDistribution(...)` ---

// Sibling file read at synth; slice to the executable code (drop banner + ESM export).
// Markers are newline-anchored so the banner's own mentions of them don't match.
const normalizeCode = readFileSync(new URL('./cf-normalize.draft.mjs', import.meta.url), 'utf8')
  .split('\n// ── begin function code ──\n')[1]
  .split('\n// ── test seam')[0];

const normalizeFn = new cloudfront.CfnFunction(this, 'aws-website-cdn-cdk-normalize', {
  name: 'aws-website-cdn-cdk-normalize',
  autoPublish: true,
  functionConfig: {
    comment: 'Normalize Accept/Accept-Encoding into the x-cache-variant cache-key token',
    runtime: 'cloudfront-js-2.0',
  },
  functionCode: normalizeCode,
});

// --- then apply this diff to the existing CfnDistribution defaultCacheBehavior ---
//
//   defaultCacheBehavior: {
//     targetOriginId: 'S3-www.lazutkin.com',
//     viewerProtocolPolicy: 'redirect-to-https',
//     allowedMethods: ['GET', 'HEAD'],
//     cachedMethods: ['GET', 'HEAD'],
//     compress: true,
//     minTtl: 0,
//     defaultTtl: 86400,
//     maxTtl: 31536000,
// +   functionAssociations: [
// +     {eventType: 'viewer-request', functionArn: normalizeFn.attrFunctionArn},
// +   ],
//     forwardedValues: {
//       queryString: false,
//       cookies: {forward: 'none'},
// -     headers: ['Accept', 'Accept-Encoding'],
// +     // x-cache-variant is the real key dimension; Accept/Accept-Encoding stay as the
// +     // safety floor (function unassociated → degrade to raw-header keying, not collapse;
// +     // Accept is also stripped from the origin request if not whitelisted).
// +     headers: ['x-cache-variant', 'Accept', 'Accept-Encoding'],
//     },
//   },
