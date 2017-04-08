import angularCompatibility from './angularCompatibility.js';
import Coupler from './Coupler.js';
import Modeler from './Modeler.js';
import {escapeKey, unescapeKey, joinPath, SERVER_TIMESTAMP} from './utils.js';

import _ from 'lodash';
import Vue from 'vue';


class Transaction {
  constructor(path, tree) {
    this._path = path;
    this._tree = tree;
  }

  get currentValue() {return this._tree.getObject(this._path);}
  get outcome() {return this._outcome;}
  get values() {return this._values;}

  _setOutcome(value) {
    if (this._outcome) throw new Error('Transaction already resolved with ' + this._outcome);
    this._outcome = value;
  }

  abort() {
    this._setOutcome('abort');
  }

  cancel() {
    this._setOutcome('cancel');
  }

  set(value) {
    if (value === undefined) throw new Error('Invalid argument: undefined');
    this._setOutcome('set');
    this._values = {'': value};
  }

  update(values) {
    if (values === undefined) throw new Error('Invalid argument: undefined');
    if (_.isEmpty(values)) return this.cancel();
    this._setOutcome('update');
    this._values = values;
  }
}


export default class Tree {
  constructor(truss, rootUrl, bridge, dispatcher) {
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
    if (angularCompatibility.active) {
      this._vue.$watch('$data', () => {angularCompatibility.digest();}, {deep: true});
    }
    // Call this.init(classes) to complete initialization; we need two phases so that truss can bind
    // the tree into its own accessors prior to defining computed functions, which may try to
    // access the tree root via truss.
  }

  get root() {
    return this._vue.$data.$root;
  }

  get truss() {
    return this._truss;
  }

  init(classes) {
    this._modeler = new Modeler(classes);
    this._vue.$data.$root = this._createObject('/', '');
    this._completeCreateObject(this.root);
    this._plantPlaceholders(this.root, '/');
    Object.seal(this);
  }

  destroy() {
    this._coupler.destroy();
    if (this._modeler) this._modeler.destroy();
    this._vue.$destroy();
  }

  connectReference(ref, valueCallback, method) {
    this._checkHandle(ref);
    const operation = this._dispatcher.createOperation('read', method, ref);
    let unwatch;
    if (valueCallback) {
      const segments = _(ref.path).split('/').map(segment => unescapeKey(segment)).value();
      unwatch = this._vue.$watch(
        this.getObject.bind(this, segments), valueCallback, {immediate: true});
    }
    operation._disconnect = this._disconnectReference.bind(this, ref, operation, unwatch);
    this._dispatcher.begin(operation).then(() => {
      if (operation.running && !operation._disconnected) {
        this._coupler.couple(ref.path, operation);
        operation._coupled = true;
      }
    }).catch(e => {});  // ignore exception, let onFailure handlers deal with it
    return operation._disconnect;
  }

  _disconnectReference(ref, operation, unwatch, error) {
    if (operation._disconnected) return;
    operation._disconnected = true;
    if (unwatch) unwatch();
    if (operation._coupled) {
      this._coupler.decouple(ref.path, operation);  // will call back to _prune if necessary
      operation._coupled = false;
    }
    this._dispatcher.end(operation, error).catch(e => {});
  }

  isReferenceReady(ref) {
    this._checkHandle(ref);
    return this._coupler.isSubtreeReady(ref.path);
  }

  connectQuery(query, keysCallback, method) {
    this._checkHandle(query);
    const operation = this._dispatcher.createOperation('read', method, query);
    operation._disconnect = this._disconnectQuery.bind(this, query, operation);
    this._dispatcher.begin(operation).then(() => {
      if (operation.running && !operation._disconnected) {
        this._coupler.subscribe(query, operation, keysCallback);
        operation._coupled = true;
      }
    }).catch(e => {});  // ignore exception, let onFailure handlers deal with it
    return operation._disconnect;
  }

  _disconnectQuery(query, operation, error) {
    if (operation._disconnected) return;
    operation._disconnected = true;
    if (operation._coupled) {
      this._coupler.unsubscribe(query, operation);  // will call back to _prune if necessary
      operation._coupled = false;
    }
    this._dispatcher.end(operation, error).catch(e => {});
  }

