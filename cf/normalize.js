// CloudFront Function (viewer-request, cloudfront-js-2.0): normalizes Accept /
// Accept-Encoding into the `x-cache-variant` cache-key token. Read verbatim as the
// function body by lib/aws-website-cdn-cdk-stack.mjs. No export — the runtime has no
// module system; test/cf-normalize.test.mjs evaluates this file to test it. Token
// registry + design: projects/aws-website-cdn-cdk/decisions § Tier 1 (vault).

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
  // if (fmt['image/avif'])    v += 'a';   // reserved — enable when .avif produced
  if (enc['br']) v += 'b';
  if (enc['gzip']) v += 'g';
  // (h) reserved — heic has no reliable Accept token for web delivery
  // (j) reserved — jxl: no browser advertises image/jxl yet
  // if (fmt['text/markdown']) v += 'm';   // reserved — enable when .md ships
  if (fmt['image/webp']) v += 'w';
  if (enc['zstd']) v += 'z';
  return v;
};

// Entry point kept in AWS's documented `function handler` form; arrows are fine elsewhere.
function handler(event) {
  const h = event.request.headers;
  const accept = h.accept ? h.accept.value.toLowerCase() : '';
  const ae = h['accept-encoding'] ? h['accept-encoding'].value.toLowerCase() : '';
  h['x-cache-variant'] = {value: variant(accept, ae)};
  return event.request;
}
