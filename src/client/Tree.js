import angularCompatibility from './angularCompatibility.js';
import Coupler from './Coupler.js';
import Modeler from './Modeler.js';
import {escapeKey, unescapeKey} from './utils.js';

import _ from 'lodash';
import Vue from 'vue';

export default class Tree {
  constructor(truss, rootUrl, bridge, dispatcher, classes) {
    this._truss = truss;
    this._rootUrl = rootUrl;
    this._bridge = bridge;
    this._dispatcher = dispatcher;
    this._firebasePropertyEditAllowed = false;
    this._coupler = new Coupler(
      rootUrl, bridge, dispatcher, this._integrateSnapshot.bind(this), this._prune.bind(this));
    this._vue = new Vue({data: {$root: undefined}});
    if (angularCompatibility.active) {
      this._vue.$watch('$data', angularCompatibility.digest, {deep: true});
    }
    this._modeler = new Modeler(classes);
    this._vue.$data.$root = this._createObject('/', '');
    this._completeCreateObject(this.root);
    this._plantPlaceholders(this.root, '/');
  }

  get root() {
    return this._vue.$data.$root;
  }

  destroy() {
    this._coupler.destroy();
    this._modeler.destroy();
    this._vue.$destroy();
  }

  connectReference(ref, valueCallback) {
    this._checkHandle(ref);
    const operation = this._dispatcher.createOperation('read', 'connect', ref);
    let unwatch;
    if (valueCallback) {
      const segments = _(ref.path).split('/').map(segment => unescapeKey(segment)).value();
      unwatch = this._vue.$watch(this._getObject.bind(segments), valueCallback);
    }
    operation._disconnect = this._disconnectReference.bind(this, ref, operation, unwatch);
    this._dispatcher.begin(operation).then(() => {
      if (operation.running) this._coupler.couple(ref.path, operation);
    }).catch(e => {});  // ignore exception, let onFailure handlers deal with it
    return operation._disconnect;
  }

  _disconnectReference(ref, operation, unwatch, error) {
    if (operation._disconnected) return;
    operation._disconnected = true;
    if (unwatch) unwatch();
    this._coupler.decouple(ref.path, operation);  // will call back to _prune if necessary
    this._dispatcher.end(operation, error).catch(e => {});
  }

  fetchReference(ref) {
    this._checkHandle(ref);
    return this._dispatcher.execute('read', 'get', ref, () => {
      if (this.isReferenceReady(ref)) return this._getObject(ref.path);
      this._bridge.once(this._rootUrl + ref.path, null, 'value').then(snap => {
        this._coupler.couple(ref.path);
        try {
          this._integrateSnapshot(snap);
          const result = this._getObject(ref.path);
          return result;
        } finally {
          this._coupler.decouple(ref.path);
        }
      });
    });
  }

  isReferenceReady(ref) {
    this._checkHandle(ref);
    return this._coupler.isSubtreeReady(ref.path);
  }

  connectQuery(query, keysCallback) {
    this._checkHandle(query);
    const operation = this._dispatcher.createOperation('read', 'connect', query);
    operation._disconnect = this._disconnectQuery.bind(this, query, operation);
    this._dispatcher.begin(operation).then(() => {
      if (operation.running) this._coupler.subscribe(query, operation, keysCallback);
    }).catch(e => {});  // ignore exception, let onFailure handlers deal with it
    return operation._disconnect;
  }

  _disconnectQuery(query, operation, error) {
    if (operation._disconnected) return;
    operation._disconnected = true;
    this._coupler.unsubscribe(query, operation);  // will call back to _prune if necessary
    this._dispatcher.end(operation, error).catch(e => {});
  }

  fetchQuery(query) {
    this._checkHandle(query);
    return this._dispatcher.execute('read', 'get', query, () => {
      const queryKeys = this._coupler.getQueryKeys(query);
      if (queryKeys) {
        const result = {};
        if (queryKeys.length) {
          const container = this._getObject(query.path);
          _.each(queryKeys, key => {result[key] = container[key];});
        }
        return result;
      } else {
        this._bridge.once(this._rootUrl + query.path, query._terms, 'value').then(snap => {
          const result = {};
          const queryKeys = _.keys(snap.value);
          if (queryKeys.length) {
            this._coupler.couple(query.path);
            try {
              this._integrateSnapshot(snap);
              const container = this._getObject(query.path);
              _.each(queryKeys, key => {result[key] = container[key];});
            } finally {
              this._coupler.decouple(query.path);
            }
          }
          return result;
        });
      }
    });
  }

  isQueryReady(query) {
    return this._coupler.isQueryReady(query);
  }

  _checkHandle(handle) {
    if (handle._tree !== this) throw new Error('Reference belongs to another Truss instance');
  }

  /**
   * Creates a Truss object and sets all its basic properties: path segment variables, user-defined
   * properties, and computed properties.  The latter two will be enumerable so that Vue will pick
   * them up and make the reactive, so you should call _completeCreateObject once it's done so and
   * before any Firebase properties are added.
   */
  _createObject(path, key, parent) {
    if (parent && _.has(parent, key)) throw new Error(`Duplicate object created for ${path}`);
    let properties = {
      $truss: {value: this._truss, writable: false, configurable: false, enumerable: false},
      // We want Vue to wrap this; we'll make it non-enumerable in _completeCreateObject.
      $parent: {value: parent, writable: false, configurable: true, enumerable: true},
      $key: {value: key, writable: false, configurable: false, enumerable: false},
      $path: {value: path, writable: false, configurable: false, enumerable: false}
    };

    const touchThis = parent ? () => parent[key] : () => this._vue.$data.$root;
    const object = this._modeler.createObject(path, properties, touchThis);
    Object.defineProperties(object, properties);
    return object;
  }

