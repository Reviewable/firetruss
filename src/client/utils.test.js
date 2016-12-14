// jshint strict:global
'use strict';

import test from 'ava';
import utils from './utils.js';

test('escapeKey', t => {
  t.is(utils.escapeKey('foo\\.$#[]/'), 'foo\\5c\\2e\\24\\23\\5b\\5d\\2f');
});

test('unescapeKey', t => {
  t.is(utils.unescapeKey('foo\\5c\\2e\\24\\23\\5b\\5d\\2f'), 'foo\\.$#[]/');
});
