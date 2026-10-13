import {test} from 'node:test';
import assert from 'node:assert/strict';
import * as cdk from 'aws-cdk-lib';
import {Template} from 'aws-cdk-lib/assertions';
import {AwsWebsiteCdnCdkStack} from '../lib/aws-website-cdn-cdk-stack.mjs';

// Why the order matters: the comment on normalizeFn.addDependency in the stack.
test('the viewer-request function updates after the origin Lambda', () => {
  const template = Template.fromStack(new AwsWebsiteCdnCdkStack(new cdk.App(), 'Test'));
  const origins = Object.entries(template.findResources('AWS::Lambda::Function')).filter(([, r]) => r.Properties?.Environment?.Variables?.EXPECTED_SECRET);
  assert.equal(origins.length, 1);
  const functions = Object.values(template.findResources('AWS::CloudFront::Function'));
  assert.equal(functions.length, 1);
  assert.ok(functions[0].DependsOn?.includes(origins[0][0]), 'the CloudFront Function must DependsOn the origin Lambda');
});
