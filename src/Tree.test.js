import {afterEach, beforeEach, mock, test} from 'node:test';
import assert from 'node:assert/strict';

import Tree, {
  checkUpdateHasOnlyDescendantsWithNoOverlap, relativizePaths, toFirebaseJson
} from './Tree.js';

let context;

beforeEach(() => {
  context = {
    rootUrl: 'https://example.firebaseio.com',
    bridge: {on: mock.fn(), off: mock.fn()},
    dispatcher: {clearReady: mock.fn(), markReady: mock.fn(), retry: mock.fn()},
    truss: {}
  };
  context.tree = new Tree(
    context.truss, context.rootUrl, context.bridge, context.dispatcher);
  context.tree.init([]);
});

afterEach(() => {
  context.tree.destroy();
  mock.reset();
  context = undefined;
});

test('checkUpdateHasOnlyDescendantsWithNoOverlap', () => {
  let updates;

  updates = {'/foo': 1};
  checkUpdateHasOnlyDescendantsWithNoOverlap('/foo', updates);

  updates = {'/': 1};
  checkUpdateHasOnlyDescendantsWithNoOverlap('/', updates);

  updates = {'/foo/bar': 1, '/foo/baz/qux': 2};
  checkUpdateHasOnlyDescendantsWithNoOverlap('/foo', updates);

  updates = {'/foo/bar': 1, '/foo/baz/qux': 2};
  checkUpdateHasOnlyDescendantsWithNoOverlap('/', updates);

  updates = {'foo': 1, 'bar': 2};
  checkUpdateHasOnlyDescendantsWithNoOverlap('/foo', updates);
  assert.deepEqual(updates, {'/foo/foo': 1, '/foo/bar': 2});

  updates = {'foo': 1, 'bar': 2};
  checkUpdateHasOnlyDescendantsWithNoOverlap('/', updates);
  assert.deepEqual(updates, {'/foo': 1, '/bar': 2});

  assert.throws(() => {
    checkUpdateHasOnlyDescendantsWithNoOverlap('/foo', {'bar/baz': 1});
  }, {message: /absolute/});

  assert.throws(() => {
    checkUpdateHasOnlyDescendantsWithNoOverlap('/foo', {'/bar': 1});
  }, {message: /descendant/});

  assert.throws(() => {
    checkUpdateHasOnlyDescendantsWithNoOverlap('/foo', {'/': 1});
  }, {message: /descendant/});

  assert.throws(() => {
    checkUpdateHasOnlyDescendantsWithNoOverlap('/foo/bar', {'/foo/baz': 1});
  }, {message: /descendant/});

  assert.throws(() => {
    checkUpdateHasOnlyDescendantsWithNoOverlap('/foo', {'bar/baz': 1});
  }, {message: /absolute/});

  assert.throws(() => {
    checkUpdateHasOnlyDescendantsWithNoOverlap('/foo', {'/foo': 1, '/foo/bar': 2});
  }, {message: /overlap/});

  assert.throws(() => {
    checkUpdateHasOnlyDescendantsWithNoOverlap('/foo', {'/foo/bar': 1, '/foo/bar/baz': 2});
  }, {message: /overlap/});

  assert.throws(() => {
    checkUpdateHasOnlyDescendantsWithNoOverlap('/foo', {'/foo/bar': 1, 'bar': 2});
  }, {message: /overlap/});

  checkUpdateHasOnlyDescendantsWithNoOverlap('/foo', {'/foo/bar': 1, '/foo/barz': 2});
});

test('relativizePaths', () => {
  let updates;

  updates = {'/foo': 1};
  relativizePaths('/foo', updates);
  assert.deepEqual(updates, {'': 1});

  updates = {'/': 1};
  relativizePaths('/', updates);
  assert.deepEqual(updates, {'': 1});

  updates = {'/foo/bar': 1, '/foo/baz/qux': 2};
  relativizePaths('/foo', updates);
  assert.deepEqual(updates, {'bar': 1, 'baz/qux': 2});

  updates = {'/foo/bar': 1, '/foo/baz/qux': 2};
  relativizePaths('/', updates);
  assert.deepEqual(updates, {'foo/bar': 1, 'foo/baz/qux': 2});
});

test('plantValue', () => {
  const tree = context.tree;

  assert.deepEqual(toFirebaseJson(tree.root), {});
  tree._plantValue('/foo', 'foo', {bar: 'x'}, tree.root, false, false, false, []);
  assert.deepEqual(toFirebaseJson(tree.root), {foo: {bar: 'x'}});
  const foo = tree.root.foo;
  tree._plantValue('/foo', 'foo', {bar: 'x', baz: 'y'}, tree.root, false, false, false, []);
  assert.equal(tree.root.foo, foo);
  assert.deepEqual(toFirebaseJson(tree.root), {foo: {bar: 'x', baz: 'y'}});
  tree._plantValue('/foo/qux', 'qux', 'z', foo, false, false, false, []);
  assert.equal(tree.root.foo, foo);
  assert.deepEqual(toFirebaseJson(tree.root), {foo: {bar: 'x', baz: 'y', qux: 'z'}});
  tree._plantValue('/foo', 'foo', {bar: 'x'}, tree.root, false, false, false, []);
  assert.equal(tree.root.foo, foo);
  assert.deepEqual(toFirebaseJson(tree.root), {foo: {bar: 'x'}});
  tree._plantValue('/foo', 'foo', {bar: {qux: 'y'}}, tree.root, false, false, false, []);
  assert.deepEqual(toFirebaseJson(tree.root), {foo: {bar: {qux: 'y'}}});
});

test('prune', () => {
  const tree = context.tree;

  tree._plantValue('/foo', 'foo', {bar: 'x'}, tree.root, false, false, false, []);
  tree._prune('/foo');
  assert.deepEqual(toFirebaseJson(tree.root), {});

  tree._plantValue('/foo', 'foo', {bar: 'x'}, tree.root, false, false, false, []);
  tree._prune('/foo/bar');
  assert.deepEqual(toFirebaseJson(tree.root), {});

  tree._plantValue('/foo', 'foo', {bar: 'x', baz: 'y'}, tree.root, false, false, false, []);
  tree._prune('/foo/bar');
  assert.deepEqual(toFirebaseJson(tree.root), {foo: {baz: 'y'}});

  tree._plantValue('/foo', 'foo', {bar: 'x', baz: {qux: 'y'}}, tree.root, false, false, false, []);
  tree._prune('/foo/baz/qux');
  assert.deepEqual(toFirebaseJson(tree.root), {foo: {bar: 'x'}});
});
