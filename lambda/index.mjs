import process from 'process';
import {join} from 'path';

import mime from 'mime';
import * as s3 from '@aws-sdk/client-s3';

const BUCKET = process.env.BUCKET;
const PREFIX = process.env.PREFIX || '/';
const CACHE_PERIOD = process.env.CACHE_PERIOD || String(60 * 60 * 24 * 3); // 3d
const EXPECTED_SECRET = process.env.EXPECTED_SECRET;

const FOLDER_SUFFIX = '/index.html';
const WEBP = {isSupported: /\bimage\/webp\b/i, suffix: '.webp'};

const MONTH_ABBR = {
  jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06',
  jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12',
};

// Redirect table. Exact paths win first; patterns are tried in order.
// Patterns expose either a static `target` or a `resolve(match) => string`.
const REDIRECTS = {
  exact: {
    // Orphan: no canonical post on 2005-09-23; hand-mapped to the closest from
    // the openwrt_gui series (2005-09-30). Without this the legacy-format regex
    // below would synthesize a target that itself 404s.
    '/blog/2005/sep/23/openwrt_gui/': '/blog/2005-09-30-openwrt_gui_development',
  },
  patterns: [
    {
      // Django-era feed URLs (~1,500 polls/month from old RSS readers). Per-tag
      // mapping isn't faithful — legacy numeric category IDs don't map to current
      // tag slugs — so everything funnels to the global feed.
      match:
        /^(?:\/blog\/feeds\/rss\/categories\/\d+|\/blog\/feeds\/(?:rss|atom)\/latest|\/blog\/rss201\.xml|\/blog\/categories\/(?:[^/]+\/(?:atom|rss201)\.xml|\d+\/rss201\.xml|rss\/?)|\/atom\.xml)\/?$/,
      target: '/index.xml',
    },
    {
      // Legacy date-path form (was emitted as Hugo aliases until 2026-05-16).
      // /blog/2014/07/11/heya-unify-back-to-js/  →  /blog/2014-07-11-heya-unify-back-to-js
      match: /^\/blog\/(\d{4})\/(\d{2})\/(\d{2})\/([a-zA-Z0-9_-]+)\/?$/,
      resolve: m => `/blog/${m[1]}-${m[2]}-${m[3]}-${m[4]}`,
    },
    {
      // Django text-month form (pre-Hugo era, never aliased).
      // /blog/2006/may/6/migration-magic-removal/  →  /blog/2006-05-06-migration-magic-removal
      match: /^\/blog\/(\d{4})\/(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\/(\d{1,2})\/([a-zA-Z0-9_-]+)\/?$/,
      resolve: m => `/blog/${m[1]}-${MONTH_ABBR[m[2]]}-${String(m[3]).padStart(2, '0')}-${m[4]}`,
    },
  ],
};

const findRedirect = (path) => {
  if (path in REDIRECTS.exact) return REDIRECTS.exact[path];
  for (const r of REDIRECTS.patterns) {
    const m = r.match.exec(path);
    if (m) return r.resolve ? r.resolve(m) : r.target;
  }
  return null;
};

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

const redirect = (location) => ({
  statusCode: 301,
  headers: {
    Location: location,
    'Cache-Control': `public, max-age=${CACHE_PERIOD}`,
    'Content-Type': 'text/plain',
  },
  body: '',
});

const forbidden = () => ({
  statusCode: 403,
  headers: {'Content-Type': 'text/plain'},
  body: 'Forbidden',
});

export const handler = async (event) => {
  const {path, headers} = event;
  const lcHeaders = {};
  for (const [k, v] of Object.entries(headers || {})) lcHeaders[k.toLowerCase()] = v;
  if (!EXPECTED_SECRET || lcHeaders['x-origin-verify'] !== EXPECTED_SECRET) return forbidden();
  const target = findRedirect(path);
  if (target) return redirect(target);
  return tryFolder(path, headers);
};
