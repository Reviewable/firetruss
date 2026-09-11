import {test} from 'node:test';
import assert from 'node:assert/strict';
import _ from 'lodash';

import './Truss.test.setup.js';
import Dispatcher from './Dispatcher.js';
import MetaTree from './MetaTree.js';

// The bridge doesn't await auth listeners, so it can deliver consecutive callbacks that overlap.
function createMetaTree({unauth} = {}) {
  let handleAuthChange;
  const unauthCalls = [];
  const bridge = {
    onAuth: (rootUrl, callback, context) => {handleAuthChange = callback.bind(context);},
    trackServer: () => undefined,
    on: () => undefined,
    off: () => undefined,
    unauth: () => {
      unauthCalls.push(true);
      return unauth ? unauth() : Promise.resolve();
    },
    authWithCustomToken: () => Promise.resolve(),
    authAnonymously: () => Promise.resolve()
  };
  const dispatcher = new Dispatcher(bridge);
  const metaTree = new MetaTree('https://example.firebaseio.com', {}, bridge, dispatcher);
  return {deliver: user => handleAuthChange(user), dispatcher, metaTree, unauthCalls};
}

// Mimics the client's key handling:  a sign-in installs the key before its user is published, and
// a sign-out releases it afterwards, both via an asynchronous worker.
function interceptCertifications(dispatcher, metaTree, log) {
  dispatcher.intercept('certify', {
    onBefore: op => {
      if (!op.operand) return;
      return Promise.resolve().then(() => Promise.resolve()).then(() => {log.push('install');});
    },
    onAfter: op => {
      if (op.operand || metaTree.root.user) return;
      return Promise.resolve().then(() => {log.push('release');});
    }
  });
}

function settle(promise) {
  return Promise.resolve(promise).then(_.constant('resolved'), error => error);
}

// Resolves to 'hung' rather than waiting forever, so a deadlock fails the assertion it belongs to
// instead of timing out the whole run.
function race(promise, label = 'hung') {
  return Promise.race([
    settle(promise),
    new Promise(resolve => {setTimeout(() => resolve(label), 250);})
  ]);
}

test('certifications are serialized when the bridge delivers them back to back', async () => {
  const {deliver, dispatcher, metaTree} = createMetaTree();
  const log = [];
  interceptCertifications(dispatcher, metaTree, log);

  const first = deliver({uid: 'github:1'});
  const second = deliver(null);
  await Promise.all([first, second]);

  assert.equal(metaTree.root.userid, null, 'published the users out of order');
  assert.deepEqual(log, ['install', 'release']);
});

test('a sign-in delivered during a sign-out keeps its key', async () => {
  const {deliver, dispatcher, metaTree} = createMetaTree();
  const log = [];
  interceptCertifications(dispatcher, metaTree, log);

  const first = deliver(null);
  const second = deliver({uid: 'github:2'});
  await Promise.all([first, second]);

  // Serialized, the sign-out releases first and the sign-in reinstalls; what must never happen is
  // ending with a published user and no key.
  assert.equal(metaTree.root.userid, 'github:2');
  assert.equal(log[log.length - 1], 'install', 'left a signed-in user without a key');
});

test('a sign-out queued behind a sign-in is not discarded as a duplicate', async () => {
  const {deliver, metaTree} = createMetaTree();
  // Establish a signed-out root first, so the duplicate check has a null to compare against.
  await deliver(null);
  assert.equal(metaTree.root.user, null);

  const first = deliver({uid: 'github:1'});
  const second = deliver(null);
  await Promise.all([first, second]);

  assert.equal(metaTree.root.userid, null, 'stayed signed in after a sign-out');
  assert.equal(metaTree.root.user, null);
});

test('a failed certification does not wedge the queue', async () => {
  const {deliver, dispatcher, metaTree} = createMetaTree();
  let fail = true;
  dispatcher.intercept('certify', {
    onBefore: () => {
      if (!fail) return;
      fail = false;
      return Promise.reject(new Error('interceptor blew up'));
    }
  });

  await deliver({uid: 'github:1'}).catch(() => undefined);
  await deliver({uid: 'github:2'});

  assert.equal(metaTree.root.userid, 'github:2');
});

// A bridge callback that arrives only after the queued turn has started is the case that defeats
// any synchronous "are we certifying" flag, so deliver the second one from inside onBefore.
test('a sign-out delivered after the sign-in turn starts is not discarded', async () => {
  const {deliver, dispatcher, metaTree} = createMetaTree();
  await deliver(null);
  let delivered;
  dispatcher.intercept('certify', {
    onBefore: op => {
      if (!op.operand || delivered) return;
      delivered = Promise.resolve(deliver(null)).catch(() => undefined);
      return Promise.resolve().then(() => Promise.resolve());
    }
  });

  await deliver({uid: 'github:1'});
  await delivered;

  assert.equal(metaTree.root.userid, null, 'the late sign-out was dropped');
});

