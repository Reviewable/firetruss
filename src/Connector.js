import {Handle, Query, Reference} from './Reference.js';
import angular from './angularCompatibility.js';

import _ from 'lodash';
import Vue from 'vue';


export default class Connector {
  constructor(scope, connections, tree, method, refs) {
    Object.freeze(connections);
    this._scope = scope;
    this._connections = connections;
    this._tree = tree;
    this._method = method;
    this._refs = refs || {};
    this._subConnectors = {};
    this._currentDescriptors = {};
    this._disconnects = {};
    this._vue = new Vue({data: _.mapValues(connections, _.constant(undefined))});

    this._linkScopeProperties();

    _.each(connections, (descriptor, key) => {
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
    return _.every(this._currentDescriptors, (descriptor, key) => {
      if (!descriptor) return false;
      if (descriptor instanceof Handle) return descriptor.ready;
      return this._subConnectors[key].ready;
    });
  }

  get at() {
    return this._refs;
  }

  destroy() {
    this._unlinkScopeProperties();
    _.each(this._angularUnwatches, unwatch => {unwatch();});
    _.each(this._connections, (descriptor, key) => {this._disconnect(key);});
    this._vue.$destroy();
  }

  _linkScopeProperties() {
    if (!this._scope) return;
    for (const key in this._connections) {
      if (key in this._scope) {
        throw new Error(`Property already defined on connection target: ${key}`);
      }
    }
    Object.defineProperties(this._scope, _.mapValues(this._connections, (descriptor, key) => ({
      configurable: true, enumerable: true, get: () => this._vue[key]
    })));
  }

  _unlinkScopeProperties() {
    if (!this._scope) return;
    _.each(this._connections, (descriptor, key) => {
      delete this._scope[key];
    });
  }

  _bindComputedConnection(key, fn) {
    const getter = this._computeConnection.bind(this, fn);
    const update = this._updateComputedConnection.bind(this, key, fn);
    // Use this._vue.$watch instead of truss.watch here so that we can disable the immediate
    // callback if we'll get one from Angular anyway.
    this._vue.$watch(getter, update, {immediate: !angular.active, deep: true});
    if (angular.active) {
      if (!this._angularUnwatches) this._angularUnwatches = [];
      this._angularUnwatches.push(angular.watch(getter, update, true));
    }
  }

  _computeConnection(fn) {
    return flattenRefs(fn.call(this._scope));
  }

  _updateComputedConnection(key, value) {
    const newDescriptor = _.isFunction(value) ? value(this._scope) : value;
    const oldDescriptor = this._currentDescriptors[key];
    if (oldDescriptor === newDescriptor ||
        newDescriptor instanceof Handle && newDescriptor.isEqual(oldDescriptor)) return;
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
    this._currentDescriptors[key] = newDescriptor;
  }

  _updateConnections(connections) {
    _.each(connections, (descriptor, key) => {
      this._updateComputedConnection(key, descriptor);
    });
    _.each(this._connections, (descriptor, key) => {
      if (!_.has(connections, key)) this._updateComputedConnection(key);
    });
    this._connections = connections;
  }

  _connect(key, descriptor) {
    this._currentDescriptors[key] = descriptor;
    if (!descriptor) return;
    if (descriptor instanceof Reference) {
      this._refs[key] = descriptor;
      const updateFn = this._scope ? this._updateScopeRef.bind(this, key) : null;
      this._disconnects[key] = this._tree.connectReference(descriptor, updateFn, this._method);
    } else if (descriptor instanceof Query) {
      this._refs[key] = descriptor;
      const updateFn = this._scope ? this._updateScopeQuery.bind(this, key) : null;
      this._disconnects[key] = this._tree.connectQuery(descriptor, updateFn, this._method);
    } else {
      const subScope = {}, subRefs = {};
      this._refs[key] = subRefs;
      const subConnector = this._subConnectors[key] =
        new Connector(subScope, descriptor, this._tree, this._method, subRefs);
      if (this._scope) {
        // Use a truss.watch here instead of this._vue.$watch so that the "immediate" execution
        // actually takes place after we've captured the unwatch function, in case the subConnector
        // is ready immediately.
        const unwatch = this._disconnects[key] = this._tree.truss.watch(
          () => subConnector.ready,
          subReady => {
            if (!subReady) return;
            unwatch();
            delete this._disconnects[key];
            Vue.set(this._vue, key, subScope);
            angular.digest();
          }
        );
      }
    }
  }

  _disconnect(key) {
    delete this._refs[key];
    if (this._scope) this._updateScopeRef(key, undefined);
    if (_.has(this._subConnectors, key)) {
      this._subConnectors[key].destroy();
      delete this._subConnectors[key];
    }
    if (this._disconnects[key]) this._disconnects[key]();
    delete this._disconnects[key];
    delete this._currentDescriptors[key];
  }

  _updateScopeRef(key, value) {
    if (this._vue[key] !== value) {
      Vue.set(this._vue, key, value);
      angular.digest();
    }
  }

  _updateScopeQuery(key, childKeys) {
    let changed = false;
    if (!this._vue[key]) {
      Vue.set(this._vue, key, {});
      changed = true;
    }
    const subScope = this._vue[key];
    for (const childKey in subScope) {
      if (!subScope.hasOwnProperty(childKey)) continue;
      if (!_.contains(childKeys, childKey)) {
        Vue.delete(subScope, childKey);
        changed = true;
      }
    }
    let object;
    for (const segment of this._currentDescriptors[key].path.split('/')) {
      object = segment ? object[segment] : this._tree.root;
    }
    for (const childKey of childKeys) {
      if (subScope.hasOwnProperty(childKey)) continue;
      Vue.set(subScope, childKey, object[childKey]);
      changed = true;
    }
    if (changed) angular.digest();
  }

}

function flattenRefs(refs) {
  if (!refs) return;
  if (refs instanceof Handle) return refs.toString();
  return _.mapValues(refs, flattenRefs);
}