  isQueryReady(query) {
    return this._coupler.isQueryReady(query);
  }

  _checkHandle(handle) {
    if (!handle.belongsTo(this._truss)) {
      throw new Error('Reference belongs to another Truss instance');
    }
  }

  update(ref, method, values) {
    values = _.clone(values);
    let numValues = _.size(values);
    if (!numValues) return Promise.resolve();
    if (method === 'update' || method === 'override') {
      checkUpdateHasOnlyDescendantsWithNoOverlap(ref.path, values);
    }
    this._applyLocalWrite(values, method === 'override');
    if (method === 'override') return Promise.resolve();
    for (const path of _.keys(values)) {
      if (this._modeler.isLocal(path)) delete values[path];
    }
    numValues = _.size(values);
    if (!numValues) return Promise.resolve();
    const url = this._rootUrl + this._extractCommonPathPrefix(values);
    return this._dispatcher.execute('write', method, ref, () => {
      if (numValues === 1) {
        return this._bridge.set(url, values[''], this._writeSerial);
      } else {
        return this._bridge.update(url, values, this._writeSerial);
      }
    });
  }

  commit(ref, updateFunction) {
    let tries = 0;

    const attemptTransaction = () => {
      if (tries++ >= 25) return Promise.reject(new Error('maxretry'));
      const txn = new Transaction();
      try {
        updateFunction(txn);
      } catch (e) {
        return Promise.reject(e);
      }
      const values = _.clone(txn.values);
      const oldValue = toFirebaseJson(this.getObject(ref.path));
      switch (txn.outcome) {
        case 'abort': return;
        case 'cancel':
          break;
        case 'set':
          if (this._modeler.isLocal(ref.path)) {
            throw new Error(`Commit in local subtree: ${ref.path}`);
          }
          this._applyLocalWrite({[ref.path]: values['']});
          break;
        case 'update':
          checkUpdateHasOnlyDescendantsWithNoOverlap(ref.path, values);
          _(values).keys().each(path => {
            if (this._modeler.isLocal(path)) throw new Error(`Commit in local subtree: ${path}`);
          });
          this._applyLocalWrite(values);
          relativizePaths(ref.path, values);
          break;
        default:
          throw new Error('Invalid transaction outcome: ' + (txn.outcome || 'none'));
      }
      return this._bridge.transaction(
        this._rootUrl + ref.path, oldValue, values
      ).then(committed => {
        if (!committed) return attemptTransaction();
        return txn;
      });
    };

    return this._truss.peek(ref, () => {
      return this._dispatcher.execute('write', 'commit', ref, attemptTransaction);
    });
  }

  _applyLocalWrite(values, override) {
    // TODO: correctly apply local writes that impact queries.  Currently, a local write will update
    // any objects currently selected by a query, but won't add or remove results.
    this._writeSerial++;
    this._localWriteTimestamp = this._truss.now;
    _.each(values, (value, path) => {
      const local = this._modeler.isLocal(path);
      const coupledDescendantPaths =
        local ? [path] : this._coupler.findCoupledDescendantPaths(path);
      if (_.isEmpty(coupledDescendantPaths)) return;
      const offset = (path === '/' ? 0 : path.length) + 1;
      for (const descendantPath of coupledDescendantPaths) {
        const subPath = descendantPath.slice(offset);
        let subValue = value;
        if (subPath) {
          const segments = subPath.split('/');
          for (const segment of segments) {
            subValue = subValue[unescapeKey(segment)];
            if (subValue === undefined) break;
          }
        }
        if (subValue === undefined || subValue === null) {
          this._prune(subPath);
        } else {
          const key = unescapeKey(_.last(descendantPath.split('/')));
          this._plantValue(
            descendantPath, key, subValue, this._scaffoldAncestors(descendantPath), false,
            override
          );
        }
        if (!override && !local) {
          this._localWrites[descendantPath] = this._writeSerial;
        }
      }
    });
  }

