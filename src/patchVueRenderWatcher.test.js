import {afterEach, mock, test} from 'node:test';
import assert from 'node:assert/strict';
import Vue from 'vue';
import _ from 'lodash';

import {patchRenderWatcherGet} from './patchVueRenderWatcher.js';


const originalErrorHandler = Vue.config.errorHandler;

afterEach(() => {
  Vue.config.errorHandler = originalErrorHandler;
  mock.reset();
});

test('routes render watcher errors to the Vue error handler', () => {
  const error = new Error('render failed');
  const prototype = {get() {throw error;}};
  const watcher = _.create(prototype);
  watcher.vm = {_watcher: watcher};
  Vue.config.errorHandler = mock.fn();

  patchRenderWatcherGet(prototype);
  assert.doesNotThrow(() => watcher.get());
  assert.deepEqual(
    Vue.config.errorHandler.mock.calls[0].arguments,
    [error, watcher.vm, 'uncaught render error']
  );
});

test('rethrows errors from non-render watchers', () => {
  const error = new Error('watch failed');
  const prototype = {get() {throw error;}};
  const watcher = _.create(prototype);
  watcher.vm = {};
  Vue.config.errorHandler = mock.fn();

  patchRenderWatcherGet(prototype);
  assert.throws(() => watcher.get(), error);
  assert.equal(Vue.config.errorHandler.mock.callCount(), 0);
});
