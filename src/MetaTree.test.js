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
    off: () => undefined
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
