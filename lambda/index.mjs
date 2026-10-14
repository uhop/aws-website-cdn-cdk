import process from 'process';
import {join} from 'path';

import mime from 'mime';
import * as s3 from '@aws-sdk/client-s3';

const BUCKET = process.env.BUCKET;
const PREFIX = process.env.PREFIX || '/';
const CACHE_PERIOD = process.env.CACHE_PERIOD || String(60 * 60 * 24 * 3); // 3d
const TEXT_CACHE_PERIOD = process.env.TEXT_CACHE_PERIOD || String(60 * 3); // 3m
const EXPECTED_SECRET = process.env.EXPECTED_SECRET;

const FOLDER_SUFFIX = '/index.html';

// Order is the tie-breaker when two variants share the same byte count (modern first).
// `char` is the x-cache-variant code (see cf/normalize.js). `j` comes mostly from a .jxl
// URL the viewer-request function strips, since no browser lists image/jxl in Accept.
const IMAGE_CODECS = [
  {accept: /\bimage\/jxl\b/i, suffix: '.jxl', contentType: 'image/jxl', char: 'j'},
  {accept: /\bimage\/avif\b/i, suffix: '.avif', contentType: 'image/avif', char: 'a'},
  {accept: /\bimage\/webp\b/i, suffix: '.webp', contentType: 'image/webp', char: 'w'},
];

// Direct variant URLs that markup may hardcode pass through exactly, and a miss falls back
// to the base object instead of a 404. A .jxl URL arrives here only when the
// viewer-request function did not run; with it, the suffix is already the `j` token char.
const IMAGE_VARIANT_SUFFIX = /\.(webp|avif|jxl)$/;

const MONTH_ABBR = {
  jan: '01',
  feb: '02',
  mar: '03',
  apr: '04',
  may: '05',
  jun: '06',
  jul: '07',
  aug: '08',
  sep: '09',
  oct: '10',
  nov: '11',
  dec: '12',
};

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
      match: /^\/blog\/(\d{4})\/(\d{2})\/(\d{2})\/([a-zA-Z0-9_-]+)\/?$/,
      resolve: (m) => `/blog/${m[1]}-${m[2]}-${m[3]}-${m[4]}`,
    },
    {
      // Django text-month form (pre-Hugo era, never aliased).
      match: /^\/blog\/(\d{4})\/(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\/(\d{1,2})\/([a-zA-Z0-9_-]+)\/?$/,
      resolve: (m) => `/blog/${m[1]}-${MONTH_ABBR[m[2]]}-${String(m[3]).padStart(2, '0')}-${m[4]}`,
    },
    {
      // Canonicalize `/path/` → slashless (all emitted URLs are slashless, root
      // `/` excepted). MUST stay last: the date-path/feed patterns above also end
      // in a slash and resolve their own targets, so a strip-first here would
      // truncate them to a broken slashless form.
      match: /^(\/.+)\/$/,
      resolve: (m) => m[1],
    },
  ],
};

export const findRedirect = (path) => {
  if (path in REDIRECTS.exact) return REDIRECTS.exact[path];
  for (const r of REDIRECTS.patterns) {
    const m = r.match.exec(path);
    if (m) return r.resolve ? r.resolve(m) : r.target;
  }
  return null;
};

// Order is the tie-breaker when two variants share the same byte count. `char` is the
// x-cache-variant code (see cf/normalize.js) used when the edge token is present.
const TEXT_CODECS = [
  {accept: /\bbr\b/i, suffix: '.br', encoding: 'br', char: 'b'},
  {accept: /\bzstd\b/i, suffix: '.zst', encoding: 'zstd', char: 'z'},
  {accept: /\bgzip\b/i, suffix: '.gz', encoding: 'gzip', char: 'g'},
];

const IMAGE_TYPES = new Set(['image/jpeg', 'image/png']);

// Text a deploy rewrites under the same name. The invalidation cannot reach a browser's
// copy, so browsers recheck after TEXT_CACHE_PERIOD; CloudFront keeps CACHE_PERIOD.
// CSS and JS stay long.
const SHORT_LIVED = new Set([
  'text/html',
  'text/plain',
  'text/xml',
  'text/markdown',
  'text/csv',
  'application/json',
  'application/xml',
  'application/manifest+json',
  'application/ld+json',
  'application/atom+xml',
  'application/rss+xml',
]);

const cacheControl = (contentType) =>
  SHORT_LIVED.has(contentType) ? `public, max-age=${TEXT_CACHE_PERIOD}, s-maxage=${CACHE_PERIOD}` : `public, max-age=${CACHE_PERIOD}`;

const s3Client = new s3.S3Client();

// Without s3:ListBucket (the stack) S3 answers a missing key with 403, and a HEAD error has no
// body for the SDK to name, so the status decides; any other error is logged.
const isMissing = (error) => {
  const status = error.$metadata?.httpStatusCode;
  return status === 403 || status === 404;
};

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
    if (!isMissing(error)) console.error('Error checking variant:', name, error);
    return null;
  }
};

const buildHeaders = (meta, contentType, headers, vary) => {
  const headersFromMeta = {};
  if (meta.ContentEncoding) headersFromMeta['Content-Encoding'] = meta.ContentEncoding;
  if (meta.ContentLanguage) headersFromMeta['Content-Language'] = meta.ContentLanguage;
  if (meta.ETag) headersFromMeta['ETag'] = meta.ETag;
  if (meta.ExpiresString) headersFromMeta['Expires'] = meta.ExpiresString;
  if (meta.LastModified) headersFromMeta['Last-Modified'] = `${meta.LastModified.toUTCString()}`;
  if (vary) headersFromMeta['Vary'] = vary;

  return {
    'Cache-Control': cacheControl(contentType),
    'Content-Type': contentType,
    ...headersFromMeta,
    ...headers,
  };
};

