import {Query} from './Reference.js';
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
    this._vue = new Vue({data: _.mapValues(connections, _.constant(undefined))});

    this._linkScopeProperties();

    _.each(connections, (descriptor, key) => {
      if (_.isFunction(descriptor)) {
        this._bindComputedConnection(key, descriptor);
      } else {
        this._connect(key, descriptor);
      }
    });
  }

  get ready() {
    return _.every(this._currentDescriptors, (descriptor, key) => {
      if (!descriptor) return true;
      if (descriptor instanceof Query) return descriptor.ready;
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
        newDescriptor instanceof Query && newDescriptor.isEqual(oldDescriptor)) return;
    if (!newDescriptor) {
      this._disconnect(key);
      return;
    }
    if (newDescriptor instanceof Query || !_.has(this._subConnectors, key)) {
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
      this._updateComputedConnection(key);
    });
    this._connections = connections;
  }

  _connect(key, descriptor) {
    this._currentDescriptors[key] = descriptor;
    if (!descriptor) return;
    if (descriptor instanceof Query) {
      this._tree.connect(descriptor);
    } else {
      const subScope = {};
      if (this._scope) {
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
    } else if (this._currentDescriptors[key]) {
      this._tree.disconnect(this._currentDescriptors[key]);
    }
    delete this._currentDescriptors[key];
  }

}
