import {afterEach, beforeEach, mock, test} from 'node:test';
import assert from 'node:assert/strict';
import Vue from 'vue';

import Tree from './Tree.js';
import {promiseCancel} from './utils/promises.js';

/* eslint-disable lodash/prefer-constant */

class Root {
  static get $trussMount() {return '/';}
  constructor() {
    this.x = 1;
  }

  get y() {
    return this.x + 1;
  }

  get z() {
    return this.a + 1;
  }

  get v() {
    return this.sub && this.sub.y + 10;
  }

  get w() {
    return this.sub && this.sub.z + 10;
  }

  makeA() {
    Vue.set(this, 'a', 2);
  }

  get complex() {
    return {b: this.x || 5};
  }

  get derived() {
    return this.complex.b + 1;
  }
}

class Subroot {
  static get $trussMount() {return '/sub';}
  get y() {
    return this.$parent.x + 2;
  }

  get z() {
    return this.$parent.a + 2;
  }
}

class SubrootFoo {
  static get $trussMount() {return '/sub/foo';}
}

let earlyObserver;
let context;

class EarlyObservedRoot {
  static get $trussMount() {return '/';}

  constructor() {
    earlyObserver = new Vue({data: {scope: this}});
    Vue.set(this, 'source', undefined);
  }

  get derived() {
    return this.source;
  }
}

beforeEach(() => {
  context = {
    rootUrl: 'https://example.firebaseio.com',
    bridge: {on: mock.fn(), off: mock.fn()},
    dispatcher: {clearReady: mock.fn(), markReady: mock.fn(), retry: mock.fn()},
    truss: {get root() {return context.tree.root;}}
  };
  context.tree = new Tree(
    context.truss, context.rootUrl, context.bridge, context.dispatcher);
  context.tree.init([Root, SubrootFoo, Subroot]);
});

afterEach(() => {
  context.tree.destroy();
  if (earlyObserver) {
    earlyObserver.$destroy();
    earlyObserver = null;
  }
  mock.reset();
  context = undefined;
});

test('initialize placeholders', () => {
  const tree = context.tree;
  assert.equal(tree.root.constructor, Root);
  assert.equal(tree.root.sub.constructor, Subroot);
  assert.equal(tree.root.sub.foo.constructor, SubrootFoo);
});

function testModelInheritanceMountOrder(orderName, orderClasses) {
  test(`mount model inheritance ${orderName}`, () => {
    class TopLocator {
      static get $trussMount() {return '/top-locators/$reviewKey';}

      get inheritedComputed() {
        return `review=${this.$reviewKey}`;
      }
    }

    class Locator extends TopLocator {
      static get $trussMount() {return '/locators/$reviewKey/$locatorKey';}
    }

    const tree = new Tree(
      context.truss, context.rootUrl, context.bridge, context.dispatcher);
    try {
      tree.init(orderClasses(TopLocator, Locator));
      const topLocator = tree._createObject('/top-locators/top-review', tree.root);
      tree._fixObject(topLocator);
      tree._completeCreateObject(topLocator);
      const locator = tree._createObject('/locators/review-1/locator-1', tree.root);
      tree._fixObject(locator);
      tree._completeCreateObject(locator);

      assert.equal(topLocator.constructor, TopLocator);
      assert.equal(topLocator.$reviewKey, 'top-review');
      assert.equal(topLocator.inheritedComputed, 'review=top-review');
      assert.equal(locator.constructor, Locator);
      assert.equal(locator.$reviewKey, 'review-1');
      assert.equal(locator.$locatorKey, 'locator-1');
      assert.equal(locator.inheritedComputed, 'review=review-1');
    } finally {
      tree.destroy();
    }
  });
}

testModelInheritanceMountOrder('base first', (TopLocator, Locator) => [TopLocator, Locator]);
testModelInheritanceMountOrder('subclass first', (TopLocator, Locator) => [Locator, TopLocator]);

test('reject user-defined reserved properties', () => {
  class ReservedProperty {
    static get $trussMount() {return '/reserved';}
    get $userDefined() {return true;}
  }

  const tree = new Tree(
    context.truss, context.rootUrl, context.bridge, context.dispatcher);
  try {
    assert.throws(
      () => tree.init([ReservedProperty]),
      /Property names starting with "\$" are reserved: ReservedProperty\.\$userDefined/
    );
  } finally {
    tree.destroy();
  }
});

test('update after instance property change', async () => {
  const tree = context.tree;
  tree.root.x = 2;
  await Promise.resolve();
  assert.equal(tree.root.y, 3);
  assert.equal(tree.root.sub.y, 4);
  assert.equal(tree.root.v, 14);
});

test('update after new instance property created', async () => {
  const tree = context.tree;
  tree.root.makeA();
  await Promise.resolve();
  assert.equal(tree.root.z, 3);
  assert.equal(tree.root.sub.z, 4);
  assert.equal(tree.root.w, 14);
});

test('computing non-primitive values', async () => {
  const tree = context.tree;
  assert.equal(tree.root.derived, 2);
  tree.root.x = 3;
  await Promise.resolve();
  assert.equal(tree.root.derived, 4);
  tree.checkVueObject(tree.root, '/');
});

function testFinalizedPromise(method, trussMethod) {
  test(`${method} returns the finalized promise`, async () => {
    const error = new Error(`${method} failed`);
    const sourcePromise = promiseCancel(Promise.reject(error), mock.fn());
    context.truss[trussMethod] = mock.fn(() => sourcePromise);

    const args = method === '$when' ? [() => false] : [];
    const initialHookCount = context.tree.root.$$hooks['hook:destroyed'].length;
    const promise = context.tree.root[method](...args);

    assert.notEqual(promise, sourcePromise);
    assert.equal(promise.cancel, sourcePromise.cancel);
    await assert.rejects(promise, error);
    assert.equal(context.tree.root.$$hooks['hook:destroyed'].length, initialHookCount);
  });
}

testFinalizedPromise('$when', 'when');
testFinalizedPromise('$nextTick', 'nextTick');

test('computed properties added after observation remain reactive', async () => {
  const tree = new Tree(
    context.truss, context.rootUrl, context.bridge, context.dispatcher);
  tree.init([EarlyObservedRoot]);
  const root = tree.root;

  let observed;
  const unwatch = tree._vue.$watch(() => {
    root.$$touchThis();
    return root.derived && root.derived.child;
  }, value => {
    observed = value;
  }, {immediate: true});

  Vue.set(root, 'source', {child: 1});
  await Vue.nextTick();
  assert.equal(observed, 1);
  unwatch();
  tree.destroy();
});
