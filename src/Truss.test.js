import {mock, test} from 'node:test';
import assert from 'node:assert/strict';
import _ from 'lodash';

import './Truss.test.setup.js';
import Truss from './Truss.js';
import {Reference} from './Reference.js';


test('wait for remote data updates resolves immediately when none are pending', async () => {
  const waitForRemoteDataUpdates = mock.fn();
  const nextTick = mock.fn();
  const truss = {_tree: {waitForRemoteDataUpdates}, nextTick};

  const promise = Truss.prototype.waitForThrottledRemoteDataUpdates.call(truss);
  let resolved = false;
  promise.then(() => {resolved = true;});
  await Promise.resolve();

  assert.equal(resolved, true);
  assert.equal(waitForRemoteDataUpdates.mock.calls.length, 1);
  assert.equal(nextTick.mock.calls.length, 0);
});

test('wait for remote data updates adds a next tick after pending snapshots', async () => {
  let resolveRemoteDataUpdates;
  const remoteDataUpdates = new Promise(resolve => {resolveRemoteDataUpdates = resolve;});
  let resolveNextTick;
  const nextTickPromise = new Promise(resolve => {resolveNextTick = resolve;});
  const waitForRemoteDataUpdates = mock.fn(() => remoteDataUpdates);
  const nextTick = mock.fn(() => nextTickPromise);
  const truss = {_tree: {waitForRemoteDataUpdates}, nextTick};

  const promise = Truss.prototype.waitForThrottledRemoteDataUpdates.call(truss);
  let resolved = false;
  promise.then(() => {resolved = true;});
  resolveRemoteDataUpdates();
  await Promise.resolve();

  assert.equal(nextTick.mock.calls.length, 1);
  assert.equal(resolved, false);

  resolveNextTick();
  await promise;
  assert.equal(resolved, true);
});


for (const outcome of ['failure', 'success']) {
  test(`peek ignores queued failures after ${outcome} cleanup`, async () => {
    let onFailure, onReady;
    const disconnect = mock.fn();
    const unintercept = mock.fn();
    const unobserve = mock.fn();
    const tree = {connectReference: () => disconnect, getObject: _.constant(42)};
    const target = new Reference(tree, '/value');
    const truss = {
      _tree: tree,
      intercept(method, callbacks) {
        assert.equal(method, 'peek');
        onFailure = callbacks.onFailure;
        return unintercept;
      },
      observe(subject, callback) {onReady = callback; return unobserve;}
    };
    const promise = Truss.prototype.peek.call(truss, target);
    await Promise.resolve();

    // Dispatcher snapshots callbacks before deferring their invocation with setTimeout.
    const error = new Error('original read failure');
    const queuedFailure = () => onFailure({target, error});
    if (outcome === 'failure') {
      queuedFailure();
      await assert.rejects(promise, error);
    } else {
      onReady(true);
      assert.equal(await promise, 42);
    }

    assert.equal(disconnect.mock.calls.length, 1);
    assert.equal(unintercept.mock.calls.length, 1);
    assert.equal(unobserve.mock.calls.length, 1);
    assert.doesNotThrow(queuedFailure);
    assert.equal(disconnect.mock.calls.length, 1);
  });
}
