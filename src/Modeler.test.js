import test from 'ava';
import td from 'testdouble';
import Vue from 'vue';

import Tree from './Tree.js';
import Bridge from './Bridge.js';
import Dispatcher from './Dispatcher.js';

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

test.beforeEach(t => {
  t.context = {
    rootUrl: 'https://example.firebaseio.com',
    bridge: td.instance(Bridge),
    dispatcher: td.instance(Dispatcher),
    truss: {get root() {return t.context.tree.root;}}
  };
  t.context.tree = new Tree(
    t.context.truss, t.context.rootUrl, t.context.bridge, t.context.dispatcher);
  t.context.tree.init([Root, SubrootFoo, Subroot]);
});

test.afterEach(t => {
  t.context.tree.destroy();
  if (earlyObserver) {
    earlyObserver.$destroy();
    earlyObserver = null;
  }
});

test('initialize placeholders', t => {
  const tree = t.context.tree;
  t.is(tree.root.constructor, Root);
  t.is(tree.root.sub.constructor, Subroot);
  t.is(tree.root.sub.foo.constructor, SubrootFoo);
});

test('update after instance property change', t => {
  const tree = t.context.tree;
  tree.root.x = 2;
  return Promise.resolve().then(() => {
    t.is(tree.root.y, 3);
    t.is(tree.root.sub.y, 4);
    t.is(tree.root.v, 14);
  });
});

test('update after new instance property created', t => {
  const tree = t.context.tree;
  tree.root.makeA();
  return Promise.resolve().then(() => {
    t.is(tree.root.z, 3);
    t.is(tree.root.sub.z, 4);
    t.is(tree.root.w, 14);
  });
});

test('computing non-primitive values', t => {
  const tree = t.context.tree;
  t.is(tree.root.derived, 2);
  tree.root.x = 3;
  return Promise.resolve().then(() => {
    t.is(tree.root.derived, 4);
    tree.checkVueObject(tree.root, '/');
  });
});

test('wrapping observed properties preserves missing child dependencies', t => {
  const tree = t.context.tree;
  const context = {};
  const navigation = {context};
  const vue = new Vue({data: {navigation}});

  tree._modeler._wrapProperties(navigation);
  t.true(Object.hasOwn(navigation, '$_context'));

  let review;
  const unwatch = vue.$watch(() => navigation.context.review, value => {
    review = value;
  }, {immediate: true});
  t.is(review, undefined);

  Vue.set(context, 'review', {ready: true});
  return Vue.nextTick().then(() => {
    t.deepEqual(review, {ready: true});
    unwatch();
    vue.$destroy();
  });
});

test('computed properties added after observation remain reactive', t => {
  const tree = new Tree(
    t.context.truss, t.context.rootUrl, t.context.bridge, t.context.dispatcher);
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
  return Vue.nextTick().then(() => {
    t.is(observed, 1);
    unwatch();
    tree.destroy();
  });
});
