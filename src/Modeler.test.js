import {afterEach, beforeEach, mock, test} from 'node:test';
import assert from 'node:assert/strict';
import Vue from 'vue';

import Tree from './Tree.js';

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