test('a certify onBefore rejects its user by returning false', async () => {
  const {deliver, dispatcher, metaTree, unauthCalls} = createMetaTree();
  await deliver(null);
  dispatcher.intercept('certify', {onBefore: op => op.operand ? false : undefined});

  const error = await settle(deliver({uid: 'github:1'}));

  assert.equal(error.code, 'AUTH_REJECTED');
  assert.equal(metaTree.root.user, null, 'published a rejected user');
  assert.equal(unauthCalls.length, 1, 'never signed the worker out');
});

test('a rejection decided after an await still blocks publication', async () => {
  const {deliver, dispatcher, metaTree} = createMetaTree();
  await deliver(null);
  dispatcher.intercept('certify', {
    onBefore: async op => {
      if (!op.operand) return;
      await Promise.resolve();
      return false;
    }
  });

  const error = await settle(deliver({uid: 'github:1'}));

  assert.equal(error.code, 'AUTH_REJECTED');
  assert.equal(metaTree.root.user, null);
});

// All handlers have to settle before the verdict is acted on, or a rejecting handler could race a
// sibling that's still installing a key for the user being rejected.
test('a false verdict waits for a still-running async handler', async () => {
  const {deliver, dispatcher, metaTree} = createMetaTree();
  await deliver(null);
  const log = [];
  dispatcher.intercept('certify', {onBefore: op => op.operand ? false : undefined});
  dispatcher.intercept('certify', {
    onBefore: async op => {
      if (!op.operand) return;
      await Promise.resolve();
      await Promise.resolve();
      log.push('slow handler finished');
    }
  });

  const error = await settle(deliver({uid: 'github:1'}));

  assert.equal(error.code, 'AUTH_REJECTED');
  assert.deepEqual(log, ['slow handler finished'], 'acted on the verdict before handlers settled');
  assert.equal(metaTree.root.user, null);
});

test('authenticate rejects when its certification fails', async () => {
  const {deliver, dispatcher, metaTree} = createMetaTree();
  dispatcher.intercept('certify', {
    onBefore: op => {
      if (!op.operand) return;
      return Promise.reject(new Error('cannot certify'));
    }
  });

  // Establish an initial auth change first, so the delivered user isn't marked superseded before
  // it's ever certified.
  await deliver(null);

  // The bridge resolves the auth call, then delivers the user whose certification rejects.
  const authenticated = metaTree.authenticate('token');
  await Promise.resolve();
  Promise.resolve(deliver({uid: 'github:1'})).catch(() => undefined);

  await assert.rejects(authenticated, {message: 'cannot certify'});
  assert.equal(metaTree.root.userid, null);
});

test('authenticate rejects with AUTH_REJECTED when an interceptor refuses its user', async () => {
  const {deliver, dispatcher, metaTree} = createMetaTree();
  await deliver(null);
  dispatcher.intercept('certify', {onBefore: op => op.operand ? false : undefined});

  const authenticated = metaTree.authenticate('token');
  await Promise.resolve();
  Promise.resolve(deliver({uid: 'github:1'})).catch(() => undefined);

  const error = await settle(authenticated);
  assert.equal(error.code, 'AUTH_REJECTED');
  assert.equal(metaTree.root.user, null);
});

// Client calls are fully serialized, so the second waits for the first rather than interleaving
// with it and inheriting its certification.
test('a second auth call waits for the first to finish', async () => {
  const {deliver, dispatcher, metaTree} = createMetaTree();
  await deliver(null);
  const log = [];
  dispatcher.intercept('certify', {
    onBefore: op => {
      if (!op.operand) return;
      log.push(`certifying ${op.operand.uid}`);
      return Promise.resolve().then(() => Promise.resolve());
    }
  });

  const first = metaTree.authenticate('token-a');
  await Promise.resolve();
  Promise.resolve(deliver({uid: 'github:a'})).catch(() => undefined);
  const second = metaTree.authenticate('token-b');
  await Promise.resolve();

  await first;
  Promise.resolve(deliver({uid: 'github:b'})).catch(() => undefined);
  await second;

  assert.deepEqual(log, ['certifying github:a', 'certifying github:b']);
  assert.equal(metaTree.root.userid, 'github:b');
});

