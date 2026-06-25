// ─────────────────────────────────────────────────────────────────────────────
// DRAFT — bring the CloudFront distribution under IaC (currently out-of-band).
//
// This file is intentionally NOT wired into bin/aws-website-cdn-cdk.js, so a
// stray `cdk deploy` cannot act on it. It is the proposed target to ADOPT the
// existing distribution E34PYR2RAH8SD6 via `cdk import` — NOT to deploy fresh.
//
// WHY import, not deploy:
//   The distribution already exists and owns the `www.lazutkin.com` alias. A
//   `cdk deploy` would try to CREATE a second distribution and fail with
//   CNAMEAlreadyExists. `cdk import` adopts the existing physical resource with
//   no recreate, no downtime, and NO change to the bill — CloudFront billing is
//   traffic-based and independent of the management tool. Logging stays legacy
//   standard logging to S3 (free; you pay only the S3 storage you already pay).
//
// WHY L1 (CfnDistribution) and not the friendlier L2 Distribution construct:
//   The live distribution uses legacy `ForwardedValues` — cache key =
//   Accept, Accept-Encoding, Origin, Referer (no query string, no cookies),
//   TTLs 0 / 86400 / 31536000. That cache key is load-bearing: Accept /
//   Accept-Encoding are what make the per-variant negotiation work. The L2
//   construct cannot express ForwardedValues (it always emits a CachePolicy),
//   so an L2 representation would NOT match the live resource and `cdk import`
//   would not be a clean no-op. This L1 config mirrors the live distribution
//   field-for-field, so the import is a true no-op: zero behavior change, zero
//   cost change. (Modernizing to a CachePolicy later is a separate, optional,
//   behavior-equivalent step — do it deliberately and verify negotiation.)
//
// ADOPTION RUNBOOK (you run these — outward-facing infra is yours):
//   1. Paste the `new cloudfront.CfnDistribution(...)` block below into the
//      stack constructor in lib/aws-website-cdn-cdk-stack.mjs, and
//      `import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';`.
//   2. `cdk diff` — confirm the ONLY change is an added (to-be-imported)
//      distribution; nothing else is modified.
//   3. `cdk import` — when prompted for the resource's physical id, give the
//      distribution id: E34PYR2RAH8SD6. CloudFormation adopts it in place.
//   4. `cdk diff` again — it must report NO changes. If it shows drift, a field
//      below doesn't match the live config; reconcile before any `cdk deploy`.
//   The secret header value is read from SSM (/blog/origin-verify), never
//   hardcoded — same source the Lambda already uses.
// ─────────────────────────────────────────────────────────────────────────────

import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';

// --- paste inside the stack constructor, AFTER `api` and `expectedSecret` ---
//
// const expectedSecret = ssm.StringParameter.valueForStringParameter(this, '/blog/origin-verify');
// const apiDomain = `${api.restApiId}.execute-api.${cdk.Stack.of(this).region}.amazonaws.com`;
// (Or keep the literal live origin domain below for a byte-exact import, then
//  switch to the api-derived form once imported and verified.)

new cloudfront.CfnDistribution(this, 'aws-website-cdn-cdk-distribution', {
  distributionConfig: {
    enabled: true,
    aliases: ['www.lazutkin.com'],
    defaultRootObject: 'index.html',
    priceClass: 'PriceClass_All',
    httpVersion: 'http2',
    ipv6Enabled: true,

    origins: [
      {
        id: 'S3-www.lazutkin.com',
        domainName: '2hht94pt7g.execute-api.us-east-1.amazonaws.com', // == this stack's API Gateway
        originPath: '/prod',
        customOriginConfig: {
          httpPort: 80,
          httpsPort: 443,
          originProtocolPolicy: 'https-only',
          originSslProtocols: ['TLSv1.2'],
          originReadTimeout: 30,
          originKeepaliveTimeout: 5,
        },
        originCustomHeaders: [
          {headerName: 'x-origin-verify', headerValue: expectedSecret}, // SSM /blog/origin-verify
        ],
      },
    ],

    defaultCacheBehavior: {
      targetOriginId: 'S3-www.lazutkin.com',
      viewerProtocolPolicy: 'redirect-to-https',
      allowedMethods: ['GET', 'HEAD'],
      cachedMethods: ['GET', 'HEAD'],
      compress: true,
      minTtl: 0,
      defaultTtl: 86400, // 1 day
      maxTtl: 31536000, // 1 year
      // Legacy ForwardedValues — the load-bearing cache key for variant negotiation.
      forwardedValues: {
        queryString: false,
        cookies: {forward: 'none'},
        headers: ['Accept', 'Accept-Encoding', 'Origin', 'Referer'],
      },
    },

    customErrorResponses: [
      {
        errorCode: 404,
        responsePagePath: '/404.html',
        responseCode: 404,
        errorCachingMinTtl: 300,
      },
    ],

    viewerCertificate: {
      acmCertificateArn: 'arn:aws:acm:us-east-1:514551178298:certificate/c768d9f3-346b-4403-978c-a1b541e5e9bc',
      sslSupportMethod: 'sni-only',
      minimumProtocolVersion: 'TLSv1.2_2021',
    },

    // ── the whole point of this exercise: logging is now in IaC ──
    // Legacy standard logging → existing www.lazutkin.com-logs bucket, same
    // `cloudfront/` prefix bin/analyze-logs ingests. Free; only S3 storage.
    logging: {
      bucket: 'www.lazutkin.com-logs.s3.amazonaws.com',
      includeCookies: false,
      prefix: 'cloudfront/',
    },
  },
});
