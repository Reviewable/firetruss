import {afterEach, beforeEach, mock, test} from 'node:test';
import assert from 'node:assert/strict';
import _ from 'lodash';

import Coupler from './Coupler.js';

let context;

function countCalls(fn, matcher = _.constant(true)) {
  return _.filter(fn.mock.calls, call => matcher(call.arguments)).length;
}

function assertCallCount(fn, matcher, times) {
  assert.equal(countCalls(fn, matcher), times);
}

function isOnCall(url, args) {
  const [
    eventUrl, listenUrl, constraints, eventType, snapshotCallback, errorCallback, , options
  ] = args;
  return args.length === 8 &&
    _.isEqual([eventUrl, listenUrl, constraints, eventType], [url, url, null, 'value']) &&
    _.isFunction(snapshotCallback) &&
    _.isFunction(errorCallback) &&
    _.isEqual(options, {sync: true});
}

function isOffCall(url, args) {
  const [eventUrl, listenUrl, constraints, eventType, snapshotCallback] = args;
  return args.length === 6 &&
    _.isEqual([eventUrl, listenUrl, constraints, eventType], [url, url, null, 'value']) &&
    _.isFunction(snapshotCallback);
}

function assertNoCalls(fn) {
  assert.equal(fn.mock.calls.length, 0);
}

function assertSnapshotApplied(path, times) {
  assertCallCount(context.applySnapshot, args => args[0] && args[0].path === path, times);
}

beforeEach(() => {
  context = {
    rootUrl: 'https://example.firebaseio.com',
    bridge: {on: mock.fn(), off: mock.fn()},
    dispatcher: {clearReady: mock.fn(), markReady: mock.fn(), retry: mock.fn()},
    applySnapshot: mock.fn(),
    prunePath: mock.fn()
  };
  context.coupler = new Coupler(
    context.rootUrl, context.bridge, context.dispatcher, context.applySnapshot,
    context.prunePath
  );
  context.op1 = {_disconnect: mock.fn()};
  context.op2 = {};
  context.op3 = {};
  context.verifyOn = (url, times = 1) => {
    assertCallCount(context.bridge.on, args => isOnCall(url, args), times);
  };
  context.verifyOff = (url, times = 1) => {
    assertCallCount(context.bridge.off, args => isOffCall(url, args), times);
  };
});

afterEach(() => {
  context.coupler.destroy();
  mock.reset();
  context = undefined;
});

test('couple, decouple on root node', () => {
  const that = context.coupler;
  const url = context.rootUrl + '/';
  assert.equal(that.isTrunkCoupled('/'), false);

  that.couple('/', context.op1);
  assert.equal(that._root.count, 1);
  assert.deepEqual(that._root.operations, [context.op1]);
  assert.equal(that._root.listening, true);
  assert.equal(that.isTrunkCoupled('/'), true);
  context.verifyOn(url);
  assertNoCalls(context.bridge.off);

  that.decouple('/', context.op1);
  assert.equal(that._root.count, 0);
  assert.deepEqual(that._root.operations, []);
  assert.equal(that._root.listening, false);
  assert.equal(that.isTrunkCoupled('/'), false);
  context.verifyOn(url);
  context.verifyOff(url);
});

test('couple, decouple, on root child', () => {
  const that = context.coupler;
  const url = context.rootUrl + '/foo';
  assert.equal(that.isTrunkCoupled('/foo'), false);

  that.couple('/foo', context.op1);
  assert.equal(that._root.children.foo.count, 1);
  assert.equal(that._root.children.foo.listening, true);
  assert.equal(that.isTrunkCoupled('/foo'), true);
  context.verifyOn(url);
  assertNoCalls(context.bridge.off);

  that.decouple('/foo', context.op1);
  assert.ok(_.isEmpty(that._root.children));
  assert.equal(that.isTrunkCoupled('/foo'), false);
  context.verifyOn(url);
  context.verifyOff(url);
});

test('couple, decouple, on root descendant', () => {
  const that = context.coupler;
  const url = context.rootUrl + '/foo/bar';
  assert.equal(that.isTrunkCoupled('/foo/bar'), false);

  that.couple('/foo/bar', context.op1);
  assert.equal(that._root.children.foo.children.bar.count, 1);
  assert.equal(that._root.children.foo.children.bar.listening, true);
  assert.equal(that.isTrunkCoupled('/foo/bar'), true);
  context.verifyOn(url);
  assertNoCalls(context.bridge.off);

  that.decouple('/foo/bar', context.op1);
  assert.ok(_.isEmpty(that._root.children));
  assert.equal(that.isTrunkCoupled('/foo/bar'), false);
  context.verifyOn(url);
  context.verifyOff(url);
});

test('multiple coupler on same node', () => {
  const that = context.coupler;
  const url = context.rootUrl + '/foo';

  that.couple('/foo', context.op1);
  that.couple('/foo', context.op2);
  assert.equal(that._root.children.foo.count, 2);
  assert.deepEqual(that._root.children.foo.operations, [context.op1, context.op2]);
  assert.equal(that._root.children.foo.listening, true);
  assert.equal(that.isTrunkCoupled('/foo'), true);
  context.verifyOn(url);
  assertNoCalls(context.bridge.off);

  that.decouple('/foo', context.op1);
  assert.equal(that._root.children.foo.count, 1);
  assert.deepEqual(that._root.children.foo.operations, [context.op2]);
  assert.equal(that._root.children.foo.listening, true);
  assert.equal(that.isTrunkCoupled('/foo'), true);
  context.verifyOn(url);
  assertNoCalls(context.bridge.off);
});

