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
