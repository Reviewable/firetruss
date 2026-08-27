import {mock, test} from 'node:test';
import assert from 'node:assert/strict';

import './Truss.test.setup.js';
import Truss from './Truss.js';


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
