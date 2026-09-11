import {test} from 'node:test';
import assert from 'node:assert/strict';

import './Truss.test.setup.js';
import Dispatcher from './Dispatcher.js';
import MetaTree from './MetaTree.js';

// The bridge doesn't await auth listeners, so it can deliver consecutive callbacks that overlap.
function createMetaTree() {
  let handleAuthChange;
  const bridge = {
    onAuth: (rootUrl, callback, context) => {handleAuthChange = callback.bind(context);},
    trackServer: () => undefined,
    on: () => undefined,
    off: () => undefined,
    unauth: () => Promise.resolve(),
    authWithCustomToken: () => Promise.resolve(),
    authAnonymously: () => Promise.resolve()
  };
  const dispatcher = new Dispatcher(bridge);
  const metaTree = new MetaTree('https://example.firebaseio.com', {}, bridge, dispatcher);
  return {deliver: user => handleAuthChange(user), dispatcher, metaTree};
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

test('an interceptor that triggers a nested auth change does not deadlock', async () => {
  const {deliver, dispatcher, metaTree} = createMetaTree();
  let nested;
  dispatcher.intercept('certify', {
    onAfter: op => {
      if (!op.operand || nested) return;
      // An interceptor reacting to a sign-in by signing back out, e.g. a client that rejects the
      // user it was just handed.
      nested = metaTree.unauthenticate();
      return nested;
    }
  });

  await deliver({uid: 'github:1'});
  await nested;

  assert.equal(metaTree.root.userid, null);
});

test('authenticate rejects when its certification fails', async () => {
  const {deliver, dispatcher, metaTree} = createMetaTree();
  dispatcher.intercept('certify', {
    onBefore: op => {
      if (!op.operand) return;
      return Promise.reject(new Error('cannot certify'));
    }
  });

  // Establish an initial auth change first, so authenticate()'s serial bump doesn't mark the
  // delivered user as superseded before it's ever certified.
  await deliver(null);

  // The bridge resolves the auth call, then delivers the user whose certification rejects.
  const authenticated = metaTree.authenticate('token');
  await Promise.resolve();
  Promise.resolve(deliver({uid: 'github:1'})).catch(() => undefined);

  await assert.rejects(authenticated, {message: 'cannot certify'});
  assert.equal(metaTree.root.userid, null);
});

test('two nested auth changes from one interceptor both complete', async () => {
  const {deliver, dispatcher, metaTree} = createMetaTree();
  const reached = [];
  dispatcher.intercept('certify', {
    onAfter: async op => {
      if (!op.operand || reached.length) return;
      reached.push('first');
      await metaTree.unauthenticate();
      reached.push('second');
      await metaTree.unauthenticate();
      reached.push('done');
    }
  });

  await deliver({uid: 'github:1'});

  assert.deepEqual(reached, ['first', 'second', 'done']);
});

// The bridge can deliver several auth callbacks and RPC resolutions in a single inbound batch, so
// every callback runs before any authenticate() continuation resumes.
function deliverBatch(deliver, entries) {
  for (const entry of entries) Promise.resolve(deliver(entry)).catch(() => undefined);
}

test('overlapping authentications each see their own certification failure', async () => {
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
  const second = metaTree.authenticate('token-b');
  await Promise.resolve();
  deliverBatch(deliver, [{uid: 'github:a'}, {uid: 'github:b'}]);

  await assert.rejects(first, {message: 'A rejected'}, 'first inherited the second result');
  await second;
});

test('overlapping authentications do not inherit a later failure', async () => {
  const {deliver, dispatcher, metaTree} = createMetaTree();
  await deliver(null);
  dispatcher.intercept('certify', {
    onBefore: op => {
      if (op.operand && op.operand.uid === 'github:b') {
        return Promise.reject(new Error('B rejected'));
      }
    }
  });

  const first = metaTree.authenticate('token-a');
  const second = metaTree.authenticate('token-b');
  await Promise.resolve();
  deliverBatch(deliver, [{uid: 'github:a'}, {uid: 'github:b'}]);

  await first;
  await assert.rejects(second, {message: 'B rejected'});
});
