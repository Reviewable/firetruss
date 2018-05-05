import _ from 'lodash';
import Vue from 'vue';
import angular from './angularCompatibility.js';
import {splitPath} from './utils/paths.js';


class QueryHandler {
  constructor(coupler, query) {
    this._coupler = coupler;
    this._query = query;
    this._listeners = [];
    this._keys = [];
    this._url = this._coupler._rootUrl + query.path;
    this._segments = splitPath(query.path, true);
    this._listening = false;
    this.ready = false;
  }

  attach(operation, keysCallback) {
    this._listen();
    this._listeners.push({operation, keysCallback});
    if (keysCallback) keysCallback(this._keys);
  }

  detach(operation) {
    const k = _.findIndex(this._listeners, {operation});
    if (k >= 0) this._listeners.splice(k, 1);
    return this._listeners.length;
  }

  _listen() {
    if (this._listening) return;
    this._coupler._bridge.on(
      this._query.toString(), this._url, this._query.constraints, 'value',
      this._handleSnapshot, this._handleError, this, {sync: true});
    this._listening = true;
  }

  destroy() {
    this._coupler._bridge.off(
      this._query.toString(), this._url, this._query.constraints, 'value', this._handleSnapshot,
      this);
    this._listening = false;
    this.ready = false;
    angular.digest();
    for (const key of this._keys) {
      this._coupler._decoupleSegments(this._segments.concat(key));
    }
  }

  _handleSnapshot(snap) {
    this._coupler._queueSnapshotCallback(() => {
      // Order is important here: first couple any new subpaths so _handleSnapshot will update the
      // tree, then tell the client to update its keys, pulling values from the tree.
      if (!this._listeners.length || !this._listening) return;
      const updatedKeys = this._updateKeys(snap);
      this._coupler._applySnapshot(snap);
      if (!this.ready) {
        this.ready = true;
        angular.digest();
        for (const listener of this._listeners) {
          this._coupler._dispatcher.markReady(listener.operation);
        }
      }
      if (updatedKeys) {
        for (const listener of this._listeners) {
          if (listener.keysCallback) listener.keysCallback(updatedKeys);
        }
      }
    });
  }

  _updateKeys(snap) {
    let updatedKeys;
    if (snap.path === this._query.path) {
      updatedKeys = _.keys(snap.value);
      updatedKeys.sort();
      if (_.isEqual(this._keys, updatedKeys)) {
        updatedKeys = null;
      } else {
        for (const key of _.difference(updatedKeys, this._keys)) {
          this._coupler._coupleSegments(this._segments.concat(key));
        }
        for (const key of _.difference(this._keys, updatedKeys)) {
          this._coupler._decoupleSegments(this._segments.concat(key));
        }
        this._keys = updatedKeys;
      }
    } else if (snap.path.replace(/\/[^/]+/, '') === this._query.path) {
      const hasKey = _.includes(this._keys, snap.key);
      if (snap.value) {
        if (!hasKey) {
          this._coupler._coupleSegments(this._segments.concat(snap.key));
          this._keys.push(snap.key);
          this._keys.sort();
          updatedKeys = this._keys;
        }
      } else if (hasKey) {
        this._coupler._decoupleSegments(this._segments.concat(snap.key));
        _.pull(this._keys, snap.key);
        this._keys.sort();
        updatedKeys = this._keys;
      }
    }
    return updatedKeys;
  }

  _handleError(error) {
    if (!this._listeners.length || !this._listening) return;
    this._listening = false;
    this.ready = false;
    angular.digest();
    Promise.all(_.map(this._listeners, listener => {
      this._coupler._dispatcher.clearReady(listener.operation);
      return this._coupler._dispatcher.retry(listener.operation, error).catch(e => {
        listener.operation._disconnect(e);
        return false;
      });
    })).then(results => {
      if (_.some(results)) {
        if (this._listeners.length) this._listen();
      } else {
        for (const listener of this._listeners) listener.operation._disconnect(error);
      }
    });
  }
}


class Node {
  constructor(coupler, path, parent) {
    this._coupler = coupler;
    this.path = path;
    this.parent = parent;
    this.url = this._coupler._rootUrl + path;
    this.operations = [];
    this.queryCount = 0;
    this.listening = false;
    this.ready = false;
    this.children = {};
  }

