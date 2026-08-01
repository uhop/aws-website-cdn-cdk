// CloudFront Function (viewer-request, cloudfront-js-2.0). Two jobs, in order:
// 301 any non-canonical Host to www.lazutkin.com, then normalize Accept /
// Accept-Encoding into the `x-cache-variant` cache-key token. Read verbatim as the
// function body by lib/aws-website-cdn-cdk-stack.mjs. No export — the runtime has no
// module system; test/cf-normalize.test.mjs evaluates this file to test it. Token
// registry + design: projects/aws-website-cdn-cdk/decisions § Tier 1 (vault).

// CloudFront always answers on the distribution's own d*.cloudfront.net default domain
// and AWS offers no switch to disable it, so the site is reachable under two names.
// Returning a response here short-circuits BEFORE the cache lookup — which is why Host
// need not join the cache key: a redirect can never be stored against the canonical host.
// Doing this any later (origin Lambda, origin-response) would require exactly that.
const CANONICAL_HOST = 'www.lazutkin.com';

// forwardedValues.queryString is false, so the origin never sees a query string — but the
// viewer's copy still has to survive the hop, or a shared /search?q=… loses its query.
// Values are re-emitted verbatim: they arrive encoded, and re-encoding would double it.
const rebuildQuery = (qs) => {
  const parts = [];
  for (const key in qs) {
    const multiValue = qs[key].multiValue;
    if (multiValue) {
      for (let i = 0; i < multiValue.length; ++i) parts.push(key + '=' + multiValue[i].value);
      continue;
    }
    const value = qs[key].value;
    parts.push(value === '' ? key : key + '=' + value);
  }
  return parts.length ? '?' + parts.join('&') : '';
};

// q defaults to 1 when absent; q=0 (0, 0.0, 0.000…) is the only "not acceptable" value.
const acceptable = (params) => {
  for (let i = 1; i < params.length; ++i) {
    if (params[i].indexOf('q=') === 0) return parseFloat(params[i].slice(2)) !== 0;
  }
  return true;
};

// Parse each header ONCE into a presence map — membership is an O(1) hit, not a re-split
// per lookup. Prototype-less map so a hostile token can't collide with Object.prototype.
const accepted = (headerValue) =>
  headerValue.split(',').reduce((set, part) => {
    const params = part.split(';').map((s) => s.trim());
    if (params[0] && acceptable(params)) set[params[0]] = true;
    return set;
  }, Object.create(null));

const variant = (accept, ae) => {
  const fmt = accepted(accept);
  const enc = accepted(ae);
  let v = '';
  // Frozen alphabetical-by-char order — append on match; canonical without a sort.
  // Reserved slots keep each future char's fixed position: fill in place, never reorder.
  if (fmt['image/avif']) v += 'a';
  if (enc['br']) v += 'b';
  if (enc['gzip']) v += 'g';
  // (h) reserved — heic has no reliable Accept token for web delivery
  // (j) reserved — jxl: no browser advertises image/jxl in Accept (Safari decodes
  //     it but stays silent — reached via <picture><source> markup instead)
  // if (fmt['text/markdown']) v += 'm';   // reserved — enable when .md ships
  if (fmt['image/webp']) v += 'w';
  if (enc['zstd']) v += 'z';
  return v;
};

// Entry point kept in AWS's documented `function handler` form; arrows are fine elsewhere.
function handler(event) {
  const request = event.request;
  const h = request.headers;

  // Absent Host is also non-canonical — redirect rather than guess.
  const host = h.host ? h.host.value.toLowerCase() : '';
  if (host !== CANONICAL_HOST) {
    return {
      statusCode: 301,
      statusDescription: 'Moved Permanently',
      headers: {
        location: {value: 'https://' + CANONICAL_HOST + request.uri + rebuildQuery(request.querystring)},
      },
    };
  }

  const accept = h.accept ? h.accept.value.toLowerCase() : '';
  const ae = h['accept-encoding'] ? h['accept-encoding'].value.toLowerCase() : '';
  h['x-cache-variant'] = {value: variant(accept, ae)};
  return request;
}
