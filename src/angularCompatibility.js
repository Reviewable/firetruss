/* globals window */

import _ from 'lodash';
import Vue from 'vue';


const vue = new Vue({data: {digestRequest: 0}});
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
  ['digest', 'watch', 'defineModule', 'debounceDigest'].forEach(method => {
    angularProxy[method] = noop;
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
        vue.$watch(() => vue.digestRequest, () => {
          if (vue.digestRequest > lastDigestRequest) {
            digestInProgress = true;
            rootScope.$digest.original.call(rootScope);
            lastDigestRequest = vue.digestRequest = vue.digestRequest + 1;
          } else {
            digestInProgress = false;
          }
        });
        _.last(vue._watchers).id = Infinity;  // make sure watcher is scheduled last
        return rootScope;
      }
    ]);
  }]);
}

function noop() {}

export default angularProxy;