test('override child coupling', () => {
  const that = context.coupler;
  const rootUrl = context.rootUrl;

  that.couple('/foo/bar', context.op1);
  that.couple('/foo', context.op2);
  assert.equal(that._root.children.foo.count, 1);
  assert.equal(that._root.children.foo.listening, true);
  assert.equal(that.isTrunkCoupled('/foo'), true);
  assert.equal(that._root.children.foo.children.bar.count, 1);
  assert.equal(that._root.children.foo.children.bar.listening, true);
  assert.equal(that.isTrunkCoupled('/foo/bar'), true);
  context.verifyOn(rootUrl + '/foo/bar');
  context.verifyOn(rootUrl + '/foo');

  that._root.children.foo._handleSnapshot({path: '/foo'});
  assert.equal(that._root.children.foo.children.bar.listening, false);
  context.verifyOff(rootUrl + '/foo/bar');

  that.decouple('/foo', context.op2);
  assert.equal(that._root.children.foo.count, 0);
  assert.equal(that._root.children.foo.listening, false);
  assert.equal(that.isTrunkCoupled('/foo'), false);
  assert.equal(that._root.children.foo.children.bar.count, 1);
  assert.equal(that._root.children.foo.children.bar.listening, true);
  assert.equal(that.isTrunkCoupled('/foo/bar'), true);
  context.verifyOn(rootUrl + '/foo/bar', 2);
  context.verifyOn(rootUrl + '/foo');
  context.verifyOff(rootUrl + '/foo/bar');
  context.verifyOff(rootUrl + '/foo');
});

test('superseded coupling', () => {
  const that = context.coupler;
  const rootUrl = context.rootUrl;

  that.couple('/foo', context.op1);
  that.couple('/foo/bar', context.op2);
  assert.equal(that._root.children.foo.count, 1);
  assert.equal(that._root.children.foo.listening, true);
  assert.equal(that.isTrunkCoupled('/foo'), true);
  assert.equal(that._root.children.foo.children.bar.count, 1);
  assert.ok(!that._root.children.foo.children.bar.listening);
  assert.equal(that.isTrunkCoupled('/foo/bar'), true);
  context.verifyOn(rootUrl + '/foo');
  context.verifyOff(rootUrl + '/foo', 0);
  context.verifyOn(rootUrl + '/foo/bar', 0);
  context.verifyOff(rootUrl + '/foo/bar', 0);
});

test('uncoupled parents with coupled children are not deleted', () => {
  const that = context.coupler;

  that.couple('/foo', context.op1);
  that.couple('/foo/bar', context.op2);
  that.couple('/foo/baz', context.op3);
  that.decouple('/foo/bar', context.op2);
  assert.equal(that._root.children.foo.children.baz.count, 1);
});

test('handle snapshot', () => {
  const that = context.coupler;

  that.couple('/foo/bar', context.op1);
  const node = that._root.children.foo.children.bar;
  assert.ok(!node.ready);
  node._handleSnapshot({path: '/foo/bar'});
  assert.equal(node.ready, true);
  node._handleSnapshot({path: '/foo/bar/baz'});
  node._handleSnapshot({path: '/foo'});

  assertSnapshotApplied('/foo/bar', 1);
  assertSnapshotApplied('/foo/bar/baz', 1);
  assertSnapshotApplied('/foo', 0);
});

test('handle error', async () => {
  const that = context.coupler;
  const error = new Error('test');

  that.couple('/foo/bar', context.op1);
  that.couple('/foo/bar/baz', context.op2);
  const bar = that._root.children.foo.children.bar;
  const baz = bar.children.baz;

  assert.equal(bar.count, 1);
  assert.equal(bar.listening, true);
  assert.equal(baz.count, 1);
  assert.ok(!baz.listening);

  bar._handleSnapshot({path: '/foo/bar'});
  assert.equal(bar.ready, true);

  baz._handleError(error);  // ignored, not listening to baz

  assert.equal(bar.count, 1);
  assert.equal(bar.listening, true);
  assert.equal(baz.count, 1);
  assert.ok(!baz.listening);

  context.dispatcher.retry.mock.mockImplementationOnce(() => Promise.resolve(true));
  const handlerPromise = bar._handleError(error);
  assert.equal(bar.ready, false);
  assert.equal(baz.ready, false);
  assert.equal(bar.listening, false);

  await handlerPromise;
  assert.equal(countCalls(
    context.dispatcher.retry, args => args[0] === context.op1 && args[1] === error
  ), 1);
  assert.equal(bar.listening, true);
  bar._handleSnapshot({path: '/foo/bar'});
  assert.equal(bar.ready, true);

  context.dispatcher.retry.mock.mockImplementationOnce(() => Promise.resolve(false));
  context.op1._disconnect.mock.mockImplementationOnce(() => {
    that.decouple('/foo/bar', context.op1);
  });
  await bar._handleError(error);

  assert.equal(countCalls(
    context.dispatcher.retry, args => args[0] === context.op1 && args[1] === error
  ), 2);
  assert.equal(countCalls(context.op1._disconnect, args => args[0] === error), 1);
  assert.equal(bar.listening, false);
  assert.equal(bar.count, 0);
  assert.equal(baz.listening, true);
  assert.equal(baz.count, 1);
});
