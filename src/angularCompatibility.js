/* globals window */

import _ from 'lodash';


let earlyDigestPending;
let bareDigest = function() {
  earlyDigestPending = true;
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
['digest', 'defineModule'].forEach(method => {angularProxy[method] = noop;});

if (angularProxy.active) {
  angularProxy.digest = bareDigest;
  window.angular.module('firetruss', []).run(['$rootScope', function($rootScope) {
    bareDigest = $rootScope.$evalAsync.bind($rootScope);
    if (earlyDigestPending) bareDigest();
  }]);
  angularProxy.defineModule = function(Truss) {
    window.angular.module('firetruss').constant('Truss', Truss);
  };
}

function noop() {}

export default angularProxy;
