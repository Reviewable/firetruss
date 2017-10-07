import {Reference, Handle} from './Reference.js';
import angular from './angularCompatibility.js';
import stats from './utils/stats.js';
import {makePathMatcher, joinPath, splitPath, escapeKey, unescapeKey} from './utils/paths.js';
import {isTrussEqual} from './utils/utils.js';
import {promiseFinally} from './utils/promises.js';

import _ from 'lodash';
import performanceNow from 'performance-now';

// These are defined separately for each object so they're not included in Value below.
const RESERVED_VALUE_PROPERTY_NAMES = {$$$trussCheck: true, __ob__: true};

// Holds properties that we're going to set on a model object that's being created right now as soon
// as it's been created, but that we'd like to be accessible in the constructor.  The object
// prototype's getters will pick those up until they get overridden in the instance.
let creatingObjectProperties;

let currentPropertyFrozen;


class Value {
  get $parent() {return creatingObjectProperties.$parent.value;}
  get $path() {return creatingObjectProperties.$path.value;}
  get $truss() {
    Object.defineProperty(this, '$truss', {value: this.$parent.$truss});
    return this.$truss;
  }
  get $ref() {
    Object.defineProperty(this, '$ref', {value: new Reference(this.$truss._tree, this.$path)});
    return this.$ref;
  }
  get $refs() {return this.$ref;}
  get $key() {
    Object.defineProperty(
      this, '$key', {value: unescapeKey(this.$path.slice(this.$path.lastIndexOf('/') + 1))});
    return this.$key;
  }
  get $data() {return this;}
  get $hidden() {return false;}
  get $empty() {return _.isEmpty(this.$data);}
  get $keys() {return _.keys(this.$data);}
  get $values() {return _.values(this.$data);}
  get $meta() {return this.$truss.meta;}
  get $root() {return this.$truss.root;}  // access indirectly to leave dependency trace
  get $now() {return this.$truss.now;}
  get $ready() {return this.$ref.ready;}
  get $overridden() {return false;}

  $intercept(actionType, callbacks) {
    const unintercept = this.$truss.intercept(actionType, callbacks);
    const uninterceptAndRemoveFinalizer = () => {
      unintercept();
      _.pull(this.$$finalizers, uninterceptAndRemoveFinalizer);
    };
    this.$$finalizers.push(uninterceptAndRemoveFinalizer);
    return uninterceptAndRemoveFinalizer;
  }

  $connect(scope, connections) {
    if (!connections) {
      connections = scope;
      scope = undefined;
    }
    const connector = this.$truss.connect(scope, wrapConnections(this, connections));
    const originalDestroy = connector.destroy;
    const destroy = () => {
      _.pull(this.$$finalizers, destroy);
      return originalDestroy.call(connector);
    };
    this.$$finalizers.push(destroy);
    connector.destroy = destroy;
    return connector;
  }

  $peek(target, callback) {
    const promise = promiseFinally(
      this.$truss.peek(target, callback), () => {_.pull(this.$$finalizers, promise.cancel);}
    );
    this.$$finalizers.push(promise.cancel);
    return promise;
  }

  $watch(subjectFn, callbackFn, options) {
    let unwatchAndRemoveFinalizer;

    const unwatch = this.$truss.watch(() => {
      this.$$touchThis();
      return subjectFn.call(this);
    }, callbackFn.bind(this), options);

    unwatchAndRemoveFinalizer = () => {
      unwatch();
      _.pull(this.$$finalizers, unwatchAndRemoveFinalizer);
    };
    this.$$finalizers.push(unwatchAndRemoveFinalizer);
    return unwatchAndRemoveFinalizer;
  }

  $when(expression, options) {
    const promise = this.$truss.when(() => {
      this.$$touchThis();
      return expression.call(this);
    }, options);
    promiseFinally(promise, () => {_.pull(this.$$finalizers, promise.cancel);});
    this.$$finalizers.push(promise.cancel);
    return promise;
  }

  $freezeComputedProperty() {
    if (!_.isBoolean(currentPropertyFrozen)) {
      throw new Error('Cannot freeze a computed property outside of its getter function');
    }
    currentPropertyFrozen = true;
  }

