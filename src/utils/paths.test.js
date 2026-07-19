import {test} from 'node:test';
import assert from 'node:assert/strict';
import {escapeKey, unescapeKey, joinPath, makePathMatcher} from './paths.js';

test('escapeKey', () => {
  assert.equal(escapeKey('foo\\.$#[]/'), 'foo\\5c\\2e\\24\\23\\5b\\5d\\2f');
});

test('unescapeKey', () => {
  assert.equal(unescapeKey('foo\\5c\\2e\\24\\23\\5b\\5d\\2f'), 'foo\\.$#[]/');
});

test('joinPath', () => {
  assert.equal(joinPath('/foo', 'bar'), '/foo/bar');
  assert.equal(joinPath('/', 'foo/bar', 'baz'), '/foo/bar/baz');
  assert.equal(joinPath('/foo', '/bar'), '/bar');
});

test('PathMatcher', () => {
  assert.deepEqual(makePathMatcher('/foo/bar').match('/foo/bar'), {});
  assert.ok(!makePathMatcher('/foo/bar').match('/foo/qux'));
  assert.deepEqual(makePathMatcher('/foo/$bar').match('/foo/qux'), {$bar: 'qux'});
  assert.deepEqual(makePathMatcher('/foo/$bar/$*').match('/foo/qux/quuux'), {$bar: 'qux'});
});
