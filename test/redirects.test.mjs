import {test} from 'node:test';
import assert from 'node:assert/strict';
import {findRedirect} from '../lambda/index.mjs';

// The generic strip-slash rule must collapse `/path/` → `/path` WITHOUT stealing
// precedence from the legacy date-path / text-month / feed / exact redirects that
// also end in a slash — it sits LAST in REDIRECTS.patterns. These cases lock that
// ordering: reorder the table and the second group breaks.

test('trailing-slash URLs canonicalize to slashless (root excepted)', () => {
  assert.equal(findRedirect('/blog/2026-05-26-code-linearization/'), '/blog/2026-05-26-code-linearization');
  assert.equal(findRedirect('/tags/javascript/'), '/tags/javascript');
  assert.equal(findRedirect('/tags/'), '/tags');
  assert.equal(findRedirect('/blog/'), '/blog');
  assert.equal(findRedirect('/about/'), '/about');
  assert.equal(findRedirect('/page/2/'), '/page/2');
});

test('legacy / feed / exact redirects win over the generic strip-slash rule', () => {
  assert.equal(findRedirect('/blog/2014/05/18/unification-for-js/'), '/blog/2014-05-18-unification-for-js');
  assert.equal(findRedirect('/blog/2006/may/6/migration-magic-removal/'), '/blog/2006-05-06-migration-magic-removal');
  assert.equal(findRedirect('/blog/2005/sep/23/openwrt_gui/'), '/blog/2005-09-30-openwrt_gui_development');
  assert.equal(findRedirect('/blog/feeds/rss/categories/5/'), '/index.xml');
});

test('root and already-canonical paths are not redirected', () => {
  assert.equal(findRedirect('/'), null);
  assert.equal(findRedirect('/blog/2026-05-26-code-linearization'), null);
  assert.equal(findRedirect('/index.xml'), null);
  assert.equal(findRedirect('/blog/2026-05-26-code-linearization/cover.jpg'), null);
});
