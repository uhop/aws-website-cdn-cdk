import {test, before, beforeEach, after} from 'node:test';
import assert from 'node:assert/strict';
import * as cdk from 'aws-cdk-lib';
import {Template} from 'aws-cdk-lib/assertions';
import * as s3 from '@aws-sdk/client-s3';
import {AwsWebsiteCdnCdkStack} from '../lib/aws-website-cdn-cdk-stack.mjs';

// The origin Lambda holds s3:GetObject only (least privilege), so S3 answers a missing key
// with 403, and a HEAD error has no body: the SDK names it `Unknown`. A miss (403 or 404)
// must stay silent; any other error is logged. S3 is mocked as in head.test.mjs, its misses
// shaped like the real ones; console.error is collected.

const SECRET = 'test-secret';

const HEAD_TABLE = {
  'blog/post/index.html': {ContentType: 'text/html', ContentLength: 1000, ETag: '"p"', LastModified: new Date('2026-10-13T00:00:00Z')},
  'broken.css': {ContentType: 'text/css', ContentLength: 1000, ETag: '"b"', LastModified: new Date('2026-10-13T00:00:00Z')},
};

const NOT_FOUND = new Set(['legacy']);
const FAILING = new Set(['broken.css.br', 'unlucky']);

const s3Error = (status) =>
  new s3.S3ServiceException({name: 'Unknown', $fault: status < 500 ? 'client' : 'server', message: 'UnknownError', $metadata: {httpStatusCode: status}});

let handler;
let originalSend;
let originalError;
let logged;

const installMock = () => {
  logged = [];
  console.error = (...args) => logged.push(args);
  s3.S3Client.prototype.send = async function (command) {
    const key = command.input.Key;
    if (FAILING.has(key)) throw s3Error(500);
    if (NOT_FOUND.has(key)) throw new s3.NotFound({message: 'UnknownError', $metadata: {httpStatusCode: 404}});
    if (command instanceof s3.HeadObjectCommand) {
      if (key in HEAD_TABLE) return HEAD_TABLE[key];
      throw s3Error(403);
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

test('the origin Lambda may not list the bucket', () => {
  const template = Template.fromStack(new AwsWebsiteCdnCdkStack(new cdk.App(), 'Test'));
  const actions = Object.values(template.findResources('AWS::IAM::Policy'))
    .flatMap((p) => p.Properties.PolicyDocument.Statement)
    .flatMap((s) => [s.Action].flat());
  assert.ok(actions.includes('s3:GetObject'));
  assert.ok(!actions.some((a) => a === 's3:ListBucket' || a === 's3:*' || a === 's3:List*'), JSON.stringify(actions));
});

test('a page reached through 403 misses logs nothing', async () => {
  const res = await handler(event('/blog/post', {'x-cache-variant': 'bgz'}));
  assert.equal(res.statusCode, 200);
  assert.deepEqual(logged, []);
});

test('an unknown page is a 404 and logs nothing', async () => {
  const res = await handler(event('/no/such/page', {'x-cache-variant': 'bgz'}));
  assert.equal(res.statusCode, 404);
  assert.deepEqual(logged, []);
});

test('a 404 miss logs nothing either', async () => {
  const res = await handler(event('/legacy'));
  assert.equal(res.statusCode, 404);
  assert.deepEqual(logged, []);
});

test('a failing variant probe is logged, and the original is served', async () => {
  const res = await handler(event('/broken.css', {'x-cache-variant': 'b'}));
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers['Content-Encoding'], undefined);
  assert.equal(logged.length, 1);
  assert.match(logged[0][0], /^Error checking variant/);
});

test('a failing lookup is logged', async () => {
  const res = await handler(event('/unlucky'));
  assert.equal(res.statusCode, 404);
  assert.equal(logged.length, 1);
  assert.match(logged[0][0], /^Error checking original object/);
});