const respond = (data, meta, contentType, headers = {}, vary = 'Accept-Encoding') => ({
  statusCode: 200,
  headers: buildHeaders(meta, contentType, headers, vary),
  body: typeof data.toBase64 === 'function' ? data.toBase64() : Buffer.from(data.buffer).toString('base64'),
  isBase64Encoded: true,
});

const respondHead = (meta, contentType, headers = {}, vary = 'Accept-Encoding') => ({
  statusCode: 200,
  headers: buildHeaders(meta, contentType, headers, vary),
  // Content-Length omitted deliberately: API Gateway recomputes it from the empty
  // proxy body, so the real representation size can't survive the integration.
  body: '',
  isBase64Encoded: false,
});

// HEAD-probe only (no body fetch), so HEAD and GET resolve to the same variant + headers.
const resolveVariant = async (name, headers, meta) => {
  const normalizedHeaders = {};
  for (const [key, value] of Object.entries(headers)) {
    normalizedHeaders[key.toLowerCase()] = value;
  }

  const acceptEncoding = normalizedHeaders['accept-encoding'] || '';
  // `aws s3 sync` types extensions it doesn't know as S3's `binary/octet-stream`, which is no
  // registered type: the name decides, else the standard `application/octet-stream`.
  const contentType = !meta.ContentType || meta.ContentType.endsWith('/octet-stream') ? mime.getType(name) || 'application/octet-stream' : meta.ContentType;

  // The edge-computed x-cache-variant token is authoritative when present — it carries
  // zstd, which CloudFront strips from Accept-Encoding. Absent (direct-to-API-Gateway, or
  // before the cfNormalize flag ships) → derive from raw headers. Token grammar: cf/normalize.js.
  const token = normalizedHeaders['x-cache-variant'];
  const formatOk = token !== undefined ? (c) => token.includes(c.char) : (c) => c.accept.test(normalizedHeaders['accept'] || '');
  const codecOk = token !== undefined ? (c) => token.includes(c.char) : (c) => c.accept.test(acceptEncoding);

  if (IMAGE_TYPES.has(contentType)) {
    const accepted = IMAGE_CODECS.filter(formatOk);
    const probes = await Promise.all(
      accepted.map(async (c) => {
        const variantMeta = await headVariant(name + c.suffix);
        return variantMeta ? {...c, size: variantMeta.ContentLength} : null;
      }),
    );
    // Identity is always a valid candidate; its size is already known from the original HEAD.
    const choices = [...probes.filter(Boolean), {suffix: '', contentType, size: meta.ContentLength}];
    // Stable sort: when sizes tie, IMAGE_CODECS order wins, identity last.
    choices.sort((a, b) => a.size - b.size);
    const winner = choices[0];
    return {key: name + winner.suffix, contentType: winner.contentType, headers: {}, vary: 'Accept'};
  } else if (!meta.ContentEncoding) {
    // No type list: cxop picks which files get siblings (blog-hugo bin/optimize-public); the bucket is the record.
    const accepted = TEXT_CODECS.filter(codecOk);
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
        return {key: name + winner.suffix, contentType, headers: {'Content-Encoding': winner.encoding}, vary: 'Accept-Encoding'};
      }
    }
  }

  return {key: name, contentType, headers: {}, vary: ''};
};

const getObject = async (name, method, headers, meta) => {
  const plan = await resolveVariant(name, headers, meta);
  if (method === 'HEAD') return respondHead(meta, plan.contentType, plan.headers, plan.vary);
  const data = await getData(plan.key);
  return respond(data, meta, plan.contentType, plan.headers, plan.vary);
};

const tryFolder = async (path, method, headers) => {
  let name = join(PREFIX, path);
  if (name.startsWith('/')) name = name.substring(1);

  if (name && !name.endsWith('/')) {
    const variant = IMAGE_VARIANT_SUFFIX.exec(name);
    // A markup-hardcoded variant URL (<source srcset="….jxl">) must not 404 when its
    // sibling went missing at build (a codec silently absent) — retry the base name,
    // which then negotiates normally.
    const candidates = variant ? [name, name.slice(0, -variant[0].length)] : [name];
    for (const key of candidates) {
      try {
        const meta = await s3Client.send(
          new s3.HeadObjectCommand({
            Bucket: BUCKET,
            Key: key,
          }),
        );
        return getObject(key, method, headers, meta);
      } catch (error) {
        if (!isMissing(error)) console.error('Error checking original object:', key, error);
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
    return getObject(name, method, headers, meta);
  } catch (error) {
    if (!isMissing(error)) console.error('Error checking path object:', name, error);
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
  const {path, headers, httpMethod} = event;
  const lcHeaders = {};
  for (const [k, v] of Object.entries(headers || {})) lcHeaders[k.toLowerCase()] = v;
  if (!EXPECTED_SECRET || lcHeaders['x-origin-verify'] !== EXPECTED_SECRET) return forbidden();
  const target = findRedirect(path);
  if (target) return redirect(target);
  return tryFolder(path, httpMethod, headers);
};
