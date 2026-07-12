import {test, before, beforeEach, after} from 'node:test';
import assert from 'node:assert/strict';
import * as s3 from '@aws-sdk/client-s3';

// resolveVariant negotiation driven by the x-cache-variant edge token. When present the
// token is authoritative (it carries zstd, which CloudFront strips from Accept-Encoding);
// when absent the Lambda falls back to raw Accept / Accept-Encoding (direct-AG / pre-flag).
// S3 is mocked by overriding S3Client.prototype.send (same approach as head.test.mjs).

const SECRET = 'test-secret';

// Sizes chosen so zstd < br < gzip < identity, so best-match-by-size picks zstd when allowed.
const HEAD_TABLE = {
  doc: {ContentType: 'text/html', ContentLength: 1000, ETag: '"d"', LastModified: new Date('2026-07-01T00:00:00Z')},
  'doc.br': {ContentLength: 300},
  'doc.zst': {ContentLength: 250},
  'doc.gz': {ContentLength: 400},
  pic: {ContentType: 'image/png', ContentLength: 5000, ETag: '"p"', LastModified: new Date('2026-07-01T00:00:00Z')},
  'pic.webp': {ContentLength: 2000},
  'pic.avif': {ContentLength: 1500},
  // Original already smaller than every variant — identity must win best-match.
  tiny: {ContentType: 'image/png', ContentLength: 100, ETag: '"t"', LastModified: new Date('2026-07-01T00:00:00Z')},
  'tiny.webp': {ContentLength: 900},
  'tiny.avif': {ContentLength: 800},
  // Suffix-on-top variant keys; s3 sync types .jxl as octet-stream (it doesn't know the ext).
  'photo.jpg': {ContentType: 'image/jpeg', ContentLength: 4000, ETag: '"j"', LastModified: new Date('2026-07-01T00:00:00Z')},
  'photo.jpg.jxl': {ContentType: 'binary/octet-stream', ContentLength: 3200},
  'photo.jpg.webp': {ContentLength: 3600},
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

const getKeys = () => sent.filter((c) => c instanceof s3.GetObjectCommand).map((c) => c.input.Key);

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
});
beforeEach(installMock);
after(() => {
  s3.S3Client.prototype.send = originalSend;
});

test('token present serves zstd even when Accept-Encoding omits it (token overrides raw headers)', async () => {
  const res = await handler(event('/doc', {'x-cache-variant': 'bgz', 'Accept-Encoding': 'br'}));
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers['Content-Encoding'], 'zstd'); // smallest of br/zstd/gzip
  assert.equal(res.headers['Vary'], 'Accept-Encoding'); //  downstream still varies on the real header
  assert.deepEqual(getKeys(), ['doc.zst']);
});

test('token restricts the codec set to its chars', async () => {
  const res = await handler(event('/doc', {'x-cache-variant': 'g', 'Accept-Encoding': 'br, zstd, gzip'}));
  assert.equal(res.headers['Content-Encoding'], 'gzip'); // only gzip allowed by the token
  assert.deepEqual(getKeys(), ['doc.gz']);
});

test('empty token (present) means no capabilities → identity, no codec probes', async () => {
  const res = await handler(event('/doc', {'x-cache-variant': '', 'Accept-Encoding': 'br, gzip'}));
  assert.equal(res.headers['Content-Encoding'], undefined);
  assert.deepEqual(getKeys(), ['doc']);
});

test('token absent falls back to raw Accept-Encoding (today’s behavior)', async () => {
  const res = await handler(event('/doc', {'Accept-Encoding': 'br'}));
  assert.equal(res.headers['Content-Encoding'], 'br');
  assert.deepEqual(getKeys(), ['doc.br']);
});

test('token with w negotiates webp on an image', async () => {
  const res = await handler(event('/pic', {'x-cache-variant': 'bgw'}));
  assert.equal(res.headers['Content-Type'], 'image/webp');
  assert.equal(res.headers['Vary'], 'Accept');
  assert.deepEqual(getKeys(), ['pic.webp']);
});

test('token without w keeps the original image, ignoring a raw Accept: image/webp', async () => {
  const res = await handler(event('/pic', {'x-cache-variant': 'bgz', Accept: 'image/webp'}));
  assert.equal(res.headers['Content-Type'], 'image/png');
  assert.deepEqual(getKeys(), ['pic']);
});

test('token absent falls back to raw Accept for webp', async () => {
  const res = await handler(event('/pic', {Accept: 'image/webp'}));
  assert.equal(res.headers['Content-Type'], 'image/webp');
  assert.deepEqual(getKeys(), ['pic.webp']);
});

test('image best-match-by-size picks the smallest accepted variant', async () => {
  const res = await handler(event('/pic', {'x-cache-variant': 'aw'}));
  assert.equal(res.headers['Content-Type'], 'image/avif'); // 1500 < 2000 (webp) < 5000 (original)
  assert.equal(res.headers['Vary'], 'Accept');
  assert.deepEqual(getKeys(), ['pic.avif']);
});

test('a smaller variant outside the accepted set never wins', async () => {
  const res = await handler(event('/pic', {'x-cache-variant': 'w'}));
  assert.equal(res.headers['Content-Type'], 'image/webp'); // avif is smaller but not accepted
  assert.deepEqual(getKeys(), ['pic.webp']);
});

test('identity wins best-match when the original is smallest', async () => {
  const res = await handler(event('/tiny', {'x-cache-variant': 'aw'}));
  assert.equal(res.headers['Content-Type'], 'image/png');
  assert.equal(res.headers['Vary'], 'Accept');
  assert.deepEqual(getKeys(), ['tiny']);
});

test('token absent falls back to raw Accept for avif', async () => {
  const res = await handler(event('/pic', {Accept: 'image/avif,image/webp'}));
  assert.equal(res.headers['Content-Type'], 'image/avif');
  assert.deepEqual(getKeys(), ['pic.avif']);
});

test('direct .jxl request is an exact pass-through, typed from the name, never re-negotiated', async () => {
  const res = await handler(event('/photo.jpg.jxl', {'x-cache-variant': 'aw', Accept: 'image/avif,image/webp'}));
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers['Content-Type'], 'image/jxl'); // octet-stream S3 meta recovered from the name
  assert.equal(res.headers['Content-Encoding'], undefined);
  assert.deepEqual(getKeys(), ['photo.jpg.jxl']); // no sibling probes: the smaller webp is ignored
});

test('missing markup-referenced variant falls back to the base object and negotiates', async () => {
  const res = await handler(event('/photo.jpg.avif', {'x-cache-variant': 'w'}));
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers['Content-Type'], 'image/webp'); // photo.jpg.avif absent → base photo.jpg → webp wins
  assert.deepEqual(getKeys(), ['photo.jpg.webp']);
});

test('missing variant of a missing base still 404s', async () => {
  const res = await handler(event('/ghost.jpg.jxl', {'x-cache-variant': 'aw'}));
  assert.equal(res.statusCode, 404);
});
