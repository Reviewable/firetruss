import test from 'ava';
import td from 'testdouble';
import _ from 'lodash';

import Couplings from './Couplings.js';
import Bridge from './Bridge.js';

td.verifyNoCalls = call => td.verify(call, {times: 0, ignoreExtraArgs: true});

test.beforeEach(t => {
  t.context = {
    rootUrl: 'https://example.firebaseio.com',
    bridge: td.object(Bridge),
    applySnapshot: td.function()
  };
  t.context.couplings = new Couplings(t.context.rootUrl, t.context.bridge, t.context.applySnapshot);
  t.context.verifyOn = (url, times = 1) => td.verify(t.context.bridge.on(
    url, url, null, 'value', td.matchers.isA(Function), td.matchers.isA(Function),
    t.context.couplings, {sync: true}
  ), {times: times});
  t.context.verifyOff = (url, times = 1) => td.verify(t.context.bridge.off(
    url, url, null, 'value', td.matchers.isA(Function), t.context.couplings
  ), {times: times});
});

test.afterEach(t => {
  t.context.couplings.destroy();
});

test('couple, decouple on root node', t => {
  const that = t.context.couplings;
  const url = t.context.rootUrl + '/';
  t.false(that._isCoupled('/'));

  that.couple('/');
  t.is(that._root.count, 1);
  t.true(that._root.listening);
  t.true(that._isCoupled('/'));
  t.context.verifyOn(url);
  td.verifyNoCalls(t.context.bridge.off());

  that.decouple('/');
  t.is(that._root.count, 0);
  t.false(that._root.listening);
  t.false(that._isCoupled('/'));
  t.context.verifyOn(url);
  t.context.verifyOff(url);
});

test('couple, decouple, on root child', t => {
  const that = t.context.couplings;
  const url = t.context.rootUrl + '/foo';
  t.false(that._isCoupled('/foo'));

  that.couple('/foo');
  t.is(that._root.children.foo.count, 1);
  t.true(that._root.children.foo.listening);
  t.true(that._isCoupled('/foo'));
  t.context.verifyOn(url);
  td.verifyNoCalls(t.context.bridge.off());

  that.decouple('/foo');
  t.true(_.isEmpty(that._root.children));
  t.false(that._isCoupled('/foo'));
  t.context.verifyOn(url);
  t.context.verifyOff(url);
});

test('couple, decouple, on root descendant', t => {
  const that = t.context.couplings;
  const url = t.context.rootUrl + '/foo/bar';
  t.false(that._isCoupled('/foo/bar'));

  that.couple('/foo/bar');
  t.is(that._root.children.foo.children.bar.count, 1);
  t.true(that._root.children.foo.children.bar.listening);
  t.true(that._isCoupled('/foo/bar'));
  t.context.verifyOn(url);
  td.verifyNoCalls(t.context.bridge.off());

  that.decouple('/foo/bar');
  t.true(_.isEmpty(that._root.children));
  t.false(that._isCoupled('/foo/bar'));
  t.context.verifyOn(url);
  t.context.verifyOff(url);
});

test('multiple couplings on same node', t => {
  const that = t.context.couplings;
  const url = t.context.rootUrl + '/foo';

  that.couple('/foo');
  that.couple('/foo');
  t.is(that._root.children.foo.count, 2);
  t.true(that._root.children.foo.listening);
  t.true(that._isCoupled('/foo'));
  t.context.verifyOn(url);
  td.verifyNoCalls(t.context.bridge.off());

  that.decouple('/foo');
  t.is(that._root.children.foo.count, 1);
  t.true(that._root.children.foo.listening);
  t.true(that._isCoupled('/foo'));
  t.context.verifyOn(url);
  td.verifyNoCalls(t.context.bridge.off());
});

