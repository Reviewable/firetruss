import test from 'ava';
import td from 'testdouble';

import Tree, {
  checkUpdateHasOnlyDescendantsWithNoOverlap, relativizePaths, toFirebaseJson
} from './Tree.js';
import Bridge from './Bridge.js';
import Dispatcher from './Dispatcher.js';


test.beforeEach(t => {
  t.context = {
    rootUrl: 'https://example.firebaseio.com',
    bridge: td.instance(Bridge),
    dispatcher: td.instance(Dispatcher),
    truss: td.object()
  };
  t.context.tree = new Tree(
    t.context.truss, t.context.rootUrl, t.context.bridge, t.context.dispatcher);
  t.context.tree.init([]);
});

test.afterEach(t => {
  t.context.tree.destroy();
});

test('checkUpdateHasOnlyDescendantsWithNoOverlap', t => {
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
  t.deepEqual(updates, {'/foo/foo': 1, '/foo/bar': 2});

  updates = {'foo': 1, 'bar': 2};
  checkUpdateHasOnlyDescendantsWithNoOverlap('/', updates);
  t.deepEqual(updates, {'/foo': 1, '/bar': 2});

  t.throws(() => {
    checkUpdateHasOnlyDescendantsWithNoOverlap('/foo', {'bar/baz': 1});
  }, {message: /absolute/});

  t.throws(() => {
    checkUpdateHasOnlyDescendantsWithNoOverlap('/foo', {'/bar': 1});
  }, {message: /descendant/});

  t.throws(() => {
    checkUpdateHasOnlyDescendantsWithNoOverlap('/foo', {'/': 1});
  }, {message: /descendant/});

  t.throws(() => {
    checkUpdateHasOnlyDescendantsWithNoOverlap('/foo/bar', {'/foo/baz': 1});
  }, {message: /descendant/});

  t.throws(() => {
    checkUpdateHasOnlyDescendantsWithNoOverlap('/foo', {'bar/baz': 1});
  }, {message: /absolute/});

  t.throws(() => {
    checkUpdateHasOnlyDescendantsWithNoOverlap('/foo', {'/foo': 1, '/foo/bar': 2});
  }, {message: /overlap/});

  t.throws(() => {
    checkUpdateHasOnlyDescendantsWithNoOverlap('/foo', {'/foo/bar': 1, '/foo/bar/baz': 2});
  }, {message: /overlap/});

  t.throws(() => {
    checkUpdateHasOnlyDescendantsWithNoOverlap('/foo', {'/foo/bar': 1, 'bar': 2});
  }, {message: /overlap/});

  checkUpdateHasOnlyDescendantsWithNoOverlap('/foo', {'/foo/bar': 1, '/foo/barz': 2});
});

test('relativizePaths', t => {
  let updates;

  updates = {'/foo': 1};
  relativizePaths('/foo', updates);
  t.deepEqual(updates, {'': 1});

  updates = {'/': 1};
  relativizePaths('/', updates);
  t.deepEqual(updates, {'': 1});

  updates = {'/foo/bar': 1, '/foo/baz/qux': 2};
  relativizePaths('/foo', updates);
  t.deepEqual(updates, {'bar': 1, 'baz/qux': 2});

  updates = {'/foo/bar': 1, '/foo/baz/qux': 2};
  relativizePaths('/', updates);
  t.deepEqual(updates, {'foo/bar': 1, 'foo/baz/qux': 2});
});

test('plantValue', t => {
  const tree = t.context.tree;

  t.deepEqual(toFirebaseJson(tree.root), {});
  tree._plantValue('/foo', 'foo', {bar: 'x'}, tree.root, false, false, false, []);
  t.deepEqual(toFirebaseJson(tree.root), {foo: {bar: 'x'}});
  const foo = tree.root.foo;
  tree._plantValue('/foo', 'foo', {bar: 'x', baz: 'y'}, tree.root, false, false, false, []);
  t.is(tree.root.foo, foo);
  t.deepEqual(toFirebaseJson(tree.root), {foo: {bar: 'x', baz: 'y'}});
  tree._plantValue('/foo/qux', 'qux', 'z', foo, false, false, false, []);
  t.is(tree.root.foo, foo);
  t.deepEqual(toFirebaseJson(tree.root), {foo: {bar: 'x', baz: 'y', qux: 'z'}});
  tree._plantValue('/foo', 'foo', {bar: 'x'}, tree.root, false, false, false, []);
  t.is(tree.root.foo, foo);
  t.deepEqual(toFirebaseJson(tree.root), {foo: {bar: 'x'}});
  tree._plantValue('/foo', 'foo', {bar: {qux: 'y'}}, tree.root, false, false, false, []);
  t.deepEqual(toFirebaseJson(tree.root), {foo: {bar: {qux: 'y'}}});
});

test('prune', t => {
  const tree = t.context.tree;

  tree._plantValue('/foo', 'foo', {bar: 'x'}, tree.root, false, false, false, []);
  tree._prune('/foo');
  t.deepEqual(toFirebaseJson(tree.root), {});

  tree._plantValue('/foo', 'foo', {bar: 'x'}, tree.root, false, false, false, []);
  tree._prune('/foo/bar');
  t.deepEqual(toFirebaseJson(tree.root), {});

  tree._plantValue('/foo', 'foo', {bar: 'x', baz: 'y'}, tree.root, false, false, false, []);
  tree._prune('/foo/bar');
  t.deepEqual(toFirebaseJson(tree.root), {foo: {baz: 'y'}});

  tree._plantValue('/foo', 'foo', {bar: 'x', baz: {qux: 'y'}}, tree.root, false, false, false, []);
  tree._prune('/foo/baz/qux');
  t.deepEqual(toFirebaseJson(tree.root), {foo: {bar: 'x'}});
});
