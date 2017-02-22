(function () {
  'use strict';

  /* globals Firebase, setImmediate, setInterval */

  var fireworkers = [];
  var simulationQueue = Promise.resolve();
  var consoleIntercepted = false;
  var simulationConsoleLogs;


  var LocalStorage = function LocalStorage() {
    this._items = [];
    this._pendingItems = [];
    this._initialized = false;
    this._flushPending = this.flushPending.bind(this);
  };

  var prototypeAccessors = { length: {} };

  LocalStorage.prototype.init = function init (items) {
    if (!this._initialized) {
      this._items = items;
      this._initialized = true;
    }
  };

  LocalStorage.prototype._update = function _update (item) {
    if (!this._pendingItems.length) { setImmediate(this._flushPending); }
    this._pendingItems.push(item);
  };

  LocalStorage.prototype.flushPending = function flushPending () {
    if (!fireworkers.length) { return; }
    fireworkers[0]._send({msg: 'updateLocalStorage', items: this._pendingItems});
    this._pendingItems = [];
  };

  prototypeAccessors.length.get = function () {return this._items.length;};

  LocalStorage.prototype.key = function key (n) {
    return this._items[n].key;
  };

  LocalStorage.prototype.getItem = function getItem (key) {
    for (var i = 0, list = this._items; i < list.length; i += 1) {
      var item = list[i];

        if (item.key === key) { return item.value; }
    }
    return null;
  };

  LocalStorage.prototype.setItem = function setItem (key, value) {
    var targetItem;
    for (var i = 0, list = this._items; i < list.length; i += 1) {
      var item = list[i];

        if (item.key === key) {
        targetItem = item;
        item.value = value;
        break;
      }
    }
    if (!targetItem) {
      targetItem = {key: key, value: value};
      this._items.push(targetItem);
    }
    this._update(targetItem);
  };

  LocalStorage.prototype.removeItem = function removeItem (key) {
      var this$1 = this;

    for (var i = 0; i < this._items.length; i++) {
      if (this$1._items[i].key === key) {
        this$1._items.splice(i, 1);
        this$1._update({key: key, value: null});
        break;
      }
    }
  };

  LocalStorage.prototype.clear = function clear () {
      var this$1 = this;

    for (var item in this._items) {
      this$1._update({key: item.key, value: null});
    }
    this._items = [];
  };

  Object.defineProperties( LocalStorage.prototype, prototypeAccessors );

  self.localStorage = new LocalStorage();


  var Branch = function Branch() {
    this._root = null;
  };

  Branch.prototype.set = function set (value) {
    this._root = value;
  };

  Branch.prototype.diff = function diff (value, pathPrefix) {
    var updates = {};
    var segments = pathPrefix === '/' ? [''] : pathPrefix.split('/');
    if (this._diffRecursively(this._root, value, segments, updates)) {
      this._root = value;
      updates[pathPrefix] = value;
    }
    return updates;
  };

  Branch.prototype._diffRecursively = function _diffRecursively (oldValue, newValue, segments, updates) {
      var this$1 = this;

    if (oldValue === undefined) { oldValue = null; }
    if (newValue === undefined) { newValue = null; }
    if (oldValue === null) { return newValue !== null; }
    if (oldValue instanceof Object && newValue instanceof Object) {
      var replace = true;
      var keysToReplace = [];
      for (var childKey in newValue) {
        if (!newValue.hasOwnProperty(childKey)) { continue; }
        if (this$1._diffRecursively(
            oldValue[childKey], newValue[childKey], segments.concat(childKey), updates)) {
          keysToReplace.push(childKey);
        } else {
          replace = false;
        }
      }
      if (replace) { return true; }
      for (var childKey$1 in oldValue) {
        if (!oldValue.hasOwnProperty(childKey$1) || newValue.hasOwnProperty(childKey$1)) { continue; }
        updates[segments.concat(childKey$1).join('/')] = null;
        delete oldValue[childKey$1];
      }
      for (var i = 0, list = keysToReplace; i < list.length; i += 1) {
        var childKey$2 = list[i];

          updates[segments.concat(childKey$2).join('/')] = newValue[childKey$2];
        oldValue[childKey$2] = newValue[childKey$2];
      }
    } else {
      return newValue !== oldValue;
    }
  };


  var Fireworker = function Fireworker(port) {
    this.ping();
    this._port = port;
    this._lastWriteSerial = 0;
    this._callbacks = {};
    this._messages = [];
    this._flushMessageQueue = this._flushMessageQueue.bind(this);
    port.onmessage = this._receive.bind(this);
  };

  Fireworker.prototype.init = function init (ref) {
      var storage = ref.storage;
      var url = ref.url;

    if (storage) { self.localStorage.init(storage); }
    if (url) { createRef(url); }
    return {
      exposedFunctionNames: Object.keys(Fireworker._exposed),
      firebaseSdkVersion: Firebase.SDK_VERSION
    };
  };

  Fireworker.prototype.destroy = function destroy () {
      var this$1 = this;

    for (var key in this._callbacks) {
      var callback = this$1._callbacks[key];
      if (callback.cancel) { callback.cancel(); }
    }
    this._callbacks = {};
    this._port.onmessage = null;
    this._messages = [];
    var k = fireworkers.indexOf(this);
    if (k >= 0) { fireworkers[k] = null; }
  };

  Fireworker.prototype.ping = function ping () {
    this.lastTouched = Date.now();
  };

  Fireworker.prototype.bounceConnection = function bounceConnection () {
    Firebase.goOffline();
    Firebase.goOnline();
  };

  Fireworker.prototype._receive = function _receive (event) {
      var this$1 = this;

    Fireworker._firstMessageReceived = true;
    this.lastTouched = Date.now();
    for (var i = 0, list = event.data; i < list.length; i += 1) {
        var message = list[i];

        this$1._receiveMessage(message);
      }
  };

  Fireworker.prototype._receiveMessage = function _receiveMessage (message) {
      var this$1 = this;

    var promise;
    try {
      var fn = this[message.msg];
      if (typeof fn !== 'function') { throw new Error('Unknown message: ' + message.msg); }
      if (message.writeSerial) { this._lastWriteSerial = message.writeSerial; }
      promise = Promise.resolve(fn.call(this, message));
    } catch(e) {
      promise = Promise.reject(e);
    }
    if (!message.oneWay) {
      this._send({msg: 'acknowledge', id: message.id});
      promise.then(function (result) {
        this$1._send({msg: 'resolve', id: message.id, result: result});
      }, function (error) {
        this$1._send({msg: 'reject', id: message.id, error: errorToJson(error)});
      });
    }
  };

  Fireworker.prototype._send = function _send (message) {
    if (!this._messages.length) { setImmediate(this._flushMessageQueue); }
    this._messages.push(message);
  };

  Fireworker.prototype._flushMessageQueue = function _flushMessageQueue () {
    this._port.postMessage(this._messages);
    this._messages = [];
  };

  Fireworker.prototype.call = function call (ref) {
      var name = ref.name;
      var args = ref.args;

    try {
      return Promise.resolve(Fireworker._exposed[name].apply(null, args));
    } catch (e) {
      return Promise.reject(e);
    }
  };

  Fireworker.prototype.authWithCustomToken = function authWithCustomToken (ref) {
      var url = ref.url;
      var authToken = ref.authToken;
      var options = ref.options;

    return createRef(url).authWithCustomToken(authToken, options);
  };

  Fireworker.prototype.unauth = function unauth (ref) {
      var url = ref.url;

    return createRef(url).unauth();
  };

  Fireworker.prototype.onAuth = function onAuth (ref) {
      var url = ref.url;
      var callbackId = ref.callbackId;

    var authCallback = this._callbacks[callbackId] = this._onAuthCallback.bind(this, callbackId);
    authCallback.cancel = this._offAuth.bind(this, url, authCallback);
    createRef(url).onAuth(authCallback);
  };

  Fireworker.prototype._offAuth = function _offAuth (url, authCallback) {
    createRef(url).offAuth(authCallback);
  };

  Fireworker.prototype._onAuthCallback = function _onAuthCallback (callbackId, auth) {
    this._send({msg: 'callback', id: callbackId, args: [auth]});
  };

  Fireworker.prototype.set = function set (ref) {
      var url = ref.url;
      var value = ref.value;

    return createRef(url).set(value);
  };

  Fireworker.prototype.update = function update (ref) {
      var url = ref.url;
      var value = ref.value;

    return createRef(url).update(value);
  };

  Fireworker.prototype.on = function on (ref) {
      var listenerKey = ref.listenerKey;
      var url = ref.url;
      var spec = ref.spec;
      var eventType = ref.eventType;
      var callbackId = ref.callbackId;
      var options = ref.options;

    options = options || {};
    if (options.sync) { options.branch = new Branch(); }
    var snapshotCallback = this._callbacks[callbackId] =
      this._onSnapshotCallback.bind(this, callbackId, options);
    snapshotCallback.listenerKey = listenerKey;
    snapshotCallback.eventType = eventType;
    snapshotCallback.cancel = this.off.bind(this, {listenerKey: listenerKey, url: url, spec: spec, eventType: eventType, callbackId: callbackId});
    var cancelCallback = this._onCancelCallback.bind(this, callbackId);
    createRef(url, spec).on(eventType, snapshotCallback, cancelCallback);
    if (options.sync) { options.omitValue = true; }
  };

  Fireworker.prototype.off = function off (ref) {
      var this$1 = this;
      var listenerKey = ref.listenerKey;
      var url = ref.url;
      var spec = ref.spec;
      var eventType = ref.eventType;
      var callbackId = ref.callbackId;

    var snapshotCallback;
    if (callbackId) {
      // Callback IDs will not be reused across on() calls, so it's safe to just delete it.
      snapshotCallback = this._callbacks[callbackId];
      delete this._callbacks[callbackId];
    } else {
      for (var i = 0, list = Object.keys(this._callbacks); i < list.length; i += 1) {
        var key = list[i];

          if (!this$1._callbacks.hasOwnProperty(key)) { continue; }
        var callback = this$1._callbacks[key];
        if (callback.listenerKey === listenerKey &&
            (!eventType || callback.eventType === eventType)) {
          delete this$1._callbacks[key];
        }
      }
    }
    createRef(url, spec).off(eventType, snapshotCallback);
  };

  Fireworker.prototype._onSnapshotCallback = function _onSnapshotCallback (callbackId, options, snapshot) {
      var this$1 = this;

    if (options.sync && options.rest) {
      var path = decodeURIComponent(
        snapshot.ref().toString().replace(/.*?:\/\/[^/]*/, '').replace(/\/$/, ''));
      var value;
      try {
        value = normalizeFirebaseValue(snapshot.val());
      } catch (e) {
        options.branch.set(null);
        this._send({
          msg: 'callback', id: callbackId,
          args: [null, {path: path, exists: snapshot.exists(), valueError: errorToJson(e)}]
        });
      }
      var updates = this.options.branch.diff(value, path);
      for (var childPath in updates) {
        if (!updates.hasOwnProperty(childPath)) { continue; }
        this$1._send({
          msg: 'callback', id: callbackId,
          args: [null, {path: childPath, value: updates[childPath]}]
        });
      }
    } else {
      var snapshotJson = this._snapshotToJson(snapshot, options);
      if (options.sync) { options.branch.set(snapshotJson.value); }
      this._send({msg: 'callback', id: callbackId, args: [null, snapshotJson]});
      options.rest = true;
    }
  };

  Fireworker.prototype._onCancelCallback = function _onCancelCallback (callbackId, error) {
    delete this._callbacks[callbackId];
    this._send({msg: 'callback', id: callbackId, args: [errorToJson(error)]});
  };

  Fireworker.prototype.transaction = function transaction (ref$1) {
      var url = ref$1.url;
      var oldValue = ref$1.oldValue;
      var relativeUpdates = ref$1.relativeUpdates;

    var ref = createRef(url);
    var stale;

    return ref.transaction(function (value) {
      value = normalizeFirebaseValue(value);
      stale = !areEqualNormalFirebaseValues(value, oldValue);
      if (stale) { return; }
      if (relativeUpdates) {
        for (var relativePath in relativeUpdates) {
          if (!relativeUpdates.hasOwnProperty(relativePath)) { continue; }
          if (relativePath) {
            var segments = relativePath.split('/');
            if (value === undefined || value === null) { value = {}; }
            var object = value;
            for (var i = 0; i < segments.length - 1; i++) {
              var key = segments[i];
              var child = object[key];
              if (child === undefined || child === null) { child = object[key] = {}; }
              object = child;
            }
            object[segments[segments.length - 1]] = relativeUpdates[relativePath];
          } else {
            value = relativeUpdates[relativePath];
          }
        }
      }
      return value;
    }).then(function (result) {
      return !stale;
    }, function (error) {
      if (error.message === 'set' || error.message === 'disconnect') { return false; }
      return Promise.reject(error);
    });
  };

  Fireworker.prototype._snapshotToJson = function _snapshotToJson (snapshot, options) {
    var path =
      decodeURIComponent(snapshot.ref().toString().replace(/.*?:\/\/[^/]*/, '').replace(/\/$/, ''));
    if (options && options.omitValue) {
      return {path: path, exists: snapshot.exists(), writeSerial: this._lastWriteSerial};
    } else {
      try {
        return {
          path: path, value: normalizeFirebaseValue(snapshot.val()), writeSerial: this._lastWriteSerial
        };
      } catch (e) {
        return {
          path: path, exists: snapshot.exists(), valueError: errorToJson(e),
          writeSerial: this._lastWriteSerial
        };
      }
    }
  };

  Fireworker.prototype.onDisconnect = function onDisconnect (ref) {
      var url = ref.url;
      var method = ref.method;
      var value = ref.value;

    var onDisconnect = createRef(url).onDisconnect();
    return onDisconnect[method].call(onDisconnect, value);
  };

  Fireworker.prototype.simulate = function simulate (ref) {
      var token = ref.token;
      var method = ref.method;
      var url = ref.url;
      var args = ref.args;

    interceptConsoleLog();
    var simulatedFirebase;
    return (simulationQueue = simulationQueue.catch(function () {}).then(function () {
      simulationConsoleLogs = [];
      simulatedFirebase = createRef(url, null, 'permission_denied_simulator');
      simulatedFirebase.unauth();
      return simulatedFirebase.authWithCustomToken(token, function() {}, {remember: 'none'});
    }).then(function () {
      return simulatedFirebase[method].apply(simulatedFirebase, args);
    }).then(function () {
      return null;
    }, function (e) {
      var code = e.code || e.message;
      if (code && code.toLowerCase() === 'permission_denied') {
        return simulationConsoleLogs.join('\n');
      } else {
        return 'Got a different error in simulation: ' + e;
      }
    }));
  };

  Fireworker.expose = function expose (fn, name) {
    name = name || fn.name;
    if (!name) { throw new Error('Cannot expose a function with no name: ' + fn); }
    if (Fireworker._exposed.hasOwnProperty(name)) {
      throw new Error(("Function " + name + "() already exposed"));
    }
    if (Fireworker._firstMessageReceived) {
      throw new Error('Too late to expose function, worker in use');
    }
    Fireworker._exposed[name] = fn;
  };

  Fireworker._exposed = {};
  Fireworker._firstMessageReceived = false;


  function interceptConsoleLog() {
    if (consoleIntercepted) { return; }
    var originalLog = console.log;
    var lastTestIndex;
    console.log = function() {
      var message = Array.prototype.join.call(arguments, ' ');
      if (!/^(FIREBASE: \n?)+/.test(message)) { return originalLog.apply(console, arguments); }
      message = message
        .replace(/^(FIREBASE: \n?)+/, '')
        .replace(/^\s+([^.]*):(?:\.(read|write|validate):)?.*/g, function(match, g1, g2) {
          g2 = g2 || 'read';
          return ' ' + g2 + ' ' + g1;
        });
      if (/^\s+/.test(message)) {
        var match = message.match(/^\s+=> (true|false)/);
        if (match) {
          simulationConsoleLogs[lastTestIndex] =
            (match[1] === 'true' ? ' \u2713' : ' \u2717') + simulationConsoleLogs[lastTestIndex];
          lastTestIndex = undefined;
        } else {
          if (lastTestIndex === simulationConsoleLogs.length - 1) { simulationConsoleLogs.pop(); }
          simulationConsoleLogs.push(message);
          lastTestIndex = simulationConsoleLogs.length - 1;
        }
      } else if (/^\d+:\d+: /.test(message)) {
        simulationConsoleLogs.push('   ' + message);
      } else {
        if (lastTestIndex === simulationConsoleLogs.length - 1) { simulationConsoleLogs.pop(); }
        simulationConsoleLogs.push(message);
        lastTestIndex = undefined;
      }
    };
    consoleIntercepted = true;
  }

  function errorToJson(error) {
    var json = {name: error.name};
    var propertyNames = Object.getOwnPropertyNames(error);
    for (var i = 0, list = propertyNames; i < list.length; i += 1) {
      var propertyName = list[i];

      json[propertyName] = error[propertyName];
    }
    return json;
  }

  function createRef(url, spec, context) {
    try {
      var ref = new Firebase(url, context);
      if (spec) {
        switch (spec.by) {
          case '$key': ref = ref.orderByKey(); break;
          case '$value': ref = ref.orderByValue(); break;
          default: ref = ref.orderByChild(spec.by); break;
        }
        if (spec.at) { ref = ref.equalTo(spec.at); }
        else if (spec.from) { ref = ref.startAt(spec.from); }
        else if (spec.to) { ref = ref.endAt(spec.to); }
        if (spec.first) { ref = ref.limitToFirst(spec.first); }
        else if (spec.last) { ref = ref.limitToLast(spec.last); }
      }
      return ref;
    } catch (e) {
      e.extra = {url: url, spec: spec, context: context};
      throw e;
    }
  }

  function normalizeFirebaseValue(value) {
    if (Array.isArray(value)) {
      var normalValue = {};
      for (var i = 0; i < value.length; i++) {
        var item = value[i];
        if (item === undefined || item === null) { continue; }
        normalValue[i] = normalizeFirebaseValue(item);
      }
      return normalValue;
    }
    if (value instanceof Object) {
      for (var key in value) {
        if (value.hasOwnProperty(key)) { value[key] = normalizeFirebaseValue(value[key]); }
      }
    }
    return value;
  }


  function areEqualNormalFirebaseValues(a, b) {
    if (a === b) { return true; }
    if (!(typeof a === 'object' && typeof b === 'object')) { return false; }
    for (var key in a) {
      if (!a.hasOwnProperty(key) || !b.hasOwnProperty(key)) { return false; }
      if (!areEqualNormalFirebaseValues(a[key], b[key])) { return false; }
    }
    for (var key$1 in b) {
      if (!a.hasOwnProperty(key$1) || !b.hasOwnProperty(key$1)) { return false; }
    }
    return true;
  }

  function acceptConnections() {
    if (typeof onconnect !== 'undefined') {
      self.onconnect = function(event) {
        fireworkers.push(new Fireworker(event.ports[0]));
      };
    } else {
      fireworkers.push(new Fireworker(self));
    }
    self.localStorage.flushPending();
  }

  var CONNECTION_CHECK_INTERVAL = 60 * 1000;
  var lastConnectionCheck = Date.now();
  setInterval(function findAbandonedConnections() {
    var now = Date.now(), gap = now - lastConnectionCheck - CONNECTION_CHECK_INTERVAL;
    lastConnectionCheck = now;
    fireworkers.forEach(function (worker) {
      if (!worker) { return; }
      if (gap >= 1000 && worker.lastTouched <= now - gap) { worker.lastTouched += gap; }
      if (now - worker.lastTouched >= 3 * CONNECTION_CHECK_INTERVAL) { worker.destroy(); }
    });
    var k;
    while ((k = fireworkers.indexOf(null)) >= 0) { fireworkers.splice(k, 1); }
  }, CONNECTION_CHECK_INTERVAL);

  self.Fireworker = Fireworker;
  self.window = self;
  acceptConnections();

}());

//# sourceMappingURL=worker.js.map