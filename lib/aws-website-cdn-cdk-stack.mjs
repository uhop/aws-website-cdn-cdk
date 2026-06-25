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

export class AwsWebsiteCdnCdkStack extends cdk.Stack {
  constructor(scope, id, props) {
    super(scope, id, props);

    const bucket = s3.Bucket.fromBucketName(this, 'aws-website-cdn-cdk-bucket', 'www.lazutkin.com');
    const expectedSecret = ssm.StringParameter.valueForStringParameter(this, '/blog/origin-verify');

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
      reservedConcurrentExecutions: 10,
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
        allowMethods: ['GET', 'OPTIONS'],
        allowHeaders: apigateway.Cors.DEFAULT_HEADERS,
      },
    });
    proxyResource.addMethod('GET', new apigateway.LambdaIntegration(fn));

    // Adopt the existing distribution E34PYR2RAH8SD6 via `cdk import` (NOT deploy
    // — it owns the www.lazutkin.com alias, so a fresh create fails CNAMEAlreadyExists).
    // Mirrors the live config field-for-field; verified a clean no-op import.
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

    cdk.Aspects.of(this).add(new RequireCloudFrontLogging());
  }
}
