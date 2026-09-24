import {test} from 'node:test';
import assert from 'node:assert/strict';
import _ from 'lodash';

import './Truss.test.setup.js';
import Dispatcher from './Dispatcher.js';
import MetaTree from './MetaTree.js';

// The bridge doesn't await auth listeners, so it can deliver consecutive callbacks that overlap.
// Pass `withholdAuth` to keep the auth RPCs pending until `resolveAuth()` releases them by token,
// which is how a call's own certification result gets separated from later background ones.
function createMetaTree({unauth, withholdAuth, authResults = {}} = {}) {
  let handleAuthChange;
  const unauthCalls = [];
  const authCalls = [];
  const pendingAuth = new Map();
  // The worker resolves an auth request with the user it signed in (`userToJson(result.user)`), so
  // the stub does too:  a call uses that to know an auth change answering it is on its way.
  const authenticate = token => {
    authCalls.push(token);
    if (!withholdAuth) return Promise.resolve(authResults[token]);
    return new Promise(resolve => {pendingAuth.set(token, resolve);});
  };
  const bridge = {
    onAuth: (rootUrl, callback, context) => {handleAuthChange = callback.bind(context);},
    trackServer: () => undefined,
    on: () => undefined,
    off: () => undefined,
    unauth: () => {
      unauthCalls.push(true);
      return unauth ? unauth() : Promise.resolve();
    },
    authWithCustomToken: (rootUrl, token) => authenticate(token),
    authAnonymously: () => authenticate(undefined)
  };
  const dispatcher = new Dispatcher(bridge);
  const metaTree = new MetaTree('https://example.firebaseio.com', {}, bridge, dispatcher);
  return {
    deliver: user => handleAuthChange(user),
    dispatcher, metaTree, unauthCalls, authCalls,
    resolveAuth: (token, user) => {
      const resolve = pendingAuth.get(token);
      assert.ok(resolve, `no auth RPC pending for ${token}`);
      pendingAuth.delete(token);
      resolve(user);
    }
  };
}