  get active() {
    return this.count || this.queryCount;
  }

  get count() {
    return this.operations.length;
  }

  listen(skip) {
    if (!skip && this.count) {
      if (this.listening) return;
      _.forEach(this.operations, op => {this._coupler._dispatcher.clearReady(op);});
      this._coupler._bridge.on(
        this.url, this.url, null, 'value', this._handleSnapshot, this._handleError, this,
        {sync: true});
      this.listening = true;
    } else {
      _.forEach(this.children, child => {child.listen();});
    }
  }

  unlisten(skip) {
    if (!skip && this.listening) {
      this._coupler._bridge.off(this.url, this.url, null, 'value', this._handleSnapshot, this);
      this.listening = false;
      this._forAllDescendants(node => {
        if (node.ready) {
          node.ready = false;
          angular.digest();
        }
      });
    } else {
      _.forEach(this.children, child => {child.unlisten();});
    }
  }

  _handleSnapshot(snap) {
    this._coupler._queueSnapshotCallback(() => {
      if (!this.listening || !this._coupler.isTrunkCoupled(snap.path)) return;
      this._coupler._applySnapshot(snap);
      if (!this.ready && snap.path === this.path) {
        this.ready = true;
        angular.digest();
        this.unlisten(true);
        this._forAllDescendants(node => {
          for (const op of node.operations) this._coupler._dispatcher.markReady(op);
        });
      }
    });
  }

  _handleError(error) {
    if (!this.count || !this.listening) return;
    this.listening = false;
    this._forAllDescendants(node => {
      if (node.ready) {
        node.ready = false;
        angular.digest();
      }
      for (const op of node.operations) this._coupler._dispatcher.clearReady(op);
    });
    return Promise.all(_.map(this.operations, op => {
      return this._coupler._dispatcher.retry(op, error).catch(e => {
        op._disconnect(e);
        return false;
      });
    })).then(results => {
      if (_.some(results)) {
        if (this.count) this.listen();
      } else {
        for (const op of this.operations) op._disconnect(error);
        // Pulling all the operations will automatically get us listening on descendants.
      }
    });
  }

  _forAllDescendants(iteratee) {
    iteratee(this);
    _.forEach(this.children, child => child._forAllDescendants(iteratee));
  }

  collectCoupledDescendantPaths(paths) {
    if (!paths) paths = {};
    paths[this.path] = this.active;
    if (!this.active) {
      _.forEach(this.children, child => {child.collectCoupledDescendantPaths(paths);});
    }
    return paths;
  }
}


export default class Coupler {
  constructor(rootUrl, bridge, dispatcher, applySnapshot, prunePath) {
    this._rootUrl = rootUrl;
    this._bridge = bridge;
    this._dispatcher = dispatcher;
    this._applySnapshot = applySnapshot;
    this._pendingSnapshotCallbacks = [];
    this._throttled = {processPendingSnapshots: this._processPendingSnapshots};
    this._prunePath = prunePath;
    this._vue = new Vue({data: {root: undefined, queryHandlers: {}}});
    this._nodeIndex = Object.create(null);
    Object.freeze(this);
    // Set root node after freezing Coupler, otherwise it gets vue-ified too.
    this._vue.$data.root = new Node(this, '/');
    this._nodeIndex['/'] = this._root;
  }

  get _root() {
    return this._vue.$data.root;
  }

  get _queryHandlers() {
    return this._vue.$data.queryHandlers;
  }

  destroy() {
    _.forEach(this._queryHandlers, queryHandler => {queryHandler.destroy();});
    this._root.unlisten();
    this._vue.$destroy();
  }

  couple(path, operation) {
    return this._coupleSegments(splitPath(path, true), operation);
  }

  _coupleSegments(segments, operation) {
    let node;
    let superseded = !operation;
    let ready = false;
    for (const segment of segments) {
      let child = segment ? node.children && node.children[segment] : this._root;
      if (!child) {
        child = new Node(this, `${node.path === '/' ? '' : node.path}/${segment}`, node);
        Vue.set(node.children, segment, child);
        this._nodeIndex[child.path] = child;
      }
      superseded = superseded || child.listening;
      ready = ready || child.ready;
      node = child;
    }
    if (operation) {
      node.operations.push(operation);
    } else {
      node.queryCount++;
    }
    if (superseded) {
      if (operation && ready) this._dispatcher.markReady(operation);
    } else {
      node.listen();  // node will call unlisten() on descendants when ready
    }
  }

