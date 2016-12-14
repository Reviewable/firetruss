'use strict';

import Reference from './Reference.js';
import {unescapeKey} from './utils.js';

import _ from 'lodash';
import performanceNow from 'performance-now';
import Vue from 'vue';

// These are defined separately for each object so they're not included in Value below.
const RESERVED_VALUE_PROPERTY_NAMES = {$truss: true, $parent: true, $key: true, $path: true};

const computedPropertyStats = {};


class Value {
  get $ref() {return new Reference(this.$truss, this.$path);}
  get $refs() {return [this.$ref];}
  get $keys() {return _.keys(this);}
  get $values() {return _.values(this);}
  get $root() {return this.$truss._vue.$data.$root;}  // access via $data to leave dependency trace
  $set(value) {return this.$ref.set(value);}
  $update(values) {return this.$ref.update(values);}
  $commit(options, updateFn) {return this.$ref.commit(options, updateFn);}
  // TODO
  // $temporarilyOverride(updateFn)
  // $onPropertyChange(method)
  // $freezeProperty
}


class ComputedPropertyStats {
  constructor(name) {
    _.extend(this, {name, numRecomputes: 0, numUpdates: 0, runtime: 0});
  }
}


class Tree {
  constructor(truss, classes) {
    this._truss = truss;
    this._firebasePropertyEditAllowed = false;
    this._vue = new Vue({data: {$root: null}});
    this._mounts = _(classes).map(Class => this._mountClass(Class)).flatten().value();
    this._vue.$data.$root = this._createObject('/', '');
    // console.log(this._vue.$data.$root);
    this._completeCreateObject(this.root);
    this._plantPlaceholders(this.root, '/');
  }

  get root() {
    return this._vue.$data.$root;
  }

  destroy() {
    this._vue.$destroy();
  }

  _augmentClass(Class) {
    let computedProperties;
    let proto = Class.prototype;
    while (proto && proto.constructor !== Object) {
      for (let name of Object.getOwnPropertyNames(proto)) {
        const descriptor = Object.getOwnPropertyDescriptor(proto, name);
        if (name.charAt(0) === '$') {
          if (_.isEqual(descriptor, Object.getOwnPropertyDescriptor(Value.prototype, name))) {
            continue;
          }
          throw new Error(`Property names starting with "$" are reserved: ${Class.name}.${name}`);
        }
        if (descriptor.set) {
          throw new Error(`Computed properties must not have a setter: ${Class.name}.${name}`);
        }
        if (descriptor.get && !(computedProperties && computedProperties[name])) {
          (computedProperties || (computedProperties = {}))[name] = {
            name, fullName: `${proto.constructor.name}.${name}`, get: descriptor.get
          };
        }
      }
      proto = Object.getPrototypeOf(proto);
    }
    for (let name of Object.getOwnPropertyNames(Value.prototype)) {
      if (name === 'constructor') continue;
      Object.defineProperty(
        Class.prototype, name, Object.getOwnPropertyDescriptor(Value.prototype, name));
    }
    return computedProperties;
  }

