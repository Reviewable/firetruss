import _ from 'lodash';


class QueryHandler {
  constructor(coupler, query, keysCallback) {
    this._coupler = coupler;
    this._query = query;
    this._keysCallback = keysCallback;
    this._count = 1;
    this._keys = [];
    this._url = `${this._coupler._rootUrl}${query.path}`;
    this._segments = query.path.split('/');
    this._coupler._bridge.on(
      query.toString(), this._url, query._terms, 'value',
      this._handleSnapshot, this._handleError.bind(query.path), this, {sync: true});
  }

  matches(query, keysCallback) {
    return this._keysCallback === keysCallback && this._query.isEqual(query);
  }

  use(delta) {
    this._count += delta;
    if (this._count === 0) this.destroy();
    return this._count > 0;
  }

  destroy() {
    this._coupler._bridge.off(
      this._query.toString(), this._url, this._query._terms, 'value', this._handleSnapshot, this);
    for (let key in this._keys) {
      this._coupler._decoupleSegments(this._segments.concat(key), false);
    }
  }

  _handleSnapshot(snap) {
    // Order is important here: first couple any new subpaths so _handleSnapshot will update the
    // tree, then tell the client to update its keys, pulling values from the tree.
    const updatedKeys = this._updateKeys(snap);
    this._coupler._handleSnapshot(snap);
    if (updatedKeys) this.keysCallback(updatedKeys);
  }

  _updateKeys(snap) {
    let updatedKeys;
    if (snap.path === this._query.path) {
      updatedKeys = _.keys(snap.value);
      updatedKeys.sort();
      if (_.isEqual(this._keys, updatedKeys)) {
        updatedKeys = null;
      } else {
        for (let key in _.difference(updatedKeys, this._keys)) {
          this._coupler._coupleSegments(this._segments.concat(key), false);
        }
        for (let key in _.difference(this._keys, updatedKeys)) {
          this._coupler._decoupleSegments(this._segments.concat(key), false);
        }
        this._keys = updatedKeys;
      }
    } else if (snap.path.replace(/\/[^/]+/, '') === this._query.path) {
      const hasKey = _.contains(this._keys, snap.key);
      if (snap.value) {
        if (!hasKey) {
          this._coupler._coupleSegments(this._segments.concat(snap.key), false);
          this._keys.push(snap.key);
          this._keys.sort();
          updatedKeys = this._keys;
        }
      } else {
        if (hasKey) {
          this._coupler._decoupleSegments(this._segments.concat(snap.key), false);
          _.pull(this._keys, snap.key);
          this._keys.sort();
          updatedKeys = this._keys;
        }
      }
    }
    return updatedKeys;
  }
}


class Node {
  constructor(coupler) {
    this._coupler = coupler;
    this.count = 0;
    this.queryCount = 0;
    this.listening = false;
    this.ready = false;
    this.stale = false;
    this.children = {};
  }

  get active() {
    return this.count || this.queryCount;
  }

  listen(segments, skip) {
    if (!skip && this.count) {
      if (this.listening) return;
      const path = segments.join('/');
      const url = `${this._coupler._rootUrl}${path}`;
      this._coupler._bridge.on(
        url, url, null, 'value', this._handleSnapshot, this._handleError.bind(this, segments), this,
        {sync: true});
      this.listening = true;
    } else {
      _.each(this.children, (child, escapedKey) => {
        child.listen(segments.concat(escapedKey));
      });
    }
  }

  unlisten(segments, skip) {
    if (!skip && this.listening) {
      const url = `${this._coupler._rootUrl}${segments.join('/')}`;
      this._coupler._bridge.off(url, url, null, 'value', this._handleSnapshot, this);
      this.listening = false;
      this.ready = false;
    } else {
      _.each(this.children, (child, escapedKey) => {
        child.unlisten(segments.concat(escapedKey));
      });
    }
  }

  _handleSnapshot(snap) {
    if (!this._coupler.isTrunkCoupled(snap.path)) return;
    if (this.listening) {
      this.ready = true;
      this.stale = false;
    }
    this._coupler._applySnapshot(snap);
  }

  _handleError(segments, error) {
    if (!this.listening) return;
    this.listening = false;
    this.stale = true;
    this.listen(segments, true);
    // TODO: propagate the error
  }

  collectCoupledDescendantPaths(segments, paths) {
    if (paths) paths[segments.join('/')] = this.active;
    if (!paths) paths = [];
    if (!this.active) {
      _.each(this.children, (child, childKey) => {
        child.collectCoupledDescendantPaths(segments.concat(childKey), paths);
      });
    }
    return paths;
  }
}


export default class Coupler {
  constructor(rootUrl, bridge, applySnapshot, prunePath) {
    this._rootUrl = rootUrl;
    this._bridge = bridge;
    this._applySnapshot = applySnapshot;
    this._prunePath = prunePath;
    this._root = new Node(this);
    this._queryHandlers = [];
  }

  destroy() {
    this._root.unlisten(['']);
  }

  couple(path) {
    return this._coupleSegments(path.split('/'), true);
  }

  _coupleSegments(segments, listen) {
    let node;
    let superseded = !listen;
    for (let segment of segments) {
      let child = segment ? node.children && node.children[segment] : this._root;
      if (!child) node.children[segment] = child = new Node(this);
      superseded = superseded || child.listening;
      node = child;
    }
    if (listen) node.count++; else node.queryCount++;
    if (!superseded) {
      node.listen(segments);
      node.unlisten(segments, true);
    }
  }

  decouple(path) {
    return this._decoupleSegments(path.split('/'), true);
  }

  _decoupleSegments(segments, listen) {
    const ancestors = [];
    let node;
    for (let segment of segments) {
      node = segment ? node.children && node.children[segment] : this._root;
      if (!node) break;
      ancestors.push(node);
    }
    if (!node || !(listen ? node.count : node.queryCount)) {
      throw new Error(`Path not coupled: ${segments.join('/')}`);
    }
    if (listen) node.count--; else node.queryCount--;
    if (listen && !node.count) {
      // Ideally, we wouldn't resync the full values here since we probably already have the current
      // value for all children.  But making sure that's true is tricky in an async system (what if
      // the node's value changes and the update crosses the 'off' call in transit?) and this
      // situation should be sufficiently rare that the optimization is probably not worth it right
      // now.
      node.listen(segments);
      if (node.listening) node.unlisten(segments);
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

  subscribe(query, keysCallback) {
    const queryHandler =
      _.find(this._queryHandlers, queryHandler => queryHandler.matches(query, keysCallback));
    if (queryHandler) {
      queryHandler.use(true);
    } else {
      this._queryHandlers.push(new QueryHandler(this, query, keysCallback));
    }
 }

  unsubscribe(query, keysCallback) {
    const queryHandler =
      _.find(this._queryHandlers, queryHandler => queryHandler.matches(query, keysCallback));
    if (queryHandler && !queryHandler.use(false)) _.pull(this._queryHandlers, queryHandler);
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

