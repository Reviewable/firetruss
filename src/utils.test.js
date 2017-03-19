import test from 'ava';
import {escapeKey, unescapeKey, joinPath, makePathMatcher} from './utils.js';

test('escapeKey', t => {
  t.is(escapeKey('foo\\.$#[]/'), 'foo\\5c\\2e\\24\\23\\5b\\5d\\2f');
});

test('unescapeKey', t => {
  t.is(unescapeKey('foo\\5c\\2e\\24\\23\\5b\\5d\\2f'), 'foo\\.$#[]/');
});

test('joinPath', t => {
  t.is(joinPath('/foo', 'bar'), '/foo/bar');
  t.is(joinPath('/', 'foo/bar', 'baz'), '/foo/bar/baz');
  t.is(joinPath('/foo', '/bar'), '/bar');
});

test('PathMatcher', t => {
  t.deepEqual(makePathMatcher('/foo/bar').match('/foo/bar'), {});
  t.falsy(makePathMatcher('/foo/bar').match('/foo/qux'), {});
  t.deepEqual(makePathMatcher('/foo/$bar').match('/foo/qux'), {$bar: 'qux'});
  t.deepEqual(makePathMatcher('/foo/$bar/$*').match('/foo/qux/quuux'), {$bar: 'qux'});
});
