'use strict';

import Tree from './Tree.js';
import KeyGenerator from './KeyGenerator.js';
import Bridge from './Bridge.js';
import angularCompatibility from './angularCompatibility.js';
import {escapeKey, unescapeKey} from './utils.js';

const TIMESTAMP = Object.freeze({'.sv': 'timestamp'});

let bridge;


// jshint latedef:false
class Truss {
// jshint latedef:nofunc

  /**
   * Create a new Truss instance, specific to a given Firebase.  There should be exactly one Truss
   * per root Firebase URL, so in most code this will be a singleton.
   *
   * @param rootUrl {String} The root URL, https://{project}.firebaseio.com.
   * @param classes {Array<Function>} A list of the classes to map onto the datastore structure.
   *    Each class must have a static $trussMount property that is a (wildcarded) datastore path, or
   *    an options object {path: string, placeholder: object}, or an array of either.
   */
  constructor(rootUrl, classes) {
    // TODO: allow rootUrl to be a test database object for testing
    this._rootUrl = rootUrl.replace(/\/$/, '');
    this._keyGenerator = new KeyGenerator();
    bridge.trackServer(this._rootUrl);
    this._tree = new Tree(this, classes);
    Object.defineProperty(this, 'root', {
      value: this._vue.$data.$root, writable: false, configurable: false, enumerable: false
    });
    if (angularCompatibility.active) {
      this._vue.$watch('$data', angularCompatibility.digest, {deep: true});
    }
  }

  destroy() {
    this.tree.destroy();
  }

  get now() {}
  newKey() {return this._keyGenerator.generateUniqueKey(this.now);}

  get user() {}
  authenticate(token) {}
  unauthenticate() {}

  interceptConnections(/* {beforeConnect: beforeFn, afterDisconnect: afterFn, onError: errorFn} */) {}
  interceptWrites(/* {beforeWrite: beforeFn, afterWrite: afterFn, onError: errorFn} */) {}
  pull(scope, connections) {}  // returns readyPromise
  bind(scope, connections) {}  // returns readyPromise
  // connections are {key: Query | Array<Reference> | fn() -> (Query | Array<Reference>)}

  static get computedPropertyStats() {return this._tree.computedPropertyStats;}

  static connectWorker(webWorker) {
    if (bridge) throw new Error('Worker already connected');
    bridge = new Bridge(webWorker);
    return bridge.init();
  }

  static preExpose(functionName) {
    Truss.worker[functionName] = bridge.bindExposedFunction(functionName);
  }

  static goOnline() {
    bridge.activate(true);
  }

  static goOffline() {
    bridge.activate(false);
  }

  static escapeKey(key) {
    return escapeKey(key);
  }

  static unescapeKey(escapedKey) {
    return unescapeKey(escapedKey);
  }

  static get TIMESTAMP() {
    return TIMESTAMP;
  }
}

[
  'onError', 'offError', 'onSlow', 'offSlow', 'bounceConnection', 'debugPermissionDeniedErrors'
].forEach(methodName => {
  Truss[methodName] = function() {return bridge[methodName].apply(bridge, arguments);};
});


Truss.DefaultTransactionOptions = Object.seal({
  applyLocally: true, nonsequential: false, safeAbort: false
});
Truss.ABORT_TRANSACTION_NOW = Object.create(null);
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
