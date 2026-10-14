import {test, before, beforeEach, after} from 'node:test';
import assert from 'node:assert/strict';
import * as cdk from 'aws-cdk-lib';
import {Template} from 'aws-cdk-lib/assertions';
import * as s3 from '@aws-sdk/client-s3';
import {AwsWebsiteCdnCdkStack} from '../lib/aws-website-cdn-cdk-stack.mjs';

// A missing key must read as a miss (404, silent) and a denied one as an error (403, logged).
// S3 returns 404 for a missing key only to a caller holding s3:ListBucket; without it, 403.
// S3 is mocked as in head.test.mjs; console.error is collected.

const SECRET = 'test-secret';

const HEAD_TABLE = {
  'blog/post/index.html': {ContentType: 'text/html', ContentLength: 1000, ETag: '"p"', LastModified: new Date('2026-10-13T00:00:00Z')},
  'denied.css': {ContentType: 'text/css', ContentLength: 1000, ETag: '"d"', LastModified: new Date('2026-10-13T00:00:00Z')},
};

const DENIED = new Set(['denied.css.br', 'locked']);

let handler;
let originalSend;
let originalError;
let logged;

const installMock = () => {
  logged = [];
  console.error = (...args) => logged.push(args);
  s3.S3Client.prototype.send = async function (command) {
    const key = command.input.Key;
    if (DENIED.has(key)) {
      throw new s3.S3ServiceException({name: 'Unknown', $fault: 'client', message: 'UnknownError', $metadata: {httpStatusCode: 403}});
    }
    if (command instanceof s3.HeadObjectCommand) {
      if (key in HEAD_TABLE) return HEAD_TABLE[key];
      throw new s3.NotFound({message: 'UnknownError', $metadata: {httpStatusCode: 404}});
    }
    if (command instanceof s3.GetObjectCommand) {
      const bytes = new Uint8Array(Buffer.from(`BODY:${key}`));
      return {Body: {transformToByteArray: async () => bytes}};
    }
    throw new Error(`unexpected command ${command.constructor.name}`);
  };
};

const event = (path, headers = {}) => ({
  httpMethod: 'GET',
  path,
  headers: {'x-origin-verify': SECRET, ...headers},
});

before(async () => {
  process.env.EXPECTED_SECRET = SECRET;
  process.env.BUCKET = 'test-bucket';
  ({handler} = await import('../lambda/index.mjs'));
  originalSend = s3.S3Client.prototype.send;
  originalError = console.error;
});
beforeEach(installMock);
after(() => {
  s3.S3Client.prototype.send = originalSend;
  console.error = originalError;
});

test('the origin Lambda may list the bucket, so a missing key is a 404', () => {
  const template = Template.fromStack(new AwsWebsiteCdnCdkStack(new cdk.App(), 'Test'));
  const statements = Object.values(template.findResources('AWS::IAM::Policy')).flatMap((p) => p.Properties.PolicyDocument.Statement);
  const list = statements.filter((s) => s.Action === 's3:ListBucket' && s.Effect === 'Allow');
  assert.equal(list.length, 1);
  const resource = JSON.stringify(list[0].Resource);
  assert.ok(resource.includes(':s3:::www.lazutkin.com'), resource);
  assert.ok(!resource.includes('/*'), 'ListBucket applies to the bucket, not its objects');
});

test('a page reached through misses logs nothing', async () => {
  const res = await handler(event('/blog/post', {'x-cache-variant': 'bgz'}));
  assert.equal(res.statusCode, 200);
  assert.deepEqual(logged, []);
});

test('an unknown page is a 404 and logs nothing', async () => {
  const res = await handler(event('/no/such/page', {'x-cache-variant': 'bgz'}));
  assert.equal(res.statusCode, 404);
  assert.deepEqual(logged, []);
});

test('a denied variant probe is logged, and the original is served', async () => {
  const res = await handler(event('/denied.css', {'x-cache-variant': 'b'}));
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers['Content-Encoding'], undefined);
  assert.equal(logged.length, 1);
  assert.match(logged[0][0], /^Error checking variant/);
});

test('a denied lookup is logged', async () => {
  const res = await handler(event('/locked'));
  assert.equal(res.statusCode, 404);
  assert.equal(logged.length, 1);
  assert.match(logged[0][0], /^Error checking original object/);
});
