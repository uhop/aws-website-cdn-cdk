import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

// cf/normalize.js is CloudFront Function source (no ESM export — the runtime has no
// module system), so evaluate the real file to expose the entry point + helpers. A
// syntax error in the deployable source therefore fails this suite.
const src = readFileSync(new URL('../cf/normalize.js', import.meta.url), 'utf8');
const {handler, accepted, CANONICAL_HOST} = new Function(`${src}\nreturn {handler, accepted, CANONICAL_HOST};`)();

// Guards the x-cache-variant token grammar. The load-bearing invariant is
// `token === sorted(token)`: the function builds the token by appending in a FROZEN
// alphabetical order (no runtime sort), so an out-of-place detection line would silently
// change cache keys. The sweep below turns that into a red test. Order affects only the
// cache key, never content (the Lambda consumes by membership).

// Run the real handler (exercises header extraction, lowercasing, always-set). The
// canonical Host is mandatory: without it the handler 301s and never reaches the token.
const run = (accept, acceptEncoding) => {
  const headers = {host: {value: CANONICAL_HOST}};
  if (accept !== undefined) headers.accept = {value: accept};
  if (acceptEncoding !== undefined) headers['accept-encoding'] = {value: acceptEncoding};
  const out = handler({request: {headers}});
  return out.headers['x-cache-variant'].value;
};

// Non-canonical hosts: returns a response object, so there is no .headers['x-cache-variant'].
const redirect = (host, uri = '/', querystring = {}) => handler({request: {headers: host === undefined ? {} : {host: {value: host}}, uri, querystring}});

// Real-world Accept headers (MDN default values), trimmed to what matters here.
const CHROME_IMG = 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8';
const SAFARI_IMG = 'image/webp,image/png,image/svg+xml,image/*;q=0.8,*/*;q=0.5';

test('representative clients map to the expected canonical token', () => {
  assert.equal(run(CHROME_IMG, 'gzip, deflate, br, zstd'), 'abgwz'); // Chrome
  assert.equal(run(SAFARI_IMG, 'gzip, deflate, br'), 'bgw'); //         Safari (no zstd)
  assert.equal(run('*/*', 'gzip'), 'g'); //                            curl
  assert.equal(run('*/*', undefined), ''); //                         no Accept-Encoding → identity
  assert.equal(run(undefined, undefined), ''); //                     nothing at all
});

test('always set, even when empty (presence is the "function ran" signal)', () => {
  const out = handler({request: {headers: {host: {value: CANONICAL_HOST}}}});
  assert.equal(out.headers['x-cache-variant'].value, '');
});

// The distribution answers on its d*.cloudfront.net default domain too and AWS gives no
// way to turn that off, so the canonical redirect is the only thing collapsing the two
// names. It must fire before normalization — a bounced request needs no cache token.
test('non-canonical Host gets a 301 to the canonical origin, path preserved', () => {
  const out = redirect('d2ex5t147aa14w.cloudfront.net', '/blog/2026-07-28-fast-enough');
  assert.equal(out.statusCode, 301);
  assert.equal(out.statusDescription, 'Moved Permanently');
  assert.equal(out.headers.location.value, 'https://www.lazutkin.com/blog/2026-07-28-fast-enough');
  assert.equal(out.headers['x-cache-variant'], undefined); // short-circuits before the token
});

test('canonical Host passes through untouched (no redirect)', () => {
  const out = redirect(CANONICAL_HOST, '/blog/x');
  assert.equal(out.statusCode, undefined); // a request, not a response
  assert.equal(out.uri, '/blog/x');
});

test('Host match is case-insensitive — an uppercased Host is still canonical', () => {
  assert.equal(redirect('WWW.LAZUTKIN.COM', '/').statusCode, undefined);
});

test('absent Host is non-canonical (redirect rather than guess)', () => {
  assert.equal(redirect(undefined, '/').statusCode, 301);
});