  _mountClass(Class) {
    if (Class.$$truss) throw new Error(`Class ${Class.name} already mounted`);
    Class.$$truss = true;
    const computedProperties = this._augmentClass(Class);
    let mounts = Class.$trussMount;
    if (!mounts) throw new Error(`Class ${Class.name} lacks a $trussMount static property`);
    if (!_.isArray(mounts)) mounts = [mounts];
    return _.map(mounts, mount => {
      if (_.isString(mount)) mount = {path: mount};
      const variables = [];
      const pathTemplate = mount.path.replace(/\/\$[^\/]+/g, match => {
        variables.push(match.slice(1));
        return '\u0001';
      }).replace(/[$-.?[-^{|}]/g, '\\$&');
      for (let variable of variables) {
        if (variable === '$' || variable.charAt(1) === '$') {
          throw new Error(`Invalid variable name: ${variable}`);
        }
        if (variable.charAt(0) === '$' && (
            _.has(Value.prototype, variable) || RESERVED_VALUE_PROPERTY_NAMES[variable]
        )) {
          throw new Error(`Variable name conflicts with built-in property or method: ${variable}`);
        }
      }
      return {
        klass: Class, variables, computedProperties,
        escapedKey: mount.path.match(/\/([^/]*)$/)[1],
        placeholder: mount.placeholder,
        regex: new RegExp('^' + pathTemplate.replace(/\u0001/g, '/([^/]+)') + '$'),
        parentRegex: new RegExp(
          '^' + (pathTemplate.replace(/\/[^/]*$/, '').replace(/\u0001/g, '/([^/]+)') || '/') + '$')
      };
    });
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

    let Class = Value;
    let computedProperties;
    for (let mount of this._mounts) {
      mount.regex.lastIndex = 0;
      var match = mount.regex.exec(path);
      if (match) {
        Class = mount.klass;
        computedProperties = mount.computedProperties;
        for (let i = 0; i < mount.variables.length; i++) {
          properties[mount.variables[i]] = {
            value: unescapeKey(match[i + 1]),
            writable: false, configurable: false, enumerable: false
          };
        }
        break;
      }
    }

    const object = new Class();

    if (computedProperties) {
      const touchThis = parent ? () => parent[key] : () => this._vue.$data.$root;
      _.each(computedProperties, prop => {
        properties[prop.name] = this._buildComputedPropertyDescriptor(object, prop, touchThis);
      });
    }

    Object.defineProperties(object, properties);
    return object;
  }

  _buildComputedPropertyDescriptor(object, prop, touchThis) {
    if (!computedPropertyStats[prop.fullName]) {
      Object.defineProperty(computedPropertyStats, prop.fullName, {
        value: new ComputedPropertyStats(prop.fullName), writable: false, enumerable: true,
        configurable: false
      });
    }
    const stats = computedPropertyStats[prop.fullName];

    function computeValue() {
      // Touch this object, since a failed access to a missing property doesn't get captured as a
      // dependency.
      touchThis();

      const startTime = performanceNow();
      // jshint validthis: true
      const result = prop.get.call(this);
      // jshint validthis: false
      stats.runtime += performanceNow() - startTime;
      stats.numRecomputes += 1;
      return result;
    }

    let value;
    let writeAllowed = false;
    let firstCallback = true;

    if (!object.__destructors__) {
      Object.defineProperty(object, '__destructors__', {
        value: [], writable: false, enumerable: false, configurable: false});
    }
    if (!object.__initializers__) {
      Object.defineProperty(object, '__initializers__', {
        value: [], writable: false, enumerable: false, configurable: false});
    }
    object.__initializers__.push(() => {
      object.__destructors__.push(
        this._vue.$watch(computeValue.bind(object), newValue => {
          if (firstCallback) {
            stats.numUpdates += 1;
            value = newValue;
            firstCallback = false;
          } else {
            if (_.isEqual(value, newValue, this._isTrussEqual, this)) return;
            stats.numUpdates += 1;
            writeAllowed = true;
            object[prop.name] = newValue;
            writeAllowed = false;
          }
        }, {immediate: true})  // use immediate:true since watcher will run computeValue anyway
      );
    });
    return {
      enumerable: true, configurable: true,
      get: function() {return value;},
      set: function(newValue) {
        if (!writeAllowed) throw new Error(`You cannot set a computed property: ${prop.name}`);
        value = newValue;
      }
    };
  }

  _isTrussEqual(a, b) {
    if (a && a.$truss || b && b.$truss) return a === b;
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
      for (let fn of object.__initializers__) fn();
    }
  }

  _destroyObject(object) {
    if (object.__destructors__) {
      for (let fn of object.__destructors__) fn();
    }
    for (let key in object) {
      if (!Object.hasOwnProperty(object, key)) continue;
      const value = object[key];
      if (value && value.$truss) this._destroyObject(value);
    }
  }

  _plantSnapshotValue(snap, parent) {
    return this._plantValue(
      pathFromUrl(snap.ref().toString()), unescapeKey(snap.key()), snap.val(), parent);
  }

  _plantValue(path, key, value, parent) {
    if (!_.isArray(value) && !_.isObject(value)) {
      this._setFirebaseProperty(parent, key, value);
      return;
    }
    const object = this._createObject(path, key, parent);
    this._setFirebaseProperty(parent, key, object);
    this._completeCreateObject(object);
    _.each(value, (item, escapedChildKey) => {
      if (item === null || item === undefined) return;
      this._plantValue(
        `${joinPath(path, escapedChildKey)}`, unescapeKey(escapedChildKey), item, object);
    });
    this._plantPlaceholders(object, path);
    return object;
  }

  _plantPlaceholders(object, path) {
    _.each(this._mounts, mount => {
      const key = unescapeKey(mount.escapedKey);
      if (!object.hasOwnProperty(key) && mount.placeholder && mount.parentRegex.test(path)) {
        this._plantValue(`${joinPath(path, mount.escapedKey)}`, key, mount.placeholder, object);
      }
    });
  }

  _setFirebaseProperty(object, key, value) {
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
    if (value === null || value === undefined) {
      if (descriptor) {
        const oldValue = object[key];
        if (oldValue && oldValue.$truss) this._deleteObject(oldValue);
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
              throw new Error(`Firebase data cannot be mutated directly: ${key}`);
            }
            descriptor.set.call(this, newValue);
          },
          configurable: true, enumerable: true
        });
      }
    }
  }

  static get computedPropertyStats() {
    return computedPropertyStats;
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

export default Tree;
