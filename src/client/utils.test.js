import test from 'ava';
import {escapeKey, unescapeKey} from './utils.js';

test('escapeKey', t => {
  t.is(escapeKey('foo\\.$#[]/'), 'foo\\5c\\2e\\24\\23\\5b\\5d\\2f');
});

test('unescapeKey', t => {
  t.is(unescapeKey('foo\\5c\\2e\\24\\23\\5b\\5d\\2f'), 'foo\\.$#[]/');
});
