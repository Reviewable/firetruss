import test from 'ava';
import td from 'testdouble';
import Vue from 'vue';

import Tree from './Tree.js';
import Bridge from './Bridge.js';
import Dispatcher from './Dispatcher.js';


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

test.beforeEach(t => {
  t.context = {
    rootUrl: 'https://example.firebaseio.com',
    bridge: td.object(Bridge),
    dispatcher: td.object(Dispatcher),
    truss: {get root() {return t.context.tree.root;}}
  };
  t.context.tree = new Tree(
    t.context.truss, t.context.rootUrl, t.context.bridge, t.context.dispatcher);
  t.context.tree.init([Root, SubrootFoo, Subroot]);
});

test.afterEach(t => {
  t.context.tree.destroy();
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
