import angular from './angularCompatibility.js';
import Coupler from './Coupler.js';
import Modeler from './Modeler.js';
import Reference from './Reference.js';
import {escapeKey, escapeKeys, unescapeKey, joinPath, splitPath} from './utils/paths.js';
import {wrapPromiseCallback} from './utils/promises.js';
import {SERVER_TIMESTAMP} from './utils/utils.js';

import _ from 'lodash';
import Vue from 'vue';


class Transaction {
  constructor(ref) {
    this._ref = ref;
    this._outcome = undefined;
    this._values = undefined;
  }

  get currentValue() {return this._ref.value;}
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
    this._initialized = false;
    this._modeler = new Modeler(truss.constructor.VERSION === 'dev');
    this._coupler = new Coupler(
      rootUrl, bridge, dispatcher, this._integrateSnapshot.bind(this), this._prune.bind(this));
    this._vue = new Vue({data: {$root: undefined}});
    Object.seal(this);
    // Call this.init(classes) to complete initialization; we need two phases so that truss can bind
    // the tree into its own accessors prior to defining computed functions, which may try to
    // access the tree root via truss.
  }

  get root() {
    if (!this._vue.$data.$root) {
      this._vue.$data.$root = this._createObject('/');
      this._fixObject(this._vue.$data.$root);
      this._completeCreateObject(this._vue.$data.$root);
      angular.digest();
    }
    return this._vue.$data.$root;
  }

  get truss() {
    return this._truss;
  }

  init(classes) {
    if (this._initialized) {
      throw new Error('Data objects already created, too late to mount classes');
    }
    this._initialized = true;
    this._modeler.init(classes, !this._vue.$data.$root);
    const createdObjects = [];
    this._plantPlaceholders(this.root, '/', undefined, createdObjects);
    for (const object of createdObjects) this._completeCreateObject(object);
  }

  destroy() {
    this._coupler.destroy();
    if (this._modeler) this._modeler.destroy();
    this._vue.$destroy();
  }

  connectReference(ref, method) {
    this._checkHandle(ref);
    const operation = this._dispatcher.createOperation('read', method, ref);
    let unwatch;
    operation._disconnect = this._disconnectReference.bind(this, ref, operation, unwatch);
    this._dispatcher.begin(operation).then(() => {
      if (operation.running && !operation._disconnected) {
        this._coupler.couple(ref.path, operation);
        operation._coupled = true;
      }
    }).catch(_.noop);  // ignore exception, let onFailure handlers deal with it
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
    this._dispatcher.end(operation, error).catch(_.noop);
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
    }).catch(_.noop);  // ignore exception, let onFailure handlers deal with it
    return operation._disconnect;
  }

  _disconnectQuery(query, operation, error) {
    if (operation._disconnected) return;
    operation._disconnected = true;
    if (operation._coupled) {
      this._coupler.unsubscribe(query, operation);  // will call back to _prune if necessary
      operation._coupled = false;
    }
    this._dispatcher.end(operation, error).catch(_.noop);
  }

  isQueryReady(query) {
    return this._coupler.isQueryReady(query);
  }

  _checkHandle(handle) {
    if (!handle.belongsTo(this._truss)) {
      throw new Error('Reference belongs to another Truss instance');
    }
  }

  throttleRemoteDataUpdates(delay) {
    this._coupler.throttleSnapshots(delay);
  }

  update(ref, method, values) {
    values = _.mapValues(values, value => escapeKeys(value));
    const numValues = _.size(values);
    if (!numValues) return Promise.resolve();
    if (method === 'update' || method === 'override') {
      checkUpdateHasOnlyDescendantsWithNoOverlap(ref.path, values);
    }
    if (this._applyLocalWrite(values, method === 'override')) return Promise.resolve();
    const pathPrefix = extractCommonPathPrefix(values);
    relativizePaths(pathPrefix, values);
    if (pathPrefix !== ref.path) ref = new Reference(ref._tree, pathPrefix, ref._annotations);
    const url = this._rootUrl + pathPrefix;
    const writeSerial = this._writeSerial;
    const set = numValues === 1;
    const operand = set ? values[''] : values;
    return this._dispatcher.execute('write', set ? 'set' : 'update', ref, operand, () => {
      if (set) return this._bridge.set(url, operand, writeSerial);
      return this._bridge.update(url, operand, writeSerial);
    });
  }

  commit(ref, updateFunction) {
    let tries = 0;
    updateFunction = wrapPromiseCallback(updateFunction);

    const attemptTransaction = () => {
      if (tries++ >= 25) {
        return Promise.reject(new Error('Transaction needed too many retries, giving up'));
      }
      const txn = new Transaction(ref);
      let oldValue;
      // Ensure that Vue's watcher queue gets emptied and computed properties are up to date before
      // running the updateFunction.
      return Vue.nextTick().then(() => {
        oldValue = toFirebaseJson(txn.currentValue);
        return updateFunction(txn);
      }).then(() => {
        if (!_.isEqual(oldValue, toFirebaseJson(txn.currentValue))) return attemptTransaction();
        if (txn.outcome === 'abort') return txn;  // early return to save time
        const values = _.mapValues(txn.values, value => escapeKeys(value));
        switch (txn.outcome) {
          case 'cancel':
            break;
          case 'set':
            if (this._applyLocalWrite({[ref.path]: values['']})) return Promise.resolve();
            break;
          case 'update':
            checkUpdateHasOnlyDescendantsWithNoOverlap(ref.path, values);
            if (this._applyLocalWrite(values)) return Promise.resolve();
            relativizePaths(ref.path, values);
            break;
          default:
            throw new Error('Invalid transaction outcome: ' + (txn.outcome || 'none'));
        }
        return this._bridge.transaction(
          this._rootUrl + ref.path, oldValue, values, this._writeSerial
        ).then(result => {
          _.forEach(result.snapshots, snapshot => this._integrateSnapshot(snapshot));
          return result.committed ? txn : attemptTransaction();
        });
      });
    };

    return this._truss.peek(ref, () => {
      return this._dispatcher.execute('write', 'commit', ref, undefined, attemptTransaction);
    });
  }

  _applyLocalWrite(values, override) {
    // TODO: correctly apply local writes that impact queries.  Currently, a local write will update
    // any objects currently selected by a query, but won't add or remove results.
    this._writeSerial++;
    this._localWriteTimestamp = this._truss.now;
    const createdObjects = [];
    let numLocal = 0;
    _.forEach(values, (value, path) => {
      const local = this._modeler.isLocal(path, value);
      if (local) numLocal++;
      const coupledDescendantPaths =
        local ? {[path]: true} : this._coupler.findCoupledDescendantPaths(path);
      if (_.isEmpty(coupledDescendantPaths)) return;
      const offset = (path === '/' ? 0 : path.length) + 1;
      for (const descendantPath in coupledDescendantPaths) {
        const subPath = descendantPath.slice(offset);
        let subValue = value;
        if (subPath && value !== null && value !== undefined) {
          for (const segment of splitPath(subPath)) {
            subValue = subValue.$data[segment];
            if (subValue === undefined) break;
          }
        }
        if (subValue === undefined || subValue === null) {
          this._prune(descendantPath);
        } else {
          const key = _.last(splitPath(descendantPath));
          this._plantValue(
            descendantPath, key, subValue,
            this._scaffoldAncestors(descendantPath, false, createdObjects), false, override, local,
            createdObjects
          );
        }
        if (!override && !local) this._localWrites[descendantPath] = this._writeSerial;
      }
    });
    for (const object of createdObjects) this._completeCreateObject(object);
    if (numLocal && numLocal < _.size(values)) {
      throw new Error('Write on a mix of local and remote tree paths.');
    }
    return override || !!numLocal;
  }

  /**
   * Creates a Truss object and sets all its basic properties: path segment variables, user-defined
   * properties, and computed properties.  The latter two will be enumerable so that Vue will pick
   * them up and make the reactive, so you should call _completeCreateObject once it's done so and
   * before any Firebase properties are added.
   */
  _createObject(path, parent) {
    if (!this._initialized && path !== '/') this.init();
    const properties = {
      // We want Vue to wrap this; we'll make it non-enumerable in _fixObject.
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
  _fixObject(object) {
    for (const name of Object.getOwnPropertyNames(object)) {
      const descriptor = Object.getOwnPropertyDescriptor(object, name);
      if (descriptor.configurable && descriptor.enumerable) {
        descriptor.enumerable = false;
        if (_.startsWith(name, '$')) descriptor.configurable = false;
        Object.defineProperty(object, name, descriptor);
      }
    }
  }

  // To be called on the result of _createObject after _fixObject, and after any additional Firebase
  // properties have been set, to run initialiers.
  _completeCreateObject(object) {
    if (object.hasOwnProperty('$$initializers')) {
      for (const fn of object.$$initializers) fn(this._vue);
      delete object.$$initializers;
    }
  }

  _destroyObject(object) {
    if (!(object && object.$truss) || object.$destroyed) return;
    this._modeler.destroyObject(object);
    // Normally we'd only destroy enumerable children, which are the Firebase properties.  However,
    // clients have the option of creating hidden placeholders, so we need to scan non-enumerable
    // properties as well.  To distinguish such placeholders from the myriad other non-enumerable
    // properties (that lead all over tree, e.g. $parent), we check that the property's parent is
    // ourselves before destroying.
    for (const key of Object.getOwnPropertyNames(object)) {
      const child = object.$data[key];
      if (child && child.$parent === object) this._destroyObject(child);
    }
  }

  _integrateSnapshot(snap) {
    _.forEach(this._localWrites, (writeSerial, path) => {
      if (snap.writeSerial >= writeSerial) delete this._localWrites[path];
    });
    if (snap.exists) {
      const createdObjects = [];
      const parent = this._scaffoldAncestors(snap.path, true, createdObjects);
      if (parent) {
        this._plantValue(
          snap.path, snap.key, snap.value, parent, true, false, false, createdObjects);
      }
      for (const object of createdObjects) this._completeCreateObject(object);
    } else {
      this._prune(snap.path, null, true);
    }
  }

  _scaffoldAncestors(path, remoteWrite, createdObjects) {
    let object;
    const segments = _.dropRight(splitPath(path, true));
    let ancestorPath = '/';
    for (let i = 0; i < segments.length; i++) {
      const segment = segments[i];
      const key = unescapeKey(segment);
      let child = segment ? object.$data[key] : this.root;
      if (segment) ancestorPath += (ancestorPath === '/' ? '' : '/') + segment;
      if (child) {
        if (remoteWrite && this._localWrites[ancestorPath]) return;
      } else {
        child = this._plantValue(
          ancestorPath, key, {}, object, remoteWrite, false, false, createdObjects);
        if (!child) return;
      }
      object = child;
    }
    return object;
  }

  _plantValue(path, key, value, parent, remoteWrite, override, local, createdObjects) {
    if (remoteWrite && (value === null || value === undefined)) {
      throw new Error(`Snapshot includes invalid value at ${path}: ${value}`);
    }
    if (remoteWrite && this._localWrites[path || '/']) return;
    if (value === SERVER_TIMESTAMP) value = this._localWriteTimestamp;
    let object = parent.$data[key];
    if (!_.isArray(value) && !(local ? _.isPlainObject(value) : _.isObject(value))) {
      this._destroyObject(object);
      this._setFirebaseProperty(parent, key, value);
      return;
    }
    let objectCreated = false;
    if (!_.isObject(object)) {
      // Need to pre-set the property, so that if the child object attempts to watch any of its own
      // properties while being created the $$touchThis method has something to add a dependency on
      // as the object's own properties won't be made reactive until *after* it's been created.
      this._setFirebaseProperty(parent, key, null);
      object = this._createObject(path, parent);
      this._setFirebaseProperty(parent, key, object, object.$hidden);
      this._fixObject(object);
      createdObjects.push(object);
      objectCreated = true;
    }
    if (override) {
      Object.defineProperty(object, '$overridden', {get: _.constant(true), configurable: true});
    } else if (object.$overridden) {
      delete object.$overridden;
    }
    // Plant hidden placeholders first, so their computed watchers will have a similar precedence to
    // the parent object, and the parent object's other children will get computed first.  This can
    // optimize updates when parts of a complex model are broken out into hidden sub-models, and
    // shouldn't risk being overwritten by actual Firebase data since that will rarely (never?) be
    // hidden.
    if (objectCreated) this._plantPlaceholders(object, path, true, createdObjects);
    _.forEach(value, (item, escapedChildKey) => {
      this._plantValue(
        joinPath(path, escapedChildKey), unescapeKey(escapedChildKey), item, object, remoteWrite,
        override, local, createdObjects
      );
    });
    if (objectCreated) {
      this._plantPlaceholders(object, path, false, createdObjects);
    } else {
      _.forEach(object, (item, childKey) => {
        const escapedChildKey = escapeKey(childKey);
        if (!value.hasOwnProperty(escapedChildKey)) {
          this._prune(joinPath(path, escapedChildKey), null, remoteWrite);
        }
      });
    }
    return object;
  }

  _plantPlaceholders(object, path, hidden, createdObjects) {
    this._modeler.forEachPlaceholderChild(path, mount => {
      if (hidden !== undefined && hidden !== !!mount.hidden) return;
      const key = unescapeKey(mount.escapedKey);
      if (!object.hasOwnProperty(key)) {
        this._plantValue(
          joinPath(path, mount.escapedKey), key, mount.placeholder, object, false, false, false,
          createdObjects);
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
        const segments = splitPath(localWritePath, true);
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
    let targetKey;
    const targetParentPath = targetPath.replace(/\/[^/]+$/, match => {
      targetKey = unescapeKey(match.slice(1));
      return '';
    });
    while (object !== undefined && object !== this.root) {
      const parent =
        object && object.$parent || object === targetObject && this.getObject(targetParentPath);
      if (!this._modeler.isPlaceholder(object && object.$path || targetPath)) {
        const ghostObjects = deleted ? null : [targetObject];
        if (!this._holdsConcreteData(object, ghostObjects)) {
          deleted = true;
          this._deleteFirebaseProperty(
            parent, object && object.$key || object === targetObject && targetKey);
        }
      }
      object = parent;
    }
    return deleted;
  }

  _holdsConcreteData(object, ghostObjects) {
    if (object === undefined || object === null) return false;
    if (ghostObjects && _.includes(ghostObjects, object)) return false;
    if (!_.isObject(object) || !object.$truss) return true;
    return _.some(object, value => this._holdsConcreteData(value, ghostObjects));
  }

  _pruneDescendants(object, lockedDescendantPaths) {
    if (lockedDescendantPaths[object.$path]) return true;
    if (object.$overridden) delete object.$overridden;
    let coupledDescendantFound = false;
    _.forEach(object, (value, key) => {
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

  getObject(path) {
    const segments = splitPath(path);
    let object;
    for (const segment of segments) {
      object = segment ? object.$data[segment] : this.root;
      if (object === undefined) return;
    }
    return object;
  }

  _getFirebasePropertyDescriptor(object, data, key) {
    const descriptor = Object.getOwnPropertyDescriptor(data, key);
    if (descriptor) {
      if (!descriptor.enumerable) {
        throw new Error(
          `Key conflict between Firebase and instance or computed properties at ` +
          `${object.$path}: ${key}`);
      }
      if (!descriptor.get || !descriptor.set) {
        throw new Error(`Unbound property at ${object.$path}: ${key}`);
      }
    } else if (key in data) {
      throw new Error(
        `Key conflict between Firebase and inherited property at ${object.$path}: ${key}`);
    }
    return descriptor;
  }

  _setFirebaseProperty(object, key, value, hidden) {
    const data = object.hasOwnProperty('$data') ? object.$data : object;
    let descriptor = this._getFirebasePropertyDescriptor(object, data, key);
    if (descriptor) {
      if (hidden) {
        // Redefine property as hidden after it's been created, since we usually don't know whether
        // it should be hidden until too late.  This is a one-way deal -- you can't unhide a
        // property later, but that's fine for our purposes.
        Object.defineProperty(data, key, {
          get: descriptor.get, set: descriptor.set, configurable: true, enumerable: false
        });
      }
      if (data[key] === value) return;
      this._firebasePropertyEditAllowed = true;
      data[key] = value;
      this._firebasePropertyEditAllowed = false;
    } else {
      Vue.set(data, key, value);
      descriptor = Object.getOwnPropertyDescriptor(data, key);
      Object.defineProperty(data, key, {
        get: descriptor.get, set: this._overwriteFirebaseProperty.bind(this, descriptor, key),
        configurable: true, enumerable: !hidden
      });
    }
    angular.digest();
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
    const data = object.hasOwnProperty('$data') ? object.$data : object;
    // Make sure it's actually a Firebase property.
    this._getFirebasePropertyDescriptor(object, data, key);
    this._destroyObject(data[key]);
    Vue.delete(data, key);
    angular.digest();
  }

  checkVueObject(object, path) {
    this._modeler.checkVueObject(object, path);
  }
}


export function checkUpdateHasOnlyDescendantsWithNoOverlap(rootPath, values) {
  // First, check all paths for correctness and absolutize them, since there could be a mix of
  // absolute paths and relative keys.
  _.forEach(_.keys(values), path => {
    if (path.charAt(0) === '/') {
      if (!(path === rootPath || rootPath === '/' ||
            _.startsWith(path, rootPath + '/') && path.length > rootPath.length + 1)) {
        throw new Error(`Update item is not a descendant of target ref: ${path}`);
      }
    } else {
      if (_.includes(path, '/')) {
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
  _.forEach(values, (value, path) => {
    for (const otherPath of allPaths) {
      if (otherPath.length > path.length) break;
      if (path !== otherPath && _.startsWith(path, otherPath)) {
        throw new Error(`Update items overlap: ${otherPath} and ${path}`);
      }
    }
  });
}

export function extractCommonPathPrefix(values) {
  let prefixSegments;
  _.forEach(values, (value, path) => {
    const segments = path === '/' ? [''] : splitPath(path, true);
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
  return prefixSegments.length === 1 ? '/' : prefixSegments.join('/');
}

export function relativizePaths(rootPath, values) {
  const offset = rootPath === '/' ? 1 : rootPath.length + 1;
  _.forEach(_.keys(values), path => {
    values[path.slice(offset)] = values[path];
    delete values[path];
  });
}

export function toFirebaseJson(object) {
  if (!_.isObject(object)) return object;
  const result = {};
  for (const key in object) {
    if (object.hasOwnProperty(key)) result[escapeKey(key)] = toFirebaseJson(object[key]);
  }
  return result;
}

