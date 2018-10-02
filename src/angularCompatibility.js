/* globals window */

import _ from 'lodash';
import Vue from 'vue';


let vue;
let lastDigestRequest = 0, digestInProgress = false;
const bareDigest = function() {
  if (vue.digestRequest > lastDigestRequest) return;
  vue.digestRequest = lastDigestRequest + 1;
};

const angularProxy = {
  active: typeof window !== 'undefined' && window.angular
};

if (angularProxy.active) {
  initAngular();
} else {
  _.forEach(['digest', 'watch', 'defineModule', 'debounceDigest'], method => {
    angularProxy[method] = _.noop;
  });
}

function initAngular() {
  const module = window.angular.module('firetruss', []);
  angularProxy.digest = bareDigest;
  angularProxy.watch = function() {throw new Error('Angular watch proxy not yet initialized');};
  angularProxy.defineModule = function(Truss) {
    module.constant('Truss', Truss);
  };
  angularProxy.debounceDigest = function(wait) {
    if (wait) {
      const debouncedDigest = _.debounce(bareDigest, wait);
      angularProxy.digest = function() {
        if (vue.digestRequest > lastDigestRequest) return;
        if (digestInProgress) bareDigest(); else debouncedDigest();
      };
    } else {
      angularProxy.digest = bareDigest;
    }
  };

  module.config(['$provide', function($provide) {
    $provide.decorator('$rootScope', ['$delegate', '$exceptionHandler',
      function($delegate, $exceptionHandler) {
        const rootScope = $delegate;
        angularProxy.watch = rootScope.$watch.bind(rootScope);
        const proto = Object.getPrototypeOf(rootScope);
        const angularDigest = proto.$digest;
        proto.$digest = bareDigest;
        proto.$digest.original = angularDigest;
        vue = new Vue({data: {digestRequest: 0}});
        vue.$watch(() => vue.digestRequest, () => {
          if (vue.digestRequest > lastDigestRequest) {
            // Make sure we execute the digest outside the Vue task queue, because otherwise if the
            // client replaced Promise with angular.$q all Truss.nextTick().then() functions will be
            // executed inside the Angular digest and hence inside the Vue task queue. But
            // Truss.nextTick() is used precisely to avoid that.  Note that it's OK to use
            // Vue.nextTick() here because even though it will schedule a flush via Promise.then()
            // it only uses the native Promise, before it could've been monkey-patched by the app.
            Vue.nextTick(() => {
              if (vue.digestRequest <= lastDigestRequest) return;
              digestInProgress = true;
              rootScope.$digest.original.call(rootScope);
              lastDigestRequest = vue.digestRequest = vue.digestRequest + 1;
            });
          } else {
            digestInProgress = false;
          }
        });
        _.last(vue._watchers).id = Infinity;  // make sure watcher is scheduled last
        patchRenderWatcherGet(Object.getPrototypeOf(_.last(vue._watchers)));
        return rootScope;
      }
    ]);
  }]);
}

// This is a kludge that catches errors that get through render watchers and end up killing the
// entire Vue event loop (e.g., errors raised in transition callbacks).  The state of the DOM may
// not be consistent after such an error is caught, but the global error handler should stop the
// world anyway.  May be related to https://github.com/vuejs/vue/issues/7653.
function patchRenderWatcherGet(prototype) {
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

export default angularProxy;
