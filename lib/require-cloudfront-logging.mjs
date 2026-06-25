import {Annotations} from 'aws-cdk-lib';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';

// Guardrail: a distribution that synthesizes without access logging silently
// loses traffic data (cf. the 2026-05-27..05-30 gap). Fail synth, don't deploy one.
export class RequireCloudFrontLogging {
  visit(node) {
    if (!(node instanceof cloudfront.CfnDistribution)) return;
    const cfg = node.distributionConfig;
    const logging = cfg && typeof cfg === 'object' ? cfg.logging : undefined;
    if (!logging) {
      Annotations.of(node).addError('CloudFront access logging must stay enabled (distributionConfig.logging is missing).');
    }
  }
}