test('override child coupling', t => {
  const that = t.context.couplings;
  const rootUrl = t.context.rootUrl;

  that.couple('/foo/bar');
  that.couple('/foo');
  t.is(that._root.children.foo.count, 1);
  t.true(that._root.children.foo.listening);
  t.true(that._isCoupled('/foo'));
  t.is(that._root.children.foo.children.bar.count, 1);
  t.false(that._root.children.foo.children.bar.listening);
  t.true(that._isCoupled('/foo/bar'));
  t.context.verifyOn(rootUrl + '/foo/bar');
  t.context.verifyOn(rootUrl + '/foo');
  t.context.verifyOff(rootUrl + '/foo/bar');

  that.decouple('/foo');
  t.is(that._root.children.foo.count, 0);
  t.false(that._root.children.foo.listening);
  t.false(that._isCoupled('/foo'));
  t.is(that._root.children.foo.children.bar.count, 1);
  t.true(that._root.children.foo.children.bar.listening);
  t.true(that._isCoupled('/foo/bar'));
  t.context.verifyOn(rootUrl + '/foo/bar', 2);
  t.context.verifyOn(rootUrl + '/foo');
  t.context.verifyOff(rootUrl + '/foo/bar');
  t.context.verifyOff(rootUrl + '/foo');
});

test('superseded coupling', t => {
  const that = t.context.couplings;
  const rootUrl = t.context.rootUrl;

  that.couple('/foo');
  that.couple('/foo/bar');
  t.is(that._root.children.foo.count, 1);
  t.true(that._root.children.foo.listening);
  t.true(that._isCoupled('/foo'));
  t.is(that._root.children.foo.children.bar.count, 1);
  t.falsy(that._root.children.foo.children.bar.listening);
  t.true(that._isCoupled('/foo/bar'));
  t.context.verifyOn(rootUrl + '/foo');
  t.context.verifyOff(rootUrl + '/foo', 0);
  t.context.verifyOn(rootUrl + '/foo/bar', 0);
  t.context.verifyOff(rootUrl + '/foo/bar', 0);
});

test('uncoupled parents with coupled children are not deleted', t => {
  const that = t.context.couplings;

  that.couple('/foo');
  that.couple('/foo/bar');
  that.couple('/foo/baz');
  that.decouple('/foo/bar');
  t.is(that._root.children.foo.children.baz.count, 1);
});

test('handle snapshot', t => {
  const that = t.context.couplings;

  that.couple('/foo/bar');
  that._handleSnapshot({path: '/foo/bar'});
  that._handleSnapshot({path: '/foo/bar/baz'});
  that._handleSnapshot({path: '/foo'});

  td.verify(t.context.applySnapshot({path: '/foo/bar'}), {times: 1});
  td.verify(t.context.applySnapshot({path: '/foo/bar/baz'}), {times: 1});
  td.verify(t.context.applySnapshot({path: '/foo'}), {times: 0});
});

test('handle error', t => {
  const that = t.context.couplings;

  that.couple('/foo/bar');
  that.couple('/foo/bar/baz');

  t.is(that._root.children.foo.children.bar.count, 1);
  t.true(that._root.children.foo.children.bar.listening);
  t.is(that._root.children.foo.children.bar.children.baz.count, 1);
  t.falsy(that._root.children.foo.children.bar.children.baz.listening);

  that._handleError('/foo', {});
  that._handleError('/foo/bar/baz', {});

  t.is(that._root.children.foo.children.bar.count, 1);
  t.true(that._root.children.foo.children.bar.listening);
  t.is(that._root.children.foo.children.bar.children.baz.count, 1);
  t.falsy(that._root.children.foo.children.bar.children.baz.listening);

  that._handleError('/foo/bar', {});

  t.is(that._root.children.foo.children.bar.count, 1);
  t.falsy(that._root.children.foo.children.bar.listening);
  t.is(that._root.children.foo.children.bar.children.baz.count, 1);
  t.true(that._root.children.foo.children.bar.children.baz.listening);

  that._handleError('/foo/bar/baz', {});

  t.is(that._root.children.foo.children.bar.count, 1);
  t.falsy(that._root.children.foo.children.bar.listening);
  t.is(that._root.children.foo.children.bar.children.baz.count, 1);
  t.falsy(that._root.children.foo.children.bar.children.baz.listening);
});
