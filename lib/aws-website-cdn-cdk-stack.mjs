import * as cdk from 'aws-cdk-lib';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import {NodejsFunction} from 'aws-cdk-lib/aws-lambda-nodejs';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import {RequireCloudFrontLogging} from './require-cloudfront-logging.mjs';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as route53 from 'aws-cdk-lib/aws-route53';
import {readFileSync} from 'node:fs';

export class AwsWebsiteCdnCdkStack extends cdk.Stack {
  constructor(scope, id, props) {
    super(scope, id, props);

    const bucket = s3.Bucket.fromBucketName(this, 'aws-website-cdn-cdk-bucket', 'www.lazutkin.com');
    const expectedSecret = ssm.StringParameter.valueForStringParameter(this, '/blog/origin-verify');
    // The ACM cert is external to this stack (pre-existing, us-east-1). Its ARN carries the
    // account id, so it's read from SSM (same mechanism as the secret) rather than hardcoded.
    const certArn = ssm.StringParameter.valueForStringParameter(this, '/blog/cert-arn');

    const fn = new NodejsFunction(this, 'aws-website-cdn-cdk', {
      runtime: lambda.Runtime.NODEJS_LATEST,
      entry: 'lambda/index.mjs',
      environment: {
        BUCKET: bucket.bucketName,
        PREFIX: '/',
        CACHE_PERIOD: String(60 * 60 * 24 * 3), // 3d
        EXPECTED_SECRET: expectedSecret,
      },
      bundling: {
        minify: true,
        sourceMap: true,
      },
      logGroup: new logs.LogGroup(this, 'aws-website-cdn-cdk-logs', {
        retention: logs.RetentionDays.ONE_MONTH,
        removalPolicy: cdk.RemovalPolicy.RETAIN,
      }),
      reservedConcurrentExecutions: 100,
    });
    fn.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ['s3:GetObject'],
        resources: [bucket.arnForObjects('*')],
      }),
    );

    const api = new apigateway.RestApi(this, 'aws-website-cdn-cdk-endpoint', {
      restApiName: 'aws-website-cdn-cdk-api',
      description: 'Micro AWS Website CDN with CDK API for serving static website content via CloudFront',
      binaryMediaTypes: ['*/*'],
    });

    const proxyResource = api.root.addProxy({
      defaultIntegration: new apigateway.LambdaIntegration(fn),
      anyMethod: false,
      defaultCorsPreflightOptions: {
        allowOrigins: apigateway.Cors.ALL_ORIGINS,
        allowMethods: ['GET', 'HEAD', 'OPTIONS'],
        allowHeaders: apigateway.Cors.DEFAULT_HEADERS,
      },
    });
    proxyResource.addMethod('GET', new apigateway.LambdaIntegration(fn));
    // HEAD needs an explicit method (anyMethod is false); without it API Gateway
    // 403s HEAD before the Lambda, even though CloudFront forwards GET+HEAD.
    proxyResource.addMethod('HEAD', new apigateway.LambdaIntegration(fn));

    // Viewer-request CloudFront Function (cf/normalize.js): 301s any non-canonical Host to
    // www.lazutkin.com, then writes the x-cache-variant cache-key token, prepended to the key
    // allowlist below (Tier 1, live since 2026-07-01). One function — CloudFront allows a
    // single viewer-request association per behavior, so the redirect lives with the token.
    // Design: projects/aws-website-cdn-cdk/decisions § Tier 1.
    const normalizeFn = new cloudfront.CfnFunction(this, 'aws-website-cdn-cdk-normalize', {
      name: 'aws-website-cdn-cdk-normalize',
      autoPublish: true,
      functionConfig: {
        comment: 'Canonical-host 301 + Accept/Accept-Encoding → x-cache-variant cache-key token',
        runtime: 'cloudfront-js-2.0',
      },
      functionCode: readFileSync(new URL('../cf/normalize.js', import.meta.url), 'utf8'),
    });

    // includeSubdomains stays false on purpose: CAA/HSTS inherit down, and
    // christi.lazutkin.com is Christina's Cargo-hosted site — no per-subdomain
    // override exists (it's a CNAME), so binding it here would be permanent.
    // preload likewise off: submission is effectively irreversible.
    const securityHeaders = new cloudfront.CfnResponseHeadersPolicy(this, 'aws-website-cdn-cdk-headers', {
      responseHeadersPolicyConfig: {
        name: 'aws-website-cdn-cdk-security-headers',
        comment: 'HSTS (apex-only by design) + nosniff/referrer/frame',
        securityHeadersConfig: {
          strictTransportSecurity: {
            accessControlMaxAgeSec: 31536000, // 1 year
            includeSubdomains: false,
            preload: false,
            override: true,
          },
          contentTypeOptions: {override: true}, // nosniff
          referrerPolicy: {referrerPolicy: 'strict-origin-when-cross-origin', override: true},
          frameOptions: {frameOption: 'DENY', override: true},
        },
      },
    });

    // Adopt the existing distribution via `cdk import` (NOT deploy
    // — it owns the www.lazutkin.com alias, so a fresh create fails CNAMEAlreadyExists).
    // Mirrors the live config field-for-field; verified a clean no-op import.
    const distribution = new cloudfront.CfnDistribution(this, 'aws-website-cdn-cdk-distribution', {
      distributionConfig: {
        enabled: true,
        // .org/.net exist only to redirect here; normalize.js 301s every
        // non-canonical host to www.lazutkin.com. The cert in SSM
        // /blog/cert-arn must carry all six or CloudFront rejects the update.
        aliases: ['www.lazutkin.com', 'lazutkin.com', 'www.lazutkin.org', 'lazutkin.org', 'www.lazutkin.net', 'lazutkin.net'],
        defaultRootObject: 'index.html',
        priceClass: 'PriceClass_All',
        httpVersion: 'http2and3',
        ipv6Enabled: true,

        origins: [
          {
            id: 'S3-www.lazutkin.com',
            domainName: `${api.restApiId}.execute-api.${this.region}.amazonaws.com`, // this stack's API Gateway
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
          functionAssociations: [{eventType: 'viewer-request', functionArn: normalizeFn.attrFunctionArn}],
          responseHeadersPolicyId: securityHeaders.attrId,
          // Cache key = x-cache-variant (the edge-computed token) + Accept + Accept-Encoding,
          // the variant-negotiation axes. NOT Origin/Referer: legacy ForwardedValues keys on
          // whatever it forwards, so those two shredded the cache (~60% HTML miss) for zero
          // use. Don't re-add for CORS.
          forwardedValues: {
            queryString: false,
            cookies: {forward: 'none'},
            headers: ['x-cache-variant', 'Accept', 'Accept-Encoding'],
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
          acmCertificateArn: certArn,
          sslSupportMethod: 'sni-only',
          minimumProtocolVersion: 'TLSv1.2_2021',
        },
      },
    });
    // `cdk import` stamps DeletionPolicy: Retain on the adopted distribution; codify
    // it so a stack delete never nukes the live CDN (and the post-import diff is clean).
    distribution.cfnOptions.deletionPolicy = cdk.CfnDeletionPolicy.RETAIN;

    // Standard logging v2 (CloudWatch vended-log delivery) — the only access-log
    // stream since the 2026-07-14 ingest cutover retired legacy. Prefix rides in
    // the destination ARN; outputFormat is frozen at creation — delete + recreate
    // to change it.
    const deliverySource = new logs.CfnDeliverySource(this, 'aws-website-cdn-cdk-access-logs-source', {
      name: 'aws-website-cdn-cdk-access-logs',
      logType: 'ACCESS_LOGS',
      resourceArn: `arn:aws:cloudfront::${this.account}:distribution/${distribution.ref}`,
    });
    const deliveryDestination = new logs.CfnDeliveryDestination(this, 'aws-website-cdn-cdk-access-logs-destination', {
      name: 'aws-website-cdn-cdk-access-logs-s3',
      outputFormat: 'w3c',
      destinationResourceArn: 'arn:aws:s3:::www.lazutkin.com-logs/cloudfront-v2',
    });
    const delivery = new logs.CfnDelivery(this, 'aws-website-cdn-cdk-access-logs-delivery', {
      deliverySourceName: deliverySource.name,
      deliveryDestinationArn: deliveryDestination.attrArn,
      fieldDelimiter: '\t',
      // The bin/analyze-logs ingested set + c-country/asn; cs-uri-query, cs(Cookie),
      // and x-forwarded-for are excluded at the source (no PII at rest).
      recordFields: [
        'date',
        'time',
        'x-edge-location',
        'sc-bytes',
        'c-ip',
        'cs-method',
        'cs-uri-stem',
        'sc-status',
        'cs(Referer)',
        'cs(User-Agent)',
        'x-edge-result-type',
        'x-host-header',
        'ssl-protocol',
        'time-to-first-byte',
        'c-country',
        'asn',
      ],
    });
    delivery.addDependency(deliverySource);

    // DNS hardening (2026-08-09). The zones are console-created; these records are the
    // stack's first DNS resources — new names only, nothing already in the zones.
    const zones = {
      com: route53.HostedZone.fromHostedZoneAttributes(this, 'zone-com', {
        hostedZoneId: 'Z05488271JEDVL69AQCTB',
        zoneName: 'lazutkin.com',
      }),
      org: route53.HostedZone.fromHostedZoneAttributes(this, 'zone-org', {
        hostedZoneId: 'Z015963524IXVK1ORRVDI',
        zoneName: 'lazutkin.org',
      }),
      net: route53.HostedZone.fromHostedZoneAttributes(this, 'zone-net', {
        hostedZoneId: 'Z0775713UXD3R8FNHR89',
        zoneName: 'lazutkin.net',
      }),
    };

    // .org/.net never handle mail — null MX (RFC 7505) + SPF fail-all + DMARC reject,
    // mirroring apodictum.com.
    for (const tld of ['org', 'net']) {
      new route53.MxRecord(this, `mx-null-${tld}`, {
        zone: zones[tld],
        values: [{priority: 0, hostName: '.'}],
      });
      new route53.TxtRecord(this, `spf-${tld}`, {zone: zones[tld], values: ['v=spf1 -all']});
      new route53.TxtRecord(this, `dmarc-${tld}`, {
        zone: zones[tld],
        recordName: '_dmarc',
        values: ['v=DMARC1; p=reject; sp=reject; adkim=s; aspf=s'],
      });
    }
    // .com does send (forwardemail SPF include) — monitor first, tighten after clean reports.
    new route53.TxtRecord(this, 'dmarc-com', {
      zone: zones.com,
      recordName: '_dmarc',
      values: ['v=DMARC1; p=none; rua=mailto:eugene.lazutkin@gmail.com'],
    });

    // DNSSEC for .org/.net, reusing the .com KSK's KMS key (Route 53 KSKs must be us-east-1).
    // The registry DS half is a Route 53 Domains call, run manually after deploy.
    for (const tld of ['org', 'net']) {
      const ksk = new route53.CfnKeySigningKey(this, `ksk-${tld}`, {
        hostedZoneId: zones[tld].hostedZoneId,
        keyManagementServiceArn: `arn:aws:kms:us-east-1:${this.account}:key/df395a7a-8b19-44c6-8f28-e734cf299003`,
        name: `lazutkin_${tld}_ksk`,
        status: 'ACTIVE',
      });
      const dnssec = new route53.CfnDNSSEC(this, `dnssec-${tld}`, {hostedZoneId: zones[tld].hostedZoneId});
      dnssec.addDependency(ksk);
    }

    cdk.Aspects.of(this).add(new RequireCloudFrontLogging());
  }
}