test('each auth call sees only its own certification failure', async () => {
  const {deliver, dispatcher, metaTree} = createMetaTree();
  await deliver(null);
  dispatcher.intercept('certify', {
    onBefore: op => {
      if (op.operand && op.operand.uid === 'github:a') {
        return Promise.reject(new Error('A rejected'));
      }
    }
  });

  const first = metaTree.authenticate('token-a');
  await Promise.resolve();
  Promise.resolve(deliver({uid: 'github:a'})).catch(() => undefined);
  await assert.rejects(first, {message: 'A rejected'});

  const second = metaTree.authenticate('token-b');
  await Promise.resolve();
  Promise.resolve(deliver({uid: 'github:b'})).catch(() => undefined);

  await second;
  assert.equal(metaTree.root.userid, 'github:b', 'the second call inherited the first failure');
});

test('an authentication that fails before certifying leaves the queue usable', async () => {
  const {deliver, dispatcher, metaTree} = createMetaTree();
  await deliver(null);
  let failNext = true;
  dispatcher.intercept('authenticate', {
    onBefore: () => {
      if (!failNext) return;
      failNext = false;
      return Promise.reject(new Error('authenticate rejected'));
    }
  });

  // This one dies without ever producing an auth callback, so it must not strand the next call.
  await assert.rejects(metaTree.authenticate('bad'), {message: 'authenticate rejected'});

  const authenticated = metaTree.authenticate('good');
  await Promise.resolve();
  Promise.resolve(deliver({uid: 'github:1'})).catch(() => undefined);

  assert.equal(await race(authenticated), 'resolved', 'the failed call stranded the queue');
  assert.equal(metaTree.root.userid, 'github:1');
});

// An already-null client user says nothing about the worker, which may still be authenticated.
test('unauthenticate signs the worker out even when the user is already null', async () => {
  const {deliver, metaTree, unauthCalls} = createMetaTree();
  await deliver(null);
  assert.equal(metaTree.root.user, null);

  await metaTree.unauthenticate();

  assert.equal(unauthCalls.length, 1, 'skipped the worker sign-out');
});

test('a logout failure reaches an unauthenticate onFailure', async () => {
  const {deliver, dispatcher, metaTree} =
    createMetaTree({unauth: () => Promise.reject(new Error('worker sign-out failed'))});
  await deliver({uid: 'github:1'});
  const failures = [];
  dispatcher.intercept('unauthenticate', {
    onFailure: op => {failures.push([op.method, op.error.message]);}
  });

  await assert.rejects(metaTree.unauthenticate(), {message: 'worker sign-out failed'});
  // onFailure callbacks are dispatched on a timeout.
  await new Promise(resolve => {setTimeout(resolve, 0);});

  assert.deepEqual(failures, [['unauthenticate', 'worker sign-out failed']]);
});

test('a null certification failure reaches an unauthenticate onFailure', async () => {
  const {deliver, dispatcher, metaTree, unauthCalls} = createMetaTree();
  await deliver({uid: 'github:1'});
  const failures = [];
  dispatcher.intercept('certify', {
    onBefore: op => {
      if (op.operand) return;
      return Promise.reject(new Error('key cleanup failed'));
    }
  });
  dispatcher.intercept('unauthenticate', {
    onFailure: op => {failures.push([op.method, op.error.message]);}
  });

  await assert.rejects(metaTree.unauthenticate(), {message: 'key cleanup failed'});
  await new Promise(resolve => {setTimeout(resolve, 0);});

  assert.deepEqual(failures, [['unauthenticate', 'key cleanup failed']]);
  assert.equal(unauthCalls.length, 0, 'signed the worker out despite failed cleanup');
});

// The sign-out that clears a rejected candidate matters more than the rejection that caused it.
test('a failed forced sign-out takes precedence over the rejection', async () => {
  const {deliver, dispatcher, metaTree} =
    createMetaTree({unauth: () => Promise.reject(new Error('worker sign-out failed'))});
  await deliver(null);
  dispatcher.intercept('certify', {onBefore: op => op.operand ? false : undefined});

  const error = await settle(deliver({uid: 'github:1'}));

  assert.equal(error.message, 'worker sign-out failed');
  assert.equal(metaTree.root.user, null);
});

// Reentrant public auth calls from a certification interceptor are not supported;  an interceptor
// rejects its user by returning false instead.  Verify the documented behaviour rather than a hang.
test('a nested public auth call from an interceptor is not supported', async () => {
  const {deliver, dispatcher, metaTree} = createMetaTree();
  await deliver(null);
  let nested;
  dispatcher.intercept('certify', {
    onAfter: op => {
      if (!op.operand || nested) return;
      nested = metaTree.unauthenticate();
      return race(nested);
    }
  });

  assert.equal(await race(deliver({uid: 'github:1'})), 'hung');
});
