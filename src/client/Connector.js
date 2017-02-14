import {Handle, Query, Reference} from './Reference.js';
import angular from './angularCompatibility.js';

import _ from 'lodash';
import Vue from 'vue';


export default class Connector {
  constructor(scope, connections, tree) {
    // TODO: allow digest options, etc.
    connections.freeze();
    this._scope = scope;
    this._connections = connections;
    this._tree = tree;
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

    if (angular.active && scope.$on && scope.$$id) scope.$on('$destroy', () => {this.destroy();});
  }

  get ready() {
    return _.every(this._currentDescriptors, (descriptor, key) => {
      if (!descriptor) return false;
      if (descriptor instanceof Handle) return descriptor.ready;
      return this._subConnectors[key].ready;
    });
  }

  destroy() {
    this._unlinkScopeProperties();
    _.each(this._angularUnwatches, unwatch => {unwatch();});
    _.each(this._connections, (descriptor, key) => {this._disconnect(key);});
  }

  _linkScopeProperties() {
    if (!this._scope) return;
    const duplicateKey = _.find(this._connections, (descriptor, key) => key in this._scope);
    if (duplicateKey) {
      throw new Error(`Property already defined on connection target: ${duplicateKey}`);
    }
    Object.defineProperties(this._scope, _.mapValues(this._connections, (descriptor, key) => ({
      configurable: true, enumerable: true, get: () => this._vue.$data[key]
    })));
  }

  _unlinkScopeProperties() {
    if (!this._scope) return;
    _.each(this._connections, (descriptor, key) => {
      delete this._scope[key];
    });
  }

  _bindComputedConnection(key, fn) {
    fn = fn.bind(this._scope);
    const update = this._updateComputedConnection.bind(this, key);
    this._vue.$watch(fn, update, {immediate: !angular.active});
    if (angular.active) {
      if (!this._angularUnwatches) this._angularUnwatches = [];
      this._angularUnwatches.push(angular.watch(fn, update));
    }
  }

  _updateComputedConnection(key, newDescriptor) {
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
      const updateFn = this._scope ? this._updateScopeRef.bind(this, key) : null;
      this._disconnects[key] = this._tree.connectReference(descriptor, updateFn);
    } else if (descriptor instanceof Query) {
      const updateFn = this._scope ? this._updateScopeQuery.bind(this, key) : null;
      this._disconnects[key] = this._tree.connectQuery(descriptor, updateFn);
    } else {
      const subScope = {};
      if (this._scope) {
        // TODO: set only after subconnector is ready (initial values filled in)
        Vue.set(this._scope, key, subScope);
        angular.digest();
      }
      this._subConnectors[key] = new Connector(subScope, descriptor, this._tree);
    }
  }

  _disconnect(key) {
    if (this._scope) {
      Vue.delete(this._scope, key);
      angular.digest();
    }
    if (_.has(this._subConnectors, key)) {
      this._subConnectors[key].destroy();
      delete this._subConnectors[key];
    }
    if (this._disconnects[key]) this._disconnects[key]();
    delete this._disconnects[key];
    delete this._currentDescriptors[key];
  }

  _updateScopeRef(key, value) {
    if (this._scope[key] !== value) {
      Vue.set(this._scope, key, value);
      angular.digest();
    }
  }

  _updateScopeQuery(key, childKeys) {
    let changed = false;
    if (!this._scope[key]) {
      Vue.set(this._scope, key, {});
      changed = true;
    }
    const subScope = this._scope[key];
    for (let childKey in subScope) {
      if (!subScope.hasOwnProperty(childKey)) continue;
      if (!_.contains(childKeys, childKey)) {
        Vue.delete(subScope, childKey);
        changed = true;
      }
    }
    let object;
    for (let segment of this._currentDescriptors[key].path.split('/')) {
      object = segment ? object[segment] : this._tree.root;
    }
    for (let childKey of childKeys) {
      if (subScope.hasOwnProperty(childKey)) continue;
      Vue.set(subScope, childKey, object[childKey]);
      changed = true;
    }
    if (changed) angular.digest();
  }

}
