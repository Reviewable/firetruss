import {Handle, Query, Reference} from './Reference.js';
import angular from './angularCompatibility.js';
import stats from './utils/stats.js';
import {isTrussEqual} from './utils/utils.js';

import _ from 'lodash';
import performanceNow from 'performance-now';
import Vue from 'vue';


export default class Connector {
  constructor(scope, connections, tree, method, refs) {
    Object.freeze(connections);
    this._scope = scope;
    this._connections = connections;
    this._tree = tree;
    this._method = method;

    this._subConnectors = {};
    this._disconnects = {};
    this._angularUnwatches = undefined;
    this._data = {};
    this._vue = new Vue({data: {
      descriptors: {},
      refs: refs || {},
      values: _.mapValues(connections, _.constant(undefined))
    }});
    this.destroy = this.destroy;  // allow instance-level overrides of destroy() method
    Object.seal(this);

    this._linkScopeProperties();

    _.forEach(connections, (descriptor, key) => {
      if (_.isFunction(descriptor)) {
        this._bindComputedConnection(key, descriptor);
      } else {
        this._connect(key, descriptor);
      }
    });

    if (angular.active && scope && scope.$on && scope.$id) {
      scope.$on('$destroy', () => {this.destroy();});
    }
  }

  get ready() {
    return _.every(this._connections, (ignored, key) => {
      const descriptor = this._vue.descriptors[key];
      if (!descriptor) return false;
      if (descriptor instanceof Handle) return descriptor.ready;
      return this._subConnectors[key].ready;
    });
  }

  get at() {
    return this._vue.refs;
  }

  get data() {
    return this._data;
  }

  destroy() {
    this._unlinkScopeProperties();
    _.forEach(this._angularUnwatches, unwatch => {unwatch();});
    _.forEach(this._connections, (descriptor, key) => {this._disconnect(key);});
    this._vue.$destroy();
  }

  _linkScopeProperties() {
    const dataProperties = _.mapValues(this._connections, (descriptor, key) => ({
      configurable: true, enumerable: false, get: () => this._vue.values[key]
    }));
    Object.defineProperties(this._data, dataProperties);
    if (this._scope) {
      for (const key in this._connections) {
        if (key in this._scope) {
          throw new Error(`Property already defined on connection target: ${key}`);
        }
      }
      Object.defineProperties(this._scope, dataProperties);
      if (this._scope.__ob__) this._scope.__ob__.dep.notify();
    }
  }

  _unlinkScopeProperties() {
    if (!this._scope) return;
    _.forEach(this._connections, (descriptor, key) => {
      delete this._scope[key];
    });
  }

  _bindComputedConnection(key, fn) {
    const connectionStats = stats.for(`connection.at.${key}`);
    const getter = this._computeConnection.bind(this, fn, connectionStats);
    const update = this._updateComputedConnection.bind(this, key, fn, connectionStats);
    const angularWatch = angular.active && !fn.angularWatchSuppressed;
    // Use this._vue.$watch instead of truss.watch here so that we can disable the immediate
    // callback if we'll get one from Angular anyway.
    this._vue.$watch(getter, update, {immediate: !angularWatch});
    if (angularWatch) {
      if (!this._angularUnwatches) this._angularUnwatches = [];
      this._angularUnwatches.push(angular.watch(getter, update, true));
    }
  }

  _computeConnection(fn, connectionStats) {
    const startTime = performanceNow();
    try {
      return flattenRefs(fn.call(this._scope));
    } finally {
      connectionStats.runtime += performanceNow() - startTime;
      connectionStats.numRecomputes += 1;
    }
  }

  _updateComputedConnection(key, value, connectionStats) {
    const newDescriptor = _.isFunction(value) ? value(this._scope) : value;
    const oldDescriptor = this._vue.descriptors[key];
    const descriptorChanged = !isTrussEqual(oldDescriptor, newDescriptor);
    if (!descriptorChanged) return;
    if (connectionStats && descriptorChanged) connectionStats.numUpdates += 1;
    if (!newDescriptor) {
      this._disconnect(key);
      return;
    }
    if (newDescriptor instanceof Handle || !_.has(this._subConnectors, key)) {
      this._disconnect(key);
      this._connect(key, newDescriptor);
    } else {
      this._subConnectors[key]._updateConnections(newDescriptor);
    }
    Vue.set(this._vue.descriptors, key, newDescriptor);
    angular.digest();
  }

  _updateConnections(connections) {
    _.forEach(connections, (descriptor, key) => {
      this._updateComputedConnection(key, descriptor);
    });
    _.forEach(this._connections, (descriptor, key) => {
      if (!_.has(connections, key)) this._updateComputedConnection(key);
    });
    this._connections = connections;
  }

  _connect(key, descriptor) {
    Vue.set(this._vue.descriptors, key, descriptor);
    angular.digest();
    if (!descriptor) return;
    if (descriptor instanceof Reference) {
      Vue.set(this._vue.refs, key, descriptor);
      const updateFn = this._updateRefValue.bind(this, key);
      this._disconnects[key] = this._tree.connectReference(descriptor, updateFn, this._method);
    } else if (descriptor instanceof Query) {
      Vue.set(this._vue.refs, key, descriptor);
      const updateFn = this._updateQueryValue.bind(this, key);
      this._disconnects[key] = this._tree.connectQuery(descriptor, updateFn, this._method);
    } else {
      const subScope = {}, subRefs = {};
      Vue.set(this._vue.refs, key, subRefs);
      const subConnector = this._subConnectors[key] =
        new Connector(subScope, descriptor, this._tree, this._method, subRefs);
      // Use a truss.watch here instead of this._vue.$watch so that the "immediate" execution
      // actually takes place after we've captured the unwatch function, in case the subConnector
      // is ready immediately.
      const unwatch = this._disconnects[key] = this._tree.truss.watch(
        () => subConnector.ready,
        subReady => {
          if (!subReady) return;
          unwatch();
          delete this._disconnects[key];
          Vue.set(this._vue.values, key, subScope);
          angular.digest();
        }
      );
    }
  }

  _disconnect(key) {
    Vue.delete(this._vue.refs, key);
    this._updateRefValue(key, undefined);
    if (_.has(this._subConnectors, key)) {
      this._subConnectors[key].destroy();
      delete this._subConnectors[key];
    }
    if (this._disconnects[key]) this._disconnects[key]();
    delete this._disconnects[key];
    Vue.delete(this._vue.descriptors, key);
    angular.digest();
  }

  _updateRefValue(key, value) {
    if (this._vue.values[key] !== value) {
      Vue.set(this._vue.values, key, value);
      angular.digest();
    }
  }

  _updateQueryValue(key, childKeys) {
    if (!this._vue.values[key]) {
      Vue.set(this._vue.values, key, {});
      angular.digest();
    }
    const subScope = this._vue.values[key];
    for (const childKey in subScope) {
      if (!subScope.hasOwnProperty(childKey)) continue;
      if (!_.includes(childKeys, childKey)) {
        Vue.delete(subScope, childKey);
        angular.digest();
      }
    }
    const object = this._tree.getObject(this._vue.descriptors[key].path);
    for (const childKey of childKeys) {
      if (subScope.hasOwnProperty(childKey)) continue;
      Vue.set(subScope, childKey, object[childKey]);
      angular.digest();
    }
  }

}

function flattenRefs(refs) {
  if (!refs) return;
  if (refs instanceof Handle) return refs.toString();
  return _.mapValues(refs, flattenRefs);
}

