import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Template} from 'aws-cdk-lib/assertions';
import {AwsWebsiteCdnCdkStack} from '../lib/aws-website-cdn-cdk-stack.mjs';
import {makeApp} from './helpers/cdk-app.mjs';

const template = Template.fromStack(new AwsWebsiteCdnCdkStack(makeApp(), 'Test'));
const behavior = Object.values(template.findResources('AWS::CloudFront::Distribution'))[0].Properties.DistributionConfig.DefaultCacheBehavior;

test('the x-cache-variant token alone keys the cache', () => {
  const policies = Object.entries(template.findResources('AWS::CloudFront::CachePolicy'));
  assert.equal(policies.length, 1);
  const [id, policy] = policies[0];
  assert.deepEqual(behavior.CachePolicyId, {'Fn::GetAtt': [id, 'Id']});
  assert.equal(behavior.ForwardedValues, undefined);
  assert.deepEqual(policy.Properties.CachePolicyConfig.ParametersInCacheKeyAndForwardedToOrigin, {
    EnableAcceptEncodingGzip: true,
    EnableAcceptEncodingBrotli: true,
    HeadersConfig: {HeaderBehavior: 'whitelist', Headers: ['x-cache-variant']},
    CookiesConfig: {CookieBehavior: 'none'},
    QueryStringsConfig: {QueryStringBehavior: 'none'},
  });
});

test('the cache lifetimes and compression carry over from the legacy settings', () => {
  const [policy] = Object.values(template.findResources('AWS::CloudFront::CachePolicy'));
  const {MinTTL, DefaultTTL, MaxTTL} = policy.Properties.CachePolicyConfig;
  assert.deepEqual({MinTTL, DefaultTTL, MaxTTL}, {MinTTL: 0, DefaultTTL: 86400, MaxTTL: 31536000});
  assert.equal(behavior.Compress, true);
});

// Without the function there is no token, so every client shares one cache entry and some
// get an encoding they cannot read. This stands in for the raw headers the key dropped.
test('the viewer-request function stays on the behavior', () => {
  const functions = Object.keys(template.findResources('AWS::CloudFront::Function'));
  assert.equal(functions.length, 1);
  assert.deepEqual(behavior.FunctionAssociations, [{EventType: 'viewer-request', FunctionARN: {'Fn::GetAtt': [functions[0], 'FunctionARN']}}]);
});
