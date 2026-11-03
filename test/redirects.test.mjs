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

test('numeric category pages go to the tag of the category they named', () => {
  for (const [id, tag] of [
    [1, 'development'],
    [4, 'django'],
    [8, 'rants'],
    [27, 'openwrt'],
    [30, 'django'],
    [31, 'windows'],
  ]) {
    assert.equal(findRedirect(`/blog/categories/${id}`), `/tags/${tag}`);
    assert.equal(findRedirect(`/blog/categories/${id}/`), `/tags/${tag}`);
  }
});

test('a category whose name has no tag goes to its parent category tag', () => {
  assert.equal(findRedirect('/blog/categories/2'), '/tags/development');
  assert.equal(findRedirect('/blog/categories/6'), '/tags/web');
  assert.equal(findRedirect('/blog/categories/18'), '/tags/db');
  assert.equal(findRedirect('/blog/categories/20'), '/tags/db');
  assert.equal(findRedirect('/blog/categories/25'), '/tags/syndication');
});

test('category IDs with no tag and no parent tag only lose their trailing slash', () => {
  for (const id of [9, 10, 12, 32, 999]) {
    assert.equal(findRedirect(`/blog/categories/${id}`), null);
    assert.equal(findRedirect(`/blog/categories/${id}/`), `/blog/categories/${id}`);
  }
});

test('slug category pages go to the tag of the same name', () => {
  assert.equal(findRedirect('/blog/categories/django'), '/tags/django');
  assert.equal(findRedirect('/blog/categories/django/'), '/tags/django');
  assert.equal(findRedirect('/blog/categories/javascript/'), '/tags/javascript');
});

test('the category index goes to the tag index', () => {
  for (const path of ['/blog/categories', '/blog/categories/', '/categories', '/categories/']) {
    assert.equal(findRedirect(path), '/tags');
  }
});

test('every Django-era feed goes to the whole-site feed, category feeds included', () => {
  for (const path of [
    '/blog/categories/4/rss201.xml',
    '/blog/categories/4/xrss201.xml',
    '/blog/categories/4/atom.xml',
    '/blog/categories/9/rss201.xml',
    '/blog/categories/12/xrss201.xml',
    '/blog/categories/django/atom.xml',
    '/blog/categories/django/rss201.xml',
    '/blog/categories/django/xrss201.xml',
    '/blog/feeds/rss/categories/1/',
    '/blog/feeds/rss/categories/4',
    '/blog/feeds/rss/categories/12/',
    '/blog/feeds/atom/categories/4',
    '/blog/feeds/atom/categories/10/',
    '/blog/feeds/rss/latest/',
    '/blog/feeds/atom/latest',
    '/blog/feeds/rss/authors/1/',
    '/blog/feeds/atom/authors/1',
    '/blog/rss201.xml',
    '/blog/categories/rss/',
    '/blog/categories/rss',
    '/atom.xml',
  ]) {
    assert.equal(findRedirect(path), '/index.xml');
  }
});

test('root and already-canonical paths are not redirected', () => {
  assert.equal(findRedirect('/'), null);
  assert.equal(findRedirect('/blog/2026-05-26-code-linearization'), null);
  assert.equal(findRedirect('/index.xml'), null);
  assert.equal(findRedirect('/blog/2026-05-26-code-linearization/cover.jpg'), null);
});
