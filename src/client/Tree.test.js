import test from 'ava';
import td from 'testdouble';

import Tree, {joinPath, checkUpdateHasOnlyDescendantsWithNoOverlap} from './Tree.js';
import Bridge from './Bridge.js';
import Dispatcher from './Dispatcher.js';


test.beforeEach(t => {
  t.context = {
    rootUrl: 'https://example.firebaseio.com',
    bridge: td.object(Bridge),
    dispatcher: td.object(Dispatcher),
    truss: td.object()
  };
  t.context.tree = new Tree(
    t.context.truss, t.context.rootUrl, t.context.bridge, t.context.dispatcher, []);
});

test.afterEach(t => {
  t.context.tree.destroy();
});

test('joinPath', t => {
  t.is(joinPath('/foo', 'bar'), '/foo/bar');
  t.is(joinPath('/', 'foo/bar', 'baz'), '/foo/bar/baz');
  t.is(joinPath('/foo', '/bar'), '/bar');
});

test('checkUpdateHasOnlyDescendantsWithNoOverlap', t => {
  let updates;

  updates = {'/foo': 1};
  checkUpdateHasOnlyDescendantsWithNoOverlap('/foo', updates);
  checkUpdateHasOnlyDescendantsWithNoOverlap('/foo', updates, true);
  t.deepEqual(updates, {'': 1});

  updates = {'/': 1};
  checkUpdateHasOnlyDescendantsWithNoOverlap('/', updates);
  checkUpdateHasOnlyDescendantsWithNoOverlap('/', updates, true);
  t.deepEqual(updates, {'': 1});

  updates = {'/foo/bar': 1, '/foo/baz/qux': 2};
  checkUpdateHasOnlyDescendantsWithNoOverlap('/foo', updates);
  checkUpdateHasOnlyDescendantsWithNoOverlap('/foo', updates, true);
  t.deepEqual(updates, {'bar': 1, 'baz/qux': 2});

  updates = {'/foo/bar': 1, '/foo/baz/qux': 2};
  checkUpdateHasOnlyDescendantsWithNoOverlap('/', updates);
  checkUpdateHasOnlyDescendantsWithNoOverlap('/', updates, true);
  t.deepEqual(updates, {'foo/bar': 1, 'foo/baz/qux': 2});

  updates = {'foo': 1, 'bar': 2};
  checkUpdateHasOnlyDescendantsWithNoOverlap('/foo', updates);
  t.deepEqual(updates, {'/foo/foo': 1, '/foo/bar': 2});

  updates = {'foo': 1, 'bar': 2};
  checkUpdateHasOnlyDescendantsWithNoOverlap('/', updates);
  t.deepEqual(updates, {'/foo': 1, '/bar': 2});

  t.throws(() => {
    checkUpdateHasOnlyDescendantsWithNoOverlap('/foo', {'bar/baz': 1});
  }, /absolute/);

  t.throws(() => {
    checkUpdateHasOnlyDescendantsWithNoOverlap('/foo', {'/bar': 1});
  }, /descendant/);

  t.throws(() => {
    checkUpdateHasOnlyDescendantsWithNoOverlap('/foo', {'/': 1});
  }, /descendant/);

  t.throws(() => {
    checkUpdateHasOnlyDescendantsWithNoOverlap('/foo/bar', {'/foo/baz': 1});
  }, /descendant/);

  t.throws(() => {
    checkUpdateHasOnlyDescendantsWithNoOverlap('/foo', {'bar/baz': 1});
  }, /absolute/);

  t.throws(() => {
    checkUpdateHasOnlyDescendantsWithNoOverlap('/foo', {'/foo': 1, '/foo/bar': 2});
  }, /overlap/);

  t.throws(() => {
    checkUpdateHasOnlyDescendantsWithNoOverlap('/foo', {'/foo/bar': 1, '/foo/bar/baz': 2});
  }, /overlap/);

  t.throws(() => {
    checkUpdateHasOnlyDescendantsWithNoOverlap('/foo', {'/foo/bar': 1, 'bar': 2});
  }, /overlap/);

  checkUpdateHasOnlyDescendantsWithNoOverlap('/foo', {'/foo/bar': 1, '/foo/barz': 2});
});

