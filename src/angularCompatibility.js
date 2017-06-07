/* globals window */

import _ from 'lodash';


let digestRequested;
let bareDigest = function() {
  digestRequested = true;
};
function indirectBareDigest() {
  bareDigest();
}

const angularProxy = {
  active: typeof window !== 'undefined' && window.angular,
  debounceDigest(wait) {
    // Bind indirectly, so we always pick up the latest definition of bareDigest.
    if (wait) {
      angularProxy.digest = _.debounce(indirectBareDigest, wait);
    } else {
      angularProxy.digest = indirectBareDigest;
    }
  }
};

if (angularProxy.active) {
  angularProxy.digest = indirectBareDigest;
  angularProxy.watch = function() {throw new Error('Angular watch proxy not yet initialized');};
  window.angular.module('firetruss', []).run(['$rootScope', function($rootScope) {
    bareDigest = function() {
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
} else {
  ['digest', 'watch', 'defineModule'].forEach(method => {angularProxy[method] = noop;});
}

function noop() {}

export default angularProxy;
