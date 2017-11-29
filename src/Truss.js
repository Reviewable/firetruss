import _ from 'lodash';
import Vue from 'vue';
import angular from './angularCompatibility.js';
import Bridge from './Bridge.js';
import Connector from './Connector.js';
import Dispatcher from './Dispatcher.js';
import KeyGenerator from './KeyGenerator.js';
import MetaTree from './MetaTree.js';
import {Handle, Reference} from './Reference.js';
import Tree from './Tree.js';
import stats from './utils/stats.js';
import {escapeKey, unescapeKey} from './utils/paths.js';
import {wrapPromiseCallback, promiseCancel, promiseFinally} from './utils/promises.js';
import {SERVER_TIMESTAMP} from './utils/utils.js';


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
    this._metaTree = new MetaTree(this._rootUrl, bridge);
    this._tree = new Tree(this, this._rootUrl, bridge, this._dispatcher);

    Object.freeze(this);
  }

  get meta() {return this._metaTree.root;}
  get root() {return this._tree.root;}

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
    return this._dispatcher.execute('auth', 'authenticate', new Reference(this._tree, '/'), () => {
      return bridge.authWithCustomToken(this._rootUrl, token, {rememberMe: true});
    });
  }

  unauthenticate() {
    return this._dispatcher.execute(
      'auth', 'unauthenticate', new Reference(this._tree, '/'), () => {
        return bridge.unauth(this._rootUrl);
      }
    );
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
    callback = wrapPromiseCallback(callback);
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

      let unwatch = this.watch(() => connector.ready, ready => {
        if (!ready) return;
        unwatch();
        unwatch = null;
        callbackPromise = promiseFinally(
          callback(scope.result), () => {angular.digest(); callbackPromise = null; cleanup();}
        ).then(result => {resolve(result);}, error => {reject(error);});
      });

      cleanup = () => {
        if (unwatch) {unwatch(); unwatch = null;}
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

  watch(subjectFn, callbackFn, options) {
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
          if (numCallbacks > 1 || subjectFn() !== newValue) return;
          callbackFn(newValue, oldValue);
          // No need to digest since under Angular we'll be using $q as Promise.
        });
      } else {
        callbackFn(newValue, oldValue);
        angular.digest();
      }
    }, {immediate: true, deep: options && options.deep});

    if (options && options.scope) options.scope.$on('$destroy', unwatch);
    return unwatch;
  }

  when(expression, options) {
    let cleanup, timeoutHandle;
    let promise = new Promise((resolve, reject) => {
      let unwatch = this.watch(expression, value => {
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
        if (unwatch) {unwatch(); unwatch = null;}
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
  VERSION: {value: VERSION}
});

angular.defineModule(Truss);