  _extractCommonPathPrefix(values) {
    let prefixSegments;
    _.each(values, (value, path) => {
      const segments = path === '/' ? [''] : path.split('/');
      if (prefixSegments) {
        let firstMismatchIndex = 0;
        const maxIndex = Math.min(prefixSegments.length, segments.length);
        while (firstMismatchIndex < maxIndex &&
               prefixSegments[firstMismatchIndex] === segments[firstMismatchIndex]) {
          firstMismatchIndex++;
        }
        prefixSegments = prefixSegments.slice(0, firstMismatchIndex);
        if (!prefixSegments.length) return false;
      } else {
        prefixSegments = segments;
      }
    });
    const pathPrefix = prefixSegments.length === 1 ? '/' : prefixSegments.join('/');
    _.each(_.keys(values), key => {
      values[key.slice(pathPrefix.length + 1)] = values[key];
      delete values[key];
    });
    return pathPrefix;
  }

  /**
   * Creates a Truss object and sets all its basic properties: path segment variables, user-defined
   * properties, and computed properties.  The latter two will be enumerable so that Vue will pick
   * them up and make the reactive, so you should call _completeCreateObject once it's done so and
   * before any Firebase properties are added.
   */
  _createObject(path, key, parent) {
    let properties = {
      // We want Vue to wrap this; we'll make it non-enumerable in _completeCreateObject.
      $parent: {value: parent, configurable: true, enumerable: true},
      $path: {value: path}
    };
    if (path === '/') properties.$truss = {value: this._truss};

    const object = this._modeler.createObject(path, properties);
    Object.defineProperties(object, properties);
    return object;
  }

  // To be called on the result of _createObject after it's been inserted into the _vue hierarchy
  // and Vue has had a chance to initialize it.
  _completeCreateObject(object) {
    for (const name of Object.getOwnPropertyNames(object)) {
      const descriptor = Object.getOwnPropertyDescriptor(object, name);
      if (descriptor.configurable && descriptor.enumerable) {
        descriptor.enumerable = false;
        if (name === '$parent') descriptor.configurable = false;
        Object.defineProperty(object, name, descriptor);
      }
    }
    if (object.$$initializers) {
      for (const fn of object.$$initializers) fn(this._vue);
      delete object.$$initializers;
    }
  }

  _destroyObject(object) {
    if (!(object && object.$truss)) return;
    this._modeler.destroyObject(object);
    for (const key in object) {
      if (!Object.hasOwnProperty(object, key)) continue;
      this._destroyObject(object[key]);
    }
  }

  _integrateSnapshot(snap) {
    _.each(_.keys(this._localWrites), (writeSerial, path) => {
      if (snap.writeSerial >= writeSerial) delete this._localWrites[path];
    });
    if (snap.exists) {
      const parent = this._scaffoldAncestors(snap.path, true);
      if (parent) this._plantValue(snap.path, snap.key, snap.value, parent, true, false);
    } else {
      this._prune(snap.path, null, true);
    }
  }

  _scaffoldAncestors(path, remoteWrite) {
    let object;
    const segments = _(path).split('/').dropRight().value();
    _.each(segments, (segment, i) => {
      const childKey = unescapeKey(segment);
      let child = childKey ? object[childKey] : this.root;
      if (!child) {
        const ancestorPath = segments.slice(0, i + 1).join('/');
        if (remoteWrite && this._localWrites[ancestorPath || '/']) return;
        child = this._plantValue(ancestorPath, childKey, {}, object);
      }
      object = child;
    });
    return object;
  }

  _plantValue(path, key, value, parent, remoteWrite, override) {
    if (value === null || value === undefined) {
      throw new Error('Snapshot includes invalid value: ' + value);
    }
    if (remoteWrite && this._localWrites[path]) return;
    if (value === SERVER_TIMESTAMP) value = this._localWriteTimestamp;
    if (!_.isArray(value) && !(_.isObject(value) && value.constructor === Object)) {
      this._setFirebaseProperty(parent, key, value);
      return;
    }
    let object = parent[key];
    if (!_.isObject(object)) {
      object = this._createObject(path, key, parent);
      this._setFirebaseProperty(parent, key, object);
      this._completeCreateObject(object);
    }
    if (override) {
      Object.defineProperty(object, '$overridden', {get: _.constant(true), configurable: true});
    } else if (object.$overridden) {
      delete object.$overridden;
    }
    _.each(value, (item, escapedChildKey) => {
      this._plantValue(
        joinPath(path, escapedChildKey), unescapeKey(escapedChildKey), item, object, remoteWrite,
        override
      );
    });
    _.each(object, (item, childKey) => {
      const escapedChildKey = escapeKey(childKey);
      if (!value.hasOwnProperty(escapedChildKey)) {
        this._prune(joinPath(path, escapedChildKey), null, remoteWrite);
      }
    });
    this._plantPlaceholders(object, path);
    return object;
  }

