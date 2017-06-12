import _ from 'lodash';


export const SERVER_TIMESTAMP = Object.freeze({'.sv': 'timestamp'});

export function escapeKey(key) {
  if (!key) return key;
  return key.toString().replace(/[\\\.\$\#\[\]\/]/g, function(char) {
    return '\\' + char.charCodeAt(0).toString(16);
  });
}

export function unescapeKey(key) {
  if (!key) return key;
  return key.toString().replace(/\\[0-9a-f]{2}/gi, function(code) {
    return String.fromCharCode(parseInt(code.slice(1), 16));
  });
}

export function wrapPromiseCallback(callback) {
  return function() {
    try {
      return Promise.resolve(callback.apply(this, arguments));
    } catch (e) {
      return Promise.reject(e);
    }
  };
}

export function promiseCancel(promise, cancel) {
  promise = promiseFinally(promise, () => {cancel = null;});
  promise.cancel = () => {
    if (!cancel) return;
    cancel();
    cancel = null;
  };
  propagatePromiseProperty(promise, 'cancel');
  return promise;
}

function propagatePromiseProperty(promise, propertyName) {
  const originalThen = promise.then, originalCatch = promise.catch;
  promise.then = (onResolved, onRejected) => {
    const derivedPromise = originalThen.call(promise, onResolved, onRejected);
    derivedPromise[propertyName] = promise[propertyName];
    propagatePromiseProperty(derivedPromise, propertyName);
    return derivedPromise;
  };
  promise.catch = onRejected => {
    const derivedPromise = originalCatch.call(promise, onRejected);
    derivedPromise[propertyName] = promise[propertyName];
    propagatePromiseProperty(derivedPromise, propertyName);
    return derivedPromise;
  };
  return promise;
}

export function promiseFinally(promise, onFinally) {
  if (!onFinally) return promise;
  onFinally = wrapPromiseCallback(onFinally);
  return promise.then(result => {
    return onFinally().then(() => result);
  }, error => {
    return onFinally().then(() => Promise.reject(error));
  });
}


class LruCacheItem {
  constructor(key, value) {
    this.key = key;
    this.value = value;
    this.touch();
  }

  touch() {
    this.timestamp = Date.now();
  }
}


class LruCache {
  constructor(maxSize, pruningSize) {
    this._items = Object.create(null);
    this._size = 0;
    this._maxSize = maxSize;
    this._pruningSize = pruningSize || Math.ceil(maxSize * 0.10);
  }

  has(key) {
    return Boolean(this._items[key]);
  }

  get(key) {
    const item = this._items[key];
    if (!item) return;
    item.touch();
    return item.value;
  }

  set(key, value) {
    const item = this._items[key];
    if (item) {
      item.value = value;
    } else {
      if (this._size >= this._maxSize) this._prune();
      this._items[key] = new LruCacheItem(key, value);
      this._size += 1;
    }
  }

  delete(key) {
    const item = this._items[key];
    if (!item) return;
    delete this._items[key];
    this._size -= 1;
  }

  _prune() {
    const itemsToPrune =
      _(this._items).toArray().sortBy('timestamp').take(this._pruningSize).value();
    for (const item of itemsToPrune) this.delete(item.key);
  }
}


const pathSegments = new LruCache(1000);

export function joinPath() {
  const segments = [];
  for (let segment of arguments) {
    if (!_.isString(segment)) segment = '' + segment;
    if (segment.charAt(0) === '/') segments.splice(0, segments.length);
    segments.push(segment);
  }
  if (segments[0] === '/') segments[0] = '';
  return segments.join('/');
}

export function splitPath(path, leaveSegmentsEscaped) {
  const key = (leaveSegmentsEscaped ? 'esc:' : '') + path;
  let segments = pathSegments.get(key);
  if (!segments) {
    segments = path.split('/');
    if (!leaveSegmentsEscaped) segments = _.map(segments, unescapeKey);
    pathSegments.set(key, segments);
  }
  return segments;
}

export function isTrussEqual(a, b) {
  return _.isEqual(a, b, isTrussValueEqual);
}

function isTrussValueEqual(a, b) {
  if (a === b || a === undefined || a === null || b === undefined || b === null ||
      a.$truss || b.$truss) return a === b;
  if (a.isEqual) return a.isEqual(b);
}


const pathMatchers = {};
const maxNumPathMatchers = 1000;


class PathMatcher {
  constructor(pattern) {
    this.variables = [];
    const prefixMatch = _.endsWith(pattern, '/$*');
    if (prefixMatch) pattern = pattern.slice(0, -3);
    const pathTemplate = pattern.replace(/\/\$[^\/]*/g, match => {
      if (match.length > 1) this.variables.push(match.slice(1));
      return '\u0001';
    });
    Object.freeze(this.variables);
    if (/[$-.?[-^{|}]/.test(pathTemplate)) {
      throw new Error('Path pattern has unescaped keys: ' + pattern);
    }
    this._regex = new RegExp(
      '^' + pathTemplate.replace(/\u0001/g, '/([^/]+)') + (prefixMatch ? '($|/)' : '$'));
  }

  match(path) {
    this._regex.lastIndex = 0;
    const match = this._regex.exec(path);
    if (!match) return;
    const bindings = {};
    for (let i = 0; i < this.variables.length; i++) {
      bindings[this.variables[i]] = unescapeKey(match[i + 1]);
    }
    return bindings;
  }

  test(path) {
    return this._regex.test(path);
  }

  toString() {
    return this._regex.toString();
  }
}


export function makePathMatcher(pattern) {
  let matcher = pathMatchers[pattern];
  if (!matcher) {
    matcher = new PathMatcher(pattern);
    // Minimal pseudo-LRU behavior, since we don't expect to actually fill up the cache.
    if (_.size(pathMatchers) === maxNumPathMatchers) delete pathMatchers[_.keys(pathMatchers)[0]];
    pathMatchers[pattern] = matcher;
  }
  return matcher;
}
