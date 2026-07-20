import {test} from 'node:test';
import assert from 'node:assert/strict';
import * as cdk from 'aws-cdk-lib';
import {Template} from 'aws-cdk-lib/assertions';
import {AwsWebsiteCdnCdkStack} from '../lib/aws-website-cdn-cdk-stack.mjs';

// Legacy standard logging was retired at the 2026-07-14 ingest cutover; v2 below
// is the only stream. Locks the retirement so it can't drift back and resume
// writing raw-IP logs to the cloudfront/ prefix nothing ingests any more.
test('CloudFront distributions carry no legacy access logging', () => {
  const stack = new AwsWebsiteCdnCdkStack(new cdk.App(), 'Test');
  const template = Template.fromStack(stack);

  for (const [logicalId, resource] of Object.entries(template.findResources('AWS::CloudFront::Distribution'))) {
    assert.equal(resource.Properties?.DistributionConfig?.Logging, undefined, `${logicalId}: legacy logging must stay retired`);
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
