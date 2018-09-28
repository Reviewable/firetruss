import _ from 'lodash';
import Vue from 'vue';
import performanceNow from 'performance-now';

/* globals window */

let vue;
let lastDigestRequest = 0;
let digestInProgress = false;
const bareDigest = function() {
  if (vue.digestRequest > lastDigestRequest) return;
  vue.digestRequest = lastDigestRequest + 1;
};

const angularProxy = {
  active: typeof window !== 'undefined' && window.angular
};

if (angularProxy.active) {
  initAngular();
} else {
  _.forEach(['digest', 'watch', 'defineModule', 'debounceDigest'], method => {
    angularProxy[method] = _.noop;
  });
}

function initAngular() {
  const module = window.angular.module('firetruss', []);
  angularProxy.digest = bareDigest;
  angularProxy.watch = function() {throw new Error('Angular watch proxy not yet initialized');};
  angularProxy.defineModule = function(Truss) {
    module.constant('Truss', Truss);
  };
  angularProxy.debounceDigest = function(wait) {
    if (wait) {
      const debouncedDigest = _.debounce(bareDigest, wait);
      angularProxy.digest = function() {
        if (vue.digestRequest > lastDigestRequest) return;
        if (digestInProgress) bareDigest(); else debouncedDigest();
      };
    } else {
      angularProxy.digest = bareDigest;
    }
  };

  module.config(['$provide', function($provide) {
    $provide.decorator('$rootScope', ['$delegate', '$exceptionHandler',
      function($delegate, $exceptionHandler) {
        const rootScope = $delegate;
        angularProxy.watch = rootScope.$watch.bind(rootScope);
        const proto = Object.getPrototypeOf(rootScope);
        const angularDigest = proto.$digest;
        proto.$digest = bareDigest;
        proto.$digest.original = angularDigest;
        vue = new Vue({data: {digestRequest: 0}});
        vue.$watch(() => vue.digestRequest, () => {
          if (vue.digestRequest > lastDigestRequest) {
            // Make sure we execute the digest outside the Vue task queue, because otherwise if the
            // client replaced Promise with angular.$q all Truss.nextTick().then() functions will be
            // executed inside the Angular digest and hence inside the Vue task queue. But
            // Truss.nextTick() is used precisely to avoid that.  Note that it's OK to use
            // Vue.nextTick() here because even though it will schedule a flush via Promise.then()
            // it only uses the native Promise, before it could've been monkey-patched by the app.
            Vue.nextTick(() => {
              if (vue.digestRequest <= lastDigestRequest) return;
              digestInProgress = true;
              rootScope.$digest.original.call(rootScope);
              lastDigestRequest = vue.digestRequest = vue.digestRequest + 1;
            });
          } else {
            digestInProgress = false;
          }
        });
        _.last(vue._watchers).id = Infinity;  // make sure watcher is scheduled last
        return rootScope;
      }
    ]);
  }]);
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
const pathMatchers = {};
const maxNumPathMatchers = 1000;


function escapeKey(key) {
  if (!key) return key;
  return key.toString().replace(/[\\.$#[\]/]/g, function(char) {
    return '\\' + char.charCodeAt(0).toString(16);
  });
}

function unescapeKey(key) {
  if (!key) return key;
  return key.toString().replace(/\\[0-9a-f]{2}/gi, function(code) {
    return String.fromCharCode(parseInt(code.slice(1), 16));
  });
}

function escapeKeys(object) {
  // isExtensible check avoids trying to escape references to Firetruss internals.
  if (!(_.isObject(object) && Object.isExtensible(object))) return object;
  let result = object;
  for (const key in object) {
    if (!object.hasOwnProperty(key)) continue;
    const value = object[key];
    const escapedKey = escapeKey(key);
    const escapedValue = escapeKeys(value);
    if (escapedKey !== key || escapedValue !== value) {
      if (result === object) result = _.clone(object);
      result[escapedKey] = escapedValue;
      if (result[key] === value) delete result[key];
    }
  }
  return result;
}

function joinPath() {
  const segments = [];
  for (let segment of arguments) {
    if (!_.isString(segment)) segment = '' + segment;
    if (segment.charAt(0) === '/') segments.splice(0, segments.length);
    segments.push(segment);
  }
  if (segments[0] === '/') segments[0] = '';
  return segments.join('/');
}

function splitPath(path, leaveSegmentsEscaped) {
  const key = (leaveSegmentsEscaped ? 'esc:' : '') + path;
  let segments = pathSegments.get(key);
  if (!segments) {
    segments = path.split('/');
    if (!leaveSegmentsEscaped) segments = _.map(segments, unescapeKey);
    pathSegments.set(key, segments);
  }
  return segments;
}


class PathMatcher {
  constructor(pattern) {
    this.variables = [];
    const prefixMatch = _.endsWith(pattern, '/$*');
    if (prefixMatch) pattern = pattern.slice(0, -3);
    const pathTemplate = pattern.replace(/\/\$[^/]*/g, match => {
      if (match.length > 1) this.variables.push(match.slice(1));
      return '\u0001';
    });
    Object.freeze(this.variables);
    if (/[.$#[\]]|\\(?![0-9a-f][0-9a-f])/i.test(pathTemplate)) {
      throw new Error('Path pattern has unescaped keys: ' + pattern);
    }
    this._regex = new RegExp(
      // eslint-disable-next-line no-control-regex
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

function makePathMatcher(pattern) {
  let matcher = pathMatchers[pattern];
  if (!matcher) {
    matcher = new PathMatcher(pattern);
    // Minimal pseudo-LRU behavior, since we don't expect to actually fill up the cache.
    if (_.size(pathMatchers) === maxNumPathMatchers) delete pathMatchers[_.keys(pathMatchers)[0]];
    pathMatchers[pattern] = matcher;
  }
  return matcher;
}

const MIN_WORKER_VERSION = '0.8.0';


class Snapshot {
  constructor({path, value, exists, writeSerial}) {
    this._path = path;
    this._value = value;
    this._exists = value === undefined ? exists || false : value !== null;
    this._writeSerial = writeSerial;
  }

  get path() {
    return this._path;
  }

  get exists() {
    return this._exists;
  }

  get value() {
    if (this._value === undefined) throw new Error('Value omitted from snapshot');
    return this._value;
  }

  get key() {
    if (this._key === undefined) this._key = unescapeKey(this._path.replace(/.*\//, ''));
    return this._key;
  }

  get writeSerial() {
    return this._writeSerial;
  }
}


class Bridge {
  constructor(webWorker) {
    this._idCounter = 0;
    this._deferreds = {};
    this._suspended = false;
    this._servers = {};
    this._callbacks = {};
    this._log = _.noop;
    this._simulatedTokenGenerator = null;
    this._maxSimulationDuration = 5000;
    this._simulatedCallFilter = null;
    this._inboundMessages = [];
    this._outboundMessages = [];
    this._flushMessageQueue = this._flushMessageQueue.bind(this);
    this._port = webWorker.port || webWorker;
    this._shared = !!webWorker.port;
    Object.seal(this);
    this._port.onmessage = this._receive.bind(this);
    window.addEventListener('unload', () => {this._send({msg: 'destroy'});});
    setInterval(() => {this._send({msg: 'ping'});}, 60 * 1000);
  }

  init(webWorker) {
    const items = [];
    try {
      const storage = window.localStorage || window.sessionStorage;
      if (!storage) throw new Error('localStorage and sessionStorage not available');
      for (let i = 0; i < storage.length; i++) {
        const key = storage.key(i);
        items.push({key, value: storage.getItem(key)});
      }
    } catch (e) {
      // Some browsers don't like us accessing local storage -- nothing we can do.
    }
    return this._send({msg: 'init', storage: items}).then(response => {
      const workerVersion = response.version.match(/^(\d+)\.(\d+)\.(\d+)(-.*)?$/);
      if (workerVersion) {
        const minVersion = MIN_WORKER_VERSION.match(/^(\d+)\.(\d+)\.(\d+)(-.*)?$/);
        // Major version must match precisely, minor and patch must be greater than or equal.
        const sufficient = workerVersion[1] === minVersion[1] && (
          workerVersion[2] > minVersion[2] ||
          workerVersion[2] === minVersion[2] && workerVersion[3] >= minVersion[3]
        );
        if (!sufficient) {
          return Promise.reject(new Error(
            `Incompatible Firetruss worker version: ${response.version} ` +
            `(${MIN_WORKER_VERSION} or better required)`
          ));
        }
      }
      return response;
    });
  }

  suspend(suspended) {
    if (suspended === undefined) suspended = true;
    if (this._suspended === suspended) return;
    this._suspended = suspended;
    if (!suspended) {
      this._receiveMessages(this._inboundMessages);
      this._inboundMessages = [];
      if (this._outboundMessages.length) Promise.resolve().then(this._flushMessageQueue);
    }
  }

  debugPermissionDeniedErrors(simulatedTokenGenerator, maxSimulationDuration, callFilter) {
    this._simulatedTokenGenerator = simulatedTokenGenerator;
    if (maxSimulationDuration !== undefined) this._maxSimulationDuration = maxSimulationDuration;
    this._simulatedCallFilter = callFilter || _.constant(true);
  }

  enableLogging(fn) {
    if (fn) {
      if (fn === true) fn = console.log.bind(console);
      this._log = fn;
    } else {
      this._log = _.noop;
    }
  }

  _send(message) {
    message.id = ++this._idCounter;
    let promise;
    if (message.oneWay) {
      promise = Promise.resolve();
    } else {
      promise = new Promise((resolve, reject) => {
        this._deferreds[message.id] = {resolve, reject};
      });
      const deferred = this._deferreds[message.id];
      deferred.promise = promise;
      promise.sent = new Promise(resolve => {
        deferred.resolveSent = resolve;
      });
      deferred.params = message;
    }
    if (!this._outboundMessages.length && !this._suspended) {
      Promise.resolve().then(this._flushMessageQueue);
    }
    this._log('send:', message);
    this._outboundMessages.push(message);
    return promise;
  }

  _flushMessageQueue() {
    this._port.postMessage(this._outboundMessages);
    this._outboundMessages = [];
  }

  _receive(event) {
    if (this._suspended) {
      this._inboundMessages = this._inboundMessages.concat(event.data);
    } else {
      this._receiveMessages(event.data);
    }
  }

  _receiveMessages(messages) {
    for (const message of messages) {
      this._log('recv:', message);
      const fn = this[message.msg];
      if (!_.isFunction(fn)) throw new Error('Unknown message: ' + message.msg);
      fn.call(this, message);
    }
  }

  bindExposedFunction(name) {
    return (function() {
      return this._send({msg: 'call', name, args: Array.prototype.slice.call(arguments)});
    }).bind(this);
  }

  resolve(message) {
    const deferred = this._deferreds[message.id];
    if (!deferred) throw new Error('Received resolution to inexistent Firebase call');
    delete this._deferreds[message.id];
    deferred.resolve(message.result);
  }

  reject(message) {
    const deferred = this._deferreds[message.id];
    if (!deferred) throw new Error('Received rejection of inexistent Firebase call');
    delete this._deferreds[message.id];
    deferred.reject(errorFromJson(message.error, deferred.params));
  }

  probeError(error) {
    const code = error.code || error.message;
    if (error.params && code && code.toLowerCase() === 'permission_denied') {
      return this._simulateCall(error.params).then(securityTrace => {
        if (securityTrace) error.permissionDeniedDetails = securityTrace;
      });
    }
    return Promise.resolve();
  }

  _simulateCall(props) {
    if (!(this._simulatedTokenGenerator && this._maxSimulationDuration > 0)) {
      return Promise.resolve();
    }
    const simulatedCalls = [];
    switch (props.msg) {
      case 'set':
        simulatedCalls.push({method: 'set', url: props.url, args: [props.value]});
        break;
      case 'update':
        simulatedCalls.push({method: 'update', url: props.url, args: [props.value]});
        break;
      case 'once':
        simulatedCalls.push({method: 'once', url: props.url, spec: props.spec, args: ['value']});
        break;
      case 'on':
        simulatedCalls.push({method: 'once', url: props.url, spec: props.spec, args: ['value']});
        break;
      case 'transaction':
        simulatedCalls.push({method: 'once', url: props.url, args: ['value']});
        simulatedCalls.push({method: 'set', url: props.url, args: [props.newValue]});
        break;
    }
    if (!simulatedCalls.length || !this._simulatedCallFilter(props.msg, props.url)) {
      return Promise.resolve();
    }
    const auth = this.getAuth(getUrlRoot(props.url));
    const simulationPromise = this._simulatedTokenGenerator(auth && auth.uid).then(token => {
      return Promise.all(_.map(simulatedCalls, message => {
        message.msg = 'simulate';
        message.token = token;
        return this._send(message);
      }));
    }).then(securityTraces => {
      if (_.every(securityTraces, trace => trace === null)) {
        return 'Unable to reproduce error in simulation';
      }
      return _.compact(securityTraces).join('\n\n');
    }).catch(e => {
      return 'Error running simulation: ' + e;
    });
    const timeoutPromise = new Promise(resolve => {
      setTimeout(resolve.bind(null, 'Simulated call timed out'), this._maxSimulationDuration);
    });
    return Promise.race([simulationPromise, timeoutPromise]);
  }

  updateLocalStorage({items}) {
    try {
      const storage = window.localStorage || window.sessionStorage;
      for (const item of items) {
        if (item.value === null) {
          storage.removeItem(item.key);
        } else {
          storage.setItem(item.key, item.value);
        }
      }
    } catch (e) {
      // If we're denied access, there's nothing we can do.
    }
  }

  trackServer(rootUrl) {
    if (this._servers.hasOwnProperty(rootUrl)) return;
    const server = this._servers[rootUrl] = {authListeners: []};
    const authCallbackId = this._registerCallback(this._authCallback.bind(this, server));
    this._send({msg: 'onAuth', url: rootUrl, callbackId: authCallbackId});
  }

  _authCallback(server, auth) {
    server.auth = auth;
    for (const listener of server.authListeners) listener(auth);
  }

  onAuth(rootUrl, callback, context) {
    const listener = callback.bind(context);
    listener.callback = callback;
    listener.context = context;
    this._servers[rootUrl].authListeners.push(listener);
    listener(this.getAuth(rootUrl));
  }

  offAuth(rootUrl, callback, context) {
    const authListeners = this._servers[rootUrl].authListeners;
    for (let i = 0; i < authListeners.length; i++) {
      const listener = authListeners[i];
      if (listener.callback === callback && listener.context === context) {
        authListeners.splice(i, 1);
        break;
      }
    }
  }

  getAuth(rootUrl) {
    return this._servers[rootUrl].auth;
  }

  authWithCustomToken(url, authToken, options) {
    return this._send({msg: 'authWithCustomToken', url, authToken, options});
  }

  unauth(url) {
    return this._send({msg: 'unauth', url});
  }

  set(url, value, writeSerial) {return this._send({msg: 'set', url, value, writeSerial});}
  update(url, value, writeSerial) {return this._send({msg: 'update', url, value, writeSerial});}

  once(url, writeSerial) {
    return this._send({msg: 'once', url, writeSerial}).then(snapshot => new Snapshot(snapshot));
  }

  on(listenerKey, url, spec, eventType, snapshotCallback, cancelCallback, context, options) {
    const handle = {
      listenerKey, eventType, snapshotCallback, cancelCallback, context,
      params: {msg: 'on', listenerKey, url, spec, eventType, options}
    };
    const callback = this._onCallback.bind(this, handle);
    this._registerCallback(callback, handle);
    // Keep multiple IDs to allow the same snapshotCallback to be reused.
    snapshotCallback.__callbackIds = snapshotCallback.__callbackIds || [];
    snapshotCallback.__callbackIds.push(handle.id);
    this._send({
      msg: 'on', listenerKey, url, spec, eventType, callbackId: handle.id, options
    }).catch(error => {
      callback(error);
    });
  }

  off(listenerKey, url, spec, eventType, snapshotCallback, context) {
    const idsToDeregister = [];
    let callbackId;
    if (snapshotCallback) {
      callbackId = this._findAndRemoveCallbackId(
        snapshotCallback, handle => _.isMatch(handle, {listenerKey, eventType, context})
      );
      if (!callbackId) return Promise.resolve();  // no-op, never registered or already deregistered
      idsToDeregister.push(callbackId);
    } else {
      for (const id of _.keys(this._callbacks)) {
        const handle = this._callbacks[id];
        if (handle.listenerKey === listenerKey && (!eventType || handle.eventType === eventType)) {
          idsToDeregister.push(id);
        }
      }
    }
    // Nullify callbacks first, then deregister after off() is complete.  We don't want any
    // callbacks in flight from the worker to be invoked while the off() is processing, but we don't
    // want them to throw an exception either.
    for (const id of idsToDeregister) this._nullifyCallback(id);
    return this._send({msg: 'off', listenerKey, url, spec, eventType, callbackId}).then(() => {
      for (const id of idsToDeregister) this._deregisterCallback(id);
    });
  }

  _onCallback(handle, error, snapshotJson) {
    if (error) {
      this._deregisterCallback(handle.id);
      const e = errorFromJson(error, handle.params);
      if (handle.cancelCallback) {
        handle.cancelCallback.call(handle.context, e);
      } else {
        console.error(e);
      }
    } else {
      handle.snapshotCallback.call(handle.context, new Snapshot(snapshotJson));
    }
  }

  transaction(url, oldValue, relativeUpdates, writeSerial) {
    return this._send(
      {msg: 'transaction', url, oldValue, relativeUpdates, writeSerial}
    ).then(result => {
      if (result.snapshots) {
        result.snapshots = _.map(result.snapshots, jsonSnapshot => new Snapshot(jsonSnapshot));
      }
      return result;
    });
  }

  onDisconnect(url, method, value) {
    return this._send({msg: 'onDisconnect', url, method, value});
  }

  bounceConnection() {
    return this._send({msg: 'bounceConnection'});
  }

  callback({id, args}) {
    const handle = this._callbacks[id];
    if (!handle) throw new Error('Unregistered callback: ' + id);
    handle.callback.apply(null, args);
  }

  _registerCallback(callback, handle) {
    handle = handle || {};
    handle.callback = callback;
    handle.id = `cb${++this._idCounter}`;
    this._callbacks[handle.id] = handle;
    return handle.id;
  }

  _nullifyCallback(id) {
    this._callbacks[id].callback = _.noop;
  }

  _deregisterCallback(id) {
    delete this._callbacks[id];
  }

  _findAndRemoveCallbackId(callback, predicate) {
    if (!callback.__callbackIds) return;
    let i = 0;
    while (i < callback.__callbackIds.length) {
      const id = callback.__callbackIds[i];
      const handle = this._callbacks[id];
      if (!handle) {
        callback.__callbackIds.splice(i, 1);
        continue;
      }
      if (predicate(handle)) {
        callback.__callbackIds.splice(i, 1);
        return id;
      }
      i += 1;
    }
  }
}


function errorFromJson(json, params) {
  if (!json || _.isError(json)) return json;
  const error = new Error(json.message);
  error.params = params;
  for (const propertyName in json) {
    if (propertyName === 'message' || !json.hasOwnProperty(propertyName)) continue;
    try {
      error[propertyName] = json[propertyName];
    } catch (e) {
      error.extra = error.extra || {};
      error.extra[propertyName] = json[propertyName];
    }
  }
  return error;
}

function getUrlRoot(url) {
  const k = url.indexOf('/', 8);
  return k >= 8 ? url.slice(0, k) : url;
}

/* eslint-disable no-use-before-define */

const EMPTY_ANNOTATIONS = {};
Object.freeze(EMPTY_ANNOTATIONS);


class Handle {
  constructor(tree, path, annotations) {
    this._tree = tree;
    this._path = path.replace(/^\/*/, '/').replace(/\/$/, '') || '/';
    if (annotations) {
      this._annotations = annotations;
      Object.freeze(annotations);
    }
  }

  get $ref() {return this;}
  get key() {
    if (!this._key) this._key = unescapeKey(this._path.replace(/.*\//, ''));
    return this._key;
  }
  get path() {return this._path;}
  get _pathPrefix() {return this._path === '/' ? '' : this._path;}
  get parent() {
    return new Reference(this._tree, this._path.replace(/\/[^/]*$/, ''), this._annotations);
  }

  get annotations() {
    return this._annotations || EMPTY_ANNOTATIONS;
  }

  child() {
    if (!arguments.length) return this;
    const segments = [];
    for (const key of arguments) {
      if (key === undefined || key === null) return;
      segments.push(escapeKey(key));
    }
    return new Reference(
      this._tree, `${this._pathPrefix}/${segments.join('/')}`,
      this._annotations
    );
  }

  children() {
    if (!arguments.length) return this;
    const escapedKeys = [];
    for (let i = 0; i < arguments.length; i++) {
      const arg = arguments[i];
      if (_.isArray(arg)) {
        const mapping = {};
        const subPath = this._pathPrefix + (escapedKeys.length ? `/${escapedKeys.join('/')}` : '');
        const rest = _.slice(arguments, i + 1);
        for (const key of arg) {
          const subRef =
            new Reference(this._tree, `${subPath}/${escapeKey(key)}`, this._annotations);
          const subMapping = subRef.children.apply(subRef, rest);
          if (subMapping) mapping[key] = subMapping;
        }
        return mapping;
      }
      if (arg === undefined || arg === null) return;
      escapedKeys.push(escapeKey(arg));
    }
    return new Reference(
      this._tree, `${this._pathPrefix}/${escapedKeys.join('/')}`, this._annotations);
  }

  peek(callback) {
    return this._tree.truss.peek(this, callback);
  }

  match(pattern) {
    return makePathMatcher(pattern).match(this.path);
  }

  test(pattern) {
    return makePathMatcher(pattern).test(this.path);
  }

  isEqual(that) {
    if (!(that instanceof Handle)) return false;
    return this._tree === that._tree && this.toString() === that.toString() &&
      _.isEqual(this._annotations, that._annotations);
  }

  belongsTo(truss) {
    return this._tree.truss === truss;
  }
}


class Query extends Handle {
  constructor(tree, path, spec, annotations) {
    super(tree, path, annotations);
    this._spec = this._copyAndValidateSpec(spec);
    const queryTerms = _(this._spec)
      .map((value, key) => `${key}=${encodeURIComponent(JSON.stringify(value))}`)
      .sortBy()
      .join('&');
    this._string = `${this._path}?${queryTerms}`;
    Object.freeze(this);
  }

  // Vue-bound
  get ready() {
    return this._tree.isQueryReady(this);
  }

  get constraints() {
    return this._spec;
  }

  annotate(annotations) {
    return new Query(
      this._tree, this._path, this._spec, _.assign({}, this._annotations, annotations));
  }

  _copyAndValidateSpec(spec) {
    if (!spec.by) throw new Error('Query needs "by" clause: ' + JSON.stringify(spec));
    if (('at' in spec) + ('from' in spec) + ('to' in spec) > 1) {
      throw new Error(
        'Query must contain at most one of "at", "from", or "to" clauses: ' + JSON.stringify(spec));
    }
    if (('first' in spec) + ('last' in spec) > 1) {
      throw new Error(
        'Query must contain at most one of "first" or "last" clauses: ' + JSON.stringify(spec));
    }
    if (!_.some(['at', 'from', 'to', 'first', 'last'], clause => clause in spec)) {
      throw new Error(
        'Query must contain at least one of "at", "from", "to", "first", or "last" clauses: ' +
        JSON.stringify(spec));
    }
    spec = _.clone(spec);
    if (spec.by !== '$key' && spec.by !== '$value') {
      if (!(spec.by instanceof Reference)) {
        throw new Error('Query "by" value must be a reference: ' + spec.by);
      }
      let childPath = spec.by.toString();
      if (!_.startsWith(childPath, this._path)) {
        throw new Error(
          'Query "by" value must be a descendant of target reference: ' + spec.by);
      }
      childPath = childPath.slice(this._path.length).replace(/^\/?/, '');
      if (!_.includes(childPath, '/')) {
        throw new Error(
          'Query "by" value must not be a direct child of target reference: ' + spec.by);
      }
      spec.by = childPath.replace(/.*?\//, '');
    }
    Object.freeze(spec);
    return spec;
  }


  toString() {
    return this._string;
  }
}


class Reference extends Handle {

  constructor(tree, path, annotations) {
    super(tree, path, annotations);
    Object.freeze(this);
  }

  get ready() {return this._tree.isReferenceReady(this);}  // Vue-bound
  get value() {return this._tree.getObject(this.path);}  // Vue-bound
  toString() {return this._path;}

  annotate(annotations) {
    return new Reference(this._tree, this._path, _.assign({}, this._annotations, annotations));
  }

  query(spec) {
    return new Query(this._tree, this._path, spec, this._annotations);
  }

  set(value) {
    return this._tree.update(this, 'set', {[this.path]: value});
  }

  update(values) {
    return this._tree.update(this, 'update', values);
  }

  override(value) {
    return this._tree.update(this, 'override', {[this.path]: value});
  }

  commit(updateFunction) {
    return this._tree.commit(this, updateFunction);
  }
}

class StatItem {
  constructor(name) {
    _.assign(this, {name, numRecomputes: 0, numUpdates: 0, runtime: 0});
  }

  add(item) {
    this.runtime += item.runtime;
    this.numUpdates += item.numUpdates;
    this.numRecomputes += item.numRecomputes;
  }

  get runtimePerRecompute() {
    return this.numRecomputes ? this.runtime / this.numRecomputes : 0;
  }

  toLogParts(totals) {
    return [
      `${this.name}:`, ` ${(this.runtime / 1000).toFixed(2)}s`,
      `(${(this.runtime / totals.runtime * 100).toFixed(1)}%)`,
      ` ${this.numUpdates} upd /`, `${this.numRecomputes} runs`,
      `(${(this.numUpdates / this.numRecomputes * 100).toFixed(1)}%)`,
      ` ${this.runtimePerRecompute.toFixed(2)}ms / run`
    ];
  }
}

class Stats {
  constructor() {
    this._items = {};
  }

  for(name) {
    if (!this._items[name]) this._items[name] = new StatItem(name);
    return this._items[name];
  }

  get list() {
    return _(this._items).values().sortBy(item => -item.runtime).value();
  }

  log(n = 10) {
    let stats = this.list;
    if (!stats.length) return;
    const totals = new StatItem('=== Total');
    _.forEach(stats, stat => {totals.add(stat);});
    stats = _.take(stats, n);
    const above = new StatItem('--- Above');
    _.forEach(stats, stat => {above.add(stat);});
    const lines = _.map(stats, item => item.toLogParts(totals));
    lines.push(above.toLogParts(totals));
    lines.push(totals.toLogParts(totals));
    const widths = _.map(_.range(lines[0].length), i => _(lines).map(line => line[i].length).max());
    _.forEach(lines, line => {
      console.log(_.map(line, (column, i) => _.padLeft(column, widths[i])).join(' '));
    });
  }
}

var stats = new Stats();

const SERVER_TIMESTAMP = Object.freeze({'.sv': 'timestamp'});

function isTrussEqual(a, b) {
  return _.isEqual(a, b, isTrussValueEqual);
}

function isTrussValueEqual(a, b) {
  if (a === b || a === undefined || a === null || b === undefined || b === null ||
      a.$truss || b.$truss) return a === b;
  if (a.isEqual) return a.isEqual(b);
}

function copyPrototype(a, b) {
  for (const prop of Object.getOwnPropertyNames(a.prototype)) {
    if (prop === 'constructor') continue;
    Object.defineProperty(b.prototype, prop, Object.getOwnPropertyDescriptor(a.prototype, prop));
  }
}

class Connector {
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

    if (angularProxy.active && scope && scope.$on && scope.$id) {
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
    const dataProperties = _.mapValues(this._connections, (unused, key) => ({
      configurable: true, enumerable: false, get: () => {
        const descriptor = this._vue.descriptors[key];
        if (descriptor instanceof Reference) return descriptor.value;
        return this._vue.values[key];
      }
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
    const angularWatch = angularProxy.active && !fn.angularWatchSuppressed;
    // Use this._vue.$watch instead of truss.observe here so that we can disable the immediate
    // callback if we'll get one from Angular anyway.
    this._vue.$watch(getter, update, {immediate: !angularWatch});
    if (angularWatch) {
      if (!this._angularUnwatches) this._angularUnwatches = [];
      this._angularUnwatches.push(angularProxy.watch(getter, update, true));
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
    angularProxy.digest();
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
    angularProxy.digest();
    if (!descriptor) return;
    Vue.set(this._vue.values, key, undefined);
    if (descriptor instanceof Reference) {
      Vue.set(this._vue.refs, key, descriptor);
      this._disconnects[key] = this._tree.connectReference(descriptor, this._method);
    } else if (descriptor instanceof Query) {
      Vue.set(this._vue.refs, key, descriptor);
      const updateFn = this._updateQueryValue.bind(this, key);
      this._disconnects[key] = this._tree.connectQuery(descriptor, updateFn, this._method);
    } else {
      const subScope = {}, subRefs = {};
      Vue.set(this._vue.refs, key, subRefs);
      const subConnector = this._subConnectors[key] =
        new Connector(subScope, descriptor, this._tree, this._method, subRefs);
      // Use a truss.observe here instead of this._vue.$watch so that the "immediate" execution
      // actually takes place after we've captured the unwatch function, in case the subConnector
      // is ready immediately.
      const unobserve = this._disconnects[key] = this._tree.truss.observe(
        () => subConnector.ready,
        subReady => {
          if (!subReady) return;
          unobserve();
          delete this._disconnects[key];
          Vue.set(this._vue.values, key, subScope);
          angularProxy.digest();
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
    angularProxy.digest();
  }

  _updateRefValue(key, value) {
    if (this._vue.values[key] !== value) {
      Vue.set(this._vue.values, key, value);
      angularProxy.digest();
    }
  }

  _updateQueryValue(key, childKeys) {
    if (!this._vue.values[key]) {
      Vue.set(this._vue.values, key, {});
      angularProxy.digest();
    }
    const subScope = this._vue.values[key];
    for (const childKey in subScope) {
      if (!subScope.hasOwnProperty(childKey)) continue;
      if (!_.includes(childKeys, childKey)) {
        Vue.delete(subScope, childKey);
        angularProxy.digest();
      }
    }
    const object = this._tree.getObject(this._vue.descriptors[key].path);
    for (const childKey of childKeys) {
      if (subScope.hasOwnProperty(childKey)) continue;
      Vue.set(subScope, childKey, object[childKey]);
      angularProxy.digest();
    }
  }

}

function flattenRefs(refs) {
  if (!refs) return;
  if (refs instanceof Handle) return refs.toString();
  return _.mapValues(refs, flattenRefs);
}

function wrapPromiseCallback(callback) {
  return function() {
    try {
      // eslint-disable-next-line no-invalid-this
      return Promise.resolve(callback.apply(this, arguments));
    } catch (e) {
      return Promise.reject(e);
    }
  };
}

function promiseCancel(promise, cancel) {
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

function promiseFinally(promise, onFinally) {
  if (!onFinally) return promise;
  onFinally = wrapPromiseCallback(onFinally);
  return promise.then(result => {
    return onFinally().then(() => result);
  }, error => {
    return onFinally().then(() => Promise.reject(error));
  });
}

const INTERCEPT_KEYS = [
  'read', 'write', 'auth', 'set', 'update', 'commit', 'connect', 'peek', 'authenticate',
  'unathenticate', 'certify', 'all'
];

const EMPTY_ARRAY = [];


class SlowHandle {
  constructor(operation, delay, callback) {
    this._operation = operation;
    this._delay = delay;
    this._callback = callback;
    this._fired = false;
  }

  initiate() {
    this.cancel();
    this._fired = false;
    const elapsed = Date.now() - this._operation._startTimestamp;
    this._timeoutId = setTimeout(() => {
      this._fired = true;
      this._callback(this._operation);
    }, this._delay - elapsed);
  }

  cancel() {
    if (this._fired) this._callback(this._operation);
    if (this._timeoutId) clearTimeout(this._timeoutId);
  }
}


class Operation {
  constructor(type, method, target, operand) {
    this._type = type;
    this._method = method;
    this._target = target;
    this._operand = operand;
    this._ready = false;
    this._running = false;
    this._ended = false;
    this._tries = 0;
    this._startTimestamp = Date.now();
    this._slowHandles = [];
  }

  get type() {return this._type;}
  get method() {return this._method;}
  get target() {return this._target;}
  get targets() {
    if (this._method !== 'update') return [this._target];
    return _.map(this._operand, (value, escapedPathFragment) => {
      return new Reference(
        this._target._tree, joinPath(this._target.path, escapedPathFragment),
        this._target._annotations);
    });
  }
  get operand() {return this._operand;}
  get ready() {return this._ready;}
  get running() {return this._running;}
  get ended() {return this._ended;}
  get tries() {return this._tries;}
  get error() {return this._error;}

  onSlow(delay, callback) {
    const handle = new SlowHandle(this, delay, callback);
    this._slowHandles.push(handle);
    handle.initiate();
  }

  _setRunning(value) {
    this._running = value;
  }

  _setEnded(value) {
    this._ended = value;
  }

  _markReady(ending) {
    this._ready = true;
    if (!ending) this._tries = 0;
    _.forEach(this._slowHandles, handle => handle.cancel());
  }

  _clearReady() {
    this._ready = false;
    this._startTimestamp = Date.now();
    _.forEach(this._slowHandles, handle => handle.initiate());
  }

  _incrementTries() {
    this._tries++;
  }
}


class Dispatcher {
  constructor(bridge) {
    this._bridge = bridge;
    this._callbacks = {};
    Object.freeze(this);
  }

  intercept(interceptKey, callbacks) {
    if (!_.includes(INTERCEPT_KEYS, interceptKey)) {
      throw new Error('Unknown intercept operation type: ' + interceptKey);
    }
    const badCallbackKeys =
      _.difference(_.keys(callbacks), ['onBefore', 'onAfter', 'onError', 'onFailure']);
    if (badCallbackKeys.length) {
      throw new Error('Unknown intercept callback types: ' + badCallbackKeys.join(', '));
    }
    const wrappedCallbacks = {
      onBefore: this._addCallback('onBefore', interceptKey, callbacks.onBefore),
      onAfter: this._addCallback('onAfter', interceptKey, callbacks.onAfter),
      onError: this._addCallback('onError', interceptKey, callbacks.onError),
      onFailure: this._addCallback('onFailure', interceptKey, callbacks.onFailure)
    };
    return this._removeCallbacks.bind(this, interceptKey, wrappedCallbacks);
  }

  _addCallback(stage, interceptKey, callback) {
    if (!callback) return;
    const key = this._getCallbacksKey(stage, interceptKey);
    const wrappedCallback = wrapPromiseCallback(callback);
    (this._callbacks[key] || (this._callbacks[key] = [])).push(wrappedCallback);
    return wrappedCallback;
  }

  _removeCallback(stage, interceptKey, wrappedCallback) {
    if (!wrappedCallback) return;
    const key = this._getCallbacksKey(stage, interceptKey);
    if (this._callbacks[key]) _.pull(this._callbacks[key], wrappedCallback);
  }

  _removeCallbacks(interceptKey, wrappedCallbacks) {
    _.forEach(wrappedCallbacks, (wrappedCallback, stage) => {
      this._removeCallback(stage, interceptKey, wrappedCallback);
    });
  }

  _getCallbacks(stage, operationType, method) {
    return [].concat(
      this._callbacks[this._getCallbacksKey(stage, method)] || EMPTY_ARRAY,
      this._callbacks[this._getCallbacksKey(stage, operationType)] || EMPTY_ARRAY,
      this._callbacks[this._getCallbacksKey(stage, 'all')] || EMPTY_ARRAY
    );
  }

  _getCallbacksKey(stage, interceptKey) {
    return `${stage}_${interceptKey}`;
  }

  execute(operationType, method, target, operand, executor) {
    executor = wrapPromiseCallback(executor);
    const operation = this.createOperation(operationType, method, target, operand);
    return this.begin(operation).then(() => {
      const executeWithRetries = () => {
        return executor().catch(e => this._retryOrEnd(operation, e).then(executeWithRetries));
      };
      return executeWithRetries();
    }).then(result => this.end(operation).then(() => result));
  }

  createOperation(operationType, method, target, operand) {
    return new Operation(operationType, method, target, operand);
  }

  begin(operation) {
    return Promise.all(_.map(
      this._getCallbacks('onBefore', operation.type, operation.method),
      onBefore => onBefore(operation)
    )).then(() => {
      if (!operation.ended) operation._setRunning(true);
    }, e => this.end(operation, e));
  }

  markReady(operation) {
    operation._markReady();
  }

  clearReady(operation) {
    operation._clearReady();
  }

  retry(operation, error) {
    operation._incrementTries();
    operation._error = error;
    return Promise.all(_.map(
      this._getCallbacks('onError', operation.type, operation.method),
      onError => onError(operation, error)
    )).then(results => {
      // If the operation ended in the meantime, bail.  This will cause the caller to attempt to
      // fail the operation, but since it's already ended the call to end() with an error will be a
      // no-op.
      if (operation.ended) return;
      const retrying = _.some(results);
      if (retrying) delete operation._error;
      return retrying;
    });
  }

  _retryOrEnd(operation, error) {
    return this.retry(operation, error).then(result => {
      if (!result) return this.end(operation, error);
    }, e => this.end(operation, e));
  }

  end(operation, error) {
    if (operation.ended) return Promise.resolve();
    operation._setRunning(false);
    operation._setEnded(true);
    if (error) {
      operation._error = error;
    } else {
      // In case we're racing with a retry(), wipe out the error.
      delete operation._error;
    }
    return Promise.all(_.map(
      this._getCallbacks('onAfter', operation.type, operation.method),
      onAfter => onAfter(operation)
    )).then(
      () => this._afterEnd(operation),
      e => {
        operation._error = e;
        return this._afterEnd(operation);
      }
    );
  }

  _afterEnd(operation) {
    operation._markReady(true);
    if (!operation.error) return Promise.resolve();
    const onFailureCallbacks = this._getCallbacks('onFailure', operation.type, operation.method);
    return this._bridge.probeError(operation.error).then(() => {
      if (onFailureCallbacks) {
        setTimeout(() => {
          _.forEach(onFailureCallbacks, onFailure => onFailure(operation));
        }, 0);
      }
      return Promise.reject(operation.error);
    });
  }
}

const ALPHABET = '-0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ_abcdefghijklmnopqrstuvwxyz';

const getRandomValues = window.crypto && window.crypto.getRandomValues &&
  window.crypto.getRandomValues.bind(window.crypto);

class KeyGenerator {
  constructor() {
    this._lastUniqueKeyTime = 0;
    this._lastRandomValues = [];
  }

  generateUniqueKey(now) {
    now = now || Date.now();
    const chars = new Array(20);
    let prefix = now;
    for (let i = 7; i >= 0; i--) {
      chars[i] = ALPHABET.charAt(prefix & 0x3f);  // eslint-disable-line no-bitwise
      prefix = Math.floor(prefix / 64);
    }
    if (now === this._lastUniqueKeyTime) {
      let i = 11;
      while (i >= 0 && this._lastRandomValues[i] === 63) {
        this._lastRandomValues[i] = 0;
        i -= 1;
      }
      if (i === -1) {
        throw new Error('Internal assertion failure: ran out of unique IDs for this millisecond');
      }
      this._lastRandomValues[i] += 1;
    } else {
      this._lastUniqueKeyTime = now;
      if (getRandomValues) {
        /* global Uint8Array */
        const array = new Uint8Array(12);
        getRandomValues(array);
        for (let i = 0; i < 12; i++) {
          // eslint-disable-next-line no-bitwise
          this._lastRandomValues[i] = array[i] & (i ? 0x3f : 0x0f);
        }
      } else {
        for (let i = 0; i < 12; i++) {
          // Make sure to leave some space for incrementing in the top nibble.
          this._lastRandomValues[i] = Math.floor(Math.random() * (i ? 64 : 16));
        }
      }
    }
    for (let i = 0; i < 12; i++) {
      chars[i + 8] = ALPHABET[this._lastRandomValues[i]];
    }
    return chars.join('');
  }
}

class MetaTree {
  constructor(rootUrl, tree, bridge, dispatcher) {
    this._rootUrl = rootUrl;
    this._tree = tree;
    this._dispatcher = dispatcher;
    this._bridge = bridge;
    this._vue = new Vue({data: {$root: {
      connected: undefined, timeOffset: 0, user: undefined, userid: undefined,
      nowAtInterval(intervalMillis) {
        const key = 'now' + intervalMillis;
        if (!this.hasOwnProperty(key)) {
          const update = () => {
            Vue.set(this, key, Date.now() + this.timeOffset);
            angularProxy.digest();
          };
          update();
          setInterval(update, intervalMillis);
        }
        return this[key];
      }
    }}});

    this._auth = {serial: 0, initialAuthChangeReceived: false};

    bridge.onAuth(rootUrl, this._handleAuthChange, this);

    this._connectInfoProperty('serverTimeOffset', 'timeOffset');
    this._connectInfoProperty('connected', 'connected');
    Object.freeze(this);
  }

  get root() {
    return this._vue.$data.$root;
  }

  destroy() {
    this._bridge.offAuth(this._rootUrl, this._handleAuthChange, this);
    this._vue.$destroy();
  }

  authenticate(token) {
    this._auth.serial++;
    return this._dispatcher.execute(
      'auth', 'authenticate', new Reference(this._tree, '/'), token, () => {
        return this._bridge.authWithCustomToken(this._rootUrl, token, {rememberMe: true});
      }
    );
  }

  unauthenticate() {
    // Signal user change to null pre-emptively.  This is what the Firebase SDK does as well, since
    // it lets the app tear down user-required connections before the user is actually deauthed,
    // which can prevent spurious permission denied errors.
    this._auth.serial++;
    return this._handleAuthChange(null).then(approved => {
      // Bail if auth change callback initiated another authentication, since it will have already
      // sent the command to the bridge and sending our own now would incorrectly override it.
      if (!approved) return;
      return this._dispatcher.execute(
        'auth', 'unauthenticate', new Reference(this._tree, '/'), undefined, () => {
          return this._bridge.unauth(this._rootUrl);
        }
      );
    });
  }

  _handleAuthChange(user) {
    const supersededChange = !this._auth.initialAuthChangeReceived && this._auth.serial;
    if (user !== undefined) this._auth.initialAuthChangeReceived = true;
    if (supersededChange) return;
    const authSerial = this._auth.serial;
    if (this.root.user === user) return Promise.resolve(false);
    return this._dispatcher.execute('auth', 'certify', new Reference(this._tree, '/'), user, () => {
      if (this.root.user === user || authSerial !== this._auth.serial) return false;
      if (user) Object.freeze(user);
      this.root.user = user;
      this.root.userid = user && user.uid;
      angularProxy.digest();
      return true;
    });
  }

  _isAuthChangeStale(user) {
    return this.root.user === user;
  }

  _connectInfoProperty(property, attribute) {
    const propertyUrl = `${this._rootUrl}/.info/${property}`;
    this._bridge.on(propertyUrl, propertyUrl, null, 'value', snap => {
      this.root[attribute] = snap.value;
      angularProxy.digest();
    });
  }
}

// These are defined separately for each object so they're not included in Value below.
const RESERVED_VALUE_PROPERTY_NAMES = {$$$trussCheck: true, __ob__: true};

// Holds properties that we're going to set on a model object that's being created right now as soon
// as it's been created, but that we'd like to be accessible in the constructor.  The object
// prototype's getters will pick those up until they get overridden in the instance.
let creatingObjectProperties;

let currentPropertyFrozen;


class BaseValue {
  get $meta() {return this.$truss.meta;}
  get $store() {return this.$truss.store;}  // access indirectly to leave dependency trace
  get $now() {return this.$truss.now;}

  $newKey() {return this.$truss.newKey();}

  $intercept(actionType, callbacks) {
    if (this.$destroyed) throw new Error('Object already destroyed');
    const unintercept = this.$truss.intercept(actionType, callbacks);
    const uninterceptAndRemoveFinalizer = () => {
      unintercept();
      _.pull(this.$$finalizers, uninterceptAndRemoveFinalizer);
    };
    this.$$finalizers.push(uninterceptAndRemoveFinalizer);
    return uninterceptAndRemoveFinalizer;
  }

  $connect(scope, connections) {
    if (this.$destroyed) throw new Error('Object already destroyed');
    if (!connections) {
      connections = scope;
      scope = undefined;
    }
    const connector = this.$truss.connect(scope, wrapConnections(this, connections));
    const originalDestroy = connector.destroy;
    const destroy = () => {
      _.pull(this.$$finalizers, destroy);
      return originalDestroy.call(connector);
    };
    this.$$finalizers.push(destroy);
    connector.destroy = destroy;
    return connector;
  }

  $peek(target, callback) {
    if (this.$destroyed) throw new Error('Object already destroyed');
    const promise = promiseFinally(
      this.$truss.peek(target, callback), () => {_.pull(this.$$finalizers, promise.cancel);}
    );
    this.$$finalizers.push(promise.cancel);
    return promise;
  }

  $observe(subjectFn, callbackFn, options) {
    if (this.$destroyed) throw new Error('Object already destroyed');
    let unobserveAndRemoveFinalizer;

    const unobserve = this.$truss.observe(() => {
      this.$$touchThis();
      return subjectFn.call(this);
    }, callbackFn.bind(this), options);

    unobserveAndRemoveFinalizer = () => {  // eslint-disable-line prefer-const
      unobserve();
      _.pull(this.$$finalizers, unobserveAndRemoveFinalizer);
    };
    this.$$finalizers.push(unobserveAndRemoveFinalizer);
    return unobserveAndRemoveFinalizer;
  }

  $when(expression, options) {
    if (this.$destroyed) throw new Error('Object already destroyed');
    const promise = this.$truss.when(() => {
      this.$$touchThis();
      return expression.call(this);
    }, options);
    promiseFinally(promise, () => {_.pull(this.$$finalizers, promise.cancel);});
    this.$$finalizers.push(promise.cancel);
    return promise;
  }

  get $$finalizers() {
    Object.defineProperty(this, '$$finalizers', {
      value: [], writable: false, enumerable: false, configurable: false});
    return this.$$finalizers;
  }
}


class Value {
  get $parent() {return creatingObjectProperties.$parent.value;}
  get $path() {return creatingObjectProperties.$path.value;}
  get $truss() {
    Object.defineProperty(this, '$truss', {value: this.$parent.$truss});
    return this.$truss;
  }
  get $ref() {
    Object.defineProperty(this, '$ref', {value: new Reference(this.$truss._tree, this.$path)});
    return this.$ref;
  }
  get $refs() {return this.$ref;}
  get $key() {
    Object.defineProperty(
      this, '$key', {value: unescapeKey(this.$path.slice(this.$path.lastIndexOf('/') + 1))});
    return this.$key;
  }
  get $data() {return this;}
  get $hidden() {return false;}  // eslint-disable-line lodash/prefer-constant
  get $empty() {return _.isEmpty(this.$data);}
  get $keys() {return _.keys(this.$data);}
  get $values() {return _.values(this.$data);}
  get $ready() {return this.$ref.ready;}
  get $overridden() {return false;}  // eslint-disable-line lodash/prefer-constant

  $nextTick() {
    if (this.$destroyed) throw new Error('Object already destroyed');
    const promise = this.$truss.nextTick();
    promiseFinally(promise, () => {_.pull(this.$$finalizers, promise.cancel);});
    this.$$finalizers.push(promise.cancel);
    return promise;
  }

  $freezeComputedProperty() {
    if (!_.isBoolean(currentPropertyFrozen)) {
      throw new Error('Cannot freeze a computed property outside of its getter function');
    }
    currentPropertyFrozen = true;
  }

  $set(value) {return this.$ref.set(value);}
  $update(values) {return this.$ref.update(values);}
  $override(values) {return this.$ref.override(values);}
  $commit(options, updateFn) {return this.$ref.commit(options, updateFn);}

  $$touchThis() {
    /* eslint-disable no-unused-expressions */
    if (this.__ob__) {
      this.__ob__.dep.depend();
    } else if (this.$parent) {
      (this.$parent.hasOwnProperty('$data') ? this.$parent.$data : this.$parent)[this.$key];
    } else {
      this.$store;
    }
    /* eslint-enable no-unused-expressions */
  }

  get $$initializers() {
    Object.defineProperty(this, '$$initializers', {
      value: [], writable: false, enumerable: false, configurable: true});
    return this.$$initializers;
  }

  get $destroyed() {  // eslint-disable-line lodash/prefer-constant
    return false;
  }
}

copyPrototype(BaseValue, Value);

_.forEach(Value.prototype, (prop, name) => {
  Object.defineProperty(
    Value.prototype, name, {value: prop, enumerable: false, configurable: false, writable: false});
});


class ErrorWrapper {
  constructor(error) {
    this.error = error;
  }
}


class FrozenWrapper {
  constructor(value) {
    this.value = value;
  }
}


class Modeler {
  constructor(debug) {
    this._trie = {Class: Value};
    this._debug = debug;
    Object.freeze(this);
  }

  init(classes, rootAcceptable) {
    if (_.isPlainObject(classes)) {
      _.forEach(classes, (Class, path) => {
        if (Class.$trussMount) return;
        Class.$$trussMount = Class.$$trussMount || [];
        Class.$$trussMount.push(path);
      });
      classes = _.values(classes);
      _.forEach(classes, Class => {
        if (!Class.$trussMount && Class.$$trussMount) {
          Class.$trussMount = Class.$$trussMount;
          delete Class.$$trussMount;
        }
      });
    }
    classes = _.uniq(classes);
    _.forEach(classes, Class => this._mountClass(Class, rootAcceptable));
    this._decorateTrie(this._trie);
  }

  destroy() {  // eslint-disable-line no-empty-function
  }

  _getMount(path, scaffold, predicate) {
    const segments = splitPath(path, true);
    let node;
    for (const segment of segments) {
      let child = segment ?
        node.children && (node.children[segment] || !scaffold && node.children.$) : this._trie;
      if (!child) {
        if (!scaffold) return;
        node.children = node.children || {};
        child = node.children[segment] = {Class: Value};
      }
      node = child;
      if (predicate && predicate(node)) break;
    }
    return node;
  }

  _findMount(predicate, node) {
    if (!node) node = this._trie;
    if (predicate(node)) return node;
    for (const childKey of _.keys(node.children)) {
      const result = this._findMount(predicate, node.children[childKey]);
      if (result) return result;
    }
  }

  _decorateTrie(node) {
    _.forEach(node.children, child => {
      this._decorateTrie(child);
      if (child.local || child.localDescendants) node.localDescendants = true;
    });
  }

  _augmentClass(Class) {
    let computedProperties;
    let proto = Class.prototype;
    while (proto && proto.constructor !== Object) {
      for (const name of Object.getOwnPropertyNames(proto)) {
        const descriptor = Object.getOwnPropertyDescriptor(proto, name);
        if (name.charAt(0) === '$') {
          if (name === '$finalize') continue;
          if (_.isEqual(descriptor, Object.getOwnPropertyDescriptor(Value.prototype, name))) {
            continue;
          }
          throw new Error(`Property names starting with "$" are reserved: ${Class.name}.${name}`);
        }
        if (descriptor.get && !(computedProperties && computedProperties[name])) {
          (computedProperties || (computedProperties = {}))[name] = {
            name, fullName: `${proto.constructor.name}.${name}`, get: descriptor.get,
            set: descriptor.set
          };
        }
      }
      proto = Object.getPrototypeOf(proto);
    }
    for (const name of Object.getOwnPropertyNames(Value.prototype)) {
      if (name === 'constructor' || Class.prototype.hasOwnProperty(name)) continue;
      Object.defineProperty(
        Class.prototype, name, Object.getOwnPropertyDescriptor(Value.prototype, name));
    }
    return computedProperties;
  }

  _mountClass(Class, rootAcceptable) {
    const computedProperties = this._augmentClass(Class);
    const allVariables = [];
    let mounts = Class.$trussMount;
    if (!mounts) throw new Error(`Class ${Class.name} lacks a $trussMount static property`);
    if (!_.isArray(mounts)) mounts = [mounts];
    _.forEach(mounts, mount => {
      if (_.isString(mount)) mount = {path: mount};
      if (!rootAcceptable && mount.path === '/') {
        throw new Error('Data root already accessed, too late to mount class');
      }
      const matcher = makePathMatcher(mount.path);
      for (const variable of matcher.variables) {
        if (variable === '$' || variable.charAt(1) === '$') {
          throw new Error(`Invalid variable name: ${variable}`);
        }
        if (variable.charAt(0) === '$' && (
          _.has(Value.prototype, variable) || RESERVED_VALUE_PROPERTY_NAMES[variable]
        )) {
          throw new Error(`Variable name conflicts with built-in property or method: ${variable}`);
        }
        allVariables.push(variable);
      }
      const escapedKey = mount.path.match(/\/([^/]*)$/)[1];
      if (escapedKey.charAt(0) === '$') {
        if (mount.placeholder) {
          throw new Error(
            `Class ${Class.name} mounted at wildcard ${escapedKey} cannot be a placeholder`);
        }
      } else if (!_.has(mount, 'placeholder')) {
        mount.placeholder = {};
      }
      const targetMount = this._getMount(mount.path.replace(/\$[^/]*/g, '$'), true);
      if (targetMount.matcher && (
        targetMount.escapedKey === escapedKey ||
        targetMount.escapedKey.charAt(0) === '$' && escapedKey.charAt(0) === '$'
      )) {
        throw new Error(
          `Multiple classes mounted at ${mount.path}: ${targetMount.Class.name}, ${Class.name}`);
      }
      _.assign(
        targetMount, {Class, matcher, computedProperties, escapedKey},
        _.pick(mount, 'placeholder', 'local', 'keysUnsafe', 'hidden'));
    });
    _.forEach(allVariables, variable => {
      if (!Class.prototype[variable]) {
        Object.defineProperty(Class.prototype, variable, {get() {
          return creatingObjectProperties ?
            creatingObjectProperties[variable] && creatingObjectProperties[variable].value :
            undefined;
        }});
      }
    });
  }

  /**
   * Creates a Truss object and sets all its basic properties: path segment variables, user-defined
   * properties, and computed properties.  The latter two will be enumerable so that Vue will pick
   * them up and make the reactive.
   */
  createObject(path, properties) {
    const mount = this._getMount(path) || {Class: Value};
    if (mount.matcher) {
      const match = mount.matcher.match(path);
      for (const variable in match) {
        properties[variable] = {value: match[variable]};
      }
    }

    creatingObjectProperties = properties;
    const object = new mount.Class();
    creatingObjectProperties = null;

    if (angularProxy.active) this._wrapProperties(object);

    if (mount.keysUnsafe) {
      properties.$data = {value: Object.create(null), configurable: true, enumerable: true};
    }
    if (mount.hidden) properties.$hidden = {value: true};
    if (mount.computedProperties) {
      _.forEach(mount.computedProperties, prop => {
        properties[prop.name] = this._buildComputedPropertyDescriptor(object, prop);
      });
    }

    return object;
  }

  _wrapProperties(object) {
    _.forEach(object, (value, key) => {
      const valueKey = '$_' + key;
      Object.defineProperties(object, {
        [valueKey]: {value, writable: true},
        [key]: {
          get: () => object[valueKey],
          set: arg => {object[valueKey] = arg; angularProxy.digest();},
          enumerable: true, configurable: true
        }
      });
    });
  }

  _buildComputedPropertyDescriptor(object, prop) {
    const propertyStats = stats.for(prop.fullName);

    let value, pendingPromise;
    let writeAllowed = false;

    object.$$initializers.push(vue => {
      let unwatchNow = false;
      const compute = computeValue.bind(object, prop, propertyStats);
      if (this._debug) compute.toString = () => {return prop.fullName;};
      let unwatch = () => {unwatchNow = true;};
      unwatch = vue.$watch(compute, newValue => {
        if (object.$destroyed) {
          unwatch();
          return;
        }
        if (pendingPromise) {
          if (pendingPromise.cancel) pendingPromise.cancel();
          pendingPromise = undefined;
        }
        if (_.isObject(newValue) && _.isFunction(newValue.then)) {
          update(undefined);
          const promise = newValue.then(finalValue => {
            if (promise === pendingPromise) update(finalValue);
            // No need to angular.digest() here, since if we're running under Angular then we expect
            // promises to be aliased to its $q service, which triggers digest itself.
          }, error => {
            if (promise === pendingPromise && update(new ErrorWrapper(error)) &&
                !error.trussExpectedException) throw error;
          });
          pendingPromise = promise;
        } else if (update(newValue)) {
          angularProxy.digest();
          if (newValue instanceof ErrorWrapper && !newValue.error.trussExpectedException) {
            throw newValue.error;
          }
        }
      }, {immediate: true});  // use immediate:true since watcher will run computeValue anyway
      // Hack to change order of computed property watchers.  By flipping their ids to be negative,
      // we ensure that they will settle before all other watchers, and also that children
      // properties will settle before their parents since values are often aggregated upwards.
      const watcher = _.last(vue._watchers);
      watcher.id = -watcher.id;

      function update(newValue) {
        if (newValue instanceof FrozenWrapper) {
          newValue = newValue.value;
          unwatch();
          _.pull(object.$$finalizers, unwatch);
        }
        if (isTrussEqual(value, newValue)) return;
        // console.log('updating', object.$key, prop.fullName, 'from', value, 'to', newValue);
        propertyStats.numUpdates += 1;
        writeAllowed = true;
        object[prop.name] = newValue;
        writeAllowed = false;
        // Freeze the computed value so it can't be accidentally modified by a third party.  Ideally
        // we'd freeze it before setting it so that Vue wouldn't instrument the object recursively
        // (since it can't change anyway), but we actually need the instrumentation in case a client
        // tries to access an inexistent property off a computed pointer to an unfrozen value (e.g.,
        // a $truss-ified object).  When instrumented, Vue will add a dependency on the unfrozen
        // value in case the property is later added.  If uninstrumented, the dependency won't be
        // added and we won't be notified.  And Vue only instruments extensible objects...
        freeze(newValue);
        return true;
      }

      if (unwatchNow) {
        unwatch();
      } else {
        object.$$finalizers.push(unwatch);
      }
    });
    return {
      enumerable: true, configurable: true,
      get() {
        if (!writeAllowed && value instanceof ErrorWrapper) throw value.error;
        return value;
      },
      set(newValue) {
        if (writeAllowed) {
          value = newValue;
        } else if (prop.set) {
          prop.set.call(this, newValue);
        } else {
          throw new Error(`You cannot set a computed property: ${prop.name}`);
        }
      }
    };
  }

  destroyObject(object) {
    if (_.has(object, '$$finalizers')) {
      // Some finalizers remove themselves from the array, so clone it before iterating.
      for (const fn of _.clone(object.$$finalizers)) fn();
    }
    if (_.isFunction(object.$finalize)) object.$finalize();
    Object.defineProperty(
      object, '$destroyed', {value: true, enumerable: false, configurable: false});
  }

  isPlaceholder(path) {
    const mount = this._getMount(path);
    return mount && mount.placeholder;
  }

  isLocal(path, value) {
    // eslint-disable-next-line no-shadow
    const mount = this._getMount(path, false, mount => mount.local);
    if (mount && mount.local) return true;
    if (this._hasLocalProperties(mount, value)) {
      throw new Error('Write on a mix of local and remote tree paths.');
    }
    return false;
  }

  _hasLocalProperties(mount, value) {
    if (!mount) return false;
    if (mount.local) return true;
    if (!mount.localDescendants || !_.isObject(value)) return false;
    for (const key in value) {
      const local =
        this._hasLocalProperties(mount.children[escapeKey(key)] || mount.children.$, value[key]);
      if (local) return true;
    }
    return false;
  }

  forEachPlaceholderChild(path, iteratee) {
    const mount = this._getMount(path);
    _.forEach(mount && mount.children, child => {
      if (child.placeholder) iteratee(child);
    });
  }

  checkVueObject(object, path, checkedObjects) {
    const top = !checkedObjects;
    if (top) checkedObjects = [];
    try {
      for (const key of Object.getOwnPropertyNames(object)) {
        if (RESERVED_VALUE_PROPERTY_NAMES[key] || Value.prototype.hasOwnProperty(key) ||
            /^\$_/.test(key)) continue;
        // eslint-disable-next-line no-shadow
        const mount = this._findMount(mount => mount.Class === object.constructor);
        if (mount && mount.matcher && _.includes(mount.matcher.variables, key)) continue;
        let value;
        try {
          value = object[key];
        } catch (e) {
          // Ignore any values that hold exceptions, or otherwise throw on access -- we won't be
          // able to check them anyway.
          continue;
        }
        if (!(_.isArray(object) && (/\d+/.test(key) || key === 'length'))) {
          const descriptor = Object.getOwnPropertyDescriptor(object, key);
          if ('value' in descriptor || !descriptor.get) {
            throw new Error(
              `Value at ${path}, contained in a Firetruss object, has a rogue property: ${key}`);
          }
          if (object.$truss && descriptor.enumerable) {
            try {
              object[key] = value;
              throw new Error(
                `Firetruss object at ${path} has an enumerable non-Firebase property: ${key}`);
            } catch (e) {
              if (e.trussCode !== 'firebase_overwrite') throw e;
            }
          }
        }
        if (_.isObject(value) && !value.$$$trussCheck && Object.isExtensible(value) &&
            !(_.isFunction(value) || value instanceof Promise)) {
          value.$$$trussCheck = true;
          checkedObjects.push(value);
          this.checkVueObject(value, joinPath(path, escapeKey(key)), checkedObjects);
        }
      }
    } finally {
      if (top) {
        for (const item of checkedObjects) delete item.$$$trussCheck;
      }
    }
  }
}


function computeValue(prop, propertyStats) {
  /* eslint-disable no-invalid-this */
  if (this.$destroyed) return;
  // Touch this object, since a failed access to a missing property doesn't get captured as a
  // dependency.
  this.$$touchThis();

  const oldPropertyFrozen = currentPropertyFrozen;
  currentPropertyFrozen = false;
  const startTime = performanceNow();
  let value;
  try {
    try {
      value = prop.get.call(this);
    } catch (e) {
      value = new ErrorWrapper(e);
    } finally {
      propertyStats.runtime += performanceNow() - startTime;
      propertyStats.numRecomputes += 1;
    }
    if (currentPropertyFrozen) value = new FrozenWrapper(value);
    return value;
  } finally {
    currentPropertyFrozen = oldPropertyFrozen;
  }
  /* eslint-enable no-invalid-this */
}

function wrapConnections(object, connections) {
  if (!connections || connections instanceof Handle) return connections;
  return _.mapValues(connections, descriptor => {
    if (descriptor instanceof Handle) return descriptor;
    if (_.isFunction(descriptor)) {
      const fn = function() {
        /* eslint-disable no-invalid-this */
        object.$$touchThis();
        return wrapConnections(object, descriptor.call(this));
        /* eslint-enable no-invalid-this */
      };
      fn.angularWatchSuppressed = true;
      return fn;
    }
    return wrapConnections(object, descriptor);
  });
}

function freeze(object) {
  if (object === null || object === undefined || !_.isObject(object) || Object.isFrozen(object) ||
      object.$truss) return object;
  object = Object.freeze(object);
  if (_.isArray(object)) return _.map(object, value => freeze(value));
  return _.mapValues(object, value => freeze(value));
}

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
    angularProxy.digest();
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
        angularProxy.digest();
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
    angularProxy.digest();
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
          angularProxy.digest();
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
        angularProxy.digest();
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
        angularProxy.digest();
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


class Coupler {
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

class Transaction {
  constructor(ref) {
    this._ref = ref;
    this._outcome = undefined;
    this._values = undefined;
  }

  get currentValue() {return this._ref.value;}
  get outcome() {return this._outcome;}
  get values() {return this._values;}

  _setOutcome(value) {
    if (this._outcome) throw new Error('Transaction already resolved with ' + this._outcome);
    this._outcome = value;
  }

  abort() {
    this._setOutcome('abort');
  }

  cancel() {
    this._setOutcome('cancel');
  }

  set(value) {
    if (value === undefined) throw new Error('Invalid argument: undefined');
    this._setOutcome('set');
    this._values = {'': value};
  }

  update(values) {
    if (values === undefined) throw new Error('Invalid argument: undefined');
    if (_.isEmpty(values)) return this.cancel();
    this._setOutcome('update');
    this._values = values;
  }
}


class Tree {
  constructor(truss, rootUrl, bridge, dispatcher) {
    this._truss = truss;
    this._rootUrl = rootUrl;
    this._bridge = bridge;
    this._dispatcher = dispatcher;
    this._firebasePropertyEditAllowed = false;
    this._writeSerial = 0;
    this._localWrites = {};
    this._localWriteTimestamp = null;
    this._initialized = false;
    this._modeler = new Modeler(truss.constructor.VERSION === 'dev');
    this._coupler = new Coupler(
      rootUrl, bridge, dispatcher, this._integrateSnapshot.bind(this), this._prune.bind(this));
    this._vue = new Vue({data: {$root: undefined}});
    Object.seal(this);
    // Call this.init(classes) to complete initialization; we need two phases so that truss can bind
    // the tree into its own accessors prior to defining computed functions, which may try to
    // access the tree root via truss.
  }

  get root() {
    if (!this._vue.$data.$root) {
      this._vue.$data.$root = this._createObject('/');
      this._fixObject(this._vue.$data.$root);
      this._completeCreateObject(this._vue.$data.$root);
      angularProxy.digest();
    }
    return this._vue.$data.$root;
  }

  get truss() {
    return this._truss;
  }

  init(classes) {
    if (this._initialized) {
      throw new Error('Data objects already created, too late to mount classes');
    }
    this._initialized = true;
    this._modeler.init(classes, !this._vue.$data.$root);
    const createdObjects = [];
    this._plantPlaceholders(this.root, '/', undefined, createdObjects);
    for (const object of createdObjects) this._completeCreateObject(object);
  }

  destroy() {
    this._coupler.destroy();
    if (this._modeler) this._modeler.destroy();
    this._vue.$destroy();
  }

  connectReference(ref, method) {
    this._checkHandle(ref);
    const operation = this._dispatcher.createOperation('read', method, ref);
    let unwatch;
    operation._disconnect = this._disconnectReference.bind(this, ref, operation, unwatch);
    this._dispatcher.begin(operation).then(() => {
      if (operation.running && !operation._disconnected) {
        this._coupler.couple(ref.path, operation);
        operation._coupled = true;
      }
    }).catch(_.noop);  // ignore exception, let onFailure handlers deal with it
    return operation._disconnect;
  }

  _disconnectReference(ref, operation, unwatch, error) {
    if (operation._disconnected) return;
    operation._disconnected = true;
    if (unwatch) unwatch();
    if (operation._coupled) {
      this._coupler.decouple(ref.path, operation);  // will call back to _prune if necessary
      operation._coupled = false;
    }
    this._dispatcher.end(operation, error).catch(_.noop);
  }

  isReferenceReady(ref) {
    this._checkHandle(ref);
    return this._coupler.isSubtreeReady(ref.path);
  }

  connectQuery(query, keysCallback, method) {
    this._checkHandle(query);
    const operation = this._dispatcher.createOperation('read', method, query);
    operation._disconnect = this._disconnectQuery.bind(this, query, operation);
    this._dispatcher.begin(operation).then(() => {
      if (operation.running && !operation._disconnected) {
        this._coupler.subscribe(query, operation, keysCallback);
        operation._coupled = true;
      }
    }).catch(_.noop);  // ignore exception, let onFailure handlers deal with it
    return operation._disconnect;
  }

  _disconnectQuery(query, operation, error) {
    if (operation._disconnected) return;
    operation._disconnected = true;
    if (operation._coupled) {
      this._coupler.unsubscribe(query, operation);  // will call back to _prune if necessary
      operation._coupled = false;
    }
    this._dispatcher.end(operation, error).catch(_.noop);
  }

  isQueryReady(query) {
    return this._coupler.isQueryReady(query);
  }

  _checkHandle(handle) {
    if (!handle.belongsTo(this._truss)) {
      throw new Error('Reference belongs to another Truss instance');
    }
  }

  throttleRemoteDataUpdates(delay) {
    this._coupler.throttleSnapshots(delay);
  }

  update(ref, method, values) {
    values = _.mapValues(values, value => escapeKeys(value));
    const numValues = _.size(values);
    if (!numValues) return Promise.resolve();
    if (method === 'update' || method === 'override') {
      checkUpdateHasOnlyDescendantsWithNoOverlap(ref.path, values);
    }
    if (this._applyLocalWrite(values, method === 'override')) return Promise.resolve();
    const pathPrefix = extractCommonPathPrefix(values);
    relativizePaths(pathPrefix, values);
    if (pathPrefix !== ref.path) ref = new Reference(ref._tree, pathPrefix, ref._annotations);
    const url = this._rootUrl + pathPrefix;
    const writeSerial = this._writeSerial;
    const set = numValues === 1;
    const operand = set ? values[''] : values;
    return this._dispatcher.execute('write', set ? 'set' : 'update', ref, operand, () => {
      const promise = this._bridge[set ? 'set' : 'update'](url, operand, writeSerial);
      return promise.catch(e => {
        if (!e.immediateFailure) return Promise.reject(e);
        return promiseFinally(this._repair(ref, values), () => Promise.reject(e));
      });
    });
  }

  commit(ref, updateFunction) {
    let tries = 0;
    updateFunction = wrapPromiseCallback(updateFunction);

    const attemptTransaction = () => {
      if (tries++ >= 25) {
        return Promise.reject(new Error('Transaction needed too many retries, giving up'));
      }
      const txn = new Transaction(ref);
      let oldValue;
      // Ensure that Vue's watcher queue gets emptied and computed properties are up to date before
      // running the updateFunction.
      return Vue.nextTick().then(() => {
        oldValue = toFirebaseJson(txn.currentValue);
        return updateFunction(txn);
      }).then(() => {
        if (!_.isEqual(oldValue, toFirebaseJson(txn.currentValue))) return attemptTransaction();
        if (txn.outcome === 'abort') return txn;  // early return to save time
        const values = _.mapValues(txn.values, value => escapeKeys(value));
        switch (txn.outcome) {
          case 'cancel':
            break;
          case 'set':
            if (this._applyLocalWrite({[ref.path]: values['']})) return Promise.resolve();
            break;
          case 'update':
            checkUpdateHasOnlyDescendantsWithNoOverlap(ref.path, values);
            if (this._applyLocalWrite(values)) return Promise.resolve();
            relativizePaths(ref.path, values);
            break;
          default:
            throw new Error('Invalid transaction outcome: ' + (txn.outcome || 'none'));
        }
        return this._bridge.transaction(
          this._rootUrl + ref.path, oldValue, values, this._writeSerial
        ).then(result => {
          _.forEach(result.snapshots, snapshot => this._integrateSnapshot(snapshot));
          return result.committed ? txn : attemptTransaction();
        }, e => {
          if (e.immediateFailure && (txn.outcome === 'set' || txn.outcome === 'update')) {
            return promiseFinally(this._repair(ref, values), () => Promise.reject(e));
          }
          return Promise.reject(e);
        });
      });
    };

    return this._truss.peek(ref, () => {
      return this._dispatcher.execute('write', 'commit', ref, undefined, attemptTransaction);
    });
  }

  _repair(ref, values) {
    // If a write fails early -- that is, before it gets applied to the Firebase client's local
    // tree -- then we need to repair our own local tree manually since Firebase won't send events
    // to unwind the change.  This should be very rare since it's always due to a developer mistake
    // so we don't need to be particularly efficient.
    const basePath = ref.path;
    const paths = _(values).keys().map(key => {
      let path = basePath;
      if (key) path = joinPath(path, key);
      return _.keys(this._coupler.findCoupledDescendantPaths(path));
    }).flatten().value();
    return Promise.all(_.map(paths, path => {
      return this._bridge.once(this._rootUrl + path).then(snap => {
        this._integrateSnapshot(snap);
      });
    }));
  }

  _applyLocalWrite(values, override) {
    // TODO: correctly apply local writes that impact queries.  Currently, a local write will update
    // any objects currently selected by a query, but won't add or remove results.
    this._writeSerial++;
    this._localWriteTimestamp = this._truss.now;
    const createdObjects = [];
    let numLocal = 0;
    _.forEach(values, (value, path) => {
      const local = this._modeler.isLocal(path, value);
      if (local) numLocal++;
      const coupledDescendantPaths =
        local ? {[path]: true} : this._coupler.findCoupledDescendantPaths(path);
      if (_.isEmpty(coupledDescendantPaths)) return;
      const offset = (path === '/' ? 0 : path.length) + 1;
      for (const descendantPath in coupledDescendantPaths) {
        const subPath = descendantPath.slice(offset);
        let subValue = value;
        if (subPath && value !== null && value !== undefined) {
          for (const segment of splitPath(subPath)) {
            subValue = subValue.$data[segment];
            if (subValue === undefined) break;
          }
        }
        if (subValue === undefined || subValue === null) {
          this._prune(descendantPath);
        } else {
          const key = _.last(splitPath(descendantPath));
          this._plantValue(
            descendantPath, key, subValue,
            this._scaffoldAncestors(descendantPath, false, createdObjects), false, override, local,
            createdObjects
          );
        }
        if (!override && !local) this._localWrites[descendantPath] = this._writeSerial;
      }
    });
    for (const object of createdObjects) this._completeCreateObject(object);
    if (numLocal && numLocal < _.size(values)) {
      throw new Error('Write on a mix of local and remote tree paths.');
    }
    return override || !!numLocal;
  }

  /**
   * Creates a Truss object and sets all its basic properties: path segment variables, user-defined
   * properties, and computed properties.  The latter two will be enumerable so that Vue will pick
   * them up and make the reactive, so you should call _completeCreateObject once it's done so and
   * before any Firebase properties are added.
   */
  _createObject(path, parent) {
    if (!this._initialized && path !== '/') this.init();
    const properties = {
      // We want Vue to wrap this; we'll make it non-enumerable in _fixObject.
      $parent: {value: parent, configurable: true, enumerable: true},
      $path: {value: path}
    };
    if (path === '/') properties.$truss = {value: this._truss};

    const object = this._modeler.createObject(path, properties);
    Object.defineProperties(object, properties);
    return object;
  }

  // To be called on the result of _createObject after it's been inserted into the _vue hierarchy
  // and Vue has had a chance to initialize it.
  _fixObject(object) {
    for (const name of Object.getOwnPropertyNames(object)) {
      const descriptor = Object.getOwnPropertyDescriptor(object, name);
      if (descriptor.configurable && descriptor.enumerable) {
        descriptor.enumerable = false;
        if (_.startsWith(name, '$')) descriptor.configurable = false;
        Object.defineProperty(object, name, descriptor);
      }
    }
  }

  // To be called on the result of _createObject after _fixObject, and after any additional Firebase
  // properties have been set, to run initialiers.
  _completeCreateObject(object) {
    if (object.hasOwnProperty('$$initializers')) {
      for (const fn of object.$$initializers) fn(this._vue);
      delete object.$$initializers;
    }
  }

  _destroyObject(object) {
    if (!(object && object.$truss) || object.$destroyed) return;
    this._modeler.destroyObject(object);
    // Normally we'd only destroy enumerable children, which are the Firebase properties.  However,
    // clients have the option of creating hidden placeholders, so we need to scan non-enumerable
    // properties as well.  To distinguish such placeholders from the myriad other non-enumerable
    // properties (that lead all over tree, e.g. $parent), we check that the property's parent is
    // ourselves before destroying.
    for (const key of Object.getOwnPropertyNames(object)) {
      const child = object.$data[key];
      if (child && child.$parent === object) this._destroyObject(child);
    }
  }

  _integrateSnapshot(snap) {
    _.forEach(this._localWrites, (writeSerial, path) => {
      if (snap.writeSerial >= writeSerial) delete this._localWrites[path];
    });
    if (snap.exists) {
      const createdObjects = [];
      const parent = this._scaffoldAncestors(snap.path, true, createdObjects);
      if (parent) {
        this._plantValue(
          snap.path, snap.key, snap.value, parent, true, false, false, createdObjects);
      }
      for (const object of createdObjects) this._completeCreateObject(object);
    } else {
      this._prune(snap.path, null, true);
    }
  }

  _scaffoldAncestors(path, remoteWrite, createdObjects) {
    let object;
    const segments = _.dropRight(splitPath(path, true));
    let ancestorPath = '/';
    for (let i = 0; i < segments.length; i++) {
      const segment = segments[i];
      const key = unescapeKey(segment);
      let child = segment ? object.$data[key] : this.root;
      if (segment) ancestorPath += (ancestorPath === '/' ? '' : '/') + segment;
      if (child) {
        if (remoteWrite && this._localWrites[ancestorPath]) return;
      } else {
        child = this._plantValue(
          ancestorPath, key, {}, object, remoteWrite, false, false, createdObjects);
        if (!child) return;
      }
      object = child;
    }
    return object;
  }

  _plantValue(path, key, value, parent, remoteWrite, override, local, createdObjects) {
    if (remoteWrite && (value === null || value === undefined)) {
      throw new Error(`Snapshot includes invalid value at ${path}: ${value}`);
    }
    if (remoteWrite && this._localWrites[path || '/']) return;
    if (value === SERVER_TIMESTAMP) value = this._localWriteTimestamp;
    let object = parent.$data[key];
    if (!_.isArray(value) && !(local ? _.isPlainObject(value) : _.isObject(value))) {
      this._destroyObject(object);
      this._setFirebaseProperty(parent, key, value);
      return;
    }
    let objectCreated = false;
    if (!_.isObject(object)) {
      // Need to pre-set the property, so that if the child object attempts to watch any of its own
      // properties while being created the $$touchThis method has something to add a dependency on
      // as the object's own properties won't be made reactive until *after* it's been created.
      this._setFirebaseProperty(parent, key, null);
      object = this._createObject(path, parent);
      this._setFirebaseProperty(parent, key, object, object.$hidden);
      this._fixObject(object);
      createdObjects.push(object);
      objectCreated = true;
    }
    if (override) {
      Object.defineProperty(object, '$overridden', {get: _.constant(true), configurable: true});
    } else if (object.$overridden) {
      delete object.$overridden;
    }
    // Plant hidden placeholders first, so their computed watchers will have a similar precedence to
    // the parent object, and the parent object's other children will get computed first.  This can
    // optimize updates when parts of a complex model are broken out into hidden sub-models, and
    // shouldn't risk being overwritten by actual Firebase data since that will rarely (never?) be
    // hidden.
    if (objectCreated) this._plantPlaceholders(object, path, true, createdObjects);
    _.forEach(value, (item, escapedChildKey) => {
      this._plantValue(
        joinPath(path, escapedChildKey), unescapeKey(escapedChildKey), item, object, remoteWrite,
        override, local, createdObjects
      );
    });
    if (objectCreated) {
      this._plantPlaceholders(object, path, false, createdObjects);
    } else {
      _.forEach(object, (item, childKey) => {
        const escapedChildKey = escapeKey(childKey);
        if (!value.hasOwnProperty(escapedChildKey)) {
          this._prune(joinPath(path, escapedChildKey), null, remoteWrite);
        }
      });
    }
    return object;
  }

  _plantPlaceholders(object, path, hidden, createdObjects) {
    this._modeler.forEachPlaceholderChild(path, mount => {
      if (hidden !== undefined && hidden !== !!mount.hidden) return;
      const key = unescapeKey(mount.escapedKey);
      if (!object.hasOwnProperty(key)) {
        this._plantValue(
          joinPath(path, mount.escapedKey), key, mount.placeholder, object, false, false, false,
          createdObjects);
      }
    });
  }

  _prune(path, lockedDescendantPaths, remoteWrite) {
    lockedDescendantPaths = lockedDescendantPaths || {};
    const object = this.getObject(path);
    if (object === undefined) return;
    if (remoteWrite && this._avoidLocalWritePaths(path, lockedDescendantPaths)) return;
    if (!(_.isEmpty(lockedDescendantPaths) && this._pruneAncestors(path, object)) &&
        _.isObject(object)) {
      // The target object is a placeholder, and all ancestors are placeholders or otherwise needed
      // as well, so we can't delete it.  Instead, dive into its descendants to delete what we can.
      this._pruneDescendants(object, lockedDescendantPaths);
    }
  }

  _avoidLocalWritePaths(path, lockedDescendantPaths) {
    for (const localWritePath in this._localWrites) {
      if (!this._localWrites.hasOwnProperty(localWritePath)) continue;
      if (path === localWritePath || localWritePath === '/' ||
          _.startsWith(path, localWritePath + '/')) return true;
      if (path === '/' || _.startsWith(localWritePath, path + '/')) {
        const segments = splitPath(localWritePath, true);
        for (let i = segments.length; i > 0; i--) {
          const subPath = segments.slice(0, i).join('/');
          const active = i === segments.length;
          if (lockedDescendantPaths[subPath] || lockedDescendantPaths[subPath] === active) break;
          lockedDescendantPaths[subPath] = active;
          if (subPath === path) break;
        }
      }
    }
  }

  _pruneAncestors(targetPath, targetObject) {
    // Destroy the child (unless it's a placeholder that's still needed) and any ancestors that
    // are no longer needed to keep this child rooted, and have no other reason to exist.
    let deleted = false;
    let object = targetObject;
    // The target object may be a primitive, in which case it won't have $path, $parent and $key
    // properties.  In that case, use the target path to figure those out instead.  Note that all
    // ancestors of the target object will necessarily not be primitives and will have those
    // properties.
    let targetKey;
    const targetParentPath = targetPath.replace(/\/[^/]+$/, match => {
      targetKey = unescapeKey(match.slice(1));
      return '';
    });
    while (object !== undefined && object !== this.root) {
      const parent =
        object && object.$parent || object === targetObject && this.getObject(targetParentPath);
      if (!this._modeler.isPlaceholder(object && object.$path || targetPath)) {
        const ghostObjects = deleted ? null : [targetObject];
        if (!this._holdsConcreteData(object, ghostObjects)) {
          deleted = true;
          this._deleteFirebaseProperty(
            parent, object && object.$key || object === targetObject && targetKey);
        }
      }
      object = parent;
    }
    return deleted;
  }

  _holdsConcreteData(object, ghostObjects) {
    if (object === undefined || object === null) return false;
    if (ghostObjects && _.includes(ghostObjects, object)) return false;
    if (!_.isObject(object) || !object.$truss) return true;
    return _.some(object, value => this._holdsConcreteData(value, ghostObjects));
  }

  _pruneDescendants(object, lockedDescendantPaths) {
    if (lockedDescendantPaths[object.$path]) return true;
    if (object.$overridden) delete object.$overridden;
    let coupledDescendantFound = false;
    _.forEach(object, (value, key) => {
      let shouldDelete = true;
      let valueLocked;
      if (lockedDescendantPaths[joinPath(object.$path, escapeKey(key))]) {
        shouldDelete = false;
        valueLocked = true;
      } else if (value.$truss) {
        const placeholder = this._modeler.isPlaceholder(value.$path);
        if (placeholder || _.has(lockedDescendantPaths, value.$path)) {
          valueLocked = this._pruneDescendants(value, lockedDescendantPaths);
          shouldDelete = !placeholder && !valueLocked;
        }
      }
      if (shouldDelete) this._deleteFirebaseProperty(object, key);
      coupledDescendantFound = coupledDescendantFound || valueLocked;
    });
    return coupledDescendantFound;
  }

  getObject(path) {
    const segments = splitPath(path);
    let object;
    for (const segment of segments) {
      object = segment ? object.$data[segment] : this.root;
      if (object === undefined) return;
    }
    return object;
  }

  _getFirebasePropertyDescriptor(object, data, key) {
    const descriptor = Object.getOwnPropertyDescriptor(data, key);
    if (descriptor) {
      if (!descriptor.enumerable) {
        const child = data[key];
        if (!child || child.$parent !== object) {
          throw new Error(
            `Key conflict between Firebase and instance or computed properties at ` +
            `${object.$path}: ${key}`);
        }
      }
      if (!descriptor.get || !descriptor.set) {
        throw new Error(`Unbound property at ${object.$path}: ${key}`);
      }
    } else if (key in data) {
      throw new Error(
        `Key conflict between Firebase and inherited property at ${object.$path}: ${key}`);
    }
    return descriptor;
  }

  _setFirebaseProperty(object, key, value, hidden) {
    const data = object.hasOwnProperty('$data') ? object.$data : object;
    let descriptor = this._getFirebasePropertyDescriptor(object, data, key);
    if (descriptor) {
      if (hidden) {
        // Redefine property as hidden after it's been created, since we usually don't know whether
        // it should be hidden until too late.  This is a one-way deal -- you can't unhide a
        // property later, but that's fine for our purposes.
        Object.defineProperty(data, key, {
          get: descriptor.get, set: descriptor.set, configurable: true, enumerable: false
        });
      }
      if (data[key] === value) return;
      this._firebasePropertyEditAllowed = true;
      data[key] = value;
      this._firebasePropertyEditAllowed = false;
    } else {
      Vue.set(data, key, value);
      descriptor = Object.getOwnPropertyDescriptor(data, key);
      Object.defineProperty(data, key, {
        get: descriptor.get, set: this._overwriteFirebaseProperty.bind(this, descriptor, key),
        configurable: true, enumerable: !hidden
      });
    }
    angularProxy.digest();
  }

  _overwriteFirebaseProperty(descriptor, key, newValue) {
    if (!this._firebasePropertyEditAllowed) {
      const e = new Error(`Firebase data cannot be mutated directly: ${key}`);
      e.trussCode = 'firebase_overwrite';
      throw e;
    }
    descriptor.set.call(this, newValue);
  }

  _deleteFirebaseProperty(object, key) {
    const data = object.hasOwnProperty('$data') ? object.$data : object;
    // Make sure it's actually a Firebase property.
    this._getFirebasePropertyDescriptor(object, data, key);
    this._destroyObject(data[key]);
    Vue.delete(data, key);
    angularProxy.digest();
  }

  checkVueObject(object, path) {
    this._modeler.checkVueObject(object, path);
  }
}


function checkUpdateHasOnlyDescendantsWithNoOverlap(rootPath, values) {
  // First, check all paths for correctness and absolutize them, since there could be a mix of
  // absolute paths and relative keys.
  _.forEach(_.keys(values), path => {
    if (path.charAt(0) === '/') {
      if (!(path === rootPath || rootPath === '/' ||
            _.startsWith(path, rootPath + '/') && path.length > rootPath.length + 1)) {
        throw new Error(`Update item is not a descendant of target ref: ${path}`);
      }
    } else {
      if (_.includes(path, '/')) {
        throw new Error(`Update item deep path must be absolute, taken from a reference: ${path}`);
      }
      const absolutePath = joinPath(rootPath, escapeKey(path));
      if (values.hasOwnProperty(absolutePath)) {
        throw new Error(`Update items overlap: ${path} and ${absolutePath}`);
      }
      values[absolutePath] = values[path];
      delete values[path];
    }
  });
  // Then check for overlaps;
  const allPaths = _(values).keys().map(path => joinPath(path, '')).sortBy('length').value();
  _.forEach(values, (value, path) => {
    for (const otherPath of allPaths) {
      if (otherPath.length > path.length) break;
      if (path !== otherPath && _.startsWith(path, otherPath)) {
        throw new Error(`Update items overlap: ${otherPath} and ${path}`);
      }
    }
  });
}

function extractCommonPathPrefix(values) {
  let prefixSegments;
  _.forEach(values, (value, path) => {
    const segments = path === '/' ? [''] : splitPath(path, true);
    if (prefixSegments) {
      let firstMismatchIndex = 0;
      const maxIndex = Math.min(prefixSegments.length, segments.length);
      while (firstMismatchIndex < maxIndex &&
             prefixSegments[firstMismatchIndex] === segments[firstMismatchIndex]) {
        firstMismatchIndex++;
      }
      prefixSegments = prefixSegments.slice(0, firstMismatchIndex);
      if (!prefixSegments.length) return false;
    } else {
      prefixSegments = segments;
    }
  });
  return prefixSegments.length === 1 ? '/' : prefixSegments.join('/');
}

function relativizePaths(rootPath, values) {
  const offset = rootPath === '/' ? 1 : rootPath.length + 1;
  _.forEach(_.keys(values), path => {
    values[path.slice(offset)] = values[path];
    delete values[path];
  });
}

function toFirebaseJson(object) {
  if (!_.isObject(object)) return object;
  const result = {};
  for (const key in object) {
    if (object.hasOwnProperty(key)) result[escapeKey(key)] = toFirebaseJson(object[key]);
  }
  return result;
}

let bridge;
let logging;
const workerFunctions = {};
// This version is filled in by the build, don't reformat the line.
const VERSION = '0.9.2';


class Truss {

  /**
   * Create a new Truss instance, specific to a given datastore.  To avoid confusion there should be
   * exactly one Truss per root datastore URL, so in most code this will be a singleton.
   *
   * @param rootUrl {String} The root URL, https://{project}.firebaseio.com.
   */
  constructor(rootUrl) {
    // TODO: allow rootUrl to be a test database object for testing
    if (!bridge) {
      throw new Error('Truss worker not connected, please call Truss.connectWorker first');
    }
    this._rootUrl = rootUrl.replace(/\/$/, '');
    this._keyGenerator = new KeyGenerator();
    this._dispatcher = new Dispatcher(bridge);
    this._vue = new Vue();

    bridge.trackServer(this._rootUrl);
    this._tree = new Tree(this, this._rootUrl, bridge, this._dispatcher);
    this._metaTree = new MetaTree(this._rootUrl, this._tree, bridge, this._dispatcher);

    Object.freeze(this);
  }

  get meta() {return this._metaTree.root;}
  get store() {return this._tree.root;}

  /**
   * Mount a set of classes against the datastore structure.  Must be called at most once, and
   * cannot be called once any data has been loaded into the tree.
   * @param classes {Array<Function> | Object<Function>} A list of the classes to map onto the
   *    datastore structure.  Each class must have a static $trussMount property that is a
   *    (wildcarded) unescaped datastore path, or an options object
   *    {path: string, placeholder: object}, or an array of either.  If the list is an object then
   *    the keys serve as default option-less $trussMount paths for classes that don't define an
   *    explicit $trussMount.
   */
  mount(classes) {
    this._tree.init(classes);
  }

  destroy() {
    this._vue.$destroy();
    this._tree.destroy();
    this._metaTree.destroy();
  }

  get now() {return Date.now() + this.meta.timeOffset;}
  newKey() {return this._keyGenerator.generateUniqueKey(this.now);}

  authenticate(token) {
    return this._metaTree.authenticate(token);
  }

  unauthenticate() {
    return this._metaTree.unauthenticate();
  }

  intercept(actionType, callbacks) {
    return this._dispatcher.intercept(actionType, callbacks);
  }

  // connections are {key: Query | Object | fn() -> (Query | Object)}
  connect(scope, connections) {
    if (!connections) {
      connections = scope;
      scope = undefined;
    }
    if (connections instanceof Handle) connections = {_: connections};
    return new Connector(scope, connections, this._tree, 'connect');
  }

  // target is Reference, Query, or connection Object like above
  peek(target, callback) {
    callback = wrapPromiseCallback(callback || _.identity);
    let cleanup, cancel;
    const promise = Promise.resolve().then(() => new Promise((resolve, reject) => {
      const scope = {};
      let callbackPromise;

      let connector = new Connector(scope, {result: target}, this._tree, 'peek');

      let unintercept = this.intercept('peek', {onFailure: op => {
        function match(descriptor) {
          if (!descriptor) return;
          if (descriptor instanceof Handle) return op.target.isEqual(descriptor);
          return _.some(descriptor, value => match(value));
        }
        if (match(connector.at)) {
          reject(op.error);
          cleanup();
        }
      }});

      let unobserve = this.observe(() => connector.ready, ready => {
        if (!ready) return;
        unobserve();
        unobserve = null;
        callbackPromise = promiseFinally(
          callback(scope.result), () => {angularProxy.digest(); callbackPromise = null; cleanup();}
        ).then(result => {resolve(result);}, error => {reject(error);});
      });

      cleanup = () => {
        if (unobserve) {unobserve(); unobserve = null;}
        if (unintercept) {unintercept(); unintercept = null;}
        if (connector) {connector.destroy(); connector = null;}
        if (callbackPromise && callbackPromise.cancel) callbackPromise.cancel();
      };

      cancel = () => {
        reject(new Error('Canceled'));
        cleanup();
      };
    }));
    return promiseCancel(promise, cancel);
  }

  observe(subjectFn, callbackFn, options) {
    const usePreciseDefaults = _.isObject(options && options.precise);
    let numCallbacks = 0;
    let oldValueClone;
    if (usePreciseDefaults) oldValueClone = _.clone(options.precise, options.deep);

    const unwatch = this._vue.$watch(subjectFn, (newValue, oldValue) => {
      if (options && options.precise) {
        const newValueClone = usePreciseDefaults ?
          (options.deep ?
            _.defaultsDeep({}, newValue, options.precise) :
            _.defaults({}, newValue, options.precise)) :
          _.clone(newValue, options.deep);
        if (_.isEqual(newValueClone, oldValueClone)) return;
        oldValueClone = newValueClone;
      }
      numCallbacks++;
      if (!unwatch) {
        // Delay the immediate callback until we've had a chance to return the unwatch function.
        Promise.resolve().then(() => {
          if (numCallbacks > 1) return;
          callbackFn(newValue, oldValue);
          // No need to digest since under Angular we'll be using $q as Promise.
        });
      } else {
        callbackFn(newValue, oldValue);
        angularProxy.digest();
      }
    }, {immediate: true, deep: options && options.deep});

    if (options && options.scope) options.scope.$on('$destroy', unwatch);
    return unwatch;
  }

  when(expression, options) {
    let cleanup, timeoutHandle;
    let promise = new Promise((resolve, reject) => {
      let unobserve = this.observe(expression, value => {
        if (!value) return;
        // Wait for computed properties to settle and double-check.
        Vue.nextTick(() => {
          value = expression();
          if (!value) return;
          resolve(value);
          cleanup();
        });
      });
      if (_.has(options, 'timeout')) {
        timeoutHandle = setTimeout(() => {
          timeoutHandle = null;
          reject(new Error(options.timeoutMessage || 'Timeout'));
          cleanup();
        }, options.timeout);
      }
      cleanup = () => {
        if (unobserve) {unobserve(); unobserve = null;}
        if (timeoutHandle) {clearTimeout(timeoutHandle); timeoutHandle = null;}
        reject(new Error('Canceled'));
      };
    });
    promise = promiseCancel(promiseFinally(promise, cleanup), cleanup);
    if (options && options.scope) options.scope.$on('$destroy', () => {promise.cancel();});
    return promise;
  }

  nextTick() {
    let cleanup;
    let promise = new Promise((resolve, reject) => {
      Vue.nextTick(resolve);
      cleanup = () => {
        reject(new Error('Canceled'));
      };
    });
    promise = promiseCancel(promise, cleanup);
    return promise;
  }

  throttleRemoteDataUpdates(delay) {
    this._tree.throttleRemoteDataUpdates(delay);
  }

  checkObjectsForRogueProperties() {
    this._tree.checkVueObject(this._tree.root, '/');
  }

  static get computedPropertyStats() {
    return stats.list;
  }

  static logComputedPropertyStats(n = 10) {
    return stats.log(n);
  }

  static connectWorker(webWorker) {
    if (bridge) throw new Error('Worker already connected');
    if (_.isString(webWorker)) {
      const Worker = window.SharedWorker || window.Worker;
      if (!Worker) throw new Error('Browser does not implement Web Workers');
      webWorker = new Worker(webWorker);
    }
    bridge = new Bridge(webWorker);
    if (logging) bridge.enableLogging(logging);
    return bridge.init(webWorker).then(
      ({exposedFunctionNames, firebaseSdkVersion}) => {
        Object.defineProperty(Truss, 'FIREBASE_SDK_VERSION', {value: firebaseSdkVersion});
        for (const name of exposedFunctionNames) {
          Truss.worker[name] = bridge.bindExposedFunction(name);
        }
      }
    );
  }

  static get worker() {return workerFunctions;}
  static preExpose(functionName) {
    Truss.worker[functionName] = bridge.bindExposedFunction(functionName);
  }

  static bounceConnection() {return bridge.bounceConnection();}
  static suspend() {return bridge.suspend();}
  static debugPermissionDeniedErrors(simulatedTokenGenerator, maxSimulationDuration, callFilter) {
    return bridge.debugPermissionDeniedErrors(
      simulatedTokenGenerator, maxSimulationDuration, callFilter);
  }

  static debounceAngularDigest(wait) {
    angularProxy.debounceDigest(wait);
  }

  static escapeKey(key) {return escapeKey(key);}
  static unescapeKey(escapedKey) {return unescapeKey(escapedKey);}

  static enableLogging(fn) {
    logging = fn;
    if (bridge) bridge.enableLogging(fn);
  }

  // Duplicate static constants on instance for convenience.
  get SERVER_TIMESTAMP() {return Truss.SERVER_TIMESTAMP;}
  get VERSION() {return Truss.VERSION;}
  get FIREBASE_SDK_VERSION() {return Truss.FIREBASE_SDK_VERSION;}
}

Object.defineProperties(Truss, {
  SERVER_TIMESTAMP: {value: SERVER_TIMESTAMP},
  VERSION: {value: VERSION},

  ComponentPlugin: {value: {
    install(Vue2, pluginOptions) {
      if (Vue !== Vue2) throw new Error('Multiple versions of Vue detected');
      if (!pluginOptions.truss) {
        throw new Error('Need to pass `truss` instance as an option to use the ComponentPlugin');
      }
      const prototypeExtension = {
        $truss: {value: pluginOptions.truss},
        $destroyed: {get() {return this._isBeingDestroyed || this._isDestroyed;}},
        $$touchThis: {value() {if (this.__ob__) this.__ob__.dep.depend();}}
      };
      const conflictingKeys = _(prototypeExtension).keys()
        .union(_.keys(BaseValue.prototype)).intersection(_.keys(Vue.prototype)).value();
      if (conflictingKeys.length) {
        throw new Error(
          'Truss extension properties conflict with Vue properties: ' + conflictingKeys.join(', '));
      }
      Object.defineProperties(Vue.prototype, prototypeExtension);
      copyPrototype(BaseValue, Vue);
      Vue.mixin({
        destroyed() {
          if (_.has(this, '$$trussFinalizers')) {
            // Some finalizers remove themselves from the array, so clone it before iterating.
            for (const fn of _.clone(this.$$trussFinalizers)) fn();
          }
        }
      });
    }
  }}
});

angularProxy.defineModule(Truss);

export default Truss;

//# sourceMappingURL=firetruss.es2015.js.map