/* global setImmediate */

import {unescapeKey, ABORT_TRANSACTION_NOW} from './utils.js';

// jshint browser:true

let bridge;

class SlownessTracker {
  constructor(record) {
    this.record = record;
    this.counted = false;
    this.canceled = false;
    this.handle = setTimeout(this.handleTimeout.bind(this), record.timeout);
  }

  handleTimeout() {
    if (this.canceled) return;
    this.counted = true;
    this.record.callback(++this.record.count, 1, this.record.timeout);
  }

  handleDone() {
    this.canceled = true;
    if (this.counted) {
      this.record.callback(--this.record.count, -1, this.record.timeout);
    } else {
      clearTimeout(this.handle);
    }
  }
}


class Snapshot {
  constructor({path, value, valueError, exists}) {
    this._path = path;
    this._value = value;
    this._valueError = errorFromJson(valueError);
    this._exists = value === undefined ? exists || false : value !== null;
  }

  get path() {
    return this._path;
  }

  get exists() {
    return this._exists;
  }

  get value() {
    this._checkValue();
    return this._value;
  }

  get key() {
    if (this._key === undefined) this._key = unescapeKey(this._path.replace(/.*\//, ''));
    return this._key;
  }

  _checkValue() {
    if (this._valueError) throw this._valueError;
    if (this._value === undefined) throw new Error('Value omitted from snapshot');
  }
}


export default class Bridge {
  constructor(webWorker) {
    this._idCounter = 0;
    this._deferreds = {};
    this._suspended = false;
    this._servers = {};
    this._callbacks = {};
    this._errorCallbacks = [];
    this._slowCallbacks = {read: [], write: [], auth: []};
    this._simulatedTokenGenerator = null;
    this._maxSimulationDuration = 5000;
    this._simulatedCallFilter = null;
    this._inboundMessages = [];
    this._outboundMessages = [];
    this._flushMessageQueue = this._flushMessageQueue.bind(this);
    this._port = webWorker.port || webWorker;
    this._shared = !!webWorker.port;
    this._port.onmessage = this._receive.bind(this);
    window.addEventListener('unload', () => {this._send({msg: 'destroy'});});
    setInterval(() => {this._send({msg: 'ping'});}, 60 * 1000);
  }

  static init(webWorker) {
    const items = [];
    try {
      const storage = window.localStorage || window.sessionStorage;
      if (!storage) return;
      for (let i = 0; i < storage.length; i++) {
        const key = storage.key(i);
        items.push({key, value: storage.getItem(key)});
      }
    } catch (e) {
      // Some browsers don't like us accessing local storage -- nothing we can do.
    }
    return this._send({msg: 'init', storage: items});
  }

  static get instance() {
    if (!bridge) throw new Error('No web worker connected, please call Truss.connectWorker first');
    return bridge;
  }

  suspend(suspended) {
    if (suspended === undefined) suspended = true;
    if (this._suspended === suspended) return;
    this._suspended = suspended;
    if (!suspended) {
      this._receiveMessages(this._inboundMessages);
      this._inboundMessages = [];
      if (this._outboundMessages.length) setImmediate(this._flushMessageQueue);
    }
  }

  debugPermissionDeniedErrors(simulatedTokenGenerator, maxSimulationDuration, callFilter) {
    this._simulatedTokenGenerator = simulatedTokenGenerator;
    if (maxSimulationDuration !== undefined) this._maxSimulationDuration = maxSimulationDuration;
    this._simulatedCallFilter = callFilter || function() {return true;};
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
      for (let name in message) if (message.hasOwnProperty(name)) deferred[name] = message[name];
    }
    if (!this._outboundMessages.length && !this._suspended) setImmediate(this._flushMessageQueue);
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
    for (let message of messages) {
      const fn = this[message.msg];
      if (typeof fn !== 'function') throw new Error('Unknown message: ' + message.msg);
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
    if (!deferred) throw new Error('fireworker received resolution to inexistent call');
    delete this._deferreds[message.id];
    deferred.resolve(message.result);
  }

  reject(message) {
    const deferred = this._deferreds[message.id];
    if (!deferred) throw new Error('fireworker received rejection of inexistent call');
    delete this._deferreds[message.id];
    this._hydrateError(message.error, deferred).then(error => {
      deferred.reject(error);
      this._emitError(error);
    });
  }

  _hydrateError(json, props) {
    const error = errorFromJson(json);
    const code = json.code || json.message;
    if (code && code.toLowerCase() === 'permission_denied') {
      return this._simulateCall(props).then(securityTrace => {
        if (securityTrace) {
          error.extra = error.extra || {};
          error.extra.debug = securityTrace;
        }
        return error;
      });
    } else {
      return Promise.resolve(error);
    }
  }

  _simulateCall(props) {
    if (!(this._simulatedTokenGenerator && this._maxSimulationDuration > 0)) {
      return Promise.resolve();
    }
    let simulatedCalls = [];
    switch (props.msg) {
      case 'set':
        simulatedCalls.push({method: 'set', url: props.url, args: [props.value]});
        break;
      case 'update':
        simulatedCalls.push({method: 'update', url: props.url, args: [props.value]});
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
      return Promise.all(simulatedCalls.map(message => {
        message.msg = 'simulate';
        message.token = token;
        return this._send(message);
      }));
    }).then(securityTraces => {
      if (securityTraces.every(trace => trace === null)) {
        return 'Unable to reproduce error in simulation';
      }
      return securityTraces.filter(trace => trace).join('\n\n');
    }).catch(e => {
      return 'Error running simulation: ' + e;
    });
    const timeoutPromise = new Promise(resolve => {
      setTimeout(resolve.bind(null, 'Simulated call timed out'), this._maxSimulationDuration);
    });
    return Promise.race([simulationPromise, timeoutPromise]);
  }

  updateLocalStorage(items) {
    try {
      const storage = window.localStorage || window.sessionStorage;
      for (let item in items) {
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
    for (let listener of server.authListeners) listener(auth);
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

  set(url, value) {return this._send({msg: 'set', url, value});}
  update(url, value) {return this._send({msg: 'update', url, value});}

  on(listenerKey, url, spec, eventType, snapshotCallback, cancelCallback, context, options) {
    const handle = {
      listenerKey, eventType, snapshotCallback, cancelCallback, context, msg: 'on', url, spec,
      timeouts: this._slowCallbacks.read.map(record => new SlownessTracker(record))
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
        snapshotCallback,
        handle =>
          handle.listenerKey === listenerKey && handle.eventType === eventType &&
          handle.context === context
      );
      if (!callbackId) return Promise.resolve();  // no-op, never registered or already deregistered
      idsToDeregister.push(callbackId);
    } else {
      for (let id of Object.keys(this._callbacks)) {
        const handle = this._callbacks[id];
        if (handle.listenerKey === listenerKey && (!eventType || handle.eventType === eventType)) {
          idsToDeregister.push(id);
        }
      }
    }
    // Nullify callbacks first, then deregister after off() is complete.  We don't want any
    // callbacks in flight from the worker to be invoked while the off() is processing, but we don't
    // want them to throw an exception either.
    for (let id of idsToDeregister) this._nullifyCallback(id);
    return this._send({msg: 'off', listenerKey, url, spec, eventType, callbackId}).then(() => {
      for (let id of idsToDeregister) this._deregisterCallback(id);
    });
  }

  _onCallback(handle, error, snapshotJson) {
    if (handle.timeouts) {
      for (let timeout of handle.timeouts) timeout.handleDone();
    }
    if (error) {
      this._deregisterCallback(handle.id);
      this._hydrateError(error, handle).then(error => {
        if (handle.cancelCallback) handle.cancelCallback.call(handle.context, error);
        this._emitError(error);
      });
    } else {
      handle.snapshotCallback.call(handle.context, new Snapshot(snapshotJson));
    }
  }

  transaction(url, updateFunction, options) {
    let tries = 0;

    const attemptTransaction = (oldValue, oldHash) => {
      if (tries++ >= 25) return Promise.reject(new Error('maxretry'));
      let newValue;
      try {
        newValue = updateFunction(oldValue);
      } catch (e) {
        return Promise.reject(e);
      }
      if (newValue === ABORT_TRANSACTION_NOW ||
          newValue === undefined && !options.safeAbort) {
        return {committed: false, snapshot: new Snapshot({url, value: oldValue})};
      }
      return this._send({msg: 'transaction', url, oldHash, newValue, options}).then(result => {
        if (result.stale) {
          return attemptTransaction(result.value, result.hash);
        } else {
          return {committed: result.committed, snapshot: new Snapshot(result.snapshotJson)};
        }
      });
    };

    return attemptTransaction(null, null);
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
    const handle = this._callbacks[id];
    if (handle.timeouts) {
      for (let timeout of handle.timeouts) timeout.handleDone();
    }
    this._callbacks[id].callback = noop;
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

  onError(callback) {
    this._errorCallbacks.push(callback);
    return callback;
  }

  offError(callback) {
    var k = this._errorCallbacks.indexOf(callback);
    if (k !== -1) this._errorCallbacks.splice(k, 1);
  }

  onSlow(operationKind, timeout, callback) {
    const kinds = operationKind === 'all' ? Object.keys(this._slowCallbacks) : [operationKind];
    for (let kind of kinds) this._slowCallbacks[kind].push({timeout, callback, count: 0});
    return callback;
  }

  offSlow(operationKind, callback) {
    const kinds = operationKind === 'all' ? Object.keys(this._slowCallbacks) : [operationKind];
    for (let kind of kinds) {
      const records = this._slowCallbacks[kind];
      for (let i = 0; i < records.length; i++) {
        if (records[i].callback === callback) {
          records.splice(i, 1);
          break;
        }
      }
    }
  }

  trackSlowness(promise, operationKind) {
    const records = this._slowCallbacks[operationKind];
    if (!records.length) return promise;

    const timeouts = records.map(record => new SlownessTracker(record));

    function opDone() {
      for (let timeout of timeouts) timeout.handleDone();
    }

    promise = promise.then(result => {
      opDone();
      return result;
    }, error => {
      opDone();
      return Promise.reject(error);
    });

    return promise;
  }

  _emitError(error) {
    if (this._errorCallbacks.length) {
      setTimeout(() => {
        for (let callback of this._errorCallbacks) callback(error);
      }, 0);
    }
  }

}


function noop() {}

function errorFromJson(json) {
  if (!json || json instanceof Error) return json;
  const error = new Error(json.message);
  for (let propertyName in json) {
    if (propertyName === 'message' || !json.hasOwnProperty(propertyName)) continue;
    try {
      error[propertyName] = json[propertyName];
    } catch (e) {
      e.extra = {propertyName};
      throw e;
    }
  }
  return error;
}

function getUrlRoot(url) {
  const k = url.indexOf('/', 8);
  return k >= 8 ? url.slice(0, k) : url;
}