  $set(value) {return this.$ref.set(value);}
  $update(values) {return this.$ref.update(values);}
  $override(values) {return this.$ref.override(values);}
  $commit(options, updateFn) {return this.$ref.commit(options, updateFn);}

  $$touchThis() {
    // jshint expr:true
    if (this.__ob__) {
      this.__ob__.dep.depend();
    } else if (this.$parent) {
      (this.$parent.hasOwnProperty('$data') ? this.$parent.$data : this.$parent)[this.$key];
    } else {
      this.$root;
    }
    // jshint expr:false
  }

  get $$initializers() {
    Object.defineProperty(this, '$$initializers', {
      value: [], writable: false, enumerable: false, configurable: true});
    return this.$$initializers;
  }

  get $$finalizers() {
    Object.defineProperty(this, '$$finalizers', {
      value: [], writable: false, enumerable: false, configurable: false});
    return this.$$finalizers;
  }
}


class ErrorWrapper {
  constructor(error) {
    this.error = error;
  }
}


class FrozenWrapper {
  constructor(value) {
    this.value = value;
  }
}


export default class Modeler {
  constructor(debug) {
    this._trie = {Class: Value};
    this._debug = debug;
    Object.freeze(this);
  }

  init(classes, rootAcceptable) {
    if (_.isPlainObject(classes)) {
      _.each(classes, (Class, path) => {
        if (Class.$trussMount) return;
        Class.$$trussMount = Class.$$trussMount || [];
        Class.$$trussMount.push(path);
      });
      classes = _.values(classes);
      _.each(classes, Class => {
        if (!Class.$trussMount && Class.$$trussMount) {
          Class.$trussMount = Class.$$trussMount;
          delete Class.$$trussMount;
        }
      });
    }
    classes = _.uniq(classes);
    _.each(classes, Class => this._mountClass(Class, rootAcceptable));
    this._decorateTrie(this._trie);
  }

  destroy() {
  }

  _getMount(path, scaffold, predicate) {
    const segments = splitPath(path, true);
    let node;
    for (const segment of segments) {
      let child = segment ?
        node.children && (node.children[segment] || !scaffold && node.children.$) : this._trie;
      if (!child) {
        if (!scaffold) return;
        node.children = node.children || {};
        child = node.children[segment] = {Class: Value};
      }
      node = child;
      if (predicate && predicate(node)) break;
    }
    return node;
  }

  _findMount(predicate, node) {
    if (!node) node = this._trie;
    if (predicate(node)) return node;
    for (const childKey of _.keys(node.children)) {
      const result = this._findMount(predicate, node.children[childKey]);
      if (result) return result;
    }
  }

  _decorateTrie(node) {
    _.each(node.children, child => {
      this._decorateTrie(child);
      if (child.local || child.localDescendants) node.localDescendants = true;
    });
  }

