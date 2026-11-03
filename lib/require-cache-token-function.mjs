import {Annotations} from 'aws-cdk-lib';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';

// The cache policy keys on the token this function writes. Without it every client shares one
// entry, and some get an encoding they cannot read. Fails synth, so a deploy stops here.
export class RequireCacheTokenFunction {
  visit(node) {
    if (!(node instanceof cloudfront.CfnDistribution)) return;
    const hasFunction = node.distributionConfig.defaultCacheBehavior.functionAssociations?.some((a) => a.eventType === 'viewer-request');
    if (hasFunction) return;
    Annotations.of(node).addError('The cache key needs the x-cache-variant token: the default behavior must keep its viewer-request function.');
  }
}
