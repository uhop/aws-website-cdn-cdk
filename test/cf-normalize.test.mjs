import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

// cf/normalize.js is CloudFront Function source (no ESM export — the runtime has no
// module system), so evaluate the real file to expose the entry point + helpers. A
// syntax error in the deployable source therefore fails this suite.
const src = readFileSync(new URL('../cf/normalize.js', import.meta.url), 'utf8');
const {handler, accepted} = new Function(`${src}\nreturn {handler, accepted};`)();

// Guards the x-cache-variant token grammar. The load-bearing invariant is
// `token === sorted(token)`: the function builds the token by appending in a FROZEN
// alphabetical order (no runtime sort), so an out-of-place detection line would silently
// change cache keys. The sweep below turns that into a red test. Order affects only the
// cache key, never content (the Lambda consumes by membership).

// Run the real handler (exercises header extraction, lowercasing, always-set).
const run = (accept, acceptEncoding) => {
  const headers = {};
  if (accept !== undefined) headers.accept = {value: accept};
  if (acceptEncoding !== undefined) headers['accept-encoding'] = {value: acceptEncoding};
  const out = handler({request: {headers}});
  return out.headers['x-cache-variant'].value;
};

// Real-world Accept headers (MDN default values), trimmed to what matters here.
const CHROME_IMG = 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8';
const SAFARI_IMG = 'image/webp,image/png,image/svg+xml,image/*;q=0.8,*/*;q=0.5';

test('representative clients map to the expected canonical token', () => {
  assert.equal(run(CHROME_IMG, 'gzip, deflate, br, zstd'), 'bgwz'); // Chrome
  assert.equal(run(SAFARI_IMG, 'gzip, deflate, br'), 'bgw'); //         Safari (no zstd)
  assert.equal(run('*/*', 'gzip'), 'g'); //                            curl
  assert.equal(run('*/*', undefined), ''); //                         no Accept-Encoding → identity
  assert.equal(run(undefined, undefined), ''); //                     nothing at all
});

test('always set, even when empty (presence is the "function ran" signal)', () => {
  const out = handler({request: {headers: {}}});
  assert.equal(out.headers['x-cache-variant'].value, '');
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
  // avif + jxl are in the registry but not emitted yet; only webp fires.
  assert.equal(run('image/avif,image/webp,image/jxl', 'br'), 'bw');
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
    const accept = subset.some((c) => c.accept) ? 'text/html,image/webp,*/*' : 'text/html,*/*';
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