  _plantPlaceholders(object, path) {
    this._modeler.forEachPlaceholderChild(path, (escapedKey, placeholder) => {
      const key = unescapeKey(escapedKey);
      if (!object.hasOwnProperty(key)) {
        this._plantValue(joinPath(path, escapedKey), key, placeholder, object);
      }
    });
  }

  _prune(path, lockedDescendantPaths, remoteWrite) {
    lockedDescendantPaths = lockedDescendantPaths || {};
    const object = this.getObject(path);
    if (object === undefined) return;
    if (remoteWrite && this._avoidLocalWritePaths(path, lockedDescendantPaths)) return;
    if (!(_.isEmpty(lockedDescendantPaths) && this._pruneAncestors(path, object)) &&
        _.isObject(object)) {
      // The target object is a placeholder, and all ancestors are placeholders or otherwise needed
      // as well, so we can't delete it.  Instead, dive into its descendants to delete what we can.
      this._pruneDescendants(object, lockedDescendantPaths);
    }
  }

  _avoidLocalWritePaths(path, lockedDescendantPaths) {
    for (const localWritePath in this._localWrites) {
      if (!this._localWrites.hasOwnProperty(localWritePath)) continue;
      if (path === localWritePath || localWritePath === '/' ||
          _.startsWith(path, localWritePath + '/')) return true;
      if (path === '/' || _.startsWith(localWritePath, path + '/')) {
        const segments = localWritePath.split('/');
        for (let i = segments.length; i > 0; i--) {
          const subPath = segments.slice(0, i).join('/');
          const active = i === segments.length;
          if (lockedDescendantPaths[subPath] || lockedDescendantPaths[subPath] === active) break;
          lockedDescendantPaths[subPath] = active;
          if (subPath === path) break;
        }
      }
    }
  }

  _pruneAncestors(targetPath, targetObject) {
    // Destroy the child (unless it's a placeholder that's still needed) and any ancestors that
    // are no longer needed to keep this child rooted, and have no other reason to exist.
    let deleted = false;
    let object = targetObject;
    // The target object may be a primitive, in which case it won't have $path, $parent and $key
    // properties.  In that case, use the target path to figure those out instead.  Note that all
    // ancestors of the target object will necessarily not be primitives and will have those
    // properties.
    const targetSegments = _(targetPath).split('/').map(unescapeKey).value();
    while (object && object !== this.root) {
      const parent =
        object.$parent || object === targetObject && this.getObject(targetSegments.slice(0, -1));
      if (!this._modeler.isPlaceholder(object.$path || targetPath)) {
        const ghostObjects = deleted ? null : [targetObject];
        if (!this._holdsConcreteData(object, ghostObjects)) {
          deleted = true;
          this._deleteFirebaseProperty(
            parent, object.$key || object === targetObject && _.last(targetSegments));
        }
      }
      object = parent;
    }
    return deleted;
  }

  _holdsConcreteData(object, ghostObjects) {
    if (ghostObjects && _.includes(ghostObjects, object)) return false;
    if (_.some(object, value => !value.$truss)) return true;
    return _.some(object, value => this._holdsConcreteData(value, ghostObjects));
  }

