import {test} from 'node:test';
import assert from 'node:assert/strict';
import * as cdk from 'aws-cdk-lib';
import {Template} from 'aws-cdk-lib/assertions';
import {AwsWebsiteCdnCdkStack} from '../lib/aws-website-cdn-cdk-stack.mjs';

// Locks the logging guardrail: every CloudFront distribution must keep access
// logging to the cloudfront/ prefix bin/analyze-logs ingests.
test('CloudFront distributions keep access logging to the cloudfront/ prefix', () => {
  const stack = new AwsWebsiteCdnCdkStack(new cdk.App(), 'Test');
  const template = Template.fromStack(stack);

  for (const [logicalId, resource] of Object.entries(template.findResources('AWS::CloudFront::Distribution'))) {
    const logging = resource.Properties?.DistributionConfig?.Logging;
    assert.ok(logging, `${logicalId}: access logging must be enabled`);
    assert.equal(logging.Prefix, 'cloudfront/', `${logicalId}: log prefix must be cloudfront/`);
  }
});

// The ingested set (tools/analyze-logs/ingest.mjs FIELD) + c-country/asn.
// Exact match doubles as the PII lock: cs-uri-query, cs(Cookie), and
// x-forwarded-for must never enter the selection.
const V2_RECORD_FIELDS = [
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
];

test('standard logging v2 delivers the PII-free field set to the cloudfront-v2/ prefix', () => {
  const stack = new AwsWebsiteCdnCdkStack(new cdk.App(), 'Test');
  const template = Template.fromStack(stack);

  template.resourceCountIs('AWS::Logs::DeliverySource', 1);
  template.hasResourceProperties('AWS::Logs::DeliverySource', {LogType: 'ACCESS_LOGS'});
  template.hasResourceProperties('AWS::Logs::DeliveryDestination', {
    OutputFormat: 'w3c',
    DestinationResourceArn: 'arn:aws:s3:::www.lazutkin.com-logs/cloudfront-v2',
  });

  const deliveries = Object.values(template.findResources('AWS::Logs::Delivery'));
  assert.equal(deliveries.length, 1, 'exactly one v2 delivery');
  assert.deepEqual(deliveries[0].Properties.RecordFields, V2_RECORD_FIELDS);
  assert.equal(deliveries[0].Properties.FieldDelimiter, '\t');
});
