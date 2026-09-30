import {unescapeKey} from './utils/paths.js';
import _ from 'lodash';

// 4.1.2 is the first worker that delivers auth results in the order Firebase reported them, which
// the serialized certifications in `MetaTree` rely on to tell a call's own answer from a background
// change.
const MIN_WORKER_VERSION = '4.1.2';


// Whether a worker at `version` satisfies `minimum`:  the major versions must match precisely, and
// the minor and patch must be greater than or equal.  Each component is compared as a number, since
// comparing the digits as text gets two-digit components wrong:  a patch of '10' sorts below '2'.
// An unparseable version yields nothing, which the caller treats as one it can't judge rather than
// as incompatible.
export function isVersionSufficient(version, minimum) {
  const worker = parseVersion(version);
  const min = parseVersion(minimum);
  if (!worker || !min) return;
  return worker.major === min.major && (
    worker.minor > min.minor || worker.minor === min.minor && worker.patch >= min.patch
  );
}

function parseVersion(version) {
  const parts = version.match(/^(\d+)\.(\d+)\.(\d+)(-.*)?$/);
  if (!parts) return;
  return {major: _.toNumber(parts[1]), minor: _.toNumber(parts[2]), patch: _.toNumber(parts[3])};
}


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


export default class Bridge {
  constructor(webWorker) {
    this._idCounter = 0;
    this._deferreds = {};
    this._suspended = false;
    this._servers = {};
    this._callbacks = {};
    this._log = _.noop;
    this._inboundMessages = [];
    this._outboundMessages = [];
    this._flushMessageQueue = this._flushMessageQueue.bind(this);
    this._port = webWorker.port || webWorker;
    this._shared = !!webWorker.port;
    this._dead = undefined;
    Object.seal(this);
    this._port.onmessage = this._receive.bind(this);
  }

  init(lockName, config) {
    const items = [];
    try {
      const storage = window.localStorage || window.sessionStorage;
      if (!storage) throw new Error('localStorage and sessionStorage not available');
      for (let i = 0; i < storage.length; i++) {
        const key = storage.key(i);
        items.push({key, value: storage.getItem(key)});
      }
    } catch {
      // Some browsers don't like us accessing local storage -- nothing we can do.
    }
    return this._send({msg: 'init', storage: items, config, lockName}).then(response => {
      if (isVersionSufficient(response.version, MIN_WORKER_VERSION) === false) {
        return Promise.reject(new Error(
          `Incompatible Firetruss worker version: ${response.version} ` +
          `(${MIN_WORKER_VERSION} or better required)`
        ));
      }
      if (response.livenessLockName) {
        navigator.locks.request(response.livenessLockName, () => {
          this.crash({error: {
            name: 'Error', message: 'worker terminated', extra: {shared: this._shared}
          }});
        });
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

  enableLogging(fn) {
    if (fn) {
      if (fn === true) {
        fn = console.log.bind(console);
        this._send({msg: 'enableFirebaseLogging', value: true});
      }
      this._log = fn;
    } else {
      this._send({msg: 'enableFirebaseLogging', value: false});
      this._log = _.noop;
    }
  }

  _send(message) {
    message.id = ++this._idCounter;
    let promise;
    if (this._dead) {
      return Promise.reject(this._dead);
    } else if (message.oneWay) {
      promise = Promise.resolve();
    } else {
      promise = new Promise((resolve, reject) => {
        this._deferreds[message.id] = {resolve, reject};
      });
      const deferred = this._deferreds[message.id];
      deferred.promise = promise;
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
    this._log('flush:', this._outboundMessages.length, 'messages');
    try {
      this._port.postMessage(this._outboundMessages);
      this._outboundMessages = [];
    } catch (e) {
      this._log('flush failed:', e);
      e.extra = {messages: this._outboundMessages};
      throw e;
    }
  }

  _receive(event) {
    if (this._dead) return;
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

  crash(message) {
    let details = `Internal worker error: ${message.error.name}: ${message.error.message}`;
    if (message.error.cause) details += ` (caused by ${message.error.cause})`;
    this._dead = new Error(details);
    if (message.error.extra) this._dead.extra = message.error.extra;
    _.forEach(this._deferreds, ({reject}) => {reject(this._dead);});
    this._deferreds = {};
    throw this._dead;
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
    } catch {
      // If we're denied access, there's nothing we can do.
    }
  }

  trackServer(rootUrl) {
    if (Object.hasOwn(this._servers, rootUrl)) return Promise.resolve();
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

  authWithCustomToken(url, authToken) {
    return this._send({msg: 'authWithCustomToken', url, authToken});
  }

  authAnonymously(url) {
    return this._send({msg: 'authAnonymously', url});
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
  try {
    error.params = params;
    for (const propertyName in json) {
      if (propertyName === 'message' || !Object.hasOwn(json, propertyName)) continue;
      try {
        error[propertyName] = json[propertyName];
      } catch {
        error.extra = error.extra || {};
        error.extra[propertyName] = json[propertyName];
      }
    }
  } catch (e) {
    if (!/object is not extensible/.test(e.message)) throw e;
  }
  return error;
}