  _pruneDescendants(object, lockedDescendantPaths) {
    if (lockedDescendantPaths[object.$path]) return true;
    if (object.$overridden) delete object.$overridden;
    let coupledDescendantFound = false;
    _.each(object, (value, key) => {
      let shouldDelete = true;
      let valueLocked;
      if (lockedDescendantPaths[joinPath(object.$path, escapeKey(key))]) {
        shouldDelete = false;
        valueLocked = true;
      } else if (value.$truss) {
        const placeholder = this._modeler.isPlaceholder(value.$path);
        if (placeholder || _.has(lockedDescendantPaths, value.$path)) {
          valueLocked = this._pruneDescendants(value, lockedDescendantPaths);
          shouldDelete = !placeholder && !valueLocked;
        }
      }
      if (shouldDelete) this._deleteFirebaseProperty(object, key);
      coupledDescendantFound = coupledDescendantFound || valueLocked;
    });
    return coupledDescendantFound;
  }

  getObject(pathOrSegments) {
    let object;
    const segments = _.isString(pathOrSegments) ?
      _(pathOrSegments).split('/').map(unescapeKey).value() : pathOrSegments;
    for (const segment of segments) {
      object = segment ? object[segment] : this.root;
      if (object === undefined) return;
    }
    return object;
  }

  _getFirebasePropertyDescriptor(object, key) {
    let descriptor = Object.getOwnPropertyDescriptor(object, key);
    if (descriptor) {
      if (!descriptor.enumerable) {
        throw new Error(
          `Key conflict between Firebase and instance or computed properties at ` +
          `${object.$path}: ${key}`);
      }
      if (!descriptor.get || !descriptor.set) {
        throw new Error(`Unbound property at ${object.$path}: ${key}`);
      }
    }
    return descriptor;
  }

  _setFirebaseProperty(object, key, value) {
    let descriptor = this._getFirebasePropertyDescriptor(object, key);
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
  }

  _overwriteFirebaseProperty(descriptor, key, newValue) {
    if (!this._firebasePropertyEditAllowed) {
      const e = new Error(`Firebase data cannot be mutated directly: ${key}`);
      e.trussCode = 'firebase_overwrite';
      throw e;
    }
    descriptor.set.call(this, newValue);
  }

  _deleteFirebaseProperty(object, key) {
    // Make sure it's actually a Firebase property.
    this._getFirebasePropertyDescriptor(object, key);
    this._destroyObject(object[key]);
    Vue.delete(object, key);
  }

  checkVueObject(object, path) {
    this._modeler.checkVueObject(object, path);
  }

  static get computedPropertyStats() {
    return Modeler.computedPropertyStats;
  }
}


export function checkUpdateHasOnlyDescendantsWithNoOverlap(rootPath, values) {
  // First, check all paths for correctness and absolutize them, since there could be a mix of
  // absolute paths and relative keys.
  _.each(_.keys(values), path => {
    if (path.charAt(0) === '/') {
      if (!(path === rootPath || rootPath === '/' ||
            _.startsWith(path, rootPath + '/') && path.length > rootPath.length + 1)) {
        throw new Error(`Update item is not a descendant of target ref: ${path}`);
      }
    } else {
      if (path.indexOf('/') >= 0) {
        throw new Error(`Update item deep path must be absolute, taken from a reference: ${path}`);
      }
      const absolutePath = joinPath(rootPath, escapeKey(path));
      if (values.hasOwnProperty(absolutePath)) {
        throw new Error(`Update items overlap: ${path} and ${absolutePath}`);
      }
      values[absolutePath] = values[path];
      delete values[path];
    }
  });
  // Then check for overlaps;
  const allPaths = _(values).keys().map(path => joinPath(path, '')).sortBy('length').value();
  _.each(values, (value, path) => {
    for (const otherPath of allPaths) {
      if (otherPath.length > path.length) break;
      if (path !== otherPath && _.startsWith(path, otherPath)) {
        throw new Error(`Update items overlap: ${otherPath} and ${path}`);
      }
    }
  });
}

export function relativizePaths(rootPath, values) {
  _.each(_.keys(values), path => {
    values[path.slice(rootPath === '/' ? 1 : rootPath.length + 1)] = values[path];
    delete values[path];
  });
}

export function toFirebaseJson(object) {
  if (typeof object === 'object') {
    const result = {};
    for (const key in object) {
      if (!object.hasOwnProperty(key)) continue;
      result[escapeKey(key)] = toFirebaseJson(object[key]);
    }
    return result;
  } else {
    return object;
  }
}