// Lets every already-scheduled microtask and timer callback run, so that a test can assert on what
// the implementation did or didn't start rather than on a fixed number of ticks.
function drain() {
  return new Promise(resolve => {setTimeout(resolve, 10);});
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

// pkaminski:  the 'rejected' outcome used to be examined only after Dispatcher.execute() had
// finished onAfter, so a throwing certify onAfter skipped the sign-out entirely and left Firebase
// holding a login the client had refused, with no unauthenticate.onFailure to detect it.
test('a rejected candidate is signed out even when a certify onAfter fails', async () => {
  const {deliver, dispatcher, metaTree, unauthCalls} = createMetaTree();
  await deliver(null);
  dispatcher.intercept('certify', {
    onBefore: op => op.operand ? false : undefined,
    onAfter: op => {
      if (op.operand) throw new Error('after hook failed');
    }
  });

  const error = await settle(deliver({uid: 'github:1'}));

  assert.equal(error.message, 'after hook failed', 'lost the hook error');
  assert.equal(metaTree.root.user, null, 'published a rejected user');
  assert.equal(unauthCalls.length, 1, 'skipped the worker sign-out for a rejected candidate');
});

test('a failed sign-out outranks a certify onAfter failure', async () => {
  const {deliver, dispatcher} =
    createMetaTree({unauth: () => Promise.reject(new Error('worker sign-out failed'))});
  await deliver(null);
  const failures = [];
  dispatcher.intercept('certify', {
    onBefore: op => op.operand ? false : undefined,
    onAfter: op => {
      if (op.operand) throw new Error('after hook failed');
    }
  });
  dispatcher.intercept('unauthenticate', {onFailure: op => {failures.push(op.method);}});

  const error = await settle(deliver({uid: 'github:1'}));
  // onFailure callbacks are dispatched on a timeout.
  await new Promise(resolve => {setTimeout(resolve, 0);});

  assert.equal(error.message, 'worker sign-out failed');
  assert.deepEqual(failures, ['unauthenticate'], 'the logout failure never reached an onFailure');
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
// Repro tests appended to MetaTree.test.js

// pkaminski gh-4033197670:  resetting the certification chain when a call claims the queue orphans
// an in-flight certification.  The paused certification completes against the orphaned tail and
// publishes its user, while the sign-out delivered meanwhile was dropped as a duplicate by
// comparing against a root that the orphaned turn hadn't updated yet.
test('a sign-out delivered while a call waits on a paused certification is not lost', async () => {
  const {deliver, dispatcher, metaTree} = createMetaTree();
  await deliver(null);
  let release;
  dispatcher.intercept('certify', {
    onBefore: op => {
      if (op.operand && op.operand.uid === 'old') {
        return new Promise(resolve => {release = resolve;});
      }
    }
  });

  // An unsolicited sign-in parks in onBefore, before the root has been updated.
  const oldCertification = Promise.resolve(deliver({uid: 'old'})).catch(() => undefined);
  await Promise.resolve();

  // The app issues a call while that certification is still paused, then the bridge reports a
  // sign-out that supersedes it.
  const authenticated = metaTree.authenticate('next');
  await Promise.resolve();
  const signedOut = Promise.resolve(deliver(null)).catch(() => undefined);
  await Promise.resolve();

  release();
  await Promise.all([oldCertification, signedOut]);
  await race(authenticated);

  assert.notEqual(metaTree.root.userid, 'old', 'published the stale user after a sign-out');
});

// pkaminski gh-4033197683:  clearing pendingFailure when a call claims the queue lets the orphaned
// tail's recovery handler refill the slot, so the new call rejects with a background error.
test('a background certification failure does not leak into the next call', async () => {
  const {deliver, dispatcher, metaTree} = createMetaTree();
  await deliver(null);
  let release, paused;
  dispatcher.intercept('certify', {
    onBefore: op => {
      if (!op.operand) return;
      if (op.operand.uid === 'background' && !paused) {
        paused = true;
        return new Promise((resolve, reject) => {release = reject;});
      }
    }
  });

  const background = Promise.resolve(deliver({uid: 'background'})).catch(() => undefined);
  await Promise.resolve();

  const authenticated = metaTree.authenticate('token');
  await Promise.resolve();
  release(new Error('old background failure'));
  await background;
  Promise.resolve(deliver({uid: 'new'})).catch(() => undefined);

  assert.equal(
    await race(authenticated), 'resolved', 'the call inherited a background failure');
  assert.equal(metaTree.root.userid, 'new');
});

// pkaminski gh-4033197643:  a call must finish on the certification result captured when its RPC
// settled, not on whatever the chain holds later.  A background failure arriving after settlement
// belongs to the next turn's drain, not to this call.
// pkaminski gh-4033197643:  a call must finish on the certification result captured when its RPC
// settled, not on whatever the chain holds later.  A background failure arriving after settlement
// belongs to the next turn's drain, not to this call.
test(
  'a certification failing after the RPC settles does not fail the call',
  async () => {
    const {deliver, dispatcher, metaTree} = createMetaTree();
    await deliver(null);
    let release, held;
    // Resolves once the held certification has actually entered onBefore, so the test doesn't have
    // to guess how many ticks that takes.
    const reached = new Promise(resolveReached => {
      dispatcher.intercept('certify', {
        onBefore: op => {
          if (!op.operand) return;
          if (op.operand.uid === 'late') {
            return Promise.reject(new Error('late background failure'));
          }
          if (held) return;
          held = true;
          return new Promise(resolve => {
            release = resolve;
            resolveReached();
          });
        }
      });
    });

    const authenticated = race(metaTree.authenticate('token'));
    await drain();
    // Hold this call's own certification open, then let it finish, so the call's window closes.
    Promise.resolve(deliver({uid: 'mine'})).catch(() => undefined);
    await reached;
    release();
    await drain();
    // Only now does an unrelated background certification fail;  it belongs to no call.
    Promise.resolve(deliver({uid: 'late'})).catch(() => undefined);

    assert.equal(await authenticated, 'resolved', 'a later background failure failed the call');
  });

// pkaminski gh-4033197605:  with a shared failure slot the first call to finish consumed it and the
// outcomes got crossed.  These two document that each call reports its own outcome once
// `firetruss-worker` delivers auth changes in Firebase's order, each with its own response;  they
// pass against the shared slot too, since that ordering alone avoids the crossing.  The unordered
// batch that crossed them is covered by firetruss-worker#27, not here.
function testBatchedAuthCalls(failing) {
  test(
    `batched auth calls report their own outcome when ${failing} fails`,
    async () => {
      const {deliver, dispatcher, metaTree, resolveAuth} = createMetaTree({withholdAuth: true});
      await deliver(null);
      dispatcher.intercept('certify', {
        onBefore: op => {
          if (op.operand && op.operand.uid === failing) {
            return Promise.reject(new Error(`${failing} failed`));
          }
        }
      });

      // Both calls are issued before either worker response comes back, but each call's callback
      // arrives with its own response:  `firetruss-worker` serializes the `userToJson` results, so
      // a later callback can't overtake an earlier request's.
      const first = race(metaTree.authenticate('token-a'));
      const second = race(metaTree.authenticate('token-b'));
      await drain();
      Promise.resolve(deliver({uid: 'a'})).catch(() => undefined);
      resolveAuth('token-a');
      await drain();
      Promise.resolve(deliver({uid: 'b'})).catch(() => undefined);
      resolveAuth('token-b');

      const outcomes = {a: await first, b: await second};
      const other = failing === 'a' ? 'b' : 'a';
      assert.equal(
        outcomes[failing].message, `${failing} failed`,
        `${failing} did not report its own failure`);
      assert.equal(outcomes[other], 'resolved', `${other} inherited ${failing}'s failure`);
    });
}

testBatchedAuthCalls('a');
testBatchedAuthCalls('b');

// pkaminski gh-4033197560:  the operation's own failure has to win over a certification failure it
// provoked, which is what the comment in _runAuthCall promises.
test('a logout failure takes precedence over a concurrent certification failure', async () => {
  const {deliver, dispatcher, metaTree} =
    createMetaTree({unauth: () => Promise.reject(new Error('worker logout failure'))});
  await deliver({uid: 'github:1'});
  dispatcher.intercept('certify', {
    onBefore: op => {
      if (op.operand) return Promise.reject(new Error('background certification failure'));
    }
  });

  const unauthenticated = metaTree.unauthenticate();
  await Promise.resolve();
  Promise.resolve(deliver({uid: 'background'})).catch(() => undefined);

  const error = await race(unauthenticated);
  assert.equal(error.message, 'worker logout failure', 'the certification error won');
});

// pkaminski gh-4033197643:  "capture a fixed certification result at RPC settlement, preserving
// that snapshot's errors".  Documents the boundary rather than pinning a fix:  it passes against
// the shared failure slot as well, since a single call has nothing to cross with.
// The auth change that answers a call arrives in the same batch as the
// response and ahead of it, since Firebase fires `onIdTokenChanged` before resolving the sign-in
// and `firetruss-worker` preserves that order, so the call must report that certification's
// failure.
test('a call reports the failure of the certification that answered it', async () => {
  const {deliver, dispatcher, metaTree, resolveAuth} = createMetaTree({withholdAuth: true});
  await deliver(null);
  dispatcher.intercept('certify', {
    onBefore: op => op.operand ? Promise.reject(new Error('cannot certify')) : undefined
  });

  const authenticated = race(metaTree.authenticate('token'));
  await drain();
  // One batch, applied synchronously:  the auth change, then the response that carries the user.
  Promise.resolve(deliver({uid: 'github:1'})).catch(() => undefined);
  resolveAuth('token', {uid: 'github:1'});

  const error = await authenticated;
  assert.equal(error.message, 'cannot certify', 'the call lost its own certification failure');
  assert.equal(metaTree.root.user, null, 'published an uncertified user');
});

// pkaminski gh-4033197718:  waiting for the previous certification tail doesn't wait for the
// previous auth operation, so both RPCs go out.  The queue has to cover the whole operation.
test('a second auth call does not start until the first operation finishes', async () => {
  const {deliver, dispatcher, metaTree, authCalls, resolveAuth} =
    createMetaTree({withholdAuth: true});
  await deliver(null);
  const log = [];
  dispatcher.intercept('authenticate', {onBefore: op => {log.push(`before ${op.operand}`);}});

  const first = settle(metaTree.authenticate('token-a'));
  const second = settle(metaTree.authenticate('token-b'));
  await drain();

  assert.deepEqual(authCalls, ['token-a'], 'sent the second RPC before the first finished');
  assert.deepEqual(log, ['before token-a'], 'ran the second call\'s interceptors early');

  resolveAuth('token-a');
  Promise.resolve(deliver({uid: 'a'})).catch(() => undefined);
  assert.equal(await race(first), 'resolved');
  await drain();
  resolveAuth('token-b');
  Promise.resolve(deliver({uid: 'b'})).catch(() => undefined);

  assert.equal(await race(second), 'resolved');
  assert.deepEqual(authCalls, ['token-a', 'token-b']);
});
