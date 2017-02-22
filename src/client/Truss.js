import _ from 'lodash';
import Vue from 'vue';
import angularCompatibility from './angularCompatibility.js';
import Bridge from './Bridge.js';
import Connector from './Connector.js';
import Dispatcher from './Dispatcher.js';
import KeyGenerator from './KeyGenerator.js';
import MetaTree from './MetaTree.js';
import {Handle, Reference} from './Reference.js';
import Tree from './Tree.js';
import {escapeKey, unescapeKey, wrapPromiseCallback, SERVER_TIMESTAMP} from './utils.js';


let bridge;
const workerFunctions = {};


export default class Truss {

  /**
   * Create a new Truss instance, specific to a given datastore.  To avoid confusion there should be
   * exactly one Truss per root datastore URL, so in most code this will be a singleton.
   *
   * @param rootUrl {String} The root URL, https://{project}.firebaseio.com.
   * @param classes {Array<Function>} A list of the classes to map onto the datastore structure.
   *    Each class must have a static $trussMount property that is a (wildcarded) datastore path, or
   *    an options object {path: string, placeholder: object}, or an array of either.
   */
  constructor(rootUrl, classes) {
    // TODO: allow rootUrl to be a test database object for testing
    if (!bridge) {
      throw new Error('Truss worker not connected, please call Truss.connectWorker first');
    }
    this._rootUrl = rootUrl.replace(/\/$/, '');
    this._keyGenerator = new KeyGenerator();
    this._dispatcher = new Dispatcher(bridge);
    this._vue = new Vue();

    this._metaTree = new MetaTree(this._rootUrl, bridge);
    Object.defineProperty(this, 'meta', {
      value: this._metaTree.root, writable: false, configurable: false, enumerable: false
    });

    this._tree = new Tree(this, this._rootUrl, bridge, this._dispatcher, classes);
    Object.defineProperty(this, 'root', {
      value: this._tree.root, writable: false, configurable: false, enumerable: false
    });
  }

  destroy() {
    this._vue.$destroy();
    this._tree.destroy();
    this._metaTree.destroy();
  }

  get now() {return Date.now() + this.meta.timeOffset;}
  newKey() {return this._keyGenerator.generateUniqueKey(this.now);}

  authenticate(token) {
    return this._dispatcher.execute('auth', new Reference(this._tree, '/'), () => {
      return bridge.authWithCustomToken(this._rootUrl, token);
    });
  }
  unauthenticate() {
    return this._dispatcher.execute('auth', new Reference(this._tree, '/'), () => {
      return bridge.unauth(this._rootUrl);
    });
  }

  intercept(actionType, callbacks) {
    return this._dispatcher.intercept(actionType, callbacks);
  }

  // connections are {key: Query | Object | fn() -> (Query | Object)}
  connect(scope, connections) {
    if (!connections) {
      connections = scope;
      scope = undefined;
      if (connections instanceof Handle) connections = {_: connections};
    }
    return new Connector(scope, connections, this._tree, 'connect');
  }

  // target is Reference, Query, or connection Object like above
  peek(target, callback) {
    callback = wrapPromiseCallback(callback);
    return new Promise((resolve, reject) => {
      const scope = {};
      const connector = new Connector(scope, {result: target}, this._tree, 'peek');
      const unwatch = this._vue.$watch(() => connector.ready, ready => {
        if (!ready) return;
        unwatch();
        callback(scope.result).then(result => {
          connector.destroy();
          resolve(result);
        }, error => {
          connector.destroy();
          reject(error);
        });
      });
    });
  }

  static get computedPropertyStats() {return this._tree.computedPropertyStats;}

  static connectWorker(webWorker) {
    if (bridge) throw new Error('Worker already connected');
    if (_.isString(webWorker)) {
      const Worker = window.SharedWorker || window.Worker;
      if (!Worker) throw new Error('Browser does not implement Web Workers');
      webWorker = new Worker(webWorker);
    }
    bridge = new Bridge(webWorker);
    return bridge.init(webWorker).then(
      ({exposedFunctionNames, firebaseSdkVersion}) => {
        Truss.FIREBASE_SDK_VERSION = firebaseSdkVersion;
        for (let name of exposedFunctionNames) {
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
    angularCompatibility.debounceDigest(wait);
  }

  static escapeKey(key) {return escapeKey(key);}
  static unescapeKey(escapedKey) {return unescapeKey(escapedKey);}

  static get SERVER_TIMESTAMP() {return SERVER_TIMESTAMP;}
}

angularCompatibility.defineModule(Truss);
