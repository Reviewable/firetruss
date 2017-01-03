/* globals window */

const angularProxy = {active: typeof window !== 'undefined' && window.angular};
['digest', 'watch', 'defineModule'].forEach(method => {angularProxy[method] = noop;});

if (angularProxy.active) {
  window.angular.module('firetruss', []).run(['$rootScope', function($rootScope) {
    angularProxy.digest = $rootScope.$evalAsync.bind($rootScope);
    angularProxy.watch = $rootScope.$watch.bind($rootScope);
  }]);
  angularProxy.defineModule = function(Truss) {
    window.angular.module('firetruss').constant('Truss', Truss);
  };
}

function noop() {}

export default angularProxy;
