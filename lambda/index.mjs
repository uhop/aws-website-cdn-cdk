import process from 'process';
import {join} from 'path';

import mime from 'mime';
import * as s3 from '@aws-sdk/client-s3';

const BUCKET = process.env.BUCKET;
const PREFIX = process.env.PREFIX || '/';
const CACHE_PERIOD = process.env.CACHE_PERIOD || String(60 * 60 * 24 * 3); // 3d

const FOLDER_SUFFIX = '/index.html';
const WEBP = {isSupported: /\bimage\/webp\b/i, suffix: '.webp'};

// Order is the tie-breaker when two variants share the same byte count.
const TEXT_CODECS = [
  {accept: /\bbr\b/i, suffix: '.br', encoding: 'br'},
  {accept: /\bzstd\b/i, suffix: '.zst', encoding: 'zstd'},
  {accept: /\bgzip\b/i, suffix: '.gz', encoding: 'gzip'},
];

// Per content-type dispatch. 'image' → best-match against a WebP variant if the
// client supports image/webp. 'compressible' → best-match-by-size across .br/.zst/.gz
// siblings plus identity. Anything not in this map serves the original byte-for-byte.
const DISPATCH = {
  'image/jpeg': 'image',
  'image/png': 'image',
  'text/plain': 'compressible',
  'text/html': 'compressible',
  'text/css': 'compressible',
  'text/xml': 'compressible',
  'text/markdown': 'compressible',
  'text/csv': 'compressible',
  'application/javascript': 'compressible',
  'application/json': 'compressible',
  'application/xml': 'compressible',
  'application/wasm': 'compressible',
  'application/manifest+json': 'compressible',
  'application/ld+json': 'compressible',
  'application/atom+xml': 'compressible',
  'application/rss+xml': 'compressible',
  'image/svg+xml': 'compressible',
  'image/bmp': 'compressible',
  'font/ttf': 'compressible',
  'font/otf': 'compressible',
};

const s3Client = new s3.S3Client();

const getData = async (name) => {
  const response = await s3Client.send(
    new s3.GetObjectCommand({
      Bucket: BUCKET,
      Key: name,
    }),
  );
  return response.Body.transformToByteArray();
};

const headVariant = async (name) => {
  try {
    return await s3Client.send(
      new s3.HeadObjectCommand({
        Bucket: BUCKET,
        Key: name,
      }),
    );
  } catch (error) {
    if (error instanceof s3.S3ServiceException) {
      if (error.name !== 'AccessDenied' && error.name !== 'NoSuchKey' && error.name !== 'NotFound') {
        console.error('Error checking variant (s3):', name, error);
      }
    } else {
      console.error('Error checking variant (other):', name, error);
    }
    return null;
  }
};

const respond = (data, meta, contentType, headers = {}, vary = 'Accept-Encoding') => {
  const headersFromMeta = {};
  if (meta.ContentEncoding) headersFromMeta['Content-Encoding'] = meta.ContentEncoding;
  if (meta.ContentLanguage) headersFromMeta['Content-Language'] = meta.ContentLanguage;
  if (meta.ETag) headersFromMeta['ETag'] = meta.ETag;
  if (meta.ExpiresString) headersFromMeta['Expires'] = meta.ExpiresString;
  if (meta.LastModified) headersFromMeta['Last-Modified'] = `${meta.LastModified.toUTCString()}`;
  if (vary) headersFromMeta['Vary'] = vary;

  return {
    statusCode: 200,
    headers: {
      'Cache-Control': `public, max-age=${CACHE_PERIOD}`,
      'Content-Type': contentType,
      ...headersFromMeta,
      ...headers,
    },
    body: typeof data.toBase64 === 'function' ? data.toBase64() : Buffer.from(data.buffer).toString('base64'),
    isBase64Encoded: true,
  };
};

const getObject = async (name, headers, meta) => {
  const normalizedHeaders = {};
  for (const [key, value] of Object.entries(headers)) {
    normalizedHeaders[key.toLowerCase()] = value;
  }

  const acceptEncoding = normalizedHeaders['accept-encoding'] || '';
  const contentType = meta.ContentType || mime.getType(name);
  const kind = DISPATCH[contentType];

  if (kind === 'image' && WEBP.isSupported.test(normalizedHeaders['accept'])) {
    const webpMeta = await headVariant(name + WEBP.suffix);
    if (webpMeta) {
      const data = await getData(name + WEBP.suffix);
      return respond(data, meta, 'image/webp', {}, 'Accept');
    }
  } else if (kind === 'compressible' && !meta.ContentEncoding) {
    const accepted = TEXT_CODECS.filter((c) => c.accept.test(acceptEncoding));
    if (accepted.length > 0) {
      const probes = await Promise.all(
        accepted.map(async (c) => {
          const variantMeta = await headVariant(name + c.suffix);
          return variantMeta ? {...c, size: variantMeta.ContentLength} : null;
        }),
      );
      const choices = probes.filter(Boolean);
      // Identity is always a valid candidate; its size is already known from the original HEAD.
      choices.push({encoding: null, suffix: '', size: meta.ContentLength});
      // Stable sort: when sizes tie, TEXT_CODECS order wins, identity loses (pushed last).
      choices.sort((a, b) => a.size - b.size);
      const winner = choices[0];
      if (winner.encoding) {
        const data = await getData(name + winner.suffix);
        return respond(data, meta, contentType, {'Content-Encoding': winner.encoding});
      }
    }
  }

  const data = await getData(name);
  return respond(data, meta, contentType, {}, '');
};

const tryFolder = async (path, headers) => {
  let name = join(PREFIX, path);
  if (name.startsWith('/')) name = name.substring(1);

  if (name && !name.endsWith('/')) {
    try {
      const meta = await s3Client.send(
        new s3.HeadObjectCommand({
          Bucket: BUCKET,
          Key: name,
        }),
      );
      return getObject(name, headers, meta);
    } catch (error) {
      // squelch
      if (!(error instanceof s3.NotFound)) {
        console.error('Error checking original object:', name, error);
      }
    }
  }

  name = join(name, FOLDER_SUFFIX);
  if (name.startsWith('/')) name = name.substring(1);

  try {
    const meta = await s3Client.send(
      new s3.HeadObjectCommand({
        Bucket: BUCKET,
        Key: name,
      }),
    );
    return getObject(name, headers, meta);
  } catch (error) {
    // squelch
    if (!(error instanceof s3.NotFound)) {
      console.error('Error checking path object:', name, error);
    }
  }

  return {
    statusCode: 404,
    headers: {
      'Content-Type': 'text/plain',
    },
    body: 'Not Found',
  };
};

export const handler = async (event) => {
  const {path, headers} = event;
  return tryFolder(path, headers);
};