test('query strings survive the redirect (origin never sees them; the viewer must)', () => {
  const one = redirect('d2ex5t147aa14w.cloudfront.net', '/search', {q: {value: 'invariants'}});
  assert.equal(one.headers.location.value, 'https://www.lazutkin.com/search?q=invariants');

  // Repeated key → multiValue; every occurrence is re-emitted, in order.
  const many = redirect('d2ex5t147aa14w.cloudfront.net', '/x', {
    tag: {value: 'a', multiValue: [{value: 'a'}, {value: 'b'}]},
  });
  assert.equal(many.headers.location.value, 'https://www.lazutkin.com/x?tag=a&tag=b');

  // Valueless key keeps its bare form rather than gaining a stray '='.
  const bare = redirect('d2ex5t147aa14w.cloudfront.net', '/x', {debug: {value: ''}});
  assert.equal(bare.headers.location.value, 'https://www.lazutkin.com/x?debug');

  // No query string → no trailing '?'.
  assert.equal(redirect('d2ex5t147aa14w.cloudfront.net', '/x').headers.location.value, 'https://www.lazutkin.com/x');
});

test('case-insensitive: values are lowercased before matching', () => {
  assert.equal(run('IMAGE/WEBP', 'BR, ZSTD'), 'bwz');
});

test('q=0 means the client refuses the token', () => {
  assert.equal(run('*/*', 'br;q=0, gzip'), 'g'); //        br refused
  assert.equal(run('*/*', 'br;q=0.0, zstd'), 'z'); //      zero decimals also refused
  assert.equal(run('*/*', 'br;q=0.001, gzip'), 'bg'); //   tiny but nonzero → accepted
});

test('reserved capabilities stay dark even when advertised', () => {
  // jxl is in the registry but not emitted (no browser advertises it; <picture> route).
  assert.equal(run('image/avif,image/webp,image/jxl', 'br'), 'abw');
});

test('noise (ordering, whitespace, deflate, q-values) collapses to one canonical token', () => {
  const canonical = run('image/webp', 'br, gzip, zstd');
  assert.equal(run('image/webp', 'zstd,br,gzip'), canonical);
  assert.equal(run('image/webp', '  gzip ,  deflate ,  br ,  zstd  '), canonical);
  assert.equal(run('image/webp', 'br;q=1.0, gzip;q=0.9, zstd;q=0.8, deflate;q=0.7'), canonical);
});

test('accepted(): presence map of acceptable tokens, exact-token only', () => {
  const enc = accepted('gzip, deflate, br');
  assert.equal(enc['br'], true);
  assert.equal(enc['gzip'], true);
  assert.equal(enc['zip'], undefined); //                  no substring match
  assert.equal(accepted('br;q=0, gzip')['br'], undefined); // q=0 filtered at parse
  assert.equal(accepted('image/webp;q=0.8')['image/webp'], true);
});

// The invariant sweep: every subset of the ACTIVE capabilities must emit a token whose
// chars are in canonical (sorted) order. Fails if a detection line moves out of place.
const ACTIVE = [
  {char: 'a', accept: 'image/avif'},
  {char: 'w', accept: 'image/webp'},
  {char: 'b', enc: 'br'},
  {char: 'z', enc: 'zstd'},
  {char: 'g', enc: 'gzip'},
];

const subsets = (arr) => {
  const out = [[]];
  for (const item of arr) {
    const n = out.length;
    for (let i = 0; i < n; ++i) out.push(out[i].concat(item));
  }
  return out;
};

test('every capability subset emits a canonically-ordered token (frozen-order invariant)', () => {
  for (const subset of subsets(ACTIVE)) {
    const accept = ['text/html', ...subset.filter((c) => c.accept).map((c) => c.accept), '*/*'].join(',');
    const encs = subset.filter((c) => c.enc).map((c) => c.enc);
    const ae = encs.length ? encs.join(', ') : '';
    const token = run(accept, ae);

    assert.equal(token, [...token].sort().join(''), `not canonical for ${JSON.stringify(subset.map((c) => c.char))}`);
    const expected = subset
      .map((c) => c.char)
      .sort()
      .join('');
    assert.equal([...token].sort().join(''), expected);
  }
});
