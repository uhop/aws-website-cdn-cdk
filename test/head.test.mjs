import {test, before, beforeEach, after} from 'node:test';
import assert from 'node:assert/strict';
import * as s3 from '@aws-sdk/client-s3';

// Handler-level tests for HEAD: it must return the same negotiated headers a GET
// would, but with an empty body and WITHOUT a GetObjectCommand (no body fetch).
// S3 is mocked by overriding S3Client.prototype.send — the module-scoped s3Client
// resolves send() off the prototype at call time, so the override reaches it.

const SECRET = 'test-secret';

// Canned HeadObject metadata per key. A probed key absent here is a 404 (NotFound),
// matching real HeadObject; the chosen test paths never hit that branch.
const HEAD_TABLE = {
  'index.xml': {ContentType: 'application/xml', ContentLength: 1000, ETag: '"v1"', LastModified: new Date('2026-06-30T00:00:00Z')},
  'index.xml.br': {ContentLength: 300},
  'img.png': {ContentType: 'image/png', ContentLength: 5000, ETag: '"img1"', LastModified: new Date('2026-06-30T00:00:00Z')},
  'img.png.webp': {ContentLength: 2000},
};

let handler;
let originalSend;
let sent;

const installMock = () => {
  sent = [];
  s3.S3Client.prototype.send = async function (command) {
    sent.push(command);
    const key = command.input.Key;
    if (command instanceof s3.HeadObjectCommand) {
      if (key in HEAD_TABLE) return HEAD_TABLE[key];
      throw new s3.NotFound({message: 'Not Found', $metadata: {httpStatusCode: 404}});
    }
    if (command instanceof s3.GetObjectCommand) {
      const bytes = new Uint8Array(Buffer.from(`BODY:${key}`));
      return {Body: {transformToByteArray: async () => bytes}};
    }
    throw new Error(`unexpected command ${command.constructor.name}`);
  };
};

const headKeys = () => sent.filter((c) => c instanceof s3.HeadObjectCommand).map((c) => c.input.Key);
const getKeys = () => sent.filter((c) => c instanceof s3.GetObjectCommand).map((c) => c.input.Key);

const event = (method, path, headers = {}) => ({
  httpMethod: method,
  path,
  headers: {'x-origin-verify': SECRET, ...headers},
});

before(async () => {
  process.env.EXPECTED_SECRET = SECRET;
  process.env.BUCKET = 'test-bucket';
  // Import after env is set: EXPECTED_SECRET is captured at module load.
  ({handler} = await import('../lambda/index.mjs'));
  originalSend = s3.S3Client.prototype.send;
});
beforeEach(installMock);
after(() => {
  s3.S3Client.prototype.send = originalSend;
});

test('HEAD on a compressible page negotiates br with no body fetch', async () => {
  const res = await handler(event('HEAD', '/index.xml', {'Accept-Encoding': 'br'}));
  assert.equal(res.statusCode, 200);
  assert.equal(res.body, '');
  assert.equal(res.isBase64Encoded, false);
  assert.equal(res.headers['Content-Type'], 'application/xml');
  assert.equal(res.headers['Content-Encoding'], 'br');
  assert.equal(res.headers['Vary'], 'Accept-Encoding');
  assert.equal(res.headers['ETag'], '"v1"');
  assert.ok(res.headers['Cache-Control']);
  assert.deepEqual(getKeys(), []);
  assert.ok(headKeys().includes('index.xml'));
  assert.ok(headKeys().includes('index.xml.br'));
});

test('HEAD without Accept-Encoding serves identity headers, still no body fetch', async () => {
  const res = await handler(event('HEAD', '/index.xml'));
  assert.equal(res.statusCode, 200);
  assert.equal(res.body, '');
  assert.equal(res.isBase64Encoded, false);
  assert.equal(res.headers['Content-Type'], 'application/xml');
  assert.equal(res.headers['Content-Encoding'], undefined);
  assert.equal(res.headers['Vary'], undefined);
  assert.deepEqual(getKeys(), []);
});

test('HEAD on an image negotiates webp with no body fetch', async () => {
  const res = await handler(event('HEAD', '/img.png', {Accept: 'image/webp'}));
  assert.equal(res.statusCode, 200);
  assert.equal(res.body, '');
  assert.equal(res.headers['Content-Type'], 'image/webp');
  assert.equal(res.headers['Vary'], 'Accept');
  assert.deepEqual(getKeys(), []);
  assert.ok(headKeys().includes('img.png.webp'));
});

test('GET on the same page DOES fetch the chosen variant body (HEAD/GET contrast)', async () => {
  const res = await handler(event('GET', '/index.xml', {'Accept-Encoding': 'br'}));
  assert.equal(res.statusCode, 200);
  assert.equal(res.isBase64Encoded, true);
  assert.equal(res.headers['Content-Encoding'], 'br');
  assert.notEqual(res.body, '');
  assert.equal(Buffer.from(res.body, 'base64').toString(), 'BODY:index.xml.br');
  assert.deepEqual(getKeys(), ['index.xml.br']);
});
