import Couplings from './Couplings.js';
import Mountings from './Mountings.js';
import {escapeKey, unescapeKey} from './utils.js';

import _ from 'lodash';
import Vue from 'vue';

export default class Tree {
  constructor(truss, rootUrl, bridge, classes) {
    this._truss = truss;
    this._bridge = bridge;
    this._firebasePropertyEditAllowed = false;
    this._couplings = new Couplings(rootUrl, bridge, this._integrateSnapshot.bind(this));
    this._vue = new Vue({data: {$root: undefined}});
    this._mountings = new Mountings(classes);
    this._vue.$data.$root = this._createObject('/', '');
    this._completeCreateObject(this.root);
    this._plantPlaceholders(this.root, '/');
  }

  get root() {
    return this._vue.$data.$root;
  }

  destroy() {
    this._couplings.destroy();
    this._vue.$destroy();
  }

  connect(query) {
    if (!query.belongsTo(this._truss)) {
      throw new Error('Reference belongs to another Truss instance');
    }
  }

  disconnect(query) {
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
      // We want Vue to wrap this; we'll hide it in _completeCreateObject.
      $parent: {value: parent, writable: false, configurable: true, enumerable: true},
      $key: {value: key, writable: false, configurable: false, enumerable: false},
      $path: {value: path, writable: false, configurable: false, enumerable: false}
    };

    const touchThis = parent ? () => parent[key] : () => this._vue.$data.$root;
    const object = this._mountings.createObject(path, properties, touchThis);
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
    if (!(object && object.$$truss)) return;
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
      this._harvestValue(snap.path);
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
        this._harvestValue(joinPath(path, escapedChildKey));
      }
    });
    this._plantPlaceholders(object, path);
    return object;
  }

  _plantPlaceholders(object, path) {
    this._mountings.forEachPlaceholderChild(path, (escapedKey, placeholder) => {
      const key = unescapeKey(escapedKey);
      if (!object.hasOwnProperty(key)) {
        this._plantValue(joinPath(path, escapedKey), key, placeholder, object);
      }
    });
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

  _harvestValue(path) {
    let object;
    const segments = path.split('/');
    const key = unescapeKey(segments.pop());
    _.each(segments, segment => {
      const childKey = unescapeKey(segment);
      object = childKey ? object[childKey] : this.root;
      if (!object) return false;
    });
    if (!object) return;
    this._deleteFirebaseProperty(object, key);
  }

  _deleteFirebaseProperty(object, key) {
    // Destroy the child (unless it's a placeholder that's still needed) and any ancestors that
    // are no longer needed to keep this child rooted, and have no other reason to exist.
    let descriptor = this._getFirebasePropertyDescriptor(object, key);
    if (!descriptor) return;
    object = object[key];
    let deleted = false;
    while (!this._isNeeded(object)) {
      deleted = true;
      this._destroyObject(object);
      Vue.delete(object.$parent, object.$key);
      object = object.$parent;
    }
    if (!deleted) this._deleteNonPlaceholderDescendants(object);
  }

  _isNeeded(object) {
    if (!object.$$truss) return false;
    return (
      object === this.root ||
      this._mountings.isPlaceholder(object.$path) ||
      !_(object).keys().every(key =>
        this._mountings.isPlaceholder(joinPath(object.$path, escapeKey(key)))
      )
    );
  }

  _deleteNonPlaceholderDescendants(object) {
    // The target object is a placeholder, and all ancestors are placeholders as well, so we can't
    // delete it.  Instead, dive into its descendants to delete what we can there.
    _.each(object, value => {
      if (value.$$truss && this._mountings.isPlaceholder(value.$path)) {
        this._deleteNonPlaceholderDescendants(value);
      } else {
        this._destroyObject(value);
        Vue.delete(object.$parent, object.$key);
      }
    });
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

  static get computedPropertyStats() {
    return Mountings.computedPropertyStats;
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

