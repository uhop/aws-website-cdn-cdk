import {test} from 'node:test';
import {Template} from 'aws-cdk-lib/assertions';
import {AwsWebsiteCdnCdkStack} from '../lib/aws-website-cdn-cdk-stack.mjs';
import {makeApp} from './helpers/cdk-app.mjs';

// Fails when tests lose cdk.json's flags: a bare App adds this account-wide resource and its
// role, which @aws-cdk/aws-apigateway:disableCloudWatchRole keeps out of a deploy.
test('tests synthesize with the feature flags a deploy uses', () => {
  const template = Template.fromStack(new AwsWebsiteCdnCdkStack(makeApp(), 'Test'));
  template.resourceCountIs('AWS::ApiGateway::Account', 0);
});