  decouple(path, operation) {
    return this._decoupleSegments(splitPath(path, true), operation);
  }

  _decoupleSegments(segments, operation) {
    const ancestors = [];
    let node;
    for (const segment of segments) {
      node = segment ? node.children && node.children[segment] : this._root;
      if (!node) break;
      ancestors.push(node);
    }
    if (!node || !(operation ? node.count : node.queryCount)) {
      throw new Error(`Path not coupled: ${segments.join('/') || '/'}`);
    }
    if (operation) {
      _.pull(node.operations, operation);
    } else {
      node.queryCount--;
    }
    if (operation && !node.count) {
      // Ideally, we wouldn't resync the full values here since we probably already have the current
      // value for all children.  But making sure that's true is tricky in an async system (what if
      // the node's value changes and the update crosses the 'off' call in transit?) and this
      // situation should be sufficiently rare that the optimization is probably not worth it right
      // now.
      node.listen();
      if (node.listening) node.unlisten();
    }
    if (!node.active) {
      for (let i = ancestors.length - 1; i > 0; i--) {
        node = ancestors[i];
        if (node === this._root || node.active || !_.isEmpty(node.children)) break;
        Vue.delete(ancestors[i - 1].children, segments[i]);
        node.ready = undefined;
        delete this._nodeIndex[node.path];
      }
      const path = segments.join('/') || '/';
      this._prunePath(path, this.findCoupledDescendantPaths(path));
    }
  }

  subscribe(query, operation, keysCallback) {
    let queryHandler = this._queryHandlers[query.toString()];
    if (!queryHandler) {
      queryHandler = new QueryHandler(this, query);
      Vue.set(this._queryHandlers, query.toString(), queryHandler);
    }
    queryHandler.attach(operation, keysCallback);
  }

  unsubscribe(query, operation) {
    const queryHandler = this._queryHandlers[query.toString()];
    if (queryHandler && !queryHandler.detach(operation)) {
      queryHandler.destroy();
      Vue.delete(this._queryHandlers, query.toString());
    }
  }

  // Return whether the node at path or any ancestors are coupled.
  isTrunkCoupled(path) {
    const segments = splitPath(path, true);
    let node;
    for (const segment of segments) {
      node = segment ? node.children && node.children[segment] : this._root;
      if (!node) return false;
      if (node.active) return true;
    }
    return false;
  }

  findCoupledDescendantPaths(path) {
    let node;
    for (const segment of splitPath(path, true)) {
      node = segment ? node.children && node.children[segment] : this._root;
      if (node && node.active) return {[path]: node.active};
      if (!node) break;
    }
    return node && node.collectCoupledDescendantPaths();
  }

  isSubtreeReady(path) {
    let node, childSegment;
    function extractChildSegment(match) {
      childSegment = match.slice(1);
      return '';
    }
    while (!(node = this._nodeIndex[path])) {
      path = path.replace(/\/[^/]*$/, extractChildSegment) || '/';
    }
    if (childSegment) void node.children;  // state an interest in the closest ancestor's children
    while (node) {
      if (node.ready) return true;
      node = node.parent;
    }
    return false;
  }

  isQueryReady(query) {
    const queryHandler = this._queryHandlers[query.toString()];
    return queryHandler && queryHandler.ready;
  }

  _queueSnapshotCallback(callback) {
    this._pendingSnapshotCallbacks.push(callback);
    this._throttled.processPendingSnapshots.call(this);
  }

  _processPendingSnapshots() {
    for (const callback of this._pendingSnapshotCallbacks) callback();
    this._pendingSnapshotCallbacks.splice(0, Infinity);
  }

  throttleSnapshots(delay) {
    if (delay) {
      this._throttled.processPendingSnapshots = _.throttle(this._processPendingSnapshots, delay);
    } else {
      this._throttled.processPendingSnapshots = this._processPendingSnapshots;
    }
  }
}

