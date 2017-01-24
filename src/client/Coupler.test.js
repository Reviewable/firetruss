import test from 'ava';
import td from 'testdouble';
import _ from 'lodash';

import Coupler from './Coupler.js';
import Bridge from './Bridge.js';

td.verifyNoCalls = call => td.verify(call, {times: 0, ignoreExtraArgs: true});

test.beforeEach(t => {
  t.context = {
    rootUrl: 'https://example.firebaseio.com',
    bridge: td.object(Bridge),
    applySnapshot: td.function(),
    prunePath: td.function()
  };
  t.context.coupler = new Coupler(
    t.context.rootUrl, t.context.bridge, t.context.applySnapshot, t.context.prunePath);
  t.context.verifyOn = (url, times = 1) => td.verify(t.context.bridge.on(
    url, url, null, 'value', td.matchers.isA(Function), td.matchers.isA(Function),
    td.matchers.anything(), {sync: true}
  ), {times: times});
  t.context.verifyOff = (url, times = 1) => td.verify(t.context.bridge.off(
    url, url, null, 'value', td.matchers.isA(Function), td.matchers.anything()
  ), {times: times});
});

test.afterEach(t => {
  t.context.coupler.destroy();
});

test('couple, decouple on root node', t => {
  const that = t.context.coupler;
  const url = t.context.rootUrl + '/';
  t.false(that.isTrunkCoupled('/'));

  that.couple('/');
  t.is(that._root.count, 1);
  t.true(that._root.listening);
  t.true(that.isTrunkCoupled('/'));
  t.context.verifyOn(url);
  td.verifyNoCalls(t.context.bridge.off());

  that.decouple('/');
  t.is(that._root.count, 0);
  t.false(that._root.listening);
  t.false(that.isTrunkCoupled('/'));
  t.context.verifyOn(url);
  t.context.verifyOff(url);
});

test('couple, decouple, on root child', t => {
  const that = t.context.coupler;
  const url = t.context.rootUrl + '/foo';
  t.false(that.isTrunkCoupled('/foo'));

  that.couple('/foo');
  t.is(that._root.children.foo.count, 1);
  t.true(that._root.children.foo.listening);
  t.true(that.isTrunkCoupled('/foo'));
  t.context.verifyOn(url);
  td.verifyNoCalls(t.context.bridge.off());

  that.decouple('/foo');
  t.true(_.isEmpty(that._root.children));
  t.false(that.isTrunkCoupled('/foo'));
  t.context.verifyOn(url);
  t.context.verifyOff(url);
});

test('couple, decouple, on root descendant', t => {
  const that = t.context.coupler;
  const url = t.context.rootUrl + '/foo/bar';
  t.false(that.isTrunkCoupled('/foo/bar'));

  that.couple('/foo/bar');
  t.is(that._root.children.foo.children.bar.count, 1);
  t.true(that._root.children.foo.children.bar.listening);
  t.true(that.isTrunkCoupled('/foo/bar'));
  t.context.verifyOn(url);
  td.verifyNoCalls(t.context.bridge.off());

  that.decouple('/foo/bar');
  t.true(_.isEmpty(that._root.children));
  t.false(that.isTrunkCoupled('/foo/bar'));
  t.context.verifyOn(url);
  t.context.verifyOff(url);
});

test('multiple coupler on same node', t => {
  const that = t.context.coupler;
  const url = t.context.rootUrl + '/foo';

  that.couple('/foo');
  that.couple('/foo');
  t.is(that._root.children.foo.count, 2);
  t.true(that._root.children.foo.listening);
  t.true(that.isTrunkCoupled('/foo'));
  t.context.verifyOn(url);
  td.verifyNoCalls(t.context.bridge.off());

  that.decouple('/foo');
  t.is(that._root.children.foo.count, 1);
  t.true(that._root.children.foo.listening);
  t.true(that.isTrunkCoupled('/foo'));
  t.context.verifyOn(url);
  td.verifyNoCalls(t.context.bridge.off());
});

