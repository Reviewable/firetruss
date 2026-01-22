import _ from 'lodash';
import Vue from 'vue';
import angular from './angularCompatibility.js';
import Bridge from './Bridge.js';
import Connector from './Connector.js';
import Dispatcher from './Dispatcher.js';
import KeyGenerator from './KeyGenerator.js';
import MetaTree from './MetaTree.js';
import {Handle} from './Reference.js';
import {BaseValue} from './Modeler.js';
import Tree from './Tree.js';
import stats from './utils/stats.js';
import {escapeKey, unescapeKey} from './utils/paths.js';
import {wrapPromiseCallback, promiseCancel, promiseFinally} from './utils/promises.js';
import {SERVER_TIMESTAMP, copyPrototype} from './utils/utils.js';


let bridge, logging;
const workerFunctions = {};
// This version is filled in by the build, don't reformat the line.
const VERSION = 'dev';


export default class Truss {

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

  get info() {return this._metaTree.root;}
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

  get now() {return Date.now() + this.info.timeOffset;}
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
    if (connections instanceof Handle || _.isFunction(connections)) connections = {_: connections};
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
          callback(scope.result), () => {angular.digest(); callbackPromise = null; cleanup();}
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
    if (usePreciseDefaults) {
      oldValueClone = options.deep ? _.cloneDeep(options.precise) : _.clone(options.precise);
    }

    // This needs to be a `let` instead of a `const` to avoid a "Cannot access before
    // initialization" error.
    let unwatch;
    // eslint-disable-next-line prefer-const
    unwatch = this._vue.$watch(subjectFn, (newValue, oldValue) => {
      if (options && options.precise) {
        const newValueClone = usePreciseDefaults ?
          (options.deep ?
            _.defaultsDeep({}, newValue, options.precise) :
            _.defaults({}, newValue, options.precise)) :
          (options.deep ? _.cloneDeep(newValue) : _.clone(newValue));
        if (_.isEqual(newValueClone, oldValueClone)) return;
        oldValueClone = newValueClone;
      }
      numCallbacks++;
      if (unwatch || options && options.immediate) {
        callbackFn(newValue, oldValue);
        angular.digest();
      } else {
        // Delay the immediate callback until we've had a chance to return the unwatch function.
        Promise.resolve().then(() => {
          const vm = options && options.vm;
          if (numCallbacks > 1 || (vm && vm.$destroyed)) return;
          callbackFn(newValue, oldValue);
          // No need to digest since under Angular we'll be using $q as Promise.
        });
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
    return stats;
  }

  static connectWorker(webWorker, config) {
    if (bridge) throw new Error('Worker already connected');
    if (_.isString(webWorker)) {
      const Worker = window.SharedWorker || window.Worker;
      if (!Worker) throw new Error('Browser does not implement Web Workers');
      webWorker = new Worker(webWorker);
      webWorker.lockName = `truss_worker_lock_${Date.now()}.${Math.random()}`;
      navigator.locks.request(webWorker.lockName, new Promise(_.noop));
    }
    bridge = new Bridge(webWorker);
    if (logging) bridge.enableLogging(logging);
    return bridge.init(webWorker.lockName, config).then(
      ({exposedFunctionNames, firebaseSdkVersion}) => {
        Object.defineProperty(Truss, 'FIREBASE_SDK_VERSION', {value: firebaseSdkVersion});
        for (const name of exposedFunctionNames) Truss.preExpose(name);
      }
    );
  }

  static get worker() {return workerFunctions;}

  static preExpose(functionName) {
    const segments = functionName.split('.');
    let obj = Truss.worker;
    for (const segment of segments.slice(0, -1)) {
      if (!Object.hasOwnProperty.call(obj, segment)) obj[segment] = {};
      obj = obj[segment];
    }
    obj[segments[segments.length - 1]] = bridge.bindExposedFunction(functionName);
  }

  static bounceConnection() {return bridge.bounceConnection();}
  static suspend() {return bridge.suspend();}
  static debugPermissionDeniedErrors(simulatedTokenGenerator, maxSimulationDuration, callFilter) {
    return bridge.debugPermissionDeniedErrors(
      simulatedTokenGenerator, maxSimulationDuration, callFilter);
  }

  static debounceAngularDigest(wait) {
    angular.debounceDigest(wait);
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
  Model: {value: Object},

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
    }
  }}
});

angular.defineModule(Truss);
