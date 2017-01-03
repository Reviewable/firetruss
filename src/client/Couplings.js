import _ from 'lodash';

export default class Couplings {
  constructor(rootUrl, bridge, applySnapshot) {
    this._rootUrl = rootUrl;
    this._bridge = bridge;
    this._applySnapshot = applySnapshot;
    this._root = {};
    this._bridge.onRawData(this._rootUrl, this._handleRawData, this);
  }

  destroy() {
    this._unlisten(this._root, ['']);
    this._bridge.offRawData(this._rootUrl, this._handleRawData, this);
  }

  couple(path) {
    const segments = path.split('/');
    let node;
    let superseded = false;
    for (let segment of segments) {
      let child = segment ? node.children && node.children[segment] : this._root;
      if (!child) (node.children || (node.children = {}))[segment] = child = {};
      superseded = superseded || child.count;
      node = child;
    }
    if (!node.count) node.count = 0;
    node.count++;
    if (!superseded) {
      this._listen(node, segments);
      this._unlisten(node, segments, true);
    }
  }

  decouple(path) {
    const segments = path.split('/');
    const ancestors = [];
    let node;
    for (let segment of segments) {
      node = segment ? node.children && node.children[segment] : this._root;
      if (!node) break;
      ancestors.push(node);
    }
    if (!node || !node.count) throw new Error(`Path not connected: ${path}`);
    node.count--;
    if (!node.count) {
      this._listen(node, segments);
      if (node.listening) this._unlisten(node, segments);
      for (let i = ancestors.length - 1; i > 0; i--) {
        node = ancestors[i];
        if (node === this._root || node.count || !_.isEmpty(node.children)) break;
        delete ancestors[i - 1].children[segments[i]];
      }
    }
  }

  _listen(node, segments, skip) {
    if (!skip && node.count) {
      if (node.listening) {
        throw new Error(`Internal error: already listening to ${segments.join('/')}`);
      }
      const path = segments.join('/');
      const url = `${this._rootUrl}${path}`;
      this._bridge.on(
        url, url, null, 'value', this._handleSnapshot, this._handleError.bind(path), this,
        {sync: true});
      node.listening = true;
    } else {
      _.each(node.children, (child, escapedKey) => {
        this._listen(child, segments.concat(escapedKey));
      });
    }
  }

  _unlisten(node, segments, skip) {
    if (!skip && node.listening) {
      const url = `${this._rootUrl}${segments.join('/')}`;
      this._bridge.off(url, url, null, 'value', this._handleSnapshot, this);
      node.listening = false;
    } else {
      _.each(node.children, (child, escapedKey) => {
        this._unlisten(child, segments.concat(escapedKey));
      });
    }
  }

  _handleSnapshot(snap) {
    if (this._isCoupled(snap.path)) this._applySnapshot(snap);
  }

  _handleRawData(data) {
    // TODO: implement
  }

  _handleError(path, error) {
    const segments = path.split('/');
    let node;
    for (let segment of segments) {
      node = segment ? node.children && node.children[segment] : this._root;
      if (!node) return;
    }
    if (!node.listening) return;
    node.listening = false;
    this._listen(node, segments, true);
    // TODO: propagate the error
  }

  _isCoupled(path) {
    const segments = path.split('/');
    let node;
    for (let segment of segments) {
      const child = segment ? node.children && node.children[segment] : this._root;
      if (!child) return false;
      if (child.count) return true;
      node = child;
    }
    return false;
  }
}

