import * as cdk from 'aws-cdk-lib';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import {NodejsFunction} from 'aws-cdk-lib/aws-lambda-nodejs';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as iam from 'aws-cdk-lib/aws-iam';

export class AwsWebsiteCdnCdkStack extends cdk.Stack {
  constructor(scope, id, props) {
    super(scope, id, props);

    const bucket = s3.Bucket.fromBucketName(this, 'aws-website-cdn-cdk-bucket', 'www.lazutkin.com');

    const fn = new NodejsFunction(this, 'aws-website-cdn-cdk', {
      runtime: lambda.Runtime.NODEJS_LATEST,
      entry: 'lambda/index.mjs',
      environment: {
        BUCKET: bucket.bucketName,
        PREFIX: '/',
        CACHE_PERIOD: String(60 * 60 * 24 * 3), // 3d
        DEPLOYMENT_TIME: new Date().toISOString(),
      },
      bundling: {
        minify: true,
        sourceMap: true,
      },
    });
    fn.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ['s3:GetObject*', 's3:HeadObject*'],
        resources: [bucket.bucketArn, `${bucket.bucketArn}/*`],
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
  }
}
