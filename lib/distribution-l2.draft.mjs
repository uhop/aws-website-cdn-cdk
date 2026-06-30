// ─────────────────────────────────────────────────────────────────────────────
// PHASE 2 (optional) — modernize the imported distribution to L2 constructs.
//
// Apply ONLY AFTER the L1 import (distribution.draft.mjs) has adopted
// E34PYR2RAH8SD6 into the stack. Unlike the L1 import, this is a real in-place
// UPDATE: it swaps legacy `ForwardedValues` for an equivalent managed
// `CachePolicy`. Not wired into bin/ — paste it in deliberately, REPLACING the
// L1 CfnDistribution block, once you're ready to modernize.
//
// COST: unchanged. A CachePolicy is free, and the cache key is identical, so the
//   origin-hit ratio (hence data-transfer/request cost) doesn't move.
//
// BEHAVIOR: equivalent ONLY IF the cache key matches. VALIDATE after deploy that
//   Accept / Accept-Encoding variant negotiation still serves br / gz / zst and
//   webp / avif correctly. CloudFront must forward the RAW Accept-Encoding — that
//   is why enableAcceptEncodingGzip/Brotli are deliberately NOT set below;
//   turning them on collapses Accept-Encoding to gzip/br and would hide zstd.
//
// CRITICAL — logical id MUST match the imported distribution, or CloudFormation
//   does a DELETE + CREATE (CNAME alias conflict on www.lazutkin.com + downtime).
//   After the L1 import, read the distribution's logical id from `cdk synth`
//   (or the deployed template) and pin it in overrideLogicalId() below.
// ─────────────────────────────────────────────────────────────────────────────

import * as cdk from 'aws-cdk-lib';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as s3 from 'aws-cdk-lib/aws-s3';

// --- paste inside the stack constructor, REPLACING the L1 CfnDistribution ---

const logBucket = s3.Bucket.fromBucketName(this, 'cf-log-bucket', 'www.lazutkin.com-logs');

const cert = acm.Certificate.fromCertificateArn(this, 'cf-cert', 'arn:aws:acm:us-east-1:514551178298:certificate/c768d9f3-346b-4403-978c-a1b541e5e9bc');

// Replicates the live ForwardedValues cache key (Accept + Accept-Encoding only;
// Origin/Referer dropped 2026-06-30). Raw Accept-Encoding is intentional — see
// header note (zstd/avif selection needs the unnormalized value).
const cachePolicy = new cloudfront.CachePolicy(this, 'cf-cache-policy', {
  cachePolicyName: 'lazutkin-blog-negotiation',
  comment: 'Accept/Accept-Encoding in cache key (variant negotiation)',
  minTtl: cdk.Duration.seconds(0),
  defaultTtl: cdk.Duration.seconds(86400), // 1 day
  maxTtl: cdk.Duration.seconds(31536000), // 1 year
  headerBehavior: cloudfront.CacheHeaderBehavior.allowList('Accept', 'Accept-Encoding'),
  queryStringBehavior: cloudfront.CacheQueryStringBehavior.none(),
  cookieBehavior: cloudfront.CacheCookieBehavior.none(),
});

const distribution = new cloudfront.Distribution(this, 'aws-website-cdn-cdk-distribution', {
  comment: 'lazutkin.com blog — API Gateway origin + Accept/Accept-Encoding negotiation',
  domainNames: ['www.lazutkin.com'],
  certificate: cert,
  defaultRootObject: 'index.html',
  priceClass: cloudfront.PriceClass.PRICE_CLASS_ALL,
  httpVersion: cloudfront.HttpVersion.HTTP2,
  enableIpv6: true,
  minimumProtocolVersion: cloudfront.SecurityPolicyProtocol.TLS_V1_2_2021,

  // ── the point of the exercise: logging lives in IaC ──
  // Legacy standard logging → existing www.lazutkin.com-logs, same prefix
  // bin/analyze-logs ingests. Free; only S3 storage (which you already pay).
  enableLogging: true,
  logBucket,
  logFilePrefix: 'cloudfront/',
  logIncludesCookies: false,

  defaultBehavior: {
    // RestApiOrigin defaults match the live origin: https-only, TLSv1.2,
    // readTimeout 30s, keepalive 5s, originPath '/<stage>' (= '/prod').
    origin: new origins.RestApiOrigin(api, {
      customHeaders: {'x-origin-verify': expectedSecret}, // SSM /blog/origin-verify
    }),
    viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
    allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD,
    cachePolicy,
    compress: true,
  },

  errorResponses: [{httpStatus: 404, responsePagePath: '/404.html', responseHttpStatus: 404, ttl: cdk.Duration.seconds(300)}],
});

// Keep the imported distribution's logical id so this is an in-place UPDATE,
// not a destroy + recreate. Replace the placeholder with the real id from the
// post-import template (`cdk synth` after the L1 import lands).
distribution.node.defaultChild.overrideLogicalId('REPLACE_WITH_IMPORTED_DISTRIBUTION_LOGICAL_ID');
