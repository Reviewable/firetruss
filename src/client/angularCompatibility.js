/* globals window */

let triggerAngularDigest;

const exports = {active: typeof window !== 'undefined' && window.angular};
export default exports;

if (exports.active) {
  window.angular.module('firetruss', []).run(
    ['$rootScope', function($rootScope) {
      triggerAngularDigest = $rootScope.$evalAsync.bind($rootScope);
    }]
  );
  exports.defineModule = function(Truss) {
    window.angular.module('firetruss').constant('Truss', Truss);
  };
} else {
  exports.defineModule = function() {};
}

exports.digest = function() {
  if (triggerAngularDigest) triggerAngularDigest();
};
