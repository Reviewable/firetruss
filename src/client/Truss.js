'use strict';

import Tree from './Tree.js';
import Connector from './Connector.js';
import MetaTree from './MetaTree.js';
import KeyGenerator from './KeyGenerator.js';
import Bridge from './Bridge.js';
import angularCompatibility from './angularCompatibility.js';
import {escapeKey, unescapeKey, TIMESTAMP, ABORT_TRANSACTION_NOW} from './utils.js';


let bridge;


// jshint latedef:false
class Truss {
// jshint latedef:nofunc

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

    this._metaTree = new MetaTree(this._rootUrl, bridge);
    Object.defineProperty(this, 'meta', {
      value: this._metaTree.root, writable: false, configurable: false, enumerable: false
    });

    this._tree = new Tree(this, this._rootUrl, bridge, classes);
    Object.defineProperty(this, 'root', {
      value: this._tree.root, writable: false, configurable: false, enumerable: false
    });

    if (angularCompatibility.active) {
      this._vue.$watch('$data', angularCompatibility.digest, {deep: true});
    }
  }

  destroy() {
    this._tree.destroy();
    this._metaTree.destroy();
  }

  get now() {return Date.now() + this.meta.timeOffset;}
  newKey() {return this._keyGenerator.generateUniqueKey(this.now);}

  authenticate(token) {return bridge.authWithCustomToken(this._rootUrl, token);}
  unauthenticate() {return bridge.unauth(this._rootUrl);}

  interceptConnections(/* {beforeConnect: beforeFn, afterDisconnect: afterFn, onError: errorFn} */) {}
  interceptWrites(/* {beforeWrite: beforeFn, afterWrite: afterFn, onError: errorFn} */) {}

  // connections are {key: Query | Object | fn() -> (Query | Object)}
  connect(scope, connections) {
    return new Connector(scope, connections, this._tree);
  }

  static get computedPropertyStats() {return this._tree.computedPropertyStats;}

  static connectWorker(webWorker) {
    if (bridge) throw new Error('Worker already connected');
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

  static preExpose(functionName) {
    Truss.worker[functionName] = bridge.bindExposedFunction(functionName);
  }

  static escapeKey(key) {
    return escapeKey(key);
  }

  static unescapeKey(escapedKey) {
    return unescapeKey(escapedKey);
  }

  static get TIMESTAMP() {return TIMESTAMP;}
  static get ABORT_TRANSACTION_NOW() {return ABORT_TRANSACTION_NOW;}
}

[
  'onError', 'offError', 'onSlow', 'offSlow', 'bounceConnection', 'debugPermissionDeniedErrors',
  'suspend'
].forEach(methodName => {
  Truss[methodName] = function() {
    return bridge[methodName].apply(bridge, arguments);
  };
});


Truss.worker = {};


function pathFromUrl(url) {
  return url.replace(/^https?:\/\/[^/]+/, '');
}

function getUrlRoot(url) {
  const k = url.indexOf('/', 8);
  return k >= 8 ? url.slice(0, k) : url;
}

angularCompatibility.defineModule(Truss);
export default Truss;