  // To be called on the result of _createObject after it's been inserted into the _vue hierarchy
  // and Vue has had a chance to initialize it.
  _completeCreateObject(object) {
    for (let name of Object.getOwnPropertyNames(object)) {
      const descriptor = Object.getOwnPropertyDescriptor(object, name);
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
      for (let fn of object.__initializers__) fn(this._vue);
    }
  }

  _destroyObject(object) {
    if (!(object && object.$truss)) return;
    if (object.__destructors__) {
      for (let fn of object.__destructors__) fn();
    }
    for (let key in object) {
      if (!Object.hasOwnProperty(object, key)) continue;
      this._destroyObject(object[key]);
    }
  }

  _integrateSnapshot(snap) {
    if (snap.exists) {
      this._plantValue(snap.path, snap.key, snap.value, this._scaffoldAncestors(snap.path));
    } else {
      this._prune(snap.path);
    }
  }

  _scaffoldAncestors(path) {
    let object;
    const segments = _(path).split('/').dropRight().value();
    _.each(segments, (segment, i) => {
      const childKey = unescapeKey(segment);
      let child = childKey ? object[childKey] : this.root;
      if (!child) {
        child = this._plantValue(segments.slice(0, i + 1).join('/'), childKey, {}, object);
      }
      object = child;
    });
    return object;
  }

  _plantValue(path, key, value, parent) {
    if (value === null || value === undefined) {
      throw new Error('Snapshot includes invalid value: ' + value);
    }
    if (!_.isArray(value) && !_.isObject(value)) {
      this._setFirebaseProperty(parent, key, value);
      return;
    }
    let object = parent[key];
    if (object === undefined) {
      object = this._createObject(path, key, parent);
      this._setFirebaseProperty(parent, key, object);
      this._completeCreateObject(object);
    }
    _.each(value, (item, escapedChildKey) => {
      this._plantValue(joinPath(path, escapedChildKey), unescapeKey(escapedChildKey), item, object);
    });
    _.each(object, (item, childKey) => {
      const escapedChildKey = escapeKey(childKey);
      if (!value.hasOwnProperty(escapedChildKey)) {
        this._prune(joinPath(path, escapedChildKey));
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

  _prune(path, coupledDescendantPaths) {
    const object = this._getObject(path);
    if (coupledDescendantPaths && coupledDescendantPaths.length || !this._pruneAncestors(object)) {
      // The target object is a placeholder, and all ancestors are placeholders or otherwise needed
      // as well, so we can't delete it.  Instead, dive into its descendants to delete what we can.
      this._pruneDescendants(object, coupledDescendantPaths);
    }
  }

  _pruneAncestors(targetObject) {
    // Destroy the child (unless it's a placeholder that's still needed) and any ancestors that
    // are no longer needed to keep this child rooted, and have no other reason to exist.
    let deleted = false;
    let object = targetObject;
    while (object && object !== this.root) {
      if (!this._modeler.isPlaceholder(object.$path)) {
        const ghostObjects = deleted ? null : [targetObject];
        if (!this._holdsConcreteData(object, ghostObjects)) {
          deleted = true;
          this._deleteFirebaseProperty(object.$parent, object.$key);
        }
      }
      object = object.$parent;
    }
    return deleted;
  }

  _holdsConcreteData(object, ghostObjects) {
    if (ghostObjects && _.contains(ghostObjects, object)) return false;
    if (_.some(object, value => !value.$truss)) return true;
    return _.some(object, value => this._holdsConcreteData(value, ghostObjects));
  }

  _pruneDescendants(object, coupledDescendantPaths) {
    if (coupledDescendantPaths[object.$path]) return true;
    let coupledDescendantFound = false;
    _.each(object, (value, key) => {
      let shouldDelete = true;
      let valueCoupled;
      if (coupledDescendantPaths[joinPath(object.$path, escapeKey(key))]) {
        shouldDelete = false;
        valueCoupled = true;
      } else if (value.$truss) {
        if (this._modeler.isPlaceholder(value.$path)) {
          valueCoupled = this._pruneDescendants(value, coupledDescendantPaths);
          shouldDelete = false;
        } else if (_.has(coupledDescendantPaths, value.$path)) {
          valueCoupled = this._pruneDescendants(value);
          shouldDelete = !valueCoupled;
        }
      }
      if (shouldDelete) this._deleteFirebaseProperty(object, key);
      coupledDescendantFound = coupledDescendantFound || valueCoupled;
    });
    return coupledDescendantFound;
  }

  _getObject(pathOrSegments) {
    let object;
    const segments = _.isString(pathOrSegments) ?
      _(pathOrSegments).split('/').map(unescapeKey).value() : pathOrSegments;
    for (let segment of segments) {
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
        get: descriptor.get,
        set: function(newValue) {
          if (!this._firebasePropertyEditAllowed) {
            throw new Error(`Firebase data cannot be mutated directly: ${key}`);
          }
          descriptor.set.call(this, newValue);
        },
        configurable: true, enumerable: true
      });
    }
  }

  _deleteFirebaseProperty(object, key) {
    // Make sure it's actually a Firebase property.
    this._getFirebasePropertyDescriptor(object, key);
    this._destroyObject(object[key]);
    Vue.delete(object, key);
  }

  static get computedPropertyStats() {
    return Modeler.computedPropertyStats;
  }
}


function throwReadOnlyError() {throw new Error('Read-only property');}

function joinPath() {
  const segments = [];
  for (let segment of arguments) {
    if (segment.charAt(0) === '/') segments.splice(0, segments.length);
    segments.push(segment);
  }
  if (segments[0] === '/') segments[0] = '';
  return segments.join('/');
}

