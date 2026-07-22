import Vue from 'vue';
import _ from 'lodash';


export default function patchVueRenderWatcher() {
  const vue = new Vue();
  const unwatch = vue.$watch(_.noop, _.noop);
  const watchers = vue._watchers || vue._scope.effects;
  patchRenderWatcherGet(Object.getPrototypeOf(watchers[watchers.length - 1]));
  unwatch();
  vue.$destroy();
}

// This is a kludge that catches errors that get through render watchers and end up killing the
// entire Vue event loop (e.g., errors raised in transition callbacks).  The state of the DOM may
// not be consistent after such an error is caught, but the global error handler should stop the
// world anyway.  May be related to https://github.com/vuejs/vue/issues/7653.
export function patchRenderWatcherGet(prototype) {
  const originalGet = prototype.get;
  prototype.get = function get() {
    try {
      return originalGet.call(this);
    } catch (e) {
      if (this.vm._watcher === this && Vue.config.errorHandler) {
        Vue.config.errorHandler(e, this.vm, 'uncaught render error');
      } else {
        throw e;
      }
    }
  };
}
