import {test} from 'node:test';
import assert from 'node:assert/strict';
import * as cdk from 'aws-cdk-lib';
import {Template} from 'aws-cdk-lib/assertions';
import {AwsWebsiteCdnCdkStack} from '../lib/aws-website-cdn-cdk-stack.mjs';

// Vacuous until the distribution is brought under IaC (the cdk import); then it
// enforces that every CloudFront distribution keeps logging to the cloudfront/
// prefix that bin/analyze-logs ingests.
test('CloudFront distributions keep access logging to the cloudfront/ prefix', () => {
  const stack = new AwsWebsiteCdnCdkStack(new cdk.App(), 'Test');
  const template = Template.fromStack(stack);

  for (const [logicalId, resource] of Object.entries(template.findResources('AWS::CloudFront::Distribution'))) {
    const logging = resource.Properties?.DistributionConfig?.Logging;
    assert.ok(logging, `${logicalId}: access logging must be enabled`);
    assert.equal(logging.Prefix, 'cloudfront/', `${logicalId}: log prefix must be cloudfront/`);
  }
});
