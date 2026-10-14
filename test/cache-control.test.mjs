import {test, before, beforeEach, after} from 'node:test';
import assert from 'node:assert/strict';
import * as s3 from '@aws-sdk/client-s3';

// Browser lifetime by content type: text a deploy rewrites in place gets a short browser
// max-age with CloudFront's 3 days in s-maxage; CSS, JS, images, and redirects keep 3 days.
// S3 is mocked as in head.test.mjs.

const SECRET = 'test-secret';
const SHORT = 'public, max-age=180, s-maxage=259200';
const LONG = 'public, max-age=259200';

const meta = (ContentType, ContentLength = 1000) => ({ContentType, ContentLength, ETag: '"e"', LastModified: new Date('2026-10-13T00:00:00Z')});

const HEAD_TABLE = {
  'index.html': meta('text/html'),
  'index.html.br': {ContentLength: 300},
  'blog/post/index.html': meta('text/html'),
  'index.xml': meta('application/rss+xml'),
  'sitemap.xml': meta('application/xml'),
  'robots.txt': meta('text/plain', 60),
  'pagefind/pagefind-entry.json': meta('application/json'),
  'pagefind/pagefind.js': meta('text/javascript'),
  'old.js': meta('application/javascript'),
  'theme/base.min.abc.css': meta('text/css'),
  'cover.jpg': meta('image/jpeg', 5000),
  'cover.jpg.avif': {ContentLength: 2000},
  'pagefind/wasm.en-us.pagefind': meta('binary/octet-stream'),
};

let handler;
let originalSend;

const installMock = () => {
  s3.S3Client.prototype.send = async function (command) {
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

const event = (method, path, headers = {}) => ({
  httpMethod: method,
  path,
  headers: {'x-origin-verify': SECRET, ...headers},
});

const cacheControl = async (path, method = 'GET', headers = {}) => {
  const res = await handler(event(method, path, headers));
  assert.equal(res.statusCode, 200, path);
  return res.headers['Cache-Control'];
};

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

test('pages get the short browser lifetime, compressed or not, GET or HEAD', async () => {
  assert.equal(await cacheControl('/'), SHORT);
  assert.equal(await cacheControl('/', 'GET', {'Accept-Encoding': 'br'}), SHORT);
  assert.equal(await cacheControl('/', 'HEAD', {'Accept-Encoding': 'br'}), SHORT);
  assert.equal(await cacheControl('/blog/post'), SHORT);
});

test('feeds, sitemap, robots.txt, and the search entry file get the short lifetime', async () => {
  assert.equal(await cacheControl('/index.xml'), SHORT);
  assert.equal(await cacheControl('/sitemap.xml'), SHORT);
  assert.equal(await cacheControl('/robots.txt'), SHORT);
  assert.equal(await cacheControl('/pagefind/pagefind-entry.json'), SHORT);
});

test('CSS and JS keep 3 days, under either JS content type', async () => {
  assert.equal(await cacheControl('/theme/base.min.abc.css'), LONG);
  assert.equal(await cacheControl('/pagefind/pagefind.js'), LONG);
  assert.equal(await cacheControl('/old.js'), LONG);
});

test('images, variants, and binary files keep 3 days', async () => {
  assert.equal(await cacheControl('/cover.jpg'), LONG);
  assert.equal(await cacheControl('/cover.jpg', 'GET', {Accept: 'image/avif,*/*'}), LONG);
  assert.equal(await cacheControl('/pagefind/wasm.en-us.pagefind'), LONG);
});

test('redirects keep 3 days', async () => {
  const res = await handler(event('GET', '/blog/post/'));
  assert.equal(res.statusCode, 301);
  assert.equal(res.headers['Cache-Control'], LONG);
});
