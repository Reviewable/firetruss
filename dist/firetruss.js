(function (global, factory) {
	typeof exports === 'object' && typeof module !== 'undefined' ? module.exports = factory(require('lodash'), require('vue')) :
	typeof define === 'function' && define.amd ? define(['lodash', 'vue'], factory) :
	(global.Truss = factory(global._,global.Vue));
}(this, (function (_,Vue) { 'use strict';

	_ = 'default' in _ ? _['default'] : _;
	Vue = 'default' in Vue ? Vue['default'] : Vue;

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

	var Query = function Query(truss, path, terms) {
	  this._truss = truss;
	  this._path = path.replace(/^\/?/, '/').replace(/\/$/, '');
	  this._terms = terms;
	};

	var prototypeAccessors$2 = { key: {},path: {},parent: {},ready: {} };

	prototypeAccessors$2.key.get = function () {
	  if (!this._key) { this._key = unescapeKey(this._path.replace(/.*\//, '')); }
	  return this._key;
	};
	prototypeAccessors$2.path.get = function () {return this._path;};
	prototypeAccessors$2.parent.get = function () {return new Reference(this._truss, this._path.replace(/\/[^/]*$/, ''));};

	prototypeAccessors$2.ready.get = function () {};// TODO: implement
	Query.prototype.waitUntilReady = function waitUntilReady () {};// TODO: implement

	Query.prototype.get = function get () {
	  // TODO: implement
	  if (this.ready) { return Promise.resolve(); }
	  return trackSlowness(worker.once(this._url, this._terms, 'value'), 'read');
	};

	Query.prototype.connect = function connect () {};// TODO: implement
	Query.prototype.disconnect = function disconnect () {};// TODO: implement

	Query.prototype.toString = function toString () {
	  var result = this._path;
	  if (this._terms) {
	    var queryTerms = this._terms.map(function (term) {
	      var queryTerm = term[0];
	      if (term.length > 1) {
	        queryTerm +=
	          '=' + encodeURIComponent(term.slice(1).map(function (x) { return JSON.stringify(x); }).join(','));
	      }
	      return queryTerm;
	    });
	    queryTerms.sort();
	    result += '?' + queryTerms.join('&');
	  }
	  return result;
	};

	Query.prototype.orderByChild = function orderByChild (ref) {
	  if (ref._terms) {
	    throw new Error('orderByChild must be called with a reference, not a query: ' + ref);
	  }
	  var relativePath = ref.toString();
	  if (_.startsWith(relativePath, this._path)) {
	    relativePath = relativePath.slice(this._path.length);
	  }
	  var terms = this._terms ? this._terms.slice() : [];
	  terms.push(['orderByChild', relativePath]);
	  return new Query(this._truss, this._path, terms);
	};

	Object.defineProperties( Query.prototype, prototypeAccessors$2 );

	[
	  'orderByKey', 'orderByValue', 'startAt', 'endAt', 'equalTo', 'limitToFirst', 'limitToLast'
	].forEach(function (methodName) {
	  Query.prototype[methodName] = function() {
	    var term = Array.prototype.slice.call(arguments);
	    term.unshift(methodName);
	    var terms = this._terms ? this._terms.slice() : [];
	    terms.push(term);
	    return new Query(this._url, terms);
	  };
	});


	// jshint latedef:false
	var Reference = (function (Query) {
	  function Reference(truss, path) {
	    Query.call(this, truss, path);
	  }

	  if ( Query ) Reference.__proto__ = Query;
	  Reference.prototype = Object.create( Query && Query.prototype );
	  Reference.prototype.constructor = Reference;

	  Reference.prototype.child = function child () {};  // TODO: implement
	  Reference.prototype.children = function children () {};  // TODO: implement
	  Reference.prototype.set = function set (value) {};  // TODO: implement
	  Reference.prototype.update = function update (values) {};  // TODO: implement

	  Reference.prototype.commit = function commit (options, updateFunction) {
	    var this$1 = this;

	    // TODO: revise
	    // const options = {
	    //   applyLocally: applyLocally === undefined ? updateFunction.applyLocally : applyLocally
	    // };
	    // ['nonsequential', 'safeAbort'].forEach(key => options[key] = updateFunction[key]);
	    for (var key in options) {
	      if (options.hasOwnProperty(key) && options[key] === undefined) {
	        options[key] = Truss.DefaultTransactionOptions[key];
	      }
	    }

	    // Hold the ref value live until transaction complete, otherwise it'll keep retrying on a null
	    // value.
	    this.on('value', noop);  // No error handling -- if this fails, so will the transaction.
	    return trackSlowness(
	      worker.transaction(this._url, updateFunction, options), 'write'
	    ).then(function (result) {
	      this$1.off('value', noop);
	      return result;
	    }, function (error) {
	      this$1.off('value', noop);
	      return Promise.reject(error);
	    });
	  };

	  return Reference;
	}(Query));

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
	var RESERVED_VALUE_PROPERTY_NAMES = {$truss: true, $parent: true, $key: true, $path: true};

	var computedPropertyStats = {};


	var Value = function Value () {};

	var prototypeAccessors$1 = { $ref: {},$refs: {},$keys: {},$values: {},$root: {} };

	prototypeAccessors$1.$ref.get = function () {return new Reference(this.$truss, this.$path);};
	prototypeAccessors$1.$refs.get = function () {return [this.$ref];};
	prototypeAccessors$1.$keys.get = function () {return _.keys(this);};
	prototypeAccessors$1.$values.get = function () {return _.values(this);};
	prototypeAccessors$1.$root.get = function () {return this.$truss._vue.$data.$root;};// access via $data to leave dependency trace
	Value.prototype.$set = function $set (value) {return this.$ref.set(value);};
	Value.prototype.$update = function $update (values) {return this.$ref.update(values);};
	Value.prototype.$commit = function $commit (options, updateFn) {return this.$ref.commit(options, updateFn);};

	Object.defineProperties( Value.prototype, prototypeAccessors$1 );


	var ComputedPropertyStats = function ComputedPropertyStats(name) {
	  _.extend(this, {name: name, numRecomputes: 0, numUpdates: 0, runtime: 0});
	};


	var Tree = function Tree(truss, classes) {
	  var this$1 = this;

	  this._truss = truss;
	  this._firebasePropertyEditAllowed = false;
	  this._vue = new Vue({data: {$root: null}});
	  this._mounts = _(classes).map(function (Class) { return this$1._mountClass(Class); }).flatten().value();
	  this._vue.$data.$root = this._createObject('/', '');
	  // console.log(this._vue.$data.$root);
	  this._completeCreateObject(this.root);
	  this._plantPlaceholders(this.root, '/');
	};

	var prototypeAccessors$1$1 = { root: {} };
	var staticAccessors$1 = { computedPropertyStats: {} };

	prototypeAccessors$1$1.root.get = function () {
	  return this._vue.$data.$root;
	};

	Tree.prototype.destroy = function destroy () {
	  this._vue.$destroy();
	};

	Tree.prototype._augmentClass = function _augmentClass (Class) {
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

	      if (name$1 === 'constructor') { continue; }
	    Object.defineProperty(
	      Class.prototype, name$1, Object.getOwnPropertyDescriptor(Value.prototype, name$1));
	  }
	  return computedProperties;
	};

	Tree.prototype._mountClass = function _mountClass (Class) {
	  if (Class.$$truss) { throw new Error(("Class " + (Class.name) + " already mounted")); }
	  Class.$$truss = true;
	  var computedProperties = this._augmentClass(Class);
	  var mounts = Class.$trussMount;
	  if (!mounts) { throw new Error(("Class " + (Class.name) + " lacks a $trussMount static property")); }
	  if (!_.isArray(mounts)) { mounts = [mounts]; }
	  return _.map(mounts, function (mount) {
	    if (_.isString(mount)) { mount = {path: mount}; }
	    var variables = [];
	    var pathTemplate = mount.path.replace(/\/\$[^\/]+/g, function (match) {
	      variables.push(match.slice(1));
	      return '\u0001';
	    }).replace(/[$-.?[-^{|}]/g, '\\$&');
	    for (var i = 0, list = variables; i < list.length; i += 1) {
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
	    return {
	      klass: Class, variables: variables, computedProperties: computedProperties,
	      escapedKey: mount.path.match(/\/([^/]*)$/)[1],
	      placeholder: mount.placeholder,
	      regex: new RegExp('^' + pathTemplate.replace(/\u0001/g, '/([^/]+)') + '$'),
	      parentRegex: new RegExp(
	        '^' + (pathTemplate.replace(/\/[^/]*$/, '').replace(/\u0001/g, '/([^/]+)') || '/') + '$')
	    };
	  });
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
	    // We want Vue to wrap this; we'll hide it in _completeCreateObject.
	    $parent: {value: parent, writable: false, configurable: true, enumerable: true},
	    $key: {value: key, writable: false, configurable: false, enumerable: false},
	    $path: {value: path, writable: false, configurable: false, enumerable: false}
	  };

	  var Class = Value;
	  var computedProperties;
	  for (var i$1 = 0, list = this._mounts; i$1 < list.length; i$1 += 1) {
	    var mount = list[i$1];

	      mount.regex.lastIndex = 0;
	    var match = mount.regex.exec(path);
	    if (match) {
	      Class = mount.klass;
	      computedProperties = mount.computedProperties;
	      for (var i = 0; i < mount.variables.length; i++) {
	        properties[mount.variables[i]] = {
	          value: unescapeKey(match[i + 1]),
	          writable: false, configurable: false, enumerable: false
	        };
	      }
	      break;
	    }
	  }

	  var object = new Class();

	  if (computedProperties) {
	    var touchThis = parent ? function () { return parent[key]; } : function () { return this$1._vue.$data.$root; };
	    _.each(computedProperties, function (prop) {
	      properties[prop.name] = this$1._buildComputedPropertyDescriptor(object, prop, touchThis);
	    });
	  }

	  Object.defineProperties(object, properties);
	  return object;
	};

	Tree.prototype._buildComputedPropertyDescriptor = function _buildComputedPropertyDescriptor (object, prop, touchThis) {
	    var this$1 = this;

	  if (!computedPropertyStats[prop.fullName]) {
	    Object.defineProperty(computedPropertyStats, prop.fullName, {
	      value: new ComputedPropertyStats(prop.fullName), writable: false, enumerable: true,
	      configurable: false
	    });
	  }
	  var stats = computedPropertyStats[prop.fullName];

	  function computeValue() {
	    // Touch this object, since a failed access to a missing property doesn't get captured as a
	    // dependency.
	    touchThis();

	    var startTime = performanceNow();
	    // jshint validthis: true
	    var result = prop.get.call(this);
	    // jshint validthis: false
	    stats.runtime += performanceNow() - startTime;
	    stats.numRecomputes += 1;
	    return result;
	  }

	  var value;
	  var writeAllowed = false;
	  var firstCallback = true;

	  if (!object.__destructors__) {
	    Object.defineProperty(object, '__destructors__', {
	      value: [], writable: false, enumerable: false, configurable: false});
	  }
	  if (!object.__initializers__) {
	    Object.defineProperty(object, '__initializers__', {
	      value: [], writable: false, enumerable: false, configurable: false});
	  }
	  object.__initializers__.push(function () {
	    object.__destructors__.push(
	      this$1._vue.$watch(computeValue.bind(object), function (newValue) {
	        if (firstCallback) {
	          stats.numUpdates += 1;
	          value = newValue;
	          firstCallback = false;
	        } else {
	          if (_.isEqual(value, newValue, this$1._isTrussEqual, this$1)) { return; }
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
	    get: function() {return value;},
	    set: function(newValue) {
	      if (!writeAllowed) { throw new Error(("You cannot set a computed property: " + (prop.name))); }
	      value = newValue;
	    }
	  };
	};

	Tree.prototype._isTrussEqual = function _isTrussEqual (a, b) {
	  if (a && a.$truss || b && b.$truss) { return a === b; }
	};

	// To be called on the result of _createObject after it's been inserted into the _vue hierarchy
	// and Vue has had a chance to initialize it.
	Tree.prototype._completeCreateObject = function _completeCreateObject (object) {
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
	  if (object.__initializers__) {
	    for (var i$1 = 0, list$1 = object.__initializers__; i$1 < list$1.length; i$1 += 1) {
	        var fn = list$1[i$1];

	        fn();
	      }
	  }
	};

	Tree.prototype._destroyObject = function _destroyObject (object) {
	    var this$1 = this;

	  if (object.__destructors__) {
	    for (var i = 0, list = object.__destructors__; i < list.length; i += 1) {
	        var fn = list[i];

	        fn();
	      }
	  }
	  for (var key in object) {
	    if (!Object.hasOwnProperty(object, key)) { continue; }
	    var value = object[key];
	    if (value && value.$truss) { this$1._destroyObject(value); }
	  }
	};

	Tree.prototype._plantSnapshotValue = function _plantSnapshotValue (snap, parent) {
	  return this._plantValue(
	    pathFromUrl(snap.ref().toString()), unescapeKey(snap.key()), snap.val(), parent);
	};

	Tree.prototype._plantValue = function _plantValue (path, key, value, parent) {
	    var this$1 = this;

	  if (!_.isArray(value) && !_.isObject(value)) {
	    this._setFirebaseProperty(parent, key, value);
	    return;
	  }
	  var object = this._createObject(path, key, parent);
	  this._setFirebaseProperty(parent, key, object);
	  this._completeCreateObject(object);
	  _.each(value, function (item, escapedChildKey) {
	    if (item === null || item === undefined) { return; }
	    this$1._plantValue(
	      ("" + (joinPath(path, escapedChildKey))), unescapeKey(escapedChildKey), item, object);
	  });
	  this._plantPlaceholders(object, path);
	  return object;
	};

	Tree.prototype._plantPlaceholders = function _plantPlaceholders (object, path) {
	    var this$1 = this;

	  _.each(this._mounts, function (mount) {
	    var key = unescapeKey(mount.escapedKey);
	    if (!object.hasOwnProperty(key) && mount.placeholder && mount.parentRegex.test(path)) {
	      this$1._plantValue(("" + (joinPath(path, mount.escapedKey))), key, mount.placeholder, object);
	    }
	  });
	};

	Tree.prototype._setFirebaseProperty = function _setFirebaseProperty (object, key, value) {
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
	  if (value === null || value === undefined) {
	    if (descriptor) {
	      var oldValue = object[key];
	      if (oldValue && oldValue.$truss) { this._deleteObject(oldValue); }
	      Vue.delete(object, key);
	    }
	  } else {
	    if (descriptor) {
	      this._firebasePropertyEditAllowed = true;
	      object[key] = value;
	      this._firebasePropertyEditAllowed = false;
	    } else {
	      Vue.set(object, key, value);
	      descriptor = Object.getOwnPropertyDescriptor(object, key);
	      Object.defineProperty(object, key, {
	        get: descriptor.get,
	        set: function(newValue) {
	          if (!this._firebasePropertyEditAllowed) {
	            throw new Error(("Firebase data cannot be mutated directly: " + key));
	          }
	          descriptor.set.call(this, newValue);
	        },
	        configurable: true, enumerable: true
	      });
	    }
	  }
	};

	staticAccessors$1.computedPropertyStats.get = function () {
	  return computedPropertyStats;
	};

	Object.defineProperties( Tree.prototype, prototypeAccessors$1$1 );
	Object.defineProperties( Tree, staticAccessors$1 );


	function throwReadOnlyError() {throw new Error('Read-only property');}

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

	// jshint browser:true

	var SlownessTracker = function SlownessTracker(record) {
	  this.record = record;
	  this.counted = false;
	  this.canceled = false;
	  this.handle = setTimeout(this.handleTimeout.bind(this), record.timeout);
	};

	SlownessTracker.prototype.handleTimeout = function handleTimeout () {
	  if (this.canceled) { return; }
	  this.counted = true;
	  this.record.callback(++this.record.count, 1, this.record.timeout);
	};

	SlownessTracker.prototype.handleDone = function handleDone () {
	  this.canceled = true;
	  if (this.counted) {
	    this.record.callback(--this.record.count, -1, this.record.timeout);
	  } else {
	    clearTimeout(this.handle);
	  }
	};


	var Bridge = function Bridge(webWorker) {
	  var this$1 = this;

	  this._idCounter = 0;
	  this._deferreds = {};
	  this._active = true;
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
	  window.addEventListener('unload', function () {this$1._send({msg: 'destroy'});});
	  setInterval(function () {this$1._send({msg: 'ping'});}, 60 * 1000);
	};

	Bridge.prototype.init = function init () {
	    var this$1 = this;

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
	  return this._send({msg: 'init', storage: items}).then(
	    function (ref) {
	        var exposedFunctionNames = ref.exposedFunctionNames;
	        var firebaseSdkVersion = ref.firebaseSdkVersion;

	      Truss.FIREBASE_SDK_VERSION = firebaseSdkVersion;
	      for (var i = 0, list = exposedFunctionNames; i < list.length; i += 1) {
	        var name = list[i];

	          Truss.worker[name] = this$1.bindExposedFunction(name);
	      }
	    }
	  );
	};

	Bridge.prototype.activate = function activate (enabled) {
	  if (this._active === enabled) { return; }
	  this._active = enabled;
	  if (enabled) {
	    this._receiveMessages(this._inboundMessages);
	    this._inboundMessages = [];
	    if (this._outboundMessages.length) { setImmediate(this._flushMessageQueue); }
	  }
	};

	Bridge.prototype.debugPermissionDeniedErrors = function debugPermissionDeniedErrors (simulatedTokenGenerator, maxSimulationDuration, callFilter) {
	  this._simulatedTokenGenerator = simulatedTokenGenerator;
	  if (maxSimulationDuration !== undefined) { this._maxSimulationDuration = maxSimulationDuration; }
	  this._simulatedCallFilter = callFilter || function() {return true;};
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
	    for (var name in message) { if (message.hasOwnProperty(name)) { deferred[name] = message[name]; } }
	  }
	  if (!this._outboundMessages.length && this._active) { setImmediate(this._flushMessageQueue); }
	  this._outboundMessages.push(message);
	  return promise;
	};

	Bridge.prototype._flushMessageQueue = function _flushMessageQueue () {
	  this._port.postMessage(this._outboundMessages);
	  this._outboundMessages = [];
	};

	Bridge.prototype._receive = function _receive (event) {
	  if (this._active) {
	    this._receiveMessages(event.data);
	  } else {
	    this._inboundMessages = this._inboundMessages.concat(event.data);
	  }
	};

	Bridge.prototype._receiveMessages = function _receiveMessages (messages) {
	    var this$1 = this;

	  for (var i = 0, list = messages; i < list.length; i += 1) {
	    var message = list[i];

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
	  if (!deferred) { throw new Error('fireworker received resolution to inexistent call'); }
	  delete this._deferreds[message.id];
	  deferred.resolve(message.result);
	};

	Bridge.prototype.reject = function reject (message) {
	    var this$1 = this;

	  var deferred = this._deferreds[message.id];
	  if (!deferred) { throw new Error('fireworker received rejection of inexistent call'); }
	  delete this._deferreds[message.id];
	  this._hydrateError(message.error, deferred).then(function (error) {
	    deferred.reject(error);
	    this$1._emitError(error);
	  });
	};

	Bridge.prototype._hydrateError = function _hydrateError (json, props) {
	  var error = this._errorFromJson(json);
	  var code = json.code || json.message;
	  if (code && code.toLowerCase() === 'permission_denied') {
	    return this._simulateCall(props).then(function (securityTrace) {
	      if (securityTrace) {
	        error.extra = error.extra || {};
	        error.extra.debug = securityTrace;
	      }
	      return error;
	    });
	  } else {
	    return Promise.resolve(error);
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
	    case 'once':
	      simulatedCalls.push({method: 'once', url: props.url, args: ['value']});
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
	  var server = this._servers[rootUrl] = {offset: 0, authListeners: []};
	  var authCallbackId = this._registerCallback(this._authCallback.bind(this, server));
	  var offsetUrl = rootUrl + "/.info/serverTimeOffset";
	  this.on(offsetUrl, offsetUrl, [], 'value', function (offset) {server.offset = offset.val();});
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

	Bridge.prototype.set = function set (url, value) {return this._send({msg: 'set', url: url, value: value});};
	Bridge.prototype.update = function update (url, value) {return this._send({msg: 'update', url: url, value: value});};

	Bridge.prototype.on = function on (listenerKey, url, terms, eventType, snapshotCallback, cancelCallback, context, options) {
	  var handle = {
	    listenerKey: listenerKey, eventType: eventType, snapshotCallback: snapshotCallback, cancelCallback: cancelCallback, context: context, msg: 'on', url: url, terms: terms,
	    timeouts: this._slowCallbacks.read.map(function (record) { return new SlownessTracker(record); })
	  };
	  var callback = this._onCallback.bind(this, handle);
	  this._registerCallback(callback, handle);
	  // Keep multiple IDs to allow the same snapshotCallback to be reused.
	  snapshotCallback.__callbackIds = snapshotCallback.__callbackIds || [];
	  snapshotCallback.__callbackIds.push(handle.id);
	  this._send({
	    msg: 'on', listenerKey: listenerKey, url: url, terms: terms, eventType: eventType, callbackId: handle.id, options: options
	  }).catch(function (error) {
	    callback(error);
	  });
	};

	Bridge.prototype.off = function off (listenerKey, url, terms, eventType, snapshotCallback, context) {
	    var this$1 = this;

	  var idsToDeregister = [];
	  var callbackId;
	  if (snapshotCallback) {
	    if (snapshotCallback.__callbackIds) {
	      var i = 0;
	      while (i < snapshotCallback.__callbackIds.length) {
	        var id = snapshotCallback.__callbackIds[i];
	        var handle = this$1._callbacks[id];
	        if (!handle) {
	          snapshotCallback.__callbackIds.splice(i, 1);
	          continue;
	        }
	        if (handle.listenerKey === listenerKey && handle.eventType === eventType &&
	            handle.context === context) {
	          callbackId = id;
	          idsToDeregister.push(id);
	          snapshotCallback.__callbackIds.splice(i, 1);
	          break;
	        }
	        i += 1;
	      }
	    }
	    if (!callbackId) { return; }// no-op, callback never registered or already deregistered
	  } else {
	    for (var i$1 = 0, list = Object.keys(this._callbacks); i$1 < list.length; i$1 += 1) {
	      var id$1 = list[i$1];

	        var handle$1 = this$1._callbacks[id$1];
	      if (handle$1.listenerKey === listenerKey && (!eventType || handle$1.eventType === eventType)) {
	        idsToDeregister.push(id$1);
	      }
	    }
	  }
	  // Nullify callbacks first, then deregister after off() is complete.We don't want any
	  // callbacks in flight from the worker to be invoked while the off() is processing, but we don't
	  // want them to throw an exception either.
	  for (var i$2 = 0, list$1 = idsToDeregister; i$2 < list$1.length; i$2 += 1) {
	      var id$2 = list$1[i$2];

	      this$1._nullifyCallback(id$2);
	    }
	  return this._send({msg: 'off', listenerKey: listenerKey, url: url, terms: terms, eventType: eventType, callbackId: callbackId}).then(function () {
	    for (var i = 0, list = idsToDeregister; i < list.length; i += 1) {
	        var id = list[i];

	        this$1._deregisterCallback(id);
	      }
	  });
	};

	Bridge.prototype._onCallback = function _onCallback (handle, error, snapshotJson) {
	    var this$1 = this;

	  if (handle.timeouts) {
	    for (var i = 0, list = handle.timeouts; i < list.length; i += 1) {
	        var timeout = list[i];

	        timeout.handleDone();
	      }
	  }
	  if (error) {
	    this._deregisterCallback(handle.id);
	    this._hydrateError(error, handle).then(function (error) {
	      if (handle.cancelCallback) { handle.cancelCallback.call(handle.context, error); }
	      this$1._emitError(error);
	    });
	  } else {
	    handle.snapshotCallback.call(handle.context, new Snapshot(snapshotJson));
	  }
	};

	Bridge.prototype.once = function once (url, terms, eventType, options) {
	  return this._send({msg: 'once', url: url, terms: terms, eventType: eventType, options: options}).then(function (snapshotJson) {
	    return new Snapshot(snapshotJson);
	  });
	};

	Bridge.prototype.transaction = function transaction (url, updateFunction, options) {
	    var this$1 = this;

	  var tries = 0;

	  var attemptTransaction = function (oldValue, oldHash) {
	    if (tries++ >= 25) { return Promise.reject(new Error('maxretry')); }
	    var newValue;
	    try {
	      newValue = updateFunction(oldValue);
	    } catch (e) {
	      return Promise.reject(e);
	    }
	    if (newValue === Firebase.ABORT_TRANSACTION_NOW ||
	        newValue === undefined && !options.safeAbort) {
	      return {committed: false, snapshot: new Snapshot({url: url, value: oldValue})};
	    }
	    return this$1._send({msg: 'transaction', url: url, oldHash: oldHash, newValue: newValue, options: options}).then(function (result) {
	      if (result.stale) {
	        return attemptTransaction(result.value, result.hash);
	      } else {
	        return {committed: result.committed, snapshot: new Snapshot(result.snapshotJson)};
	      }
	    });
	  };

	  return attemptTransaction(null, null);
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
	  var handle = this._callbacks[id];
	  if (handle.timeouts) {
	    for (var i = 0, list = handle.timeouts; i < list.length; i += 1) {
	        var timeout = list[i];

	        timeout.handleDone();
	      }
	  }
	  this._callbacks[id].callback = noop$1;
	};

	Bridge.prototype._deregisterCallback = function _deregisterCallback (id) {
	  delete this._callbacks[id];
	};

	Bridge.prototype.onError = function onError (callback) {
	  this._errorCallbacks.push(callback);
	  return callback;
	};

	Bridge.prototype.offError = function offError (callback) {
	  var k = this._errorCallbacks.indexOf(callback);
	  if (k !== -1) { this._errorCallbacks.splice(k, 1); }
	};

	Bridge.prototype.onSlow = function onSlow (operationKind, timeout, callback) {
	    var this$1 = this;

	  var kinds = operationKind === 'all' ? Object.keys(this._slowCallbacks) : [operationKind];
	  for (var i = 0, list = kinds; i < list.length; i += 1) {
	      var kind = list[i];

	      this$1._slowCallbacks[kind].push({timeout: timeout, callback: callback, count: 0});
	    }
	  return callback;
	};

	Bridge.prototype.offSlow = function offSlow (operationKind, callback) {
	    var this$1 = this;

	  var kinds = operationKind === 'all' ? Object.keys(this._slowCallbacks) : [operationKind];
	  for (var i$1 = 0, list = kinds; i$1 < list.length; i$1 += 1) {
	    var kind = list[i$1];

	      var records = this$1._slowCallbacks[kind];
	    for (var i = 0; i < records.length; i++) {
	      if (records[i].callback === callback) {
	        records.splice(i, 1);
	        break;
	      }
	    }
	  }
	};

	Bridge.prototype.trackSlowness = function trackSlowness (promise, operationKind) {
	  var records = this._slowCallbacks[operationKind];
	  if (!records.length) { return promise; }

	  var timeouts = records.map(function (record) { return new SlownessTracker(record); });

	  function opDone() {
	    for (var i = 0, list = timeouts; i < list.length; i += 1) {
	        var timeout = list[i];

	        timeout.handleDone();
	      }
	  }

	  promise = promise.then(function (result) {
	    opDone();
	    return result;
	  }, function (error) {
	    opDone();
	    return Promise.reject(error);
	  });

	  return promise;
	};

	Bridge.prototype._errorFromJson = function _errorFromJson (json) {
	  if (!json || json instanceof Error) { return json; }
	  var error = new Error(json.message);
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
	};

	Bridge.prototype._emitError = function _emitError (error) {
	    var this$1 = this;

	  if (this._errorCallbacks.length) {
	    setTimeout(function () {
	      for (var i = 0, list = this$1._errorCallbacks; i < list.length; i += 1) {
	          var callback = list[i];

	          callback(error);
	        }
	    }, 0);
	  }
	};


	function noop$1() {}

	/* globals window */

	var triggerAngularDigest;

	var exports$1 = {active: typeof window !== 'undefined' && window.angular};
	if (exports$1.active) {
	  window.angular.module('firetruss', []).run(
	    ['$rootScope', function($rootScope) {
	      triggerAngularDigest = $rootScope.$evalAsync.bind($rootScope);
	    }]
	  );
	  exports$1.defineModule = function(Truss) {
	    window.angular.module('firetruss').constant('Truss', Truss);
	  };
	} else {
	  exports$1.defineModule = function() {};
	}

	exports$1.digest = function() {
	  if (triggerAngularDigest) { triggerAngularDigest(); }
	};

	var TIMESTAMP = Object.freeze({'.sv': 'timestamp'});

	var bridge;


	// jshint latedef:false
	var Truss$1 = function Truss$1(rootUrl, classes) {
	  // TODO: allow rootUrl to be a test database object for testing
	  this._rootUrl = rootUrl.replace(/\/$/, '');
	  this._keyGenerator = new KeyGenerator();
	  bridge.trackServer(this._rootUrl);
	  this._tree = new Tree(this, classes);
	  Object.defineProperty(this, 'root', {
	    value: this._vue.$data.$root, writable: false, configurable: false, enumerable: false
	  });
	  if (exports$1.active) {
	    this._vue.$watch('$data', exports$1.digest, {deep: true});
	  }
	};

	var prototypeAccessors = { now: {},user: {} };
	var staticAccessors = { computedPropertyStats: {},TIMESTAMP: {} };

	Truss$1.prototype.destroy = function destroy () {
	  this.tree.destroy();
	};

	prototypeAccessors.now.get = function () {};
	Truss$1.prototype.newKey = function newKey () {return this._keyGenerator.generateUniqueKey(this.now);};

	prototypeAccessors.user.get = function () {};
	Truss$1.prototype.authenticate = function authenticate (token) {};
	Truss$1.prototype.unauthenticate = function unauthenticate () {};

	Truss$1.prototype.interceptConnections = function interceptConnections (/* {beforeConnect: beforeFn, afterDisconnect: afterFn, onError: errorFn} */) {};
	Truss$1.prototype.interceptWrites = function interceptWrites (/* {beforeWrite: beforeFn, afterWrite: afterFn, onError: errorFn} */) {};
	Truss$1.prototype.pull = function pull (scope, connections) {};// returns readyPromise
	Truss$1.prototype.bind = function bind (scope, connections) {};// returns readyPromise
	// connections are {key: Query | Array<Reference> | fn() -> (Query | Array<Reference>)}

	staticAccessors.computedPropertyStats.get = function () {return this._tree.computedPropertyStats;};

	Truss$1.connectWorker = function connectWorker (webWorker) {
	  if (bridge) { throw new Error('Worker already connected'); }
	  bridge = new Bridge(webWorker);
	  return bridge.init();
	};

	Truss$1.preExpose = function preExpose (functionName) {
	  Truss$1.worker[functionName] = bridge.bindExposedFunction(functionName);
	};

	Truss$1.goOnline = function goOnline () {
	  bridge.activate(true);
	};

	Truss$1.goOffline = function goOffline () {
	  bridge.activate(false);
	};

	Truss$1.escapeKey = function escapeKey (key) {
	  return escapeKey(key);
	};

	Truss$1.unescapeKey = function unescapeKey (escapedKey) {
	  return unescapeKey(escapedKey);
	};

	staticAccessors.TIMESTAMP.get = function () {
	  return TIMESTAMP;
	};

	Object.defineProperties( Truss$1.prototype, prototypeAccessors );
	Object.defineProperties( Truss$1, staticAccessors );

	[
	  'onError', 'offError', 'onSlow', 'offSlow', 'bounceConnection', 'debugPermissionDeniedErrors'
	].forEach(function (methodName) {
	  Truss$1[methodName] = function() {return bridge[methodName].apply(bridge, arguments);};
	});


	Truss$1.DefaultTransactionOptions = Object.seal({
	  applyLocally: true, nonsequential: false, safeAbort: false
	});
	Truss$1.ABORT_TRANSACTION_NOW = Object.create(null);
	Truss$1.worker = {};




	exports$1.defineModule(Truss$1);

	return Truss$1;

})));

//# sourceMappingURL=firetruss.js.map