import process from 'process';
import {join} from 'path';

import mime from 'mime';
import * as s3 from '@aws-sdk/client-s3';

const BUCKET = process.env.BUCKET;
const PREFIX = process.env.PREFIX || '/';
const CACHE_PERIOD = process.env.CACHE_PERIOD || String(60 * 60 * 24 * 3); // 3d

const FOLDER_SUFFIX = '/index.html';
const WEBP = {isSupported: /\bimage\/webp\b/i, suffix: '.webp'};
const ZSTD = {isSupported: /\bzstd\b/i, suffix: '.zst'};
const BR = {isSupported: /\bbr\b/i, suffix: '.br'};
const GZIP = {isSupported: /\bgzip\b/i, suffix: '.gz'};

const IMAGES = {
  'image/jpeg': 1,
  'image/png': 1,
};

const TEXTS = {
  'text/plain': 1,
  'text/html': 1,
  'text/css': 1,
  'application/javascript': 1,
  'application/json': 1,
  'application/xml': 1,
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

  const acceptEncoding = normalizedHeaders['accept-encoding'];
  const contentType = meta.ContentType || mime.getType(name);

  if (IMAGES[contentType] === 1 && WEBP.isSupported.test(normalizedHeaders['accept'])) {
    try {
      const data = await getData(name + WEBP.suffix);
      return respond(data, meta, 'image/webp', {}, 'Accept');
    } catch (error) {
      if (error instanceof s3.S3ServiceException) {
        if (error.name !== 'AccessDenied' && error.name !== 'NoSuchKey') {
          console.error('Error checking webp object (s3):', name, error);
        }
      } else {
        console.error('Error checking webp object (other):', name, error);
      }
      // skip
    }
  } else if (TEXTS[contentType] && !meta.ContentEncoding) {
    if (BR.isSupported.test(acceptEncoding)) {
      try {
        const data = await getData(name + BR.suffix);
        return respond(data, meta, contentType, {'Content-Encoding': 'br'});
      } catch (error) {
        if (error instanceof s3.S3ServiceException) {
          if (error.name !== 'AccessDenied' && error.name !== 'NoSuchKey') {
            console.error('Error checking webp object (s3):', name, error);
          }
        } else {
          console.error('Error checking webp object (other):', name, error);
        }
        // skip
      }
    }
    if (ZSTD.isSupported.test(acceptEncoding)) {
      try {
        const data = await getData(name + ZSTD.suffix);
        return respond(data, meta, contentType, {'Content-Encoding': 'zstd'});
      } catch (error) {
        if (error instanceof s3.S3ServiceException) {
          if (error.name !== 'AccessDenied' && error.name !== 'NoSuchKey') {
            console.error('Error checking webp object (s3):', name, error);
          }
        } else {
          console.error('Error checking webp object (other):', name, error);
        }
        // skip
      }
    }
    if (GZIP.isSupported.test(acceptEncoding)) {
      try {
        const data = await getData(name + GZIP.suffix);
        return respond(data, meta, contentType, {'Content-Encoding': 'gzip'});
      } catch (error) {
        if (error instanceof s3.S3ServiceException) {
          if (error.name !== 'AccessDenied' && error.name !== 'NoSuchKey') {
            console.error('Error checking webp object (s3):', name, error);
          }
        } else {
          console.error('Error checking webp object (other):', name, error);
        }
        // skip
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
