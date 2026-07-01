// ─────────────────────────────────────────────────────────────────────────────
// DRAFT — Tier 1 cache-key normalization via a viewer-request CloudFront Function.
//
// NOT wired into bin/aws-website-cdn-cdk.js or the stack: this is the staged design
// for the `x-cache-variant` token. Deploying it is a deliberate step (see § Deploy).
//
// WHAT IT DOES
//   A viewer-request CloudFront Function runs BEFORE the cache key is computed. It
//   reads the RAW viewer `Accept` / `Accept-Encoding`, collapses the negotiation
//   signal into a single canonical token, and writes it to `x-cache-variant`. The
//   cache policy keys on that token, so the dozens of raw header variations that map
//   to the same variant decision now share ONE cache entry.
//
//   The origin (Lambda) cannot influence the cache key — the key is frozen before the
//   origin is contacted — so a custom header set at the viewer tier is the only place
//   this normalization can happen.
//
// WHY A CUSTOM HEADER (not in-place normalization of Accept/Accept-Encoding)
//   With `compress: true`, CloudFront normalizes `Accept-Encoding` on the origin leg
//   to `gzip, br` and STRIPS zstd. That normalization touches only the Accept-Encoding
//   header, never a custom "other-defined" header. This function reads the raw AE at
//   the viewer tier (before that normalization) and carries the true codec set —
//   including zstd — through to the origin in `x-cache-variant`. It is the vehicle
//   that keeps zstd (and any future codec CloudFront doesn't grok) alive.
//
// ── THE TOKEN ────────────────────────────────────────────────────────────────
//   `x-cache-variant`: a string of lowercase single-char capability codes.
//     - Presence of a char = capability supported; absence = unsupported.
//     - Chars are in a FROZEN order (see registry) → the token is canonical.
//     - Always set, even to '' ('' = "function ran, no special capabilities":
//       identity encoding + default representation). A MISSING header means the
//       function didn't run (direct-origin access) → the Lambda falls back to raw
//       headers.
//
// ── REGISTRY (the frozen alphabet) ───────────────────────────────────────────
//   Format axis — representation, detected from `Accept`:
//     w  webp      image/webp       ACTIVE
//     a  avif      image/avif       reserved — detectable (Chrome/FF), enable when .avif produced
//     j  jxl       image/jxl        reserved — NO browser advertises the token yet
//     h  heic      image/heic       reserved — no reliable web-delivery token
//     m  markdown  text/markdown    reserved — enable when .md production + Lambda md branch ship
//   Encoding axis — transfer coding, detected from `Accept-Encoding`:
//     b  br        br               ACTIVE
//     z  zstd      zstd             ACTIVE  (the reason this header exists)
//     g  gzip      gzip             ACTIVE
//     identity     (implicit)       never a char — the mandatory fallback candidate
//   The encoding axis is OPEN, not closed: a future coding gets the next free char,
//   a detection line here, a handler branch + produced sibling in the Lambda, and a
//   registry row. The token format never changes.
//
// ── CANONICALIZATION ─────────────────────────────────────────────────────────
//   Detection runs in a PERMANENT alphabetical-by-char order and appends directly,
//   so the output is canonical BY CONSTRUCTION — no runtime sort. Canonicalization
//   needs only a fixed total order; alphabetical is chosen because it makes the
//   invariant self-documenting and the guard a one-liner (`token === sorted(token)`).
//   Detection uses exact-token matching (not substring), honoring `;q=0` as "not
//   acceptable".
//
// ── EXTENSIBILITY & DISCIPLINE ───────────────────────────────────────────────
//   - Adding: fill the capability's reserved slot IN PLACE (a commented placeholder
//     already marks its alphabetical position), once, forever.
//   - Removing: delete the line — always safe; relative order of the rest is intact.
//   - NEVER repurpose a char, and NEVER reorder one. A char's position is permanent.
//   - test/cf-normalize.test.mjs asserts `token === sorted(token)` across all 2^N
//     capability subsets, so an out-of-place insertion fails CI instead of silently
//     churning the cache (order affects only the cache key, never content — the
//     Lambda consumes by membership).
//
// ── CACHE-KEY CONFIG (when wired) ─────────────────────────────────────────────
//   Key on ['x-cache-variant', 'Accept', 'Accept-Encoding']:
//     - x-cache-variant — the real key dimension when the function runs.
//     - Accept / Accept-Encoding — the safety floor: if the function is ever
//       unassociated, the key degrades to today's raw-header behavior (correct, just
//       fragmented) instead of collapsing all clients into one entry. Accept must
//       also stay whitelisted or CloudFront strips it from the origin request.
//
// ── LAMBDA CONSUMPTION (separate change, lambda/index.mjs) ────────────────────
//   Present (incl. ''): pick the variant by membership — caps.includes('w') → webp,
//     [b,z,g present] → best-match-by-size over that set + identity, etc.
//   Absent: fall back to today's raw Accept / Accept-Encoding parsing (direct-AG or
//     pre-deploy). Both paths resolve to the same CONTENT; only the KEY is token-only.
//
// ── DEPLOY (you run this — outward-facing infra is yours) ─────────────────────
//   1. Add a `cloudfront.CfnFunction` (runtime cloudfront-js-2.0, autoPublish) whose
//      code is the CODE-ONLY slice between the `// ── begin function code ──` and
//      `// ── test seam` markers below (drops this banner + the `export`; ~1.8 KB
//      vs the 10 KB cap). Full wiring: lib/cf-function.draft.mjs.
//   2. Associate it viewer-request on the default cache behavior
//      (`functionAssociations: [{eventType: 'viewer-request', functionArn: …}]`).
//   3. Add `x-cache-variant` to the cache-key header allowlist (keep Accept +
//      Accept-Encoding).
//   4. `aws cloudfront test-function` against the DEVELOPMENT stage with captured
//      Chrome/Firefox/Safari/curl headers; confirm the tokens match the registry.
//   5. Expect a one-day re-warm (the key changes → old entries orphan). Measure on
//      the hot path (projects/aws-website-cdn-cdk/learnings § hot-path).
//
//   The `export` at the bottom is a TEST SEAM for test/cf-normalize.test.mjs; it is
//   removed when the bodies are inlined into the CloudFront Function.
// ─────────────────────────────────────────────────────────────────────────────

// ── begin function code ──
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

// ── test seam (removed when inlined into the CloudFront Function) ──
export {handler, variant, accepted};
