#!/home/linuxbrew/.linuxbrew/opt/node/bin/node

const cdk = require('aws-cdk-lib');
const {AwsWebsiteCdnCdkStack} = require('../lib/aws-website-cdn-cdk-stack.mjs');

const app = new cdk.App();

new AwsWebsiteCdnCdkStack(app, 'AwsWebsiteCdnCdkStack', {});