test('override child coupling', t => {
  const that = t.context.coupler;
  const rootUrl = t.context.rootUrl;

  that.couple('/foo/bar');
  that.couple('/foo');
  t.is(that._root.children.foo.count, 1);
  t.true(that._root.children.foo.listening);
  t.true(that.isTrunkCoupled('/foo'));
  t.is(that._root.children.foo.children.bar.count, 1);
  t.false(that._root.children.foo.children.bar.listening);
  t.true(that.isTrunkCoupled('/foo/bar'));
  t.context.verifyOn(rootUrl + '/foo/bar');
  t.context.verifyOn(rootUrl + '/foo');
  t.context.verifyOff(rootUrl + '/foo/bar');

  that.decouple('/foo');
  t.is(that._root.children.foo.count, 0);
  t.false(that._root.children.foo.listening);
  t.false(that.isTrunkCoupled('/foo'));
  t.is(that._root.children.foo.children.bar.count, 1);
  t.true(that._root.children.foo.children.bar.listening);
  t.true(that.isTrunkCoupled('/foo/bar'));
  t.context.verifyOn(rootUrl + '/foo/bar', 2);
  t.context.verifyOn(rootUrl + '/foo');
  t.context.verifyOff(rootUrl + '/foo/bar');
  t.context.verifyOff(rootUrl + '/foo');
});

test('superseded coupling', t => {
  const that = t.context.coupler;
  const rootUrl = t.context.rootUrl;

  that.couple('/foo');
  that.couple('/foo/bar');
  t.is(that._root.children.foo.count, 1);
  t.true(that._root.children.foo.listening);
  t.true(that.isTrunkCoupled('/foo'));
  t.is(that._root.children.foo.children.bar.count, 1);
  t.falsy(that._root.children.foo.children.bar.listening);
  t.true(that.isTrunkCoupled('/foo/bar'));
  t.context.verifyOn(rootUrl + '/foo');
  t.context.verifyOff(rootUrl + '/foo', 0);
  t.context.verifyOn(rootUrl + '/foo/bar', 0);
  t.context.verifyOff(rootUrl + '/foo/bar', 0);
});

test('uncoupled parents with coupled children are not deleted', t => {
  const that = t.context.coupler;

  that.couple('/foo');
  that.couple('/foo/bar');
  that.couple('/foo/baz');
  that.decouple('/foo/bar');
  t.is(that._root.children.foo.children.baz.count, 1);
});

test('handle snapshot', t => {
  const that = t.context.coupler;

  that.couple('/foo/bar');
  const node = that._root.children.foo.children.bar;
  node._handleSnapshot({path: '/foo/bar'});
  node._handleSnapshot({path: '/foo/bar/baz'});
  node._handleSnapshot({path: '/foo'});

  td.verify(t.context.applySnapshot({path: '/foo/bar'}), {times: 1});
  td.verify(t.context.applySnapshot({path: '/foo/bar/baz'}), {times: 1});
  td.verify(t.context.applySnapshot({path: '/foo'}), {times: 0});
});

test('handle error', t => {
  const that = t.context.coupler;

  that.couple('/foo/bar');
  that.couple('/foo/bar/baz');

  t.is(that._root.children.foo.children.bar.count, 1);
  t.true(that._root.children.foo.children.bar.listening);
  t.is(that._root.children.foo.children.bar.children.baz.count, 1);
  t.falsy(that._root.children.foo.children.bar.children.baz.listening);

  that._root.children.foo._handleError('/foo'.split('/'), {});
  that._root.children.foo.children.bar.children.baz._handleError('/foo/bar/baz'.split('/'), {});

  t.is(that._root.children.foo.children.bar.count, 1);
  t.true(that._root.children.foo.children.bar.listening);
  t.is(that._root.children.foo.children.bar.children.baz.count, 1);
  t.falsy(that._root.children.foo.children.bar.children.baz.listening);

  that._root.children.foo.children.bar._handleError('/foo/bar'.split('/'), {});

  t.is(that._root.children.foo.children.bar.count, 1);
  t.falsy(that._root.children.foo.children.bar.listening);
  t.is(that._root.children.foo.children.bar.children.baz.count, 1);
  t.true(that._root.children.foo.children.bar.children.baz.listening);

  that._root.children.foo.children.bar.children.baz._handleError('/foo/bar/baz'.split('/'), {});

  t.is(that._root.children.foo.children.bar.count, 1);
  t.falsy(that._root.children.foo.children.bar.listening);
  t.is(that._root.children.foo.children.bar.children.baz.count, 1);
  t.falsy(that._root.children.foo.children.bar.children.baz.listening);
});
