import _ from 'lodash';


class QueryHandler {
  constructor(coupler, query) {
    this._coupler = coupler;
    this._query = query;
    this._listeners = [];
    this._keys = [];
    this._url = `${this._coupler._rootUrl}${query.path}`;
    this._segments = query.path.split('/');
    this._listening = false;
    this.ready = false;
  }

  attach(operation, keysCallback) {
    this._listen();
    this._listeners.push({operation, keysCallback});
    keysCallback(this._keys);
  }

  detach(operation) {
    const k = _.findIndex(this._listeners, {operation});
    if (k >= 0) this._listeners.splice(k, 1);
    return this._listeners.length;
  }

  _listen() {
    if (this._listening) return;
    this._coupler._bridge.on(
      this._query.toString(), this._url, this._query._terms, 'value',
      this._handleSnapshot, this._handleError.bind(this._query.path), this, {sync: true});
    this._listening = true;
  }

  destroy() {
    this._coupler._bridge.off(
      this._query.toString(), this._url, this._query._terms, 'value', this._handleSnapshot, this);
    this._listening = false;
    this.ready = false;
    for (let key of this._keys) {
      this._coupler._decoupleSegments(this._segments.concat(key));
    }
  }

  _handleSnapshot(snap) {
    // Order is important here: first couple any new subpaths so _handleSnapshot will update the
    // tree, then tell the client to update its keys, pulling values from the tree.
    const updatedKeys = this._updateKeys(snap);
    this._coupler._handleSnapshot(snap);
    if (!this.ready) {
      this.ready = true;
      for (let listener of this._listeners) this._coupler._dispatcher.markReady(listener.operation);
    }
    if (updatedKeys) {
      for (let listener of this._listeners) listener.keysCallback(updatedKeys);
    }
  }

  _updateKeys(snap) {
    let updatedKeys;
    if (snap.path === this._query.path) {
      updatedKeys = _.keys(snap.value);
      updatedKeys.sort();
      if (_.isEqual(this._keys, updatedKeys)) {
        updatedKeys = null;
      } else {
        for (let key of _.difference(updatedKeys, this._keys)) {
          this._coupler._coupleSegments(this._segments.concat(key));
        }
        for (let key of _.difference(this._keys, updatedKeys)) {
          this._coupler._decoupleSegments(this._segments.concat(key));
        }
        this._keys = updatedKeys;
      }
    } else if (snap.path.replace(/\/[^/]+/, '') === this._query.path) {
      const hasKey = _.contains(this._keys, snap.key);
      if (snap.value) {
        if (!hasKey) {
          this._coupler._coupleSegments(this._segments.concat(snap.key));
          this._keys.push(snap.key);
          this._keys.sort();
          updatedKeys = this._keys;
        }
      } else {
        if (hasKey) {
          this._coupler._decoupleSegments(this._segments.concat(snap.key));
          _.pull(this._keys, snap.key);
          this._keys.sort();
          updatedKeys = this._keys;
        }
      }
    }
    return updatedKeys;
  }

  _handleError(error) {
    if (!this._listeners.length || !this._listening) return;
    this._listening = false;
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
        for (let listener of this._listeners) listener.operation._disconnect(error);
      }
    });
  }
}


class Node {
  constructor(coupler, path) {
    this._coupler = coupler;
    this.path = path;
    this.url = `${this._coupler._rootUrl}${path}`;
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
      _.each(this.operations, op => {this._coupler._dispatcher.clearReady(op);});
      this._coupler._bridge.on(
        this.url, this.url, null, 'value', this._handleSnapshot, this._handleError.bind(this),
        this, {sync: true});
      this.listening = true;
    } else {
      _.each(this.children, child => {child.listen();});
    }
  }

  unlisten(skip) {
    if (!skip && this.listening) {
      this._coupler._bridge.off(this.url, this.url, null, 'value', this._handleSnapshot, this);
      this.listening = false;
      this._forAllDescendants(node => {node.ready = false;});
    } else {
      _.each(this.children, child => {child.unlisten();});
    }
  }

  _handleSnapshot(snap) {
    if (!this.listening || !this._coupler.isTrunkCoupled(snap.path)) return;
    this._coupler._applySnapshot(snap);
    if (!this.ready && snap.path === this.path) {
      this.unlisten(true);
      this._forAllDescendants(node => {
        node.ready = true;
        for (let op of this.operations) this._coupler._dispatcher.markReady(op);
      });
    }
  }

  _handleError(error) {
    if (!this.count || !this.listening) return;
    this.listening = false;
    this._forAllDescendants(node => {
      node.ready = false;
      for (let op of this.operations) this._coupler._dispatcher.clearReady(op);
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
        for (let op of this.operations) op._disconnect(error);
        // Pulling all the operations will automatically get us listening on descendants.
      }
    });
  }

  _forAllDescendants(iteratee) {
    iteratee(this);
    _.each(this.children, child => child._forAllDescendants(iteratee));
  }

  collectCoupledDescendantPaths(paths) {
    if (paths) paths[this.path] = this.active;
    if (!paths) paths = [];
    if (!this.active) {
      _.each(this.children, child => {child.collectCoupledDescendantPaths(paths);});
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
    this._prunePath = prunePath;
    this._root = new Node(this, '/');
    this._queryHandlers = {};
  }

  destroy() {
    _.each(this._queryHandlers, queryHandler => {queryHandler.destroy();});
    this._root.unlisten();
  }

  couple(path, operation) {
    return this._coupleSegments(path.split('/'), operation);
  }

  _coupleSegments(segments, operation) {
    let node;
    let superseded = !operation;
    let ready = false;
    for (let segment of segments) {
      let child = segment ? node.children && node.children[segment] : this._root;
      if (!child) node.children[segment] = child =
        new Node(this, `${node.path === '/' ? '' : node.path}/${segment}`);
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
    return this._decoupleSegments(path.split('/'), operation);
  }

  _decoupleSegments(segments, operation) {
    const ancestors = [];
    let node;
    for (let segment of segments) {
      node = segment ? node.children && node.children[segment] : this._root;
      if (!node) break;
      ancestors.push(node);
    }
    if (!node || !(operation ? node.count : node.queryCount)) {
      throw new Error(`Path not coupled: ${segments.join('/')}`);
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
      const coupledDescendantPaths = node.collectCoupledDescendantPaths(segments);
      this._prunePath(segments.join('/'), coupledDescendantPaths);
      for (let i = ancestors.length - 1; i > 0; i--) {
        node = ancestors[i];
        if (node === this._root || node.active || !_.isEmpty(node.children)) break;
        delete ancestors[i - 1].children[segments[i]];
      }
    }
  }

  subscribe(query, operation, keysCallback) {
    let queryHandler = this._queryHandlers[query.toString()];
    if (!queryHandler) queryHandler = new QueryHandler(this, query);
    queryHandler.attach(operation, keysCallback);
 }

  unsubscribe(query, operation) {
    const queryHandler = this._queryHandlers[query.toString()];
    if (queryHandler && !queryHandler.detach(operation)) {
      queryHandler.destroy();
      delete this._queryHandlers[query.toString()];
    }
  }

  // Return whether the node at path or any ancestors are coupled.
  isTrunkCoupled(path) {
    const segments = path.split('/');
    let node;
    for (let segment of segments) {
      node = segment ? node.children && node.children[segment] : this._root;
      if (!node) return false;
      if (node.active) return true;
    }
    return false;
  }
}

