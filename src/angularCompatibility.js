/* globals window */

import _ from 'lodash';


let digestRequested;
let bareDigest = function() {
  digestRequested = true;
};


const angularProxy = {
  active: typeof window !== 'undefined' && window.angular,
  debounceDigest(wait) {
    if (wait) {
      angularProxy.digest = _.debounce(bareDigest, wait);
    } else {
      angularProxy.digest = bareDigest;
    }
  }
};
['digest', 'watch', 'defineModule'].forEach(method => {angularProxy[method] = noop;});

if (angularProxy.active) {
  angularProxy.digest = bareDigest;
  angularProxy.watch = function() {throw new Error('Angular watch proxy not yet initialized');};
  window.angular.module('firetruss', []).run(['$rootScope', function($rootScope) {
    angularProxy.digest = function () {
      if (digestRequested) return;
      digestRequested = true;
      $rootScope.$evalAsync(function() {digestRequested = false;});
    };
    if (digestRequested) angularProxy.digest();
    angularProxy.watch = $rootScope.$watch.bind($rootScope);
  }]);
  angularProxy.defineModule = function(Truss) {
    window.angular.module('firetruss').constant('Truss', Truss);
  };
}

function noop() {}

export default angularProxy;
