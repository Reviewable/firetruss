(function (global, factory) {
	typeof exports === 'object' && typeof module !== 'undefined' ? module.exports = factory(require('lodash'), require('vue')) :
	typeof define === 'function' && define.amd ? define(['lodash', 'vue'], factory) :
	(global.Truss = factory(global._,global.Vue));
}(this, (function (_,Vue) { 'use strict';

	_ = 'default' in _ ? _['default'] : _;
	Vue = 'default' in Vue ? Vue['default'] : Vue;

	/* globals window */

	var earlyDigestPending;
	var bareDigest = function() {
	  earlyDigestPending = true;
	};


	var angularProxy = {
	  active: typeof window !== 'undefined' && window.angular,
	  debounceDigest: function debounceDigest(wait) {
	    if (wait) {
	      angularProxy.digest = _.debounce(bareDigest, wait);
	    } else {
	      angularProxy.digest = bareDigest;
	    }
	  }
	};
	['digest', 'watch', 'defineModule'].forEach(function (method) {angularProxy[method] = noop;});

	if (angularProxy.active) {
	  angularProxy.digest = bareDigest;
	  angularProxy.watch = function() {throw new Error('Angular watch proxy not yet initialized');};
	  window.angular.module('firetruss', []).run(['$rootScope', function($rootScope) {
	    bareDigest = $rootScope.$evalAsync.bind($rootScope);
	    if (earlyDigestPending) { bareDigest(); }
	    angularProxy.watch = $rootScope.$watch.bind($rootScope);
	  }]);
	  angularProxy.defineModule = function(Truss) {
	    window.angular.module('firetruss').constant('Truss', Truss);
	  };
	}

	function noop() {}

	var SERVER_TIMESTAMP = Object.freeze({'.sv': 'timestamp'});

	function escapeKey(key) {
	  if (!key) { return key; }
	  return key.toString().replace(/[\\\.\$\#\[\]\/]/g, function(char) {
	    return '\\' + char.charCodeAt(0).toString(16);
	  });
	}

	function unescapeKey(key) {
	  if (!key) { return key; }
	  return key.toString().replace(/\\[0-9a-f]{2}/gi, function(code) {
	    return String.fromCharCode(parseInt(code.slice(1), 16));
	  });
	}

	function wrapPromiseCallback(callback) {
	  return function() {
	    try {
	      return Promise.resolve(callback.apply(this, arguments));
	    } catch (e) {
	      return Promise.reject(e);
	    }
	  };
	}

	function joinPath() {
	  var segments = [];
	  for (var i = 0, list = arguments; i < list.length; i += 1) {
	    var segment = list[i];

	    if (segment.charAt(0) === '/') { segments.splice(0, segments.length); }
	    segments.push(segment);
	  }
	  if (segments[0] === '/') { segments[0] = ''; }
	  return segments.join('/');
	}


	var pathMatchers = {};
	var maxNumPathMatchers = 1000;


	var PathMatcher = function PathMatcher(pattern) {
	  var this$1 = this;

	  this.variables = [];
	  var prefixMatch = _.endsWith(pattern, '/$*');
	  if (prefixMatch) { pattern = pattern.slice(0, -3); }
	  var pathTemplate = pattern.replace(/\/\$[^\/]*/g, function (match) {
	    if (match.length > 1) { this$1.variables.push(match.slice(1)); }
	    return '\u0001';
	  });
	  Object.freeze(this.variables);
	  if (/[$-.?[-^{|}]/.test(pathTemplate)) {
	    throw new Error('Path pattern has unescaped keys: ' + pattern);
	  }
	  this._regex = new RegExp(
	    '^' + pathTemplate.replace(/\u0001/g, '/([^/]+)') + (prefixMatch ? '($|/)' : '$'));
	  this._parentRegex = new RegExp(
	    '^' + (pathTemplate.replace(/\/[^/]*$/, '').replace(/\u0001/g, '/([^/]+)') || '/') + '$');
	};

	PathMatcher.prototype.match = function match (path) {
	    var this$1 = this;

	  this._regex.lastIndex = 0;
	  var match = this._regex.exec(path);
	  if (!match) { return; }
	  var bindings = {};
	  for (var i = 0; i < this.variables.length; i++) {
	    bindings[this$1.variables[i]] = unescapeKey(match[i + 1]);
	  }
	  return bindings;
	};

	PathMatcher.prototype.test = function test (path) {
	  return this._regex.test(path);
	};

	PathMatcher.prototype.testParent = function testParent (path) {
	  return this._parentRegex.test(path);
	};

	PathMatcher.prototype.toString = function toString () {
	  return this._regex.toString();
	};


	function makePathMatcher(pattern) {
	  var matcher = pathMatchers[pattern];
	  if (!matcher) {
	    matcher = new PathMatcher(pattern);
	    // Minimal pseudo-LRU behavior, since we don't expect to actually fill up the cache.
	    if (_.size(pathMatchers) === maxNumPathMatchers) { delete pathMatchers[_.keys(pathMatchers)[0]]; }
	    pathMatchers[pattern] = matcher;
	  }
	  return matcher;
	}

	// jshint browser:true

	var MIN_WORKER_VERSION = '0.4.0';


	var Snapshot = function Snapshot(ref) {
	  var path = ref.path;
	  var value = ref.value;
	  var valueError = ref.valueError;
	  var exists = ref.exists;

	  this._path = path;
	  this._value = value;
	  this._valueError = errorFromJson(valueError);
	  this._exists = value === undefined ? exists || false : value !== null;
	};

	var prototypeAccessors$1 = { path: {},exists: {},value: {},key: {} };

	prototypeAccessors$1.path.get = function () {
	  return this._path;
	};

	prototypeAccessors$1.exists.get = function () {
	  return this._exists;
	};

	prototypeAccessors$1.value.get = function () {
	  this._checkValue();
	  return this._value;
	};

	prototypeAccessors$1.key.get = function () {
	  if (this._key === undefined) { this._key = unescapeKey(this._path.replace(/.*\//, '')); }
	  return this._key;
	};

	Snapshot.prototype._checkValue = function _checkValue () {
	  if (this._valueError) { throw this._valueError; }
	  if (this._value === undefined) { throw new Error('Value omitted from snapshot'); }
	};

	Object.defineProperties( Snapshot.prototype, prototypeAccessors$1 );


	var Bridge = function Bridge(webWorker) {
	  var this$1 = this;

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
	  this._port.onmessage = this._receive.bind(this);
	  window.addEventListener('unload', function () {this$1._send({msg: 'destroy'});});
	  setInterval(function () {this$1._send({msg: 'ping'});}, 60 * 1000);
	};

	Bridge.prototype.init = function init (webWorker) {
	  var items = [];
	  try {
	    var storage = window.localStorage || window.sessionStorage;
	    if (!storage) { return; }
	    for (var i = 0; i < storage.length; i++) {
	      var key = storage.key(i);
	      items.push({key: key, value: storage.getItem(key)});
	    }
	  } catch (e) {
	    // Some browsers don't like us accessing local storage -- nothing we can do.
	  }
	  return this._send({msg: 'init', storage: items}).then(function (response) {
	    var workerVersion = response.version.match(/^(\d+)\.(\d+)\.(\d+)(-.*)?$/);
	    if (workerVersion) {
	      var minVersion = MIN_WORKER_VERSION.match(/^(\d+)\.(\d+)\.(\d+)(-.*)?$/);
	      // Major version must match precisely, minor and patch must be greater than or equal.
	      var sufficient = workerVersion[1] === minVersion[1] && (
	        workerVersion[2] > minVersion[2] ||
	        workerVersion[2] === minVersion[2] && workerVersion[3] >= minVersion[3]
	      );
	      if (!sufficient) { return Promise.reject(new Error(
	        "Incompatible Firetruss worker version: " + (response.version) + " " +
	        "(" + MIN_WORKER_VERSION + " or better required)"
	      )); }
	    }
	    return response;
	  });
	};

	Bridge.prototype.suspend = function suspend (suspended) {
	  if (suspended === undefined) { suspended = true; }
	  if (this._suspended === suspended) { return; }
	  this._suspended = suspended;
	  if (!suspended) {
	    this._receiveMessages(this._inboundMessages);
	    this._inboundMessages = [];
	    if (this._outboundMessages.length) { Promise.resolve().then(this._flushMessageQueue); }
	  }
	};

	Bridge.prototype.debugPermissionDeniedErrors = function debugPermissionDeniedErrors (simulatedTokenGenerator, maxSimulationDuration, callFilter) {
	  this._simulatedTokenGenerator = simulatedTokenGenerator;
	  if (maxSimulationDuration !== undefined) { this._maxSimulationDuration = maxSimulationDuration; }
	  this._simulatedCallFilter = callFilter || function() {return true;};
	};

	Bridge.prototype.enableLogging = function enableLogging (fn) {
	  if (fn) {
	    if (fn === true) { fn = console.log.bind(console); }
	    this._log = fn;
	  } else {
	    this._log = _.noop;
	  }
	};

	Bridge.prototype._send = function _send (message) {
	    var this$1 = this;

	  message.id = ++this._idCounter;
	  var promise;
	  if (message.oneWay) {
	    promise = Promise.resolve();
	  } else {
	    promise = new Promise(function (resolve, reject) {
	      this$1._deferreds[message.id] = {resolve: resolve, reject: reject};
	    });
	    var deferred = this._deferreds[message.id];
	    deferred.promise = promise;
	    promise.sent = new Promise(function (resolve) {
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
	};

	Bridge.prototype._flushMessageQueue = function _flushMessageQueue () {
	  this._port.postMessage(this._outboundMessages);
	  this._outboundMessages = [];
	};

	Bridge.prototype._receive = function _receive (event) {
	  if (this._suspended) {
	    this._inboundMessages = this._inboundMessages.concat(event.data);
	  } else {
	    this._receiveMessages(event.data);
	  }
	};

	Bridge.prototype._receiveMessages = function _receiveMessages (messages) {
	    var this$1 = this;

	  for (var i = 0, list = messages; i < list.length; i += 1) {
	    var message = list[i];

	      this$1._log('recv:', message);
	    var fn = this$1[message.msg];
	    if (typeof fn !== 'function') { throw new Error('Unknown message: ' + message.msg); }
	    fn.call(this$1, message);
	  }
	};

	Bridge.prototype.bindExposedFunction = function bindExposedFunction (name) {
	  return (function() {
	    return this._send({msg: 'call', name: name, args: Array.prototype.slice.call(arguments)});
	  }).bind(this);
	};

	Bridge.prototype.resolve = function resolve (message) {
	  var deferred = this._deferreds[message.id];
	  if (!deferred) { throw new Error('Received resolution to inexistent Firebase call'); }
	  delete this._deferreds[message.id];
	  deferred.resolve(message.result);
	};

	Bridge.prototype.reject = function reject (message) {
	  var deferred = this._deferreds[message.id];
	  if (!deferred) { throw new Error('Received rejection of inexistent Firebase call'); }
	  delete this._deferreds[message.id];
	  deferred.reject(errorFromJson(message.error, deferred.params));
	};

	Bridge.prototype.probeError = function probeError (error) {
	  var code = error.code || error.message;
	  if (error.params && code && code.toLowerCase() === 'permission_denied') {
	    return this._simulateCall(error.params).then(function (securityTrace) {
	      if (securityTrace) { error.permissionDeniedDetails = securityTrace; }
	    });
	  } else {
	    return Promise.resolve();
	  }
	};

	Bridge.prototype._simulateCall = function _simulateCall (props) {
	    var this$1 = this;

	  if (!(this._simulatedTokenGenerator && this._maxSimulationDuration > 0)) {
	    return Promise.resolve();
	  }
	  var simulatedCalls = [];
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
	  var auth = this.getAuth(getUrlRoot(props.url));
	  var simulationPromise = this._simulatedTokenGenerator(auth && auth.uid).then(function (token) {
	    return Promise.all(simulatedCalls.map(function (message) {
	      message.msg = 'simulate';
	      message.token = token;
	      return this$1._send(message);
	    }));
	  }).then(function (securityTraces) {
	    if (securityTraces.every(function (trace) { return trace === null; })) {
	      return 'Unable to reproduce error in simulation';
	    }
	    return securityTraces.filter(function (trace) { return trace; }).join('\n\n');
	  }).catch(function (e) {
	    return 'Error running simulation: ' + e;
	  });
	  var timeoutPromise = new Promise(function (resolve) {
	    setTimeout(resolve.bind(null, 'Simulated call timed out'), this$1._maxSimulationDuration);
	  });
	  return Promise.race([simulationPromise, timeoutPromise]);
	};

	Bridge.prototype.updateLocalStorage = function updateLocalStorage (items) {
	  try {
	    var storage = window.localStorage || window.sessionStorage;
	    for (var item in items) {
	      if (item.value === null) {
	        storage.removeItem(item.key);
	      } else {
	        storage.setItem(item.key, item.value);
	      }
	    }
	  } catch (e) {
	    // If we're denied access, there's nothing we can do.
	  }
	};

	Bridge.prototype.trackServer = function trackServer (rootUrl) {
	  if (this._servers.hasOwnProperty(rootUrl)) { return; }
	  var server = this._servers[rootUrl] = {authListeners: []};
	  var authCallbackId = this._registerCallback(this._authCallback.bind(this, server));
	  this._send({msg: 'onAuth', url: rootUrl, callbackId: authCallbackId});
	};

	Bridge.prototype._authCallback = function _authCallback (server, auth) {
	  server.auth = auth;
	  for (var i = 0, list = server.authListeners; i < list.length; i += 1) {
	      var listener = list[i];

	      listener(auth);
	    }
	};

	Bridge.prototype.onAuth = function onAuth (rootUrl, callback, context) {
	  var listener = callback.bind(context);
	  listener.callback = callback;
	  listener.context = context;
	  this._servers[rootUrl].authListeners.push(listener);
	  listener(this.getAuth(rootUrl));
	};

	Bridge.prototype.offAuth = function offAuth (rootUrl, callback, context) {
	  var authListeners = this._servers[rootUrl].authListeners;
	  for (var i = 0; i < authListeners.length; i++) {
	    var listener = authListeners[i];
	    if (listener.callback === callback && listener.context === context) {
	      authListeners.splice(i, 1);
	      break;
	    }
	  }
	};

	Bridge.prototype.getAuth = function getAuth (rootUrl) {
	  return this._servers[rootUrl].auth;
	};

	Bridge.prototype.authWithCustomToken = function authWithCustomToken (url, authToken, options) {
	  return this._send({msg: 'authWithCustomToken', url: url, authToken: authToken, options: options});
	};

	Bridge.prototype.unauth = function unauth (url) {
	  return this._send({msg: 'unauth', url: url});
	};

	Bridge.prototype.set = function set (url, value, writeSerial) {return this._send({msg: 'set', url: url, value: value, writeSerial: writeSerial});};
	Bridge.prototype.update = function update (url, value, writeSerial) {return this._send({msg: 'update', url: url, value: value, writeSerial: writeSerial});};

	Bridge.prototype.on = function on (listenerKey, url, spec, eventType, snapshotCallback, cancelCallback, context, options) {
	  var handle = {
	    listenerKey: listenerKey, eventType: eventType, snapshotCallback: snapshotCallback, cancelCallback: cancelCallback, context: context,
	    params: {msg: 'on', listenerKey: listenerKey, url: url, spec: spec, eventType: eventType, options: options}
	  };
	  var callback = this._onCallback.bind(this, handle);
	  this._registerCallback(callback, handle);
	  // Keep multiple IDs to allow the same snapshotCallback to be reused.
	  snapshotCallback.__callbackIds = snapshotCallback.__callbackIds || [];
	  snapshotCallback.__callbackIds.push(handle.id);
	  this._send({
	    msg: 'on', listenerKey: listenerKey, url: url, spec: spec, eventType: eventType, callbackId: handle.id, options: options
	  }).catch(function (error) {
	    callback(error);
	  });
	};

	Bridge.prototype.off = function off (listenerKey, url, spec, eventType, snapshotCallback, context) {
	    var this$1 = this;

	  var idsToDeregister = [];
	  var callbackId;
	  if (snapshotCallback) {
	    callbackId = this._findAndRemoveCallbackId(
	      snapshotCallback,
	      function (handle) { return handle.listenerKey === listenerKey && handle.eventType === eventType &&
	        handle.context === context; }
	    );
	    if (!callbackId) { return Promise.resolve(); }// no-op, never registered or already deregistered
	    idsToDeregister.push(callbackId);
	  } else {
	    for (var i = 0, list = Object.keys(this._callbacks); i < list.length; i += 1) {
	      var id = list[i];

	        var handle = this$1._callbacks[id];
	      if (handle.listenerKey === listenerKey && (!eventType || handle.eventType === eventType)) {
	        idsToDeregister.push(id);
	      }
	    }
	  }
	  // Nullify callbacks first, then deregister after off() is complete.We don't want any
	  // callbacks in flight from the worker to be invoked while the off() is processing, but we don't
	  // want them to throw an exception either.
	  for (var i$1 = 0, list$1 = idsToDeregister; i$1 < list$1.length; i$1 += 1) {
	      var id$1 = list$1[i$1];

	      this$1._nullifyCallback(id$1);
	    }
	  return this._send({msg: 'off', listenerKey: listenerKey, url: url, spec: spec, eventType: eventType, callbackId: callbackId}).then(function () {
	    for (var i = 0, list = idsToDeregister; i < list.length; i += 1) {
	        var id = list[i];

	        this$1._deregisterCallback(id);
	      }
	  });
	};

	Bridge.prototype._onCallback = function _onCallback (handle, error, snapshotJson) {
	  if (error) {
	    this._deregisterCallback(handle.id);
	    var e = errorFromJson(error, handle.params);
	    if (handle.cancelCallback) {
	      handle.cancelCallback.call(handle.context, e);
	    } else {
	      console.error(e);
	    }
	  } else {
	    handle.snapshotCallback.call(handle.context, new Snapshot(snapshotJson));
	  }
	};

	Bridge.prototype.transaction = function transaction (url, oldValue, relativeUpdates) {
	  return this._send({msg: 'transaction', url: url, oldValue: oldValue, relativeUpdates: relativeUpdates});
	};

	Bridge.prototype.onDisconnect = function onDisconnect (url, method, value) {
	  return this._send({msg: 'onDisconnect', url: url, method: method, value: value});
	};

	Bridge.prototype.bounceConnection = function bounceConnection () {
	  return this._send({msg: 'bounceConnection'});
	};

	Bridge.prototype.callback = function callback (ref) {
	    var id = ref.id;
	    var args = ref.args;

	  var handle = this._callbacks[id];
	  if (!handle) { throw new Error('Unregistered callback: ' + id); }
	  handle.callback.apply(null, args);
	};

	Bridge.prototype._registerCallback = function _registerCallback (callback, handle) {
	  handle = handle || {};
	  handle.callback = callback;
	  handle.id = "cb" + (++this._idCounter);
	  this._callbacks[handle.id] = handle;
	  return handle.id;
	};

	Bridge.prototype._nullifyCallback = function _nullifyCallback (id) {
	  this._callbacks[id].callback = noop$1;
	};

	Bridge.prototype._deregisterCallback = function _deregisterCallback (id) {
	  delete this._callbacks[id];
	};

	Bridge.prototype._findAndRemoveCallbackId = function _findAndRemoveCallbackId (callback, predicate) {
	    var this$1 = this;

	  if (!callback.__callbackIds) { return; }
	  var i = 0;
	  while (i < callback.__callbackIds.length) {
	    var id = callback.__callbackIds[i];
	    var handle = this$1._callbacks[id];
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
	};

	function noop$1() {}

	function errorFromJson(json, params) {
	  if (!json || json instanceof Error) { return json; }
	  var error = new Error(json.message);
	  error.params = params;
	  for (var propertyName in json) {
	    if (propertyName === 'message' || !json.hasOwnProperty(propertyName)) { continue; }
	    try {
	      error[propertyName] = json[propertyName];
	    } catch (e) {
	      e.extra = {propertyName: propertyName};
	      throw e;
	    }
	  }
	  return error;
	}

	function getUrlRoot(url) {
	  var k = url.indexOf('/', 8);
	  return k >= 8 ? url.slice(0, k) : url;
	}

	var EMPTY_ANNOTATIONS = {};
	Object.freeze(EMPTY_ANNOTATIONS);


	var Handle = function Handle(tree, path, annotations) {
	  this._tree = tree;
	  this._path = path.replace(/^\/*/, '/').replace(/\/$/, '');
	  if (annotations) {
	    this._annotations = annotations;
	    Object.freeze(annotations);
	  }
	};

	var prototypeAccessors$3 = { $ref: {},key: {},path: {},_pathPrefix: {},parent: {},annotations: {} };

	prototypeAccessors$3.$ref.get = function () {return this;};
	prototypeAccessors$3.key.get = function () {
	  if (!this._key) { this._key = unescapeKey(this._path.replace(/.*\//, '')); }
	  return this._key;
	};
	prototypeAccessors$3.path.get = function () {return this._path;};
	prototypeAccessors$3._pathPrefix.get = function () {return this._path === '/' ? '' : this._path;};
	prototypeAccessors$3.parent.get = function () {
	  return new Reference(this._tree, this._path.replace(/\/[^/]*$/, ''), this._annotations);
	};

	prototypeAccessors$3.annotations.get = function () {
	  return this._annotations || EMPTY_ANNOTATIONS;
	};

	Handle.prototype.child = function child () {
	  if (!arguments.length) { return this; }
	  var segments = [];
	  for (var i = 0, list = arguments; i < list.length; i += 1) {
	    var key = list[i];

	      if (key === undefined || key === null) { return; }
	    segments.push(escapeKey(key));
	  }
	  return new Reference(
	    this._tree, ((this._pathPrefix) + "/" + (segments.join('/'))),
	    this._annotations
	  );
	};

	Handle.prototype.children = function children () {
	    var arguments$1 = arguments;
	    var this$1 = this;

	  if (!arguments.length) { return this; }
	  var escapedKeys = [];
	  for (var i = 0; i < arguments.length; i++) {
	    var arg = arguments$1[i];
	    if (_.isArray(arg)) {
	      var mapping = {};
	      var subPath = (this$1._pathPrefix) + "/" + (escapedKeys.join('/'));
	      var rest = _.slice(arguments$1, i + 1);
	      for (var i$1 = 0, list = arg; i$1 < list.length; i$1 += 1) {
	        var key = list[i$1];

	          var subRef =
	          new Reference(this$1._tree, (subPath + "/" + (escapeKey(key))), this$1._annotations);
	        var subMapping = subRef.children.apply(subRef, rest);
	        if (subMapping) { mapping[key] = subMapping; }
	      }
	      if (_.isEmpty(mapping)) { return; }
	      return mapping;
	    } else {
	      if (arg === undefined || arg === null) { return; }
	      escapedKeys.push(escapeKey(arg));
	    }
	  }
	  return new Reference(
	    this._tree, ((this._pathPrefix) + "/" + (escapedKeys.join('/'))), this._annotations);
	};

	Handle.prototype.peek = function peek (callback) {
	  return this._tree.truss.peek(this, callback);
	};

	Handle.prototype.match = function match (pattern) {
	  return makePathMatcher(pattern).match(this.path);
	};

	Handle.prototype.isEqual = function isEqual (that) {
	  if (!(that instanceof Handle)) { return false; }
	  return this._tree === that._tree && this.toString() === that.toString();
	};

	Handle.prototype.belongsTo = function belongsTo (truss) {
	  return this._tree.truss === truss;
	};

	Object.defineProperties( Handle.prototype, prototypeAccessors$3 );


	var Query = (function (Handle) {
	  function Query(tree, path, spec, annotations) {
	    Handle.call(this, tree, path, annotations);
	    this._spec = this._copyAndValidateSpec(spec);
	  }

	  if ( Handle ) Query.__proto__ = Handle;
	  Query.prototype = Object.create( Handle && Handle.prototype );
	  Query.prototype.constructor = Query;

	  var prototypeAccessors$1 = { ready: {},constraints: {} };

	  // Vue-bound
	  prototypeAccessors$1.ready.get = function () {
	    return this._tree.isQueryReady(this);
	  };

	  prototypeAccessors$1.constraints.get = function () {
	    return this._spec;
	  };

	  Query.prototype.annotate = function annotate (annotations) {
	    return new Query(
	      this._tree, this._path, this._spec, _.extend({}, this._annotations, annotations));
	  };

	  Query.prototype._copyAndValidateSpec = function _copyAndValidateSpec (spec) {
	    if (!spec.by) { throw new Error('Query needs "by" clause: ' + JSON.stringify(spec)); }
	    if (('at' in spec) + ('from' in spec) + ('to' in spec) > 1) {
	      throw new Error(
	        'Query must contain at most one of "at", "from", or "to" clauses: ' + JSON.stringify(spec));
	    }
	    if (('first' in spec) + ('last' in spec) > 1) {
	      throw new Error(
	        'Query must contain at most one of "first" or "last" clauses: ' + JSON.stringify(spec));
	    }
	    if (!_.some(['at', 'from', 'to', 'first', 'last'], function (clause) { return clause in spec; })) {
	      throw new Error(
	        'Query must contain at least one of "at", "from", "to", "first", or "last" clauses: ' +
	        JSON.stringify(spec));
	    }
	    spec = _.clone(spec);
	    if (spec.by !== '$key' && spec.by !== '$value') {
	      if (!(spec.by instanceof Reference)) {
	        throw new Error('Query "by" value must be a reference: ' + spec.by);
	      }
	      var childPath = spec.by.toString();
	      if (!_.startsWith(childPath, this._path)) {
	        throw new Error(
	          'Query "by" value must be a descendant of target reference: ' + spec.by);
	      }
	      childPath = childPath.slice(this._path.length).replace(/^\/?/, '');
	      if (childPath.indexOf('/') === -1) {
	        throw new Error(
	          'Query "by" value must not be a direct child of target reference: ' + spec.by);
	      }
	      spec.by = childPath.replace(/.*?\//, '');
	    }
	    Object.freeze(spec);
	    return spec;
	  };


	  Query.prototype.toString = function toString () {
	    if (!this._string) {
	      var queryTerms = _(this._spec)
	        .map(function (value, key) { return (key + "=" + (encodeURIComponent(JSON.stringify(value)))); })
	        .sortBy()
	        .join('&');
	      this._string = (this._path) + "?" + queryTerms;
	    }
	    return this._string;
	  };

	  Object.defineProperties( Query.prototype, prototypeAccessors$1 );

	  return Query;
	}(Handle));


	// jshint latedef:false
	var Reference = (function (Handle) {
	  function Reference(tree, path, annotations) {
	    Handle.call(this, tree, path, annotations);
	  }

	  if ( Handle ) Reference.__proto__ = Handle;
	  Reference.prototype = Object.create( Handle && Handle.prototype );
	  Reference.prototype.constructor = Reference;

	  var prototypeAccessors$2 = { ready: {},value: {} };

	  prototypeAccessors$2.ready.get = function () {return this._tree.isReferenceReady(this);};  // Vue-bound
	  prototypeAccessors$2.value.get = function () {return this._tree.getObject(this.path);};  // Vue-bound
	  Reference.prototype.toString = function toString () {return this._path;};

	  Reference.prototype.annotate = function annotate (annotations) {
	    return new Reference(this._tree, this._path, _.extend({}, this._annotations, annotations));
	  };

	  Reference.prototype.query = function query (spec) {
	    return new Query(this._tree, this._path, spec);
	  };

	  Reference.prototype.set = function set (value) {
	    return this._tree.update(this, 'set', ( obj = {}, obj[this.path] = value, obj ));
	    var obj;
	  };

	  Reference.prototype.update = function update (values) {
	    return this._tree.update(this, 'update', values);
	  };

	  Reference.prototype.override = function override (value) {
	    return this._tree.update(this, 'override', ( obj = {}, obj[this.path] = value, obj ));
	    var obj;
	  };

	  Reference.prototype.commit = function commit (updateFunction) {
	    return this._tree.commit(this, updateFunction);
	  };

	  Object.defineProperties( Reference.prototype, prototypeAccessors$2 );

	  return Reference;
	}(Handle));

	var Connector = function Connector(scope, connections, tree, method, refs) {
	  var this$1 = this;

	  Object.freeze(connections);
	  this._scope = scope;
	  this._connections = connections;
	  this._tree = tree;
	  this._method = method;
	  this._refs = refs || {};
	  this._subConnectors = {};
	  this._currentDescriptors = {};
	  this._disconnects = {};
	  this._vue = new Vue({data: _.mapValues(connections, _.constant(undefined))});

	  this._linkScopeProperties();

	  _.each(connections, function (descriptor, key) {
	    if (_.isFunction(descriptor)) {
	      this$1._bindComputedConnection(key, descriptor);
	    } else {
	      this$1._connect(key, descriptor);
	    }
	  });

	  if (angularProxy.active && scope && scope.$on && scope.$$id) {
	    scope.$on('$destroy', function () {this$1.destroy();});
	  }
	};

	var prototypeAccessors$2 = { ready: {},at: {} };

	prototypeAccessors$2.ready.get = function () {
	    var this$1 = this;

	  return _.every(this._currentDescriptors, function (descriptor, key) {
	    if (!descriptor) { return false; }
	    if (descriptor instanceof Handle) { return descriptor.ready; }
	    return this$1._subConnectors[key].ready;
	  });
	};

	prototypeAccessors$2.at.get = function () {
	  return this._refs;
	};

	Connector.prototype.destroy = function destroy () {
	    var this$1 = this;

	  this._unlinkScopeProperties();
	  _.each(this._angularUnwatches, function (unwatch) {unwatch();});
	  _.each(this._connections, function (descriptor, key) {this$1._disconnect(key);});
	  this._vue.$destroy();
	};

	Connector.prototype._linkScopeProperties = function _linkScopeProperties () {
	    var this$1 = this;

	  if (!this._scope) { return; }
	  for (var key in this._connections) {
	    if (key in this$1._scope) {
	      throw new Error(("Property already defined on connection target: " + key));
	    }
	  }
	  Object.defineProperties(this._scope, _.mapValues(this._connections, function (descriptor, key) { return ({
	    configurable: true, enumerable: true, get: function () { return this$1._vue[key]; }
	  }); }));
	};

	Connector.prototype._unlinkScopeProperties = function _unlinkScopeProperties () {
	    var this$1 = this;

	  if (!this._scope) { return; }
	  _.each(this._connections, function (descriptor, key) {
	    delete this$1._scope[key];
	  });
	};

	Connector.prototype._bindComputedConnection = function _bindComputedConnection (key, fn) {
	  var getter = this._computeConnection.bind(this, fn);
	  var update = this._updateComputedConnection.bind(this, key, fn);
	  // Use this._vue.$watch instead of truss.watch here so that we can disable the immediate
	  // callback if we'll get one from Angular anyway.
	  this._vue.$watch(getter, update, {immediate: !angularProxy.active, deep: true});
	  if (angularProxy.active) {
	    if (!this._angularUnwatches) { this._angularUnwatches = []; }
	    this._angularUnwatches.push(angularProxy.watch(getter, update, true));
	  }
	};

	Connector.prototype._computeConnection = function _computeConnection (fn) {
	  return flattenRefs(fn.call(this._scope));
	};

	Connector.prototype._updateComputedConnection = function _updateComputedConnection (key, fn) {
	  var newDescriptor = fn(this._scope);
	  var oldDescriptor = this._currentDescriptors[key];
	  if (oldDescriptor === newDescriptor ||
	      newDescriptor instanceof Handle && newDescriptor.isEqual(oldDescriptor)) { return; }
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
	  this._currentDescriptors[key] = newDescriptor;
	};

	Connector.prototype._updateConnections = function _updateConnections (connections) {
	    var this$1 = this;

	  _.each(connections, function (descriptor, key) {
	    this$1._updateComputedConnection(key, descriptor);
	  });
	  _.each(this._connections, function (descriptor, key) {
	    if (!_.has(connections, key)) { this$1._updateComputedConnection(key); }
	  });
	  this._connections = connections;
	};

	Connector.prototype._connect = function _connect (key, descriptor) {
	    var this$1 = this;

	  this._currentDescriptors[key] = descriptor;
	  if (!descriptor) { return; }
	  if (descriptor instanceof Reference) {
	    this._refs[key] = descriptor;
	    var updateFn = this._scope ? this._updateScopeRef.bind(this, key) : null;
	    this._disconnects[key] = this._tree.connectReference(descriptor, updateFn, this._method);
	  } else if (descriptor instanceof Query) {
	    this._refs[key] = descriptor;
	    var updateFn$1 = this._scope ? this._updateScopeQuery.bind(this, key) : null;
	    this._disconnects[key] = this._tree.connectQuery(descriptor, updateFn$1, this._method);
	  } else {
	    var subScope = {}, subRefs = {};
	    this._refs[key] = subRefs;
	    var subConnector = this._subConnectors[key] =
	      new Connector(subScope, descriptor, this._tree, this._method, subRefs);
	    if (this._scope) {
	      // Use a truss.watch here instead of this._vue.$watch so that the "immediate" execution
	      // actually takes place after we've captured the unwatch function, in case the subConnector
	      // is ready immediately.
	      var unwatch = this._disconnects[key] = this._tree.truss.watch(
	        function () { return subConnector.ready; },
	        function (subReady) {
	          if (!subReady) { return; }
	          unwatch();
	          delete this$1._disconnects[key];
	          Vue.set(this$1._vue, key, subScope);
	          angularProxy.digest();
	        }
	      );
	    }
	  }
	};

	Connector.prototype._disconnect = function _disconnect (key) {
	  delete this._refs[key];
	  if (this._scope) { this._updateScopeRef(key, undefined); }
	  if (_.has(this._subConnectors, key)) {
	    this._subConnectors[key].destroy();
	    delete this._subConnectors[key];
	  }
	  if (this._disconnects[key]) { this._disconnects[key](); }
	  delete this._disconnects[key];
	  delete this._currentDescriptors[key];
	};

	Connector.prototype._updateScopeRef = function _updateScopeRef (key, value) {
	  if (this._vue[key] !== value) {
	    Vue.set(this._vue, key, value);
	    angularProxy.digest();
	  }
	};

	Connector.prototype._updateScopeQuery = function _updateScopeQuery (key, childKeys) {
	    var this$1 = this;

	  var changed = false;
	  if (!this._vue[key]) {
	    Vue.set(this._vue, key, {});
	    changed = true;
	  }
	  var subScope = this._vue[key];
	  for (var childKey in subScope) {
	    if (!subScope.hasOwnProperty(childKey)) { continue; }
	    if (!_.contains(childKeys, childKey)) {
	      Vue.delete(subScope, childKey);
	      changed = true;
	    }
	  }
	  var object;
	  for (var i = 0, list = this._currentDescriptors[key].path.split('/'); i < list.length; i += 1) {
	    var segment = list[i];

	      object = segment ? object[segment] : this$1._tree.root;
	  }
	  for (var i$1 = 0, list$1 = childKeys; i$1 < list$1.length; i$1 += 1) {
	    var childKey$1 = list$1[i$1];

	      if (subScope.hasOwnProperty(childKey$1)) { continue; }
	    Vue.set(subScope, childKey$1, object[childKey$1]);
	    changed = true;
	  }
	  if (changed) { angularProxy.digest(); }
	};

	Object.defineProperties( Connector.prototype, prototypeAccessors$2 );

	function flattenRefs(refs) {
	  if (!refs) { return; }
	  if (refs instanceof Handle) { return refs.toString(); }
	  return _.mapValues(refs, flattenRefs);
	}

	var INTERCEPT_KEYS = [
	  'read', 'write', 'auth', 'set', 'update', 'commit', 'connect', 'peek', 'all'
	];

	var EMPTY_ARRAY = [];


	var SlowHandle = function SlowHandle(operation, delay, callback) {
	  this._operation = operation;
	  this._delay = delay;
	  this._callback = callback;
	  this._fired = false;
	};

	SlowHandle.prototype.initiate = function initiate () {
	    var this$1 = this;

	  this.cancel();
	  this._fired = false;
	  var elapsed = Date.now() - this._operation._startTimestamp;
	  this._timeoutId = setTimeout(this._delay - elapsed, function () {
	    this$1._fired = true;
	    this$1._callback(this$1._operation);
	  });
	};

	SlowHandle.prototype.cancel = function cancel () {
	  if (this._fired) { this._callback(this._operation); }
	  if (this._timeoutId) { clearTimeout(this._timeoutId); }
	};


	var Operation = function Operation(type, method, target) {
	  this._type = type;
	  this._method = method;
	  this._target = target;
	  this._ready = false;
	  this._running = false;
	  this._ended = false;
	  this._tries = 0;
	  this._startTimestamp = Date.now();
	  this._slowHandles = [];
	};

	var prototypeAccessors$4 = { type: {},method: {},target: {},ready: {},running: {},ended: {},tries: {},error: {} };

	prototypeAccessors$4.type.get = function () {return this._type;};
	prototypeAccessors$4.method.get = function () {return this._method;};
	prototypeAccessors$4.target.get = function () {return this._target;};
	prototypeAccessors$4.ready.get = function () {return this._ready;};
	prototypeAccessors$4.running.get = function () {return this._running;};
	prototypeAccessors$4.ended.get = function () {return this._ended;};
	prototypeAccessors$4.tries.get = function () {return this._tries;};
	prototypeAccessors$4.error.get = function () {return this._error;};

	Operation.prototype.onSlow = function onSlow (delay, callback) {
	  var handle = new SlowHandle(this, delay, callback);
	  this._slowHandles.push(handle);
	  handle.initiate();
	};

	Operation.prototype._setRunning = function _setRunning (value) {
	  this._running = value;
	};

	Operation.prototype._setEnded = function _setEnded (value) {
	  this._ended = value;
	};

	Operation.prototype._markReady = function _markReady () {
	  this._ready = true;
	  this._tries = 0;
	  _.each(this._slowHandles, function (handle) { return handle.cancel(); });
	};

	Operation.prototype._clearReady = function _clearReady () {
	  this._ready = false;
	  this._startTimestamp = Date.now();
	  _.each(this._slowHandles, function (handle) { return handle.initiate(); });
	};

	Operation.prototype._incrementTries = function _incrementTries () {
	  this._tries++;
	};

	Object.defineProperties( Operation.prototype, prototypeAccessors$4 );


	var Dispatcher = function Dispatcher(bridge) {
	  this._bridge = bridge;
	  this._callbacks = {};
	};

	Dispatcher.prototype.intercept = function intercept (interceptKey, callbacks) {
	  if (!_.contains(INTERCEPT_KEYS, interceptKey)) {
	    throw new Error('Unknown intercept operation type: ' + interceptKey);
	  }
	  var badCallbackKeys =
	    _.difference(_.keys(callbacks), ['onBefore', 'onAfter', 'onError', 'onFailure']);
	  if (badCallbackKeys.length) {
	    throw new Error('Unknown intercept callback types: ' + badCallbackKeys.join(', '));
	  }
	  var wrappedCallbacks = {
	    onBefore: this._addCallback('onBefore', interceptKey, callbacks.onBefore),
	    onAfter: this._addCallback('onAfter', interceptKey, callbacks.onAfter),
	    onError: this._addCallback('onError', interceptKey, callbacks.onError),
	    onFailure: this._addCallback('onFailure', interceptKey, callbacks.onFailure)
	  };
	  return this._removeCallbacks.bind(this, interceptKey, wrappedCallbacks);
	};

	Dispatcher.prototype._addCallback = function _addCallback (stage, interceptKey, callback) {
	  if (!callback) { return; }
	  var key = this._getCallbacksKey(stage, interceptKey);
	  var wrappedCallback = wrapPromiseCallback(callback);
	  (this._callbacks[key] || (this._callbacks[key] = [])).push(wrappedCallback);
	  return wrappedCallback;
	};

	Dispatcher.prototype._removeCallback = function _removeCallback (stage, interceptKey, wrappedCallback) {
	  if (!wrappedCallback) { return; }
	  var key = this._getCallbacksKey(stage, interceptKey);
	  if (this._callbacks[key]) { _.pull(this._callbacks[key], wrappedCallback); }
	};

	Dispatcher.prototype._removeCallbacks = function _removeCallbacks (interceptKey, wrappedCallbacks) {
	    var this$1 = this;

	  _.each(wrappedCallbacks, function (wrappedCallback, stage) {
	    this$1._removeCallback(stage, interceptKey, wrappedCallback);
	  });
	};

	Dispatcher.prototype._getCallbacks = function _getCallbacks (stage, operationType, method) {
	  return [].concat(
	    this._callbacks[this._getCallbacksKey(stage, method)] || EMPTY_ARRAY,
	    this._callbacks[this._getCallbacksKey(stage, operationType)] || EMPTY_ARRAY,
	    this._callbacks[this._getCallbacksKey(stage, 'all')] || EMPTY_ARRAY
	  );
	};

	Dispatcher.prototype._getCallbacksKey = function _getCallbacksKey (stage, interceptKey) {
	  return (stage + "_" + interceptKey);
	};

	Dispatcher.prototype.execute = function execute (operationType, method, target, executor) {
	    var this$1 = this;

	  executor = wrapPromiseCallback(executor);
	  var operation = this.createOperation(operationType, method, target);
	  return this.begin(operation).then(function () {
	    var executeWithRetries = function () {
	      return executor().catch(function (e) { return this$1._retryOrEnd(operation, e).then(executeWithRetries); });
	    };
	    return executeWithRetries();
	  }).then(function (result) { return this$1.end(operation).then(function () { return result; }); });
	};

	Dispatcher.prototype.createOperation = function createOperation (operationType, method, target) {
	  return new Operation(operationType, method, target);
	};

	Dispatcher.prototype.begin = function begin (operation) {
	    var this$1 = this;

	  return Promise.all(_.map(
	    this._getCallbacks('onBefore', operation.type, operation.method),
	    function (onBefore) { return onBefore(operation); }
	  )).then(function () {
	    if (!operation.ended) { operation._setRunning(true); }
	  }, function (e) { return this$1.end(operation, e); });
	};

	Dispatcher.prototype.markReady = function markReady (operation) {
	  operation._markReady();
	};

	Dispatcher.prototype.clearReady = function clearReady (operation) {
	  operation._clearReady();
	};

	Dispatcher.prototype.retry = function retry (operation, error) {
	  operation._incrementTries();
	  operation._error = error;
	  return Promise.all(_.map(
	    this._getCallbacks('onError', operation.type, operation.method),
	    function (onError) { return onError(operation, error); }
	  )).then(function (results) {
	    var retrying = _.some(results);
	    if (retrying) { delete operation._error; }
	    return retrying;
	  });
	};

	Dispatcher.prototype._retryOrEnd = function _retryOrEnd (operation, error) {
	    var this$1 = this;

	  return this.retry(operation, error).then(function (result) {
	    if (!result) { return this$1.end(operation, error); }
	  }, function (e) { return this$1.end(operation, e); });
	};

	Dispatcher.prototype.end = function end (operation, error) {
	    var this$1 = this;

	  if (operation.ended) { return; }
	  operation._setRunning(false);
	  operation._setEnded(true);
	  if (error) { operation._error = error; }
	  return Promise.all(_.map(
	    this._getCallbacks('onAfter', operation.type, operation.method),
	    function (onAfter) { return onAfter(operation); }
	  )).then(
	    function () { return this$1._afterEnd(operation); },
	    function (e) {
	      operation._error = e;
	      return this$1._afterEnd(operation);
	    }
	  );
	};

	Dispatcher.prototype._afterEnd = function _afterEnd (operation) {
	  this.markReady(operation);
	  if (operation.error) {
	    var onFailureCallbacks = this._getCallbacks('onFailure', operation.type, operation.method);
	    return this._bridge.probeError(operation.error).then(function () {
	      if (onFailureCallbacks) {
	        setTimeout(function () {
	          _.each(onFailureCallbacks, function (onFailure) { return onFailure(operation); });
	        }, 0);
	      }
	      return Promise.reject(operation.error);
	    });
	  }
	};

	var ALPHABET = '-0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ_abcdefghijklmnopqrstuvwxyz';

	var KeyGenerator = function KeyGenerator() {
	  this._lastUniqueKeyTime = 0;
	  this._lastRandomValues = [];
	};

	KeyGenerator.prototype.generateUniqueKey = function generateUniqueKey (now) {
	    var this$1 = this;

	  now = now || Date.now();
	  var chars = new Array(20);
	  var prefix = now;
	  for (var i = 7; i >= 0; i--) {
	    chars[i] = ALPHABET.charAt(prefix & 0x3f);
	    prefix = Math.floor(prefix / 64);
	  }
	  if (now === this._lastUniqueKeyTime) {
	    var i$1 = 11;
	    while (i$1 >= 0 && this._lastRandomValues[i$1] === 63) {
	      this$1._lastRandomValues[i$1] = 0;
	      i$1 -= 1;
	    }
	    if (i$1 === -1) {
	      throw new Error('Internal assertion failure: ran out of unique IDs for this millisecond');
	    }
	    this._lastRandomValues[i$1] += 1;
	  } else {
	    this._lastUniqueKeyTime = now;
	    for (var i$2 = 0; i$2 < 12; i$2++) {
	      // Make sure to leave some space for incrementing in the top nibble.
	      this$1._lastRandomValues[i$2] = Math.floor(Math.random() * (i$2 ? 64 : 16));
	    }
	  }
	  for (var i$3 = 0; i$3 < 12; i$3++) {
	    chars[i$3 + 8] = ALPHABET[this$1._lastRandomValues[i$3]];
	  }
	  return chars.join('');
	};

	var MetaTree = function MetaTree(rootUrl, bridge) {
	  this._rootUrl = rootUrl;
	  this._bridge = bridge;
	  this._vue = new Vue({data: {$root: {
	    connected: undefined, timeOffset: 0, user: undefined, userid: undefined,
	    updateNowAtIntervals: function updateNowAtIntervals(name, intervalMillis) {
	      var this$1 = this;

	      if (this.hasOwnProperty(name)) { throw new Error(("Property \"" + name + "\" already defined")); }
	      Vue.set(this, name, Date.now() + this.timeOffset);
	      setInterval(function () {
	        this$1[name] = Date.now() + this$1.timeOffset;
	      }, intervalMillis);
	    }
	  }}});

	  if (angularProxy.active) {
	    this._vue.$watch('$data', angularProxy.digest, {deep: true});
	  }

	  bridge.onAuth(rootUrl, this._handleAuthChange, this);

	  this._connectInfoProperty('serverTimeOffset', 'timeOffset');
	  this._connectInfoProperty('connected', 'connected');
	};

	var prototypeAccessors$5 = { root: {} };

	prototypeAccessors$5.root.get = function () {
	  return this._vue.$data.$root;
	};

	MetaTree.prototype.destroy = function destroy () {
	  this._bridge.offAuth(this._rootUrl, this._handleAuthChange, this);
	  this._vue.$destroy();
	};

	MetaTree.prototype._handleAuthChange = function _handleAuthChange (user) {
	  this.root.user = user;
	  this.root.userid = user && user.uid;
	};

	MetaTree.prototype._connectInfoProperty = function _connectInfoProperty (property, attribute) {
	    var this$1 = this;

	  var propertyUrl = (this._rootUrl) + "/.info/" + property;
	  this._bridge.on(propertyUrl, propertyUrl, null, 'value', function (snap) {
	    this$1.root[attribute] = snap.value;
	  });
	};

	Object.defineProperties( MetaTree.prototype, prototypeAccessors$5 );

	var QueryHandler = function QueryHandler(coupler, query) {
	  this._coupler = coupler;
	  this._query = query;
	  this._listeners = [];
	  this._keys = [];
	  this._url = this._coupler._rootUrl + query.path;
	  this._segments = query.path.split('/');
	  this._listening = false;
	  this.ready = false;
	};

	QueryHandler.prototype.attach = function attach (operation, keysCallback) {
	  this._listen();
	  this._listeners.push({operation: operation, keysCallback: keysCallback});
	  keysCallback(this._keys);
	};

	QueryHandler.prototype.detach = function detach (operation) {
	  var k = _.findIndex(this._listeners, {operation: operation});
	  if (k >= 0) { this._listeners.splice(k, 1); }
	  return this._listeners.length;
	};

	QueryHandler.prototype._listen = function _listen () {
	  if (this._listening) { return; }
	  this._coupler._bridge.on(
	    this._query.toString(), this._url, this._query.constraints, 'value',
	    this._handleSnapshot, this._handleError.bind(this._query.path), this, {sync: true});
	  this._listening = true;
	};

	QueryHandler.prototype.destroy = function destroy () {
	    var this$1 = this;

	  this._coupler._bridge.off(
	    this._query.toString(), this._url, this._query.constraints, 'value', this._handleSnapshot,
	    this);
	  this._listening = false;
	  this.ready = false;
	  angularProxy.digest();
	  for (var i = 0, list = this._keys; i < list.length; i += 1) {
	    var key = list[i];

	      this$1._coupler._decoupleSegments(this$1._segments.concat(key));
	  }
	};

	QueryHandler.prototype._handleSnapshot = function _handleSnapshot (snap) {
	    var this$1 = this;

	  // Order is important here: first couple any new subpaths so _handleSnapshot will update the
	  // tree, then tell the client to update its keys, pulling values from the tree.
	  if (!this._listeners.length || !this._listening) { return; }
	  var updatedKeys = this._updateKeys(snap);
	  this._coupler._applySnapshot(snap);
	  if (!this.ready) {
	    this.ready = true;
	    angularProxy.digest();
	    for (var i = 0, list = this._listeners; i < list.length; i += 1) {
	      var listener = list[i];

	        this$1._coupler._dispatcher.markReady(listener.operation);
	    }
	  }
	  if (updatedKeys) {
	    for (var i$1 = 0, list$1 = this._listeners; i$1 < list$1.length; i$1 += 1) {
	        var listener$1 = list$1[i$1];

	        listener$1.keysCallback(updatedKeys);
	      }
	  }
	};

	QueryHandler.prototype._updateKeys = function _updateKeys (snap) {
	    var this$1 = this;

	  var updatedKeys;
	  if (snap.path === this._query.path) {
	    updatedKeys = _.keys(snap.value);
	    updatedKeys.sort();
	    if (_.isEqual(this._keys, updatedKeys)) {
	      updatedKeys = null;
	    } else {
	      for (var i = 0, list = _.difference(updatedKeys, this._keys); i < list.length; i += 1) {
	        var key = list[i];

	          this$1._coupler._coupleSegments(this$1._segments.concat(key));
	      }
	      for (var i$1 = 0, list$1 = _.difference(this._keys, updatedKeys); i$1 < list$1.length; i$1 += 1) {
	        var key$1 = list$1[i$1];

	          this$1._coupler._decoupleSegments(this$1._segments.concat(key$1));
	      }
	      this._keys = updatedKeys;
	    }
	  } else if (snap.path.replace(/\/[^/]+/, '') === this._query.path) {
	    var hasKey = _.contains(this._keys, snap.key);
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
	};

	QueryHandler.prototype._handleError = function _handleError (error) {
	    var this$1 = this;

	  if (!this._listeners.length || !this._listening) { return; }
	  this._listening = false;
	  Promise.all(_.map(this._listeners, function (listener) {
	    this$1._coupler._dispatcher.clearReady(listener.operation);
	    return this$1._coupler._dispatcher.retry(listener.operation, error).catch(function (e) {
	      listener.operation._disconnect(e);
	      return false;
	    });
	  })).then(function (results) {
	    if (_.some(results)) {
	      if (this$1._listeners.length) { this$1._listen(); }
	    } else {
	      for (var i = 0, list = this$1._listeners; i < list.length; i += 1) {
	          var listener = list[i];

	          listener.operation._disconnect(error);
	        }
	    }
	  });
	};


	var Node = function Node(coupler, path) {
	  this._coupler = coupler;
	  this.path = path;
	  this.url = this._coupler._rootUrl + path;
	  this.operations = [];
	  this.queryCount = 0;
	  this.listening = false;
	  this.ready = false;
	  this.children = {};
	};

	var prototypeAccessors$7 = { active: {},count: {} };

	prototypeAccessors$7.active.get = function () {
	  return this.count || this.queryCount;
	};

	prototypeAccessors$7.count.get = function () {
	  return this.operations.length;
	};

	Node.prototype.listen = function listen (skip) {
	    var this$1 = this;

	  if (!skip && this.count) {
	    if (this.listening) { return; }
	    _.each(this.operations, function (op) {this$1._coupler._dispatcher.clearReady(op);});
	    this._coupler._bridge.on(
	      this.url, this.url, null, 'value', this._handleSnapshot, this._handleError.bind(this),
	      this, {sync: true});
	    this.listening = true;
	  } else {
	    _.each(this.children, function (child) {child.listen();});
	  }
	};

	Node.prototype.unlisten = function unlisten (skip) {
	  if (!skip && this.listening) {
	    this._coupler._bridge.off(this.url, this.url, null, 'value', this._handleSnapshot, this);
	    this.listening = false;
	    this._forAllDescendants(function (node) {
	      if (node.ready) {
	        node.ready = false;
	        angularProxy.digest();
	      }
	    });
	  } else {
	    _.each(this.children, function (child) {child.unlisten();});
	  }
	};

	Node.prototype._handleSnapshot = function _handleSnapshot (snap) {
	    var this$1 = this;

	  if (!this.listening || !this._coupler.isTrunkCoupled(snap.path)) { return; }
	  this._coupler._applySnapshot(snap);
	  if (!this.ready && snap.path === this.path) {
	    this.ready = true;
	    angularProxy.digest();
	    this.unlisten(true);
	    this._forAllDescendants(function (node) {
	      for (var i = 0, list = this$1.operations; i < list.length; i += 1) {
	          var op = list[i];

	          this$1._coupler._dispatcher.markReady(op);
	        }
	    });
	  }
	};

	Node.prototype._handleError = function _handleError (error) {
	    var this$1 = this;

	  if (!this.count || !this.listening) { return; }
	  this.listening = false;
	  this._forAllDescendants(function (node) {
	    if (node.ready) {
	      node.ready = false;
	      angularProxy.digest();
	    }
	    for (var i = 0, list = this$1.operations; i < list.length; i += 1) {
	        var op = list[i];

	        this$1._coupler._dispatcher.clearReady(op);
	      }
	  });
	  return Promise.all(_.map(this.operations, function (op) {
	    return this$1._coupler._dispatcher.retry(op, error).catch(function (e) {
	      op._disconnect(e);
	      return false;
	    });
	  })).then(function (results) {
	    if (_.some(results)) {
	      if (this$1.count) { this$1.listen(); }
	    } else {
	      for (var i = 0, list = this$1.operations; i < list.length; i += 1) {
	          var op = list[i];

	          op._disconnect(error);
	        }
	      // Pulling all the operations will automatically get us listening on descendants.
	    }
	  });
	};

	Node.prototype._forAllDescendants = function _forAllDescendants (iteratee) {
	  iteratee(this);
	  _.each(this.children, function (child) { return child._forAllDescendants(iteratee); });
	};

	Node.prototype.collectCoupledDescendantPaths = function collectCoupledDescendantPaths (paths) {
	  if (!paths) { paths = {}; }
	  paths[this.path] = this.active;
	  if (!this.active) {
	    _.each(this.children, function (child) {child.collectCoupledDescendantPaths(paths);});
	  }
	  return paths;
	};

	Object.defineProperties( Node.prototype, prototypeAccessors$7 );


	var Coupler = function Coupler(rootUrl, bridge, dispatcher, applySnapshot, prunePath) {
	  this._rootUrl = rootUrl;
	  this._bridge = bridge;
	  this._dispatcher = dispatcher;
	  this._applySnapshot = applySnapshot;
	  this._prunePath = prunePath;
	  this._vue = new Vue({data: {root: new Node(this, '/'), queryHandlers: {}}});
	};

	var prototypeAccessors$1$2 = { _root: {},_queryHandlers: {} };

	prototypeAccessors$1$2._root.get = function () {return this._vue.root;};
	prototypeAccessors$1$2._queryHandlers.get = function () {return this._vue.queryHandlers;};

	Coupler.prototype.destroy = function destroy () {
	  _.each(this._queryHandlers, function (queryHandler) {queryHandler.destroy();});
	  this._root.unlisten();
	  this._vue.$destroy();
	};

	Coupler.prototype.couple = function couple (path, operation) {
	  return this._coupleSegments(path.split('/'), operation);
	};

	Coupler.prototype._coupleSegments = function _coupleSegments (segments, operation) {
	    var this$1 = this;

	  var node;
	  var superseded = !operation;
	  var ready = false;
	  for (var i = 0, list = segments; i < list.length; i += 1) {
	    var segment = list[i];

	      var child = segment ? node.children && node.children[segment] : this$1._root;
	    if (!child) {
	      child = new Node(this$1, ((node.path === '/' ? '' : node.path) + "/" + segment));
	      Vue.set(node.children, segment, child);
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
	    if (operation && ready) { this._dispatcher.markReady(operation); }
	  } else {
	    node.listen();// node will call unlisten() on descendants when ready
	  }
	};

	Coupler.prototype.decouple = function decouple (path, operation) {
	  return this._decoupleSegments(path.split('/'), operation);
	};

	Coupler.prototype._decoupleSegments = function _decoupleSegments (segments, operation) {
	    var this$1 = this;

	  var ancestors = [];
	  var node;
	  for (var i$1 = 0, list = segments; i$1 < list.length; i$1 += 1) {
	    var segment = list[i$1];

	      node = segment ? node.children && node.children[segment] : this$1._root;
	    if (!node) { break; }
	    ancestors.push(node);
	  }
	  if (!node || !(operation ? node.count : node.queryCount)) {
	    throw new Error(("Path not coupled: " + (segments.join('/'))));
	  }
	  if (operation) {
	    _.pull(node.operations, operation);
	  } else {
	    node.queryCount--;
	  }
	  if (operation && !node.count) {
	    // Ideally, we wouldn't resync the full values here since we probably already have the current
	    // value for all children.But making sure that's true is tricky in an async system (what if
	    // the node's value changes and the update crosses the 'off' call in transit?) and this
	    // situation should be sufficiently rare that the optimization is probably not worth it right
	    // now.
	    node.listen();
	    if (node.listening) { node.unlisten(); }
	  }
	  if (!node.active) {
	    var coupledDescendantPaths = node.collectCoupledDescendantPaths();
	    this._prunePath(segments.join('/'), coupledDescendantPaths);
	    for (var i = ancestors.length - 1; i > 0; i--) {
	      node = ancestors[i];
	      if (node === this$1._root || node.active || !_.isEmpty(node.children)) { break; }
	      Vue.delete(ancestors[i - 1].children, segments[i]);
	    }
	  }
	};

	Coupler.prototype.subscribe = function subscribe (query, operation, keysCallback) {
	  var queryHandler = this._queryHandlers[query.toString()];
	  if (!queryHandler) {
	    queryHandler = new QueryHandler(this, query);
	    Vue.set(this._queryHandlers, query.toString(), queryHandler);
	  }
	  queryHandler.attach(operation, keysCallback);
	 };

	Coupler.prototype.unsubscribe = function unsubscribe (query, operation) {
	  var queryHandler = this._queryHandlers[query.toString()];
	  if (queryHandler && !queryHandler.detach(operation)) {
	    queryHandler.destroy();
	    Vue.delete(this._queryHandlers, query.toString());
	  }
	};

	// Return whether the node at path or any ancestors are coupled.
	Coupler.prototype.isTrunkCoupled = function isTrunkCoupled (path) {
	    var this$1 = this;

	  var segments = path.split('/');
	  var node;
	  for (var i = 0, list = segments; i < list.length; i += 1) {
	    var segment = list[i];

	      node = segment ? node.children && node.children[segment] : this$1._root;
	    if (!node) { return false; }
	    if (node.active) { return true; }
	  }
	  return false;
	};

	Coupler.prototype.findCoupledDescendantPaths = function findCoupledDescendantPaths (path) {
	    var this$1 = this;

	  var segments = path.split('/');
	  var node;
	  for (var i = 0, list = segments; i < list.length; i += 1) {
	    var segment = list[i];

	      node = segment ? node.children && node.children[segment] : this$1._root;
	    if (!node) { break; }
	  }
	  return node ? node.collectCoupledDescendantPaths() : {};
	};

	Coupler.prototype.isSubtreeReady = function isSubtreeReady (path) {
	    var this$1 = this;

	  var segments = path.split('/');
	  var node;
	  for (var i = 0, list = segments; i < list.length; i += 1) {
	    var segment = list[i];

	      node = segment ? node.children && node.children[segment] : this$1._root;
	    if (!node) { return false; }
	    if (node.ready) { return true; }
	  }
	  return false;
	};

	Coupler.prototype.isQueryReady = function isQueryReady (query) {
	  var queryHandler = this._queryHandlers[query.toString()];
	  return queryHandler && queryHandler.ready;
	};

	Object.defineProperties( Coupler.prototype, prototypeAccessors$1$2 );

	var commonjsGlobal = typeof window !== 'undefined' ? window : typeof global !== 'undefined' ? global : typeof self !== 'undefined' ? self : {};





	function createCommonjsModule(fn, module) {
		return module = { exports: {} }, fn(module, module.exports), module.exports;
	}

	var performanceNow = createCommonjsModule(function (module) {
	// Generated by CoffeeScript 1.7.1
	(function() {
	  var getNanoSeconds, hrtime, loadTime;

	  if ((typeof performance !== "undefined" && performance !== null) && performance.now) {
	    module.exports = function() {
	      return performance.now();
	    };
	  } else if ((typeof process !== "undefined" && process !== null) && process.hrtime) {
	    module.exports = function() {
	      return (getNanoSeconds() - loadTime) / 1e6;
	    };
	    hrtime = process.hrtime;
	    getNanoSeconds = function() {
	      var hr;
	      hr = hrtime();
	      return hr[0] * 1e9 + hr[1];
	    };
	    loadTime = getNanoSeconds();
	  } else if (Date.now) {
	    module.exports = function() {
	      return Date.now() - loadTime;
	    };
	    loadTime = Date.now();
	  } else {
	    module.exports = function() {
	      return new Date().getTime() - loadTime;
	    };
	    loadTime = new Date().getTime();
	  }

	}).call(commonjsGlobal);
	});

	// These are defined separately for each object so they're not included in Value below.
	var RESERVED_VALUE_PROPERTY_NAMES = {
	  $truss: true, $parent: true, $key: true, $path: true, $ref:true,
	  $$touchThis: true, $$initializers: true, $$finalizers: true,
	  __ob__: true
	};

	var computedPropertyStats = {};


	var Value = function Value () {};

	var prototypeAccessors$8 = { $ref: {},$refs: {},$keys: {},$values: {},$root: {},$ready: {},$overridden: {} };

	prototypeAccessors$8.$ref.get = function () {
	  Object.defineProperty(this, '$ref', {value: new Reference(this.$truss._tree, this.$path)});
	  return this.$ref;
	};
	prototypeAccessors$8.$refs.get = function () {return this.$ref;};
	prototypeAccessors$8.$keys.get = function () {return _.keys(this);};
	prototypeAccessors$8.$values.get = function () {return _.values(this);};
	prototypeAccessors$8.$root.get = function () {return this.$truss.root;};// access indirectly to leave dependency trace
	prototypeAccessors$8.$ready.get = function () {return this.$ref.ready;};
	prototypeAccessors$8.$overridden.get = function () {return false;};

	Value.prototype.$watch = function $watch (subjectFn, callbackFn, options) {
	    var this$1 = this;

	  var unwatchAndRemoveDestructor;

	  var unwatch = this.$truss.watch(function () {
	    this$1.$$touchThis();
	    return subjectFn.call(this$1);
	  }, callbackFn.bind(this), options);

	  if (!this.$$finalizers) {
	    Object.defineProperty(this, '$$finalizers', {
	      value: [], writable: false, enumerable: false, configurable: false});
	  }
	  unwatchAndRemoveDestructor = function () {
	    unwatch();
	    _.pull(this$1.$$finalizers, unwatchAndRemoveDestructor);
	  };
	  this.$$finalizers.push(unwatchAndRemoveDestructor);
	  return unwatchAndRemoveDestructor;
	};

	Value.prototype.$set = function $set (value) {return this.$ref.set(value);};
	Value.prototype.$update = function $update (values) {return this.$ref.update(values);};
	Value.prototype.$override = function $override (values) {return this.$ref.override(values);};
	Value.prototype.$commit = function $commit (options, updateFn) {return this.$ref.commit(options, updateFn);};

	Object.defineProperties( Value.prototype, prototypeAccessors$8 );

	var ComputedPropertyStats = function ComputedPropertyStats(name) {
	  _.extend(this, {name: name, numRecomputes: 0, numUpdates: 0, runtime: 0});
	};

	var ErrorWrapper = function ErrorWrapper(error) {
	  this.error = error;
	};


	var Modeler = function Modeler(classes) {
	  var this$1 = this;

	  this._mounts = _(classes).uniq().map(function (Class) { return this$1._mountClass(Class); }).flatten().value();
	  var patterns = _.map(this._mounts, function (mount) { return mount.matcher.toString(); });
	  if (patterns.length !== _.uniq(patterns).length) {
	    var badPaths = _(patterns)
	      .groupBy()
	      .map(function (group, key) { return group.length === 1 ? null : key.replace(/\(\[\^\/\]\+\)/g, '$').slice(1, -1); })
	      .compact()
	      .value();
	    throw new Error('Paths have multiple mounted classes: ' + badPaths.join(', '));
	  }
	};

	var staticAccessors$2 = { computedPropertyStats: {} };

	Modeler.prototype.destroy = function destroy () {
	};

	Modeler.prototype._augmentClass = function _augmentClass (Class) {
	  var computedProperties;
	  var proto = Class.prototype;
	  while (proto && proto.constructor !== Object) {
	    for (var i = 0, list = Object.getOwnPropertyNames(proto); i < list.length; i += 1) {
	      var name = list[i];

	        var descriptor = Object.getOwnPropertyDescriptor(proto, name);
	      if (name.charAt(0) === '$') {
	        if (_.isEqual(descriptor, Object.getOwnPropertyDescriptor(Value.prototype, name))) {
	          continue;
	        }
	        throw new Error(("Property names starting with \"$\" are reserved: " + (Class.name) + "." + name));
	      }
	      if (descriptor.set) {
	        throw new Error(("Computed properties must not have a setter: " + (Class.name) + "." + name));
	      }
	      if (descriptor.get && !(computedProperties && computedProperties[name])) {
	        (computedProperties || (computedProperties = {}))[name] = {
	          name: name, fullName: ((proto.constructor.name) + "." + name), get: descriptor.get
	        };
	      }
	    }
	    proto = Object.getPrototypeOf(proto);
	  }
	  for (var i$1 = 0, list$1 = Object.getOwnPropertyNames(Value.prototype); i$1 < list$1.length; i$1 += 1) {
	    var name$1 = list$1[i$1];

	      if (name$1 === 'constructor' || Class.prototype.hasOwnProperty(name$1)) { continue; }
	    Object.defineProperty(
	      Class.prototype, name$1, Object.getOwnPropertyDescriptor(Value.prototype, name$1));
	  }
	  return computedProperties;
	};

	Modeler.prototype._mountClass = function _mountClass (Class) {
	  var computedProperties = this._augmentClass(Class);
	  var mounts = Class.$trussMount;
	  if (!mounts) { throw new Error(("Class " + (Class.name) + " lacks a $trussMount static property")); }
	  if (!_.isArray(mounts)) { mounts = [mounts]; }
	  return _.map(mounts, function (mount) {
	    if (_.isString(mount)) { mount = {path: mount}; }
	    var matcher = makePathMatcher(mount.path);
	    for (var i = 0, list = matcher.variables; i < list.length; i += 1) {
	      var variable = list[i];

	        if (variable === '$' || variable.charAt(1) === '$') {
	        throw new Error(("Invalid variable name: " + variable));
	      }
	      if (variable.charAt(0) === '$' && (
	          _.has(Value.prototype, variable) || RESERVED_VALUE_PROPERTY_NAMES[variable]
	      )) {
	        throw new Error(("Variable name conflicts with built-in property or method: " + variable));
	      }
	    }
	    var escapedKey = mount.path.match(/\/([^/]*)$/)[1];
	    if (mount.placeholder && escapedKey.charAt(0) === '$') {
	      throw new Error(
	        ("Class " + (Class.name) + " mounted at wildcard " + escapedKey + " cannot be a placeholder"));
	    }
	    return {Class: Class, matcher: matcher, computedProperties: computedProperties, escapedKey: escapedKey, placeholder: mount.placeholder};
	  });
	};

	/**
	 * Creates a Truss object and sets all its basic properties: path segment variables, user-defined
	 * properties, and computed properties.The latter two will be enumerable so that Vue will pick
	 * them up and make the reactive, so you should call _completeCreateObject once it's done so and
	 * before any Firebase properties are added.
	 */
	Modeler.prototype.createObject = function createObject (path, properties) {
	    var this$1 = this;

	  var Class = Value;
	  var computedProperties;
	  for (var i = 0, list = this._mounts; i < list.length; i += 1) {
	    var mount = list[i];

	      var match = mount.matcher.match(path);
	    if (match) {
	      Class = mount.Class;
	      computedProperties = mount.computedProperties;
	      for (var variable in match) {
	        properties[variable] = {
	          value: match[variable], writable: false, configurable: false, enumerable: false
	        };
	      }
	      break;
	    }
	  }

	  var object = new Class(properties.$truss.value);

	  if (computedProperties) {
	    _.each(computedProperties, function (prop) {
	      properties[prop.name] = this$1._buildComputedPropertyDescriptor(object, prop);
	    });
	  }

	  return object;
	};

	Modeler.prototype._buildComputedPropertyDescriptor = function _buildComputedPropertyDescriptor (object, prop) {
	  if (!computedPropertyStats[prop.fullName]) {
	    Object.defineProperty(computedPropertyStats, prop.fullName, {
	      value: new ComputedPropertyStats(prop.fullName), writable: false, enumerable: true,
	      configurable: false
	    });
	  }
	  var stats = computedPropertyStats[prop.fullName];

	  var value;
	  var writeAllowed = false;
	  var firstCallback = true;

	  if (!object.$$finalizers) {
	    Object.defineProperty(object, '$$finalizers', {
	      value: [], writable: false, enumerable: false, configurable: false});
	  }
	  if (!object.$$initializers) {
	    Object.defineProperty(object, '$$initializers', {
	      value: [], writable: false, enumerable: false, configurable: true});
	  }
	  object.$$initializers.push(function (vue) {
	    object.$$finalizers.push(
	      vue.$watch(computeValue.bind(object, prop, stats), function (newValue) {
	        if (firstCallback) {
	          stats.numUpdates += 1;
	          value = newValue;
	          firstCallback = false;
	        } else {
	          if (_.isEqual(value, newValue, isTrussValueEqual)) { return; }
	          stats.numUpdates += 1;
	          writeAllowed = true;
	          object[prop.name] = newValue;
	          writeAllowed = false;
	        }
	      }, {immediate: true})// use immediate:true since watcher will run computeValue anyway
	    );
	  });
	  return {
	    enumerable: true, configurable: true,
	    get: function() {
	      if (value instanceof ErrorWrapper) { throw value.error; }
	      return value;
	    },
	    set: function(newValue) {
	      if (!writeAllowed) { throw new Error(("You cannot set a computed property: " + (prop.name))); }
	      value = newValue;
	    }
	  };
	};

	Modeler.prototype.isPlaceholder = function isPlaceholder (path) {
	  // TODO: optimize by precomputing a single all-placeholder-paths regex
	  return _.some(this._mounts, function (mount) { return mount.placeholder && mount.matcher.test(path); });
	};

	Modeler.prototype.forEachPlaceholderChild = function forEachPlaceholderChild (path, iteratee) {
	  _.each(this._mounts, function (mount) {
	    if (mount.placeholder && mount.matcher.testParent(path)) {
	      iteratee(mount.escapedKey, mount.placeholder);
	    }
	  });
	};

	Modeler.prototype.checkVueObject = function checkVueObject (object, path) {
	    var this$1 = this;

	  for (var i = 0, list = Object.getOwnPropertyNames(object); i < list.length; i += 1) {
	    var key = list[i];

	      if (RESERVED_VALUE_PROPERTY_NAMES[key]) { continue; }
	    var descriptor = Object.getOwnPropertyDescriptor(object, key);
	    if ('value' in descriptor || !descriptor.get || !descriptor.set) {
	      throw new Error(("Firetruss object at " + path + " has a rogue property: " + key));
	    }
	    var value = object[key];
	    if (_.isObject(value)) { this$1.checkVueObject(value, joinPath(path, escapeKey(key))); }
	  }
	};

	staticAccessors$2.computedPropertyStats.get = function () {
	  return computedPropertyStats;
	};

	Object.defineProperties( Modeler, staticAccessors$2 );

	function computeValue(prop, stats) {
	  // jshint validthis: true
	  // Touch this object, since a failed access to a missing property doesn't get captured as a
	  // dependency.
	  this.$$touchThis();

	  var startTime = performanceNow();
	  try {
	    return prop.get.call(this);
	  } catch (e) {
	    return new ErrorWrapper(e);
	  } finally {
	    stats.runtime += performanceNow() - startTime;
	    stats.numRecomputes += 1;
	  }
	  // jshint validthis: false
	}

	function isTrussValueEqual(a, b) {
	  if (a && a.$truss || b && b.$truss) { return a === b; }
	}

	var Transaction = function Transaction(path, tree) {
	  this._path = path;
	  this._tree = tree;
	};

	var prototypeAccessors$6 = { currentValue: {},outcome: {},values: {} };

	prototypeAccessors$6.currentValue.get = function () {return this._tree.getObject(this._path);};
	prototypeAccessors$6.outcome.get = function () {return this._outcome;};
	prototypeAccessors$6.values.get = function () {return this._values;};

	Transaction.prototype._setOutcome = function _setOutcome (value) {
	  if (this._outcome) { throw new Error('Transaction already resolved with ' + this._outcome); }
	  this._outcome = value;
	};

	Transaction.prototype.abort = function abort () {
	  this._setOutcome('abort');
	};

	Transaction.prototype.cancel = function cancel () {
	  this._setOutcome('cancel');
	};

	Transaction.prototype.set = function set (value) {
	  if (value === undefined) { throw new Error('Invalid argument: undefined'); }
	  this._setOutcome('set');
	  this._values = {'': value};
	};

	Transaction.prototype.update = function update (values) {
	  if (values === undefined) { throw new Error('Invalid argument: undefined'); }
	  if (_.isEmpty(values)) { return this.cancel(); }
	  this._setOutcome('update');
	  this._values = values;
	};

	Object.defineProperties( Transaction.prototype, prototypeAccessors$6 );


	var Tree = function Tree(truss, rootUrl, bridge, dispatcher, classes) {
	  this._truss = truss;
	  this._rootUrl = rootUrl;
	  this._bridge = bridge;
	  this._dispatcher = dispatcher;
	  this._firebasePropertyEditAllowed = false;
	  this._writeSerial = 0;
	  this._localWrites = {};
	  this._localWriteTimestamp = null;
	  this._coupler = new Coupler(
	    rootUrl, bridge, dispatcher, this._integrateSnapshot.bind(this), this._prune.bind(this));
	  this._vue = new Vue({data: {$root: undefined}});
	  if (angularProxy.active) {
	    this._vue.$watch('$data', angularProxy.digest, {deep: true});
	  }
	  this._modeler = new Modeler(classes);
	  this._vue.$data.$root = this._createObject('/', '');
	  this._completeCreateObject(this.root);
	  this._plantPlaceholders(this.root, '/');
	};

	var prototypeAccessors$1$1 = { root: {},truss: {} };
	var staticAccessors$1 = { computedPropertyStats: {} };

	prototypeAccessors$1$1.root.get = function () {
	  return this._vue.$data.$root;
	};

	prototypeAccessors$1$1.truss.get = function () {
	  return this._truss;
	};

	Tree.prototype.destroy = function destroy () {
	  this._coupler.destroy();
	  this._modeler.destroy();
	  this._vue.$destroy();
	};

	Tree.prototype.connectReference = function connectReference (ref, valueCallback, method) {
	    var this$1 = this;

	  this._checkHandle(ref);
	  var operation = this._dispatcher.createOperation('read', method, ref);
	  var unwatch;
	  if (valueCallback) {
	    var segments = _(ref.path).split('/').map(function (segment) { return unescapeKey(segment); }).value();
	    unwatch = this._vue.$watch(
	      this.getObject.bind(this, segments), valueCallback, {immediate: true});
	  }
	  operation._disconnect = this._disconnectReference.bind(this, ref, operation, unwatch);
	  this._dispatcher.begin(operation).then(function () {
	    if (operation.running) { this$1._coupler.couple(ref.path, operation); }
	  }).catch(function (e) {});// ignore exception, let onFailure handlers deal with it
	  return operation._disconnect;
	};

	Tree.prototype._disconnectReference = function _disconnectReference (ref, operation, unwatch, error) {
	  if (operation._disconnected) { return; }
	  operation._disconnected = true;
	  if (unwatch) { unwatch(); }
	  this._coupler.decouple(ref.path, operation);// will call back to _prune if necessary
	  this._dispatcher.end(operation, error).catch(function (e) {});
	};

	Tree.prototype.isReferenceReady = function isReferenceReady (ref) {
	  this._checkHandle(ref);
	  return this._coupler.isSubtreeReady(ref.path);
	};

	Tree.prototype.connectQuery = function connectQuery (query, keysCallback, method) {
	    var this$1 = this;

	  this._checkHandle(query);
	  var operation = this._dispatcher.createOperation('read', method, query);
	  operation._disconnect = this._disconnectQuery.bind(this, query, operation);
	  this._dispatcher.begin(operation).then(function () {
	    if (operation.running) { this$1._coupler.subscribe(query, operation, keysCallback); }
	  }).catch(function (e) {});// ignore exception, let onFailure handlers deal with it
	  return operation._disconnect;
	};

	Tree.prototype._disconnectQuery = function _disconnectQuery (query, operation, error) {
	  if (operation._disconnected) { return; }
	  operation._disconnected = true;
	  this._coupler.unsubscribe(query, operation);// will call back to _prune if necessary
	  this._dispatcher.end(operation, error).catch(function (e) {});
	};

	Tree.prototype.isQueryReady = function isQueryReady (query) {
	  return this._coupler.isQueryReady(query);
	};

	Tree.prototype._checkHandle = function _checkHandle (handle) {
	  if (!handle.belongsTo(this._truss)) {
	    throw new Error('Reference belongs to another Truss instance');
	  }
	};

	Tree.prototype.update = function update (ref, method, values) {
	    var this$1 = this;

	  var numValues = _.size(values);
	  if (!numValues) { return; }
	  if (method === 'update' || method === 'override') {
	    checkUpdateHasOnlyDescendantsWithNoOverlap(ref.path, values);
	  }
	  this._applyLocalWrite(values, method === 'override');
	  if (method === 'override') { return Promise.resolve(); }
	  var url = this._rootUrl + this._extractCommonPathPrefix(values);
	  return this._dispatcher.execute('write', method, ref, function () {
	    if (numValues === 1) {
	      return this$1._bridge.set(url, values[''], this$1._writeSerial);
	    } else {
	      return this$1._bridge.update(url, values, this$1._writeSerial);
	    }
	  });
	};

	Tree.prototype.commit = function commit (ref, updateFunction) {
	    var this$1 = this;

	  var tries = 0;

	  var attemptTransaction = function () {
	    if (tries++ >= 25) { return Promise.reject(new Error('maxretry')); }
	    var txn = new Transaction();
	    try {
	      updateFunction(txn);
	    } catch (e) {
	      return Promise.reject(e);
	    }
	    var oldValue = toFirebaseJson(this$1.getObject(ref.path));
	    switch (txn.outcome) {
	      case 'abort': return;
	      case 'cancel':
	        break;
	      case 'set':
	        this$1._applyLocalWrite(( obj = {}, obj[ref.path] = txn.values[''], obj ));
	      var obj;
	        break;
	      case 'update':
	        checkUpdateHasOnlyDescendantsWithNoOverlap(ref.path, txn.values, true);
	        this$1._applyLocalWrite(txn.values);
	        break;
	      default:
	        throw new Error('Invalid transaction outcome: ' + (txn.outcome || 'none'));
	    }
	    return this$1._bridge.transaction(
	      this$1._rootUrl + ref.path, oldValue, txn.values
	    ).then(function (committed) {
	      if (!committed) { return attemptTransaction(); }
	      return txn;
	    });
	  };

	  return this._truss.peek(ref, function () {
	    return this$1._dispatcher.execute('write', 'commit', ref, attemptTransaction);
	  });
	};

	Tree.prototype._applyLocalWrite = function _applyLocalWrite (values, override) {
	    var this$1 = this;

	  // TODO: correctly apply local writes that impact queries.Currently, a local write will update
	  // any objects currently selected by a query, but won't add or remove results.
	  this._writeSerial++;
	  this._localWriteTimestamp = this._truss.now;
	  _.each(values, function (value, path) {
	    var coupledDescendantPaths = this$1._coupler.findCoupledDescendantPaths(path);
	    if (_.isEmpty(coupledDescendantPaths)) { return; }
	    var offset = (path === '/' ? 0 : path.length) + 1;
	    for (var i = 0, list = coupledDescendantPaths; i < list.length; i += 1) {
	      var descendantPath = list[i];

	        var subPath = descendantPath.slice(offset);
	      var subValue = value;
	      if (subPath) {
	        var segments = subPath.split('/');
	        for (var i$1 = 0, list$1 = segments; i$1 < list$1.length; i$1 += 1) {
	          var segment = list$1[i$1];

	            subValue = subValue[unescapeKey(segment)];
	          if (subValue === undefined) { break; }
	        }
	      }
	      if (subValue === undefined || subValue === null) {
	        this$1._prune(subPath);
	      } else {
	        var key = unescapeKey(_.last(descendantPath.split('/')));
	        this$1._plantValue(
	          descendantPath, key, subValue, this$1._scaffoldAncestors(descendantPath), false,
	          override
	        );
	      }
	      if (!override) { this$1._localWrites[descendantPath] = this$1._writeSerial; }
	    }
	  });
	};

	Tree.prototype._extractCommonPathPrefix = function _extractCommonPathPrefix (values) {
	  var prefixSegments;
	  _.each(values, function (value, path) {
	    var segments = path === '/' ? [''] : path.split('/');
	    if (prefixSegments) {
	      var firstMismatchIndex = 0;
	      var maxIndex = Math.min(prefixSegments.length, segments.length);
	      while (firstMismatchIndex < maxIndex &&
	             prefixSegments[firstMismatchIndex] === segments[firstMismatchIndex]) {
	        firstMismatchIndex++;
	      }
	      prefixSegments = prefixSegments.slice(0, firstMismatchIndex);
	      if (!prefixSegments.length) { return false; }
	    } else {
	      prefixSegments = segments;
	    }
	  });
	  var pathPrefix = prefixSegments.length === 1 ? '/' : prefixSegments.join('/');
	  _.each(_.keys(values), function (key) {
	    values[key.slice(pathPrefix.length + 1)] = values[key];
	    delete values[key];
	  });
	  return pathPrefix;
	};

	/**
	 * Creates a Truss object and sets all its basic properties: path segment variables, user-defined
	 * properties, and computed properties.The latter two will be enumerable so that Vue will pick
	 * them up and make the reactive, so you should call _completeCreateObject once it's done so and
	 * before any Firebase properties are added.
	 */
	Tree.prototype._createObject = function _createObject (path, key, parent) {
	    var this$1 = this;

	  if (parent && _.has(parent, key)) { throw new Error(("Duplicate object created for " + path)); }
	  var properties = {
	    $truss: {value: this._truss, writable: false, configurable: false, enumerable: false},
	    // We want Vue to wrap this; we'll make it non-enumerable in _completeCreateObject.
	    $parent: {value: parent, writable: false, configurable: true, enumerable: true},
	    $key: {value: key, writable: false, configurable: false, enumerable: false},
	    $path: {value: path, writable: false, configurable: false, enumerable: false},
	    $$touchThis: {
	      value: parent ? function () { return parent[key]; } : function () { return this$1._vue.$data.$root; },
	      writable: false, configurable: false, enumerable: false
	    }
	  };

	  var object = this._modeler.createObject(path, properties);
	  Object.defineProperties(object, properties);
	  return object;
	};

	// To be called on the result of _createObject after it's been inserted into the _vue hierarchy
	// and Vue has had a chance to initialize it.
	Tree.prototype._completeCreateObject = function _completeCreateObject (object) {
	    var this$1 = this;

	  for (var i = 0, list = Object.getOwnPropertyNames(object); i < list.length; i += 1) {
	    var name = list[i];

	      var descriptor = Object.getOwnPropertyDescriptor(object, name);
	    if (descriptor.configurable && descriptor.enumerable) {
	      descriptor.enumerable = false;
	      if (name === '$parent') {
	        descriptor.configurable = false;
	        descriptor.set = throwReadOnlyError;
	      }
	      Object.defineProperty(object, name, descriptor);
	    }
	  }
	  if (object.$$initializers) {
	    for (var i$1 = 0, list$1 = object.$$initializers; i$1 < list$1.length; i$1 += 1) {
	        var fn = list$1[i$1];

	        fn(this$1._vue);
	      }
	    delete object.$$initializers;
	  }
	};

	Tree.prototype._destroyObject = function _destroyObject (object) {
	    var this$1 = this;

	  if (!(object && object.$truss)) { return; }
	  if (object.$$finalizers) {
	    // Some destructors remove themselves from the array, so clone it before iterating.
	    for (var i = 0, list = _.clone(object.$$finalizers); i < list.length; i += 1) {
	        var fn = list[i];

	        fn();
	      }
	  }
	  for (var key in object) {
	    if (!Object.hasOwnProperty(object, key)) { continue; }
	    this$1._destroyObject(object[key]);
	  }
	};

	Tree.prototype._integrateSnapshot = function _integrateSnapshot (snap) {
	    var this$1 = this;

	  _.each(_.keys(this._localWrites), function (writeSerial, path) {
	    if (snap.writeSerial >= writeSerial) { delete this$1._localWrites[path]; }
	  });
	  if (snap.exists) {
	    var parent = this._scaffoldAncestors(snap.path, true);
	    if (parent) { this._plantValue(snap.path, snap.key, snap.value, parent, true, false); }
	  } else {
	    this._prune(snap.path, null, true);
	  }
	};

	Tree.prototype._scaffoldAncestors = function _scaffoldAncestors (path, remoteWrite) {
	    var this$1 = this;

	  var object;
	  var segments = _(path).split('/').dropRight().value();
	  _.each(segments, function (segment, i) {
	    var childKey = unescapeKey(segment);
	    var child = childKey ? object[childKey] : this$1.root;
	    if (!child) {
	      var ancestorPath = segments.slice(0, i + 1).join('/');
	      if (remoteWrite && this$1._localWrites[ancestorPath || '/']) { return; }
	      child = this$1._plantValue(ancestorPath, childKey, {}, object);
	    }
	    object = child;
	  });
	  return object;
	};

	Tree.prototype._plantValue = function _plantValue (path, key, value, parent, remoteWrite, override) {
	    var this$1 = this;

	  if (value === null || value === undefined) {
	    throw new Error('Snapshot includes invalid value: ' + value);
	  }
	  if (remoteWrite && this._localWrites[path]) { return; }
	  if (value === SERVER_TIMESTAMP) { value = this._localWriteTimestamp; }
	  if (!_.isArray(value) && !_.isObject(value)) {
	    this._setFirebaseProperty(parent, key, value);
	    return;
	  }
	  var object = parent[key];
	  if (object === undefined) {
	    object = this._createObject(path, key, parent);
	    this._setFirebaseProperty(parent, key, object);
	    this._completeCreateObject(object);
	  }
	  if (override) {
	    Object.defineProperty(object, '$overridden', {get: _.constant(true), configurable: true});
	  } else if (object.$overridden) {
	    delete object.$overridden;
	  }
	  _.each(value, function (item, escapedChildKey) {
	    this$1._plantValue(
	      joinPath(path, escapedChildKey), unescapeKey(escapedChildKey), item, object, remoteWrite,
	      override
	    );
	  });
	  _.each(object, function (item, childKey) {
	    var escapedChildKey = escapeKey(childKey);
	    if (!value.hasOwnProperty(escapedChildKey)) {
	      this$1._prune(joinPath(path, escapedChildKey), null, remoteWrite);
	    }
	  });
	  this._plantPlaceholders(object, path);
	  return object;
	};

	Tree.prototype._plantPlaceholders = function _plantPlaceholders (object, path) {
	    var this$1 = this;

	  this._modeler.forEachPlaceholderChild(path, function (escapedKey, placeholder) {
	    var key = unescapeKey(escapedKey);
	    if (!object.hasOwnProperty(key)) {
	      this$1._plantValue(joinPath(path, escapedKey), key, placeholder, object);
	    }
	  });
	};

	Tree.prototype._prune = function _prune (path, lockedDescendantPaths, remoteWrite) {
	  lockedDescendantPaths = lockedDescendantPaths || {};
	  var object = this.getObject(path);
	  if (object === undefined) { return; }
	  if (remoteWrite && this._avoidLocalWritePaths(path, lockedDescendantPaths)) { return; }
	  if (!(_.isEmpty(lockedDescendantPaths) && this._pruneAncestors(path, object)) &&
	      _.isObject(object)) {
	    // The target object is a placeholder, and all ancestors are placeholders or otherwise needed
	    // as well, so we can't delete it.Instead, dive into its descendants to delete what we can.
	    this._pruneDescendants(object, lockedDescendantPaths);
	  }
	};

	Tree.prototype._avoidLocalWritePaths = function _avoidLocalWritePaths (path, lockedDescendantPaths) {
	    var this$1 = this;

	  for (var localWritePath in this._localWrites) {
	    if (!this$1._localWrites.hasOwnProperty(localWritePath)) { continue; }
	    if (path === localWritePath || localWritePath === '/' ||
	        _.startsWith(path, localWritePath + '/')) { return true; }
	    if (path === '/' || _.startsWith(localWritePath, path + '/')) {
	      var segments = localWritePath.split('/');
	      for (var i = segments.length; i > 0; i--) {
	        var subPath = segments.slice(0, i).join('/');
	        var active = i === segments.length;
	        if (lockedDescendantPaths[subPath] || lockedDescendantPaths[subPath] === active) { break; }
	        lockedDescendantPaths[subPath] = active;
	        if (subPath === path) { break; }
	      }
	    }
	  }
	};

	Tree.prototype._pruneAncestors = function _pruneAncestors (targetPath, targetObject) {
	    var this$1 = this;

	  // Destroy the child (unless it's a placeholder that's still needed) and any ancestors that
	  // are no longer needed to keep this child rooted, and have no other reason to exist.
	  var deleted = false;
	  var object = targetObject;
	  // The target object may be a primitive, in which case it won't have $parent and $key
	  // properties.In that case, use the target path to figure those out instead.Note that all
	  // ancestors of the target object will necessarily not be primitives and will have those
	  // properties.
	  var targetSegments = _(targetPath).split('/').map(unescapeKey).value();
	  while (object && object !== this.root) {
	    var parent =
	      object.$parent || object === targetObject && this$1.getObject(targetSegments.slice(0, -1));
	    if (!this$1._modeler.isPlaceholder(object.$path)) {
	      var ghostObjects = deleted ? null : [targetObject];
	      if (!this$1._holdsConcreteData(object, ghostObjects)) {
	        deleted = true;
	        this$1._deleteFirebaseProperty(
	          parent, object.$key || object === targetObject && _.last(targetSegments));
	      }
	    }
	    object = parent;
	  }
	  return deleted;
	};

	Tree.prototype._holdsConcreteData = function _holdsConcreteData (object, ghostObjects) {
	    var this$1 = this;

	  if (ghostObjects && _.contains(ghostObjects, object)) { return false; }
	  if (_.some(object, function (value) { return !value.$truss; })) { return true; }
	  return _.some(object, function (value) { return this$1._holdsConcreteData(value, ghostObjects); });
	};

	Tree.prototype._pruneDescendants = function _pruneDescendants (object, lockedDescendantPaths) {
	    var this$1 = this;

	  if (lockedDescendantPaths[object.$path]) { return true; }
	  if (object.$overridden) { delete object.$overridden; }
	  var coupledDescendantFound = false;
	  _.each(object, function (value, key) {
	    var shouldDelete = true;
	    var valueLocked;
	    if (lockedDescendantPaths[joinPath(object.$path, escapeKey(key))]) {
	      shouldDelete = false;
	      valueLocked = true;
	    } else if (value.$truss) {
	      var placeholder = this$1._modeler.isPlaceholder(value.$path);
	      if (placeholder || _.has(lockedDescendantPaths, value.$path)) {
	        valueLocked = this$1._pruneDescendants(value, lockedDescendantPaths);
	        shouldDelete = !placeholder && !valueLocked;
	      }
	    }
	    if (shouldDelete) { this$1._deleteFirebaseProperty(object, key); }
	    coupledDescendantFound = coupledDescendantFound || valueLocked;
	  });
	  return coupledDescendantFound;
	};

	Tree.prototype.getObject = function getObject (pathOrSegments) {
	    var this$1 = this;

	  var object;
	  var segments = _.isString(pathOrSegments) ?
	    _(pathOrSegments).split('/').map(unescapeKey).value() : pathOrSegments;
	  for (var i = 0, list = segments; i < list.length; i += 1) {
	    var segment = list[i];

	      object = segment ? object[segment] : this$1.root;
	    if (object === undefined) { return; }
	  }
	  return object;
	};

	Tree.prototype._getFirebasePropertyDescriptor = function _getFirebasePropertyDescriptor (object, key) {
	  var descriptor = Object.getOwnPropertyDescriptor(object, key);
	  if (descriptor) {
	    if (!descriptor.enumerable) {
	      throw new Error(
	        "Key conflict between Firebase and instance or computed properties at " +
	        (object.$path) + ": " + key);
	    }
	    if (!descriptor.get || !descriptor.set) {
	      throw new Error(("Unbound property at " + (object.$path) + ": " + key));
	    }
	  }
	  return descriptor;
	};

	Tree.prototype._setFirebaseProperty = function _setFirebaseProperty (object, key, value) {
	  var descriptor = this._getFirebasePropertyDescriptor(object, key);
	  if (descriptor) {
	    this._firebasePropertyEditAllowed = true;
	    object[key] = value;
	    this._firebasePropertyEditAllowed = false;
	  } else {
	    Vue.set(object, key, value);
	    descriptor = Object.getOwnPropertyDescriptor(object, key);
	    Object.defineProperty(object, key, {
	      get: descriptor.get, set: this._overwriteFirebaseProperty.bind(this, descriptor, key),
	      configurable: true, enumerable: true
	    });
	  }
	};

	Tree.prototype._overwriteFirebaseProperty = function _overwriteFirebaseProperty (descriptor, key, newValue) {
	  if (!this._firebasePropertyEditAllowed) {
	    throw new Error(("Firebase data cannot be mutated directly: " + key));
	  }
	  descriptor.set.call(this, newValue);
	};

	Tree.prototype._deleteFirebaseProperty = function _deleteFirebaseProperty (object, key) {
	  // Make sure it's actually a Firebase property.
	  this._getFirebasePropertyDescriptor(object, key);
	  this._destroyObject(object[key]);
	  Vue.delete(object, key);
	};

	Tree.prototype.checkVueObject = function checkVueObject (object, path) {
	  this._modeler.checkVueObject(object, path);
	};

	staticAccessors$1.computedPropertyStats.get = function () {
	  return Modeler.computedPropertyStats;
	};

	Object.defineProperties( Tree.prototype, prototypeAccessors$1$1 );
	Object.defineProperties( Tree, staticAccessors$1 );

	function throwReadOnlyError() {throw new Error('Read-only property');}

	function checkUpdateHasOnlyDescendantsWithNoOverlap(rootPath, values, relativizePaths) {
	  // First, check all paths for correctness and absolutize them, since there could be a mix of
	  // absolute paths and relative keys.
	  _.each(_.keys(values), function (path) {
	    if (path.charAt(0) === '/') {
	      if (!(path === rootPath || rootPath === '/' ||
	            _.startsWith(path, rootPath + '/') && path.length > rootPath.length + 1)) {
	        throw new Error(("Update item is not a descendant of target ref: " + path));
	      }
	    } else {
	      if (path.indexOf('/') >= 0) {
	        throw new Error(("Update item deep path must be absolute, taken from a reference: " + path));
	      }
	      var absolutePath = joinPath(rootPath, escapeKey(path));
	      if (values.hasOwnProperty(absolutePath)) {
	        throw new Error(("Update items overlap: " + path + " and " + absolutePath));
	      }
	      values[absolutePath] = values[path];
	      delete values[path];
	    }
	  });
	  // Then check for overlaps and relativize if desired.
	  var allPaths = _(values).keys().map(function (path) { return joinPath(path, ''); }).sortBy('length').value();
	  _.each(_.keys(values), function (path) {
	    for (var i = 0, list = allPaths; i < list.length; i += 1) {
	      var otherPath = list[i];

	      if (otherPath.length > path.length) { break; }
	      if (path !== otherPath && _.startsWith(path, otherPath)) {
	        throw new Error(("Update items overlap: " + otherPath + " and " + path));
	      }
	    }
	    if (relativizePaths) {
	      values[path.slice(rootPath === '/' ? 1 : rootPath.length + 1)] = values[path];
	      delete values[path];
	    }
	  });
	}

	function toFirebaseJson(object) {
	  if (typeof object === 'object') {
	    var result = {};
	    for (var key in object) {
	      if (!object.hasOwnProperty(key)) { continue; }
	      result[escapeKey(key)] = toFirebaseJson(object[key]);
	    }
	    return result;
	  } else {
	    return object;
	  }
	}

	var bridge;
	var workerFunctions = {};
	// This version is filled in by the build, don't reformat the line.
	var VERSION = 'dev';


	var Truss = function Truss(rootUrl, classes) {
	  // TODO: allow rootUrl to be a test database object for testing
	  if (!bridge) {
	    throw new Error('Truss worker not connected, please call Truss.connectWorker first');
	  }
	  this._rootUrl = rootUrl.replace(/\/$/, '');
	  this._keyGenerator = new KeyGenerator();
	  this._dispatcher = new Dispatcher(bridge);
	  this._vue = new Vue();

	  bridge.trackServer(this._rootUrl);
	  this._metaTree = new MetaTree(this._rootUrl, bridge);
	  this._tree = new Tree(this, this._rootUrl, bridge, this._dispatcher, classes);
	};

	var prototypeAccessors = { meta: {},root: {},now: {},SERVER_TIMESTAMP: {},VERSION: {},FIREBASE_SDK_VERSION: {} };
	var staticAccessors = { computedPropertyStats: {},worker: {} };

	prototypeAccessors.meta.get = function () {return this._metaTree.root;};
	prototypeAccessors.root.get = function () {return this._tree.root;};

	Truss.prototype.destroy = function destroy () {
	  this._vue.$destroy();
	  this._tree.destroy();
	  this._metaTree.destroy();
	};

	prototypeAccessors.now.get = function () {return Date.now() + this.meta.timeOffset;};
	Truss.prototype.newKey = function newKey () {return this._keyGenerator.generateUniqueKey(this.now);};

	Truss.prototype.authenticate = function authenticate (token) {
	    var this$1 = this;

	  return this._dispatcher.execute('auth', 'authenticate', new Reference(this._tree, '/'), function () {
	    return bridge.authWithCustomToken(this$1._rootUrl, token, {rememberMe: true});
	  });
	};

	Truss.prototype.unauthenticate = function unauthenticate () {
	    var this$1 = this;

	  return this._dispatcher.execute(
	    'auth', 'unauthenticate', new Reference(this._tree, '/'), function () {
	      return bridge.unauth(this$1._rootUrl);
	    }
	  );
	};

	Truss.prototype.intercept = function intercept (actionType, callbacks) {
	  return this._dispatcher.intercept(actionType, callbacks);
	};

	// connections are {key: Query | Object | fn() -> (Query | Object)}
	Truss.prototype.connect = function connect (scope, connections) {
	  if (!connections) {
	    connections = scope;
	    scope = undefined;
	    if (connections instanceof Handle) { connections = {_: connections}; }
	  }
	  return new Connector(scope, connections, this._tree, 'connect');
	};

	// target is Reference, Query, or connection Object like above
	Truss.prototype.peek = function peek (target, callback) {
	    var this$1 = this;

	  callback = wrapPromiseCallback(callback);
	  return new Promise(function (resolve, reject) {
	    var scope = {};
	    var connector = new Connector(scope, {result: target}, this$1._tree, 'peek');
	    var unwatch = this$1._vue.$watch(function () { return connector.ready; }, function (ready) {
	      if (!ready) { return; }
	      unwatch();
	      callback(scope.result).then(function (result) {
	        connector.destroy();
	        resolve(result);
	      }, function (error) {
	        connector.destroy();
	        reject(error);
	      });
	    });
	  });
	};

	Truss.prototype.watch = function watch (subjectFn, callbackFn, options) {
	  var numCallbacks = 0;

	  var unwatch = this._vue.$watch(subjectFn, function (newValue, oldValue) {
	    numCallbacks++;
	    if (numCallbacks === 1) {
	      // Delay the immediate callback until we've had a chance to return the unwatch function.
	      Promise.resolve().then(function () {
	        if (numCallbacks > 1) { return; }
	        callbackFn(newValue, oldValue);
	        angularProxy.digest();
	      });
	    } else {
	      callbackFn(newValue, oldValue);
	      angularProxy.digest();
	    }
	  }, {immediate: true, deep: options && options.deep});

	  return unwatch;
	};

	Truss.prototype.when = function when (expression, options) {
	    var this$1 = this;

	  return new Promise(function (resolve) {
	    var unwatch = this$1.watch(expression, function (value) {
	      if (value) {
	        unwatch();
	        resolve(value);
	      }
	    }, options);
	  });
	};

	Truss.prototype.checkObjectsForRogueProperties = function checkObjectsForRogueProperties () {
	  this._tree.checkVueObject(this._tree.root, '/');
	};

	staticAccessors.computedPropertyStats.get = function () {return this._tree.computedPropertyStats;};

	Truss.connectWorker = function connectWorker (webWorker) {
	  if (bridge) { throw new Error('Worker already connected'); }
	  if (_.isString(webWorker)) {
	    var Worker = window.SharedWorker || window.Worker;
	    if (!Worker) { throw new Error('Browser does not implement Web Workers'); }
	    webWorker = new Worker(webWorker);
	  }
	  bridge = new Bridge(webWorker);
	  return bridge.init(webWorker).then(
	    function (ref) {
	        var exposedFunctionNames = ref.exposedFunctionNames;
	        var firebaseSdkVersion = ref.firebaseSdkVersion;

	      Object.defineProperty(Truss, 'FIREBASE_SDK_VERSION', {value: firebaseSdkVersion});
	      for (var i = 0, list = exposedFunctionNames; i < list.length; i += 1) {
	        var name = list[i];

	          Truss.worker[name] = bridge.bindExposedFunction(name);
	      }
	    }
	  );
	};

	staticAccessors.worker.get = function () {return workerFunctions;};
	Truss.preExpose = function preExpose (functionName) {
	  Truss.worker[functionName] = bridge.bindExposedFunction(functionName);
	};

	Truss.bounceConnection = function bounceConnection () {return bridge.bounceConnection();};
	Truss.suspend = function suspend () {return bridge.suspend();};
	Truss.debugPermissionDeniedErrors = function debugPermissionDeniedErrors (simulatedTokenGenerator, maxSimulationDuration, callFilter) {
	  return bridge.debugPermissionDeniedErrors(
	    simulatedTokenGenerator, maxSimulationDuration, callFilter);
	};

	Truss.debounceAngularDigest = function debounceAngularDigest (wait) {
	  angularProxy.debounceDigest(wait);
	};

	Truss.escapeKey = function escapeKey (key) {return escapeKey(key);};
	Truss.unescapeKey = function unescapeKey (escapedKey) {return unescapeKey(escapedKey);};

	Truss.enableLogging = function enableLogging (fn) {return bridge.enableLogging(fn);};

	// Duplicate static constants on instance for convenience.
	prototypeAccessors.SERVER_TIMESTAMP.get = function () {return Truss.SERVER_TIMESTAMP;};
	prototypeAccessors.VERSION.get = function () {return Truss.VERSION;};
	prototypeAccessors.FIREBASE_SDK_VERSION.get = function () {return Truss.FIREBASE_SDK_VERSION;};

	Object.defineProperties( Truss.prototype, prototypeAccessors );
	Object.defineProperties( Truss, staticAccessors );

	Object.defineProperties(Truss, {
	  SERVER_TIMESTAMP: {value: SERVER_TIMESTAMP},
	  VERSION: {value: VERSION}
	});

	angularProxy.defineModule(Truss);

	return Truss;

})));

//# sourceMappingURL=firetruss.umd.js.map