  _augmentClass(Class) {
    let computedProperties;
    let proto = Class.prototype;
    while (proto && proto.constructor !== Object) {
      for (const name of Object.getOwnPropertyNames(proto)) {
        const descriptor = Object.getOwnPropertyDescriptor(proto, name);
        if (name.charAt(0) === '$') {
          if (name === '$finalize') continue;
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
    for (const name of Object.getOwnPropertyNames(Value.prototype)) {
      if (name === 'constructor' || Class.prototype.hasOwnProperty(name)) continue;
      Object.defineProperty(
        Class.prototype, name, Object.getOwnPropertyDescriptor(Value.prototype, name));
    }
    return computedProperties;
  }

  _mountClass(Class, rootAcceptable) {
    const computedProperties = this._augmentClass(Class);
    const allVariables = [];
    let mounts = Class.$trussMount;
    if (!mounts) throw new Error(`Class ${Class.name} lacks a $trussMount static property`);
    if (!_.isArray(mounts)) mounts = [mounts];
    _.each(mounts, mount => {
      if (_.isString(mount)) mount = {path: mount};
      if (!rootAcceptable && mount.path === '/') {
        throw new Error('Data root already accessed, too late to mount class');
      }
      const matcher = makePathMatcher(mount.path);
      for (const variable of matcher.variables) {
        if (variable === '$' || variable.charAt(1) === '$') {
          throw new Error(`Invalid variable name: ${variable}`);
        }
        if (variable.charAt(0) === '$' && (
            _.has(Value.prototype, variable) || RESERVED_VALUE_PROPERTY_NAMES[variable]
        )) {
          throw new Error(`Variable name conflicts with built-in property or method: ${variable}`);
        }
        allVariables.push(variable);
      }
      const escapedKey = mount.path.match(/\/([^/]*)$/)[1];
      if (escapedKey.charAt(0) === '$') {
        if (mount.placeholder) {
          throw new Error(
            `Class ${Class.name} mounted at wildcard ${escapedKey} cannot be a placeholder`);
        }
      } else {
        if (!_.has(mount, 'placeholder')) mount.placeholder = {};
      }
      const targetMount = this._getMount(mount.path.replace(/\$[^/]*/g, '$'), true);
      if (targetMount.matcher && (
            targetMount.escapedKey === escapedKey ||
            targetMount.escapedKey.charAt(0) === '$' && escapedKey.charAt(0) === '$')) {
        throw new Error(
          `Multiple classes mounted at ${mount.path}: ${targetMount.Class.name}, ${Class.name}`);
      }
      _.extend(
        targetMount, {Class, matcher, computedProperties, escapedKey},
        _.pick(mount, 'placeholder', 'local', 'keysUnsafe', 'hidden'));
    });
    _.each(allVariables, variable => {
      if (!Class.prototype[variable]) {
        Object.defineProperty(Class.prototype, variable, {get: function() {
          return creatingObjectProperties ?
            creatingObjectProperties[variable] && creatingObjectProperties[variable].value :
            undefined;
        }});
      }
    });
  }

  /**
   * Creates a Truss object and sets all its basic properties: path segment variables, user-defined
   * properties, and computed properties.  The latter two will be enumerable so that Vue will pick
   * them up and make the reactive, so you should call _completeCreateObject once it's done so and
   * before any Firebase properties are added.
   */
  createObject(path, properties) {
    const mount = this._getMount(path) || {Class: Value};
    if (mount.matcher) {
      const match = mount.matcher.match(path);
      for (const variable in match) {
        properties[variable] = {value: match[variable]};
      }
    }

    creatingObjectProperties = properties;
    const object = new mount.Class();
    creatingObjectProperties = null;

    if (mount.keysUnsafe) properties.$data = {value: Object.create(null)};
    if (mount.hidden) properties.$hidden = {value: true};
    if (mount.computedProperties) {
      _.each(mount.computedProperties, prop => {
        properties[prop.name] = this._buildComputedPropertyDescriptor(object, prop);
      });
    }

    return object;
  }

  _buildComputedPropertyDescriptor(object, prop) {
    const propertyStats = stats.for(prop.fullName);

    let value;
    let writeAllowed = false;

    object.$$initializers.push(vue => {
      let unwatchNow = false;
      const compute = computeValue.bind(object, prop, propertyStats);
      if (this._debug) compute.toString = () => {return prop.fullName;};
      const unwatch = vue.$watch(compute, newValue => {
        if (_.isObject(newValue) && newValue.then) {
          const computationSerial = propertyStats.numRecomputes;
          newValue.then(finalValue => {
            if (computationSerial === propertyStats.numRecomputes) update(finalValue);
          }, error => {
            if (computationSerial === propertyStats.numRecomputes) {
              if (update(new ErrorWrapper(error))) throw error;
            }
          });
        } else {
          if (update(newValue)) {
            angular.digest();
            if (newValue instanceof ErrorWrapper) throw newValue.error;
          }
        }
      }, {immediate: true});  // use immediate:true since watcher will run computeValue anyway

      function update(newValue) {
        if (newValue instanceof FrozenWrapper) {
          newValue = newValue.value;
          if (unwatch) {
            unwatch();
            _.pull(object.$$finalizers, unwatch);
          } else {
            unwatchNow = true;
          }
        }
        if (isTrussEqual(value, newValue)) return;
        // console.log('updating', object.$key, prop.fullName, 'from', value, 'to', newValue);
        freeze(newValue);
        propertyStats.numUpdates += 1;
        writeAllowed = true;
        object[prop.name] = newValue;
        writeAllowed = false;
      }

      if (unwatchNow) {
        unwatch();
      } else {
        object.$$finalizers.push(unwatch);
      }
    });
    return {
      enumerable: true, configurable: true,
      get: function() {
        if (value instanceof ErrorWrapper) throw value.error;
        return value;
      },
      set: function(newValue) {
        if (!writeAllowed) throw new Error(`You cannot set a computed property: ${prop.name}`);
        value = newValue;
      }
    };
  }

  destroyObject(object) {
    if (_.has(object, '$$finalizers')) {
      // Some destructors remove themselves from the array, so clone it before iterating.
      for (const fn of _.clone(object.$$finalizers)) fn();
    }
    if (_.isFunction(object.$finalize)) object.$finalize();
  }

  isPlaceholder(path) {
    const mount = this._getMount(path);
    return mount && mount.placeholder;
  }

  isLocal(path) {
    const mount = this._getMount(path, false, mount => mount.local);
    if (!mount) return false;
    if (mount.local) return true;
    if (mount.localDescendants) throw new Error(`Subtree mixes local and remote data: ${path}`);
    return false;
  }

  forEachPlaceholderChild(path, iteratee) {
    const mount = this._getMount(path);
    _.each(mount && mount.children, child => {
      if (child.placeholder) iteratee(child.escapedKey, child.placeholder);
    });
  }

  checkVueObject(object, path, checkedObjects) {
    const top = !checkedObjects;
    if (top) checkedObjects = [];
    try {
      for (const key of Object.getOwnPropertyNames(object)) {
        if (RESERVED_VALUE_PROPERTY_NAMES[key] || Value.prototype.hasOwnProperty(key)) continue;
        // jshint loopfunc:true
        const mount = this._findMount(mount => mount.Class === object.constructor);
        // jshint loopfunc:false
        if (mount && mount.matcher && _.includes(mount.matcher.variables, key)) continue;
        if (!(Array.isArray(object) && (/\d+/.test(key) || key === 'length'))) {
          const descriptor = Object.getOwnPropertyDescriptor(object, key);
          if ('value' in descriptor || !descriptor.get) {
            throw new Error(
              `Value at ${path}, contained in a Firetruss object, has a rogue property: ${key}`);
          }
          if (object.$truss && descriptor.enumerable) {
            try {
              object[key] = object[key];
              throw new Error(
                `Firetruss object at ${path} has an enumerable non-Firebase property: ${key}`);
            } catch (e) {
              if (e.trussCode !== 'firebase_overwrite') throw e;
            }
          }
        }
        const value = object[key];
        if (_.isObject(value) && !value.$$$trussCheck && Object.isExtensible(value) &&
            !(value instanceof Function)) {
          value.$$$trussCheck = true;
          checkedObjects.push(value);
          this.checkVueObject(value, joinPath(path, escapeKey(key)), checkedObjects);
        }
      }
    } finally {
      if (top) {
        for (const item of checkedObjects) delete item.$$$trussCheck;
      }
    }
  }
}


function computeValue(prop, propertyStats) {
  // jshint validthis: true
  // Touch this object, since a failed access to a missing property doesn't get captured as a
  // dependency.
  this.$$touchThis();

  currentPropertyFrozen = false;
  const startTime = performanceNow();
  let value;
  try {
    try {
      value = prop.get.call(this);
    } catch (e) {
      value = new ErrorWrapper(e);
    } finally {
      propertyStats.runtime += performanceNow() - startTime;
      propertyStats.numRecomputes += 1;
    }
    if (currentPropertyFrozen) value = new FrozenWrapper(value);
    return value;
  } finally {
    currentPropertyFrozen = undefined;
  }
  // jshint validthis: false
}

function wrapConnections(object, connections) {
  if (!connections || connections instanceof Handle) return connections;
  return _.mapValues(connections, descriptor => {
    if (descriptor instanceof Handle) return descriptor;
    if (_.isFunction(descriptor)) {
      const fn = function() {
        object.$$touchThis();
        return wrapConnections(object, descriptor.call(this));
      };
      fn.angularWatchSuppressed = true;
      return fn;
    } else {
      return wrapConnections(object, descriptor);
    }
  });
}

function freeze(object) {
  if (object === null || object === undefined || Object.isFrozen(object) || !_.isObject(object) ||
      object.$truss) return object;
  object = Object.freeze(object);
  if (_.isArray(object)) {
    return _.map(object, value => freeze(value));
  } else {
    return _.mapValues(object, value => freeze(value));
  }
}
