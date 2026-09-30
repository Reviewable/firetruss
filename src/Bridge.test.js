import {test} from 'node:test';
import assert from 'node:assert/strict';
import _ from 'lodash';

import './Truss.test.setup.js';
import Bridge, {isVersionSufficient} from './Bridge.js';

// `init()` is where the worker version is checked, so drive it with a stubbed `_send` that reports
// the version under test.
function checkVersion(version) {
  const bridge = _.create(Bridge.prototype, {
    _send: _.constant(Promise.resolve({version})),
    _shared: {}
  });
  return Bridge.prototype.init.call(bridge, {}, undefined)
    .then(_.constant('accepted'), error => error.message);
}

// The components have to be compared as numbers.  Compared as text a patch of '10' sorts below '2',
// so a worker past a two-digit boundary would be rejected against a minimum below it.  `init()`
// only shows that once the compiled-in minimum has a non-zero component, so the comparison it uses
// is exercised directly against minimums the constant may not currently hold.
test('version components are compared numerically, not as text', () => {
  assert.ok(isVersionSufficient('4.1.10', '4.1.2'), 'compared the patch as text');
  assert.ok(isVersionSufficient('4.10.0', '4.1.2'), 'compared the minor as text');
  assert.ok(isVersionSufficient('4.1.2', '4.1.2'), 'rejected an exact match');
  assert.ok(!isVersionSufficient('4.1.1', '4.1.2'), 'accepted a version below the minimum');
  assert.ok(!isVersionSufficient('5.0.0', '4.1.2'), 'accepted a mismatched major version');
});

test('a version below the minimum is rejected', async () => {
  const rejection = await checkVersion('3.9.9');
  assert.match(rejection, /^Incompatible Firetruss worker version: 3\.9\.9 /);
});

test('a mismatched major version is rejected', async () => {
  assert.match(await checkVersion('5.0.0'), /^Incompatible Firetruss worker version: 5\.0\.0 /);
});

// An unparseable version is left alone rather than treated as incompatible, as before.
test('an unparseable version is not judged', async () => {
  assert.equal(await checkVersion('dev'), 'accepted');
});
