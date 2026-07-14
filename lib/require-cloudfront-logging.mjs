import {Annotations, Stack} from 'aws-cdk-lib';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as logs from 'aws-cdk-lib/aws-logs';

// Guardrail: a distribution that synthesizes without access logging silently
// loses traffic data (cf. the 2026-05-27..05-30 gap). Fail synth, don't deploy one.
// Both streams are required until the v2 cutover retires legacy.
export class RequireCloudFrontLogging {
  visit(node) {
    if (!(node instanceof cloudfront.CfnDistribution)) return;
    const cfg = node.distributionConfig;
    const logging = cfg && typeof cfg === 'object' ? cfg.logging : undefined;
    if (!logging) {
      Annotations.of(node).addError('CloudFront access logging must stay enabled (distributionConfig.logging is missing).');
    }
    const hasV2 = Stack.of(node)
      .node.findAll()
      .some((n) => n instanceof logs.CfnDeliverySource && n.logType === 'ACCESS_LOGS');
    if (!hasV2) {
      Annotations.of(node).addError('CloudFront access logging must stay enabled (no ACCESS_LOGS delivery source for standard logging v2).');
    }
  }
}
