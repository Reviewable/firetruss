import {Reference, Handle} from './Reference.js';
import angular from './angularCompatibility.js';
import stats from './utils/stats.js';
import {makePathMatcher, joinPath, splitPath, escapeKey, unescapeKey} from './utils/paths.js';
import {isTrussEqual, copyPrototype} from './utils/utils.js';
import {promiseFinally} from './utils/promises.js';

import _ from 'lodash';

// These are defined separately for each object so they're not included in Value below.
const RESERVED_VALUE_PROPERTY_NAMES = {__ob__: true};

const UNSUPPORTED_LIFECYCLE_METHODS = new Set([
  'beforeMount', 'mounted', 'beforeUpdate', 'updated', 'activated', 'deactivated', 'errorCaptured'
]);
const UNSUPPORTED_LIFECYCLE_HOOKS =
  new Set(_.map(UNSUPPORTED_LIFECYCLE_METHODS, method => `hook:${method}`));

const LAST_COMPUTED_VALUE = Symbol('last-computed-value');

// Holds properties that we're going to set on a model object that's being created right now as soon
// as it's been created, but that we'd like to be accessible in the constructor.  The object
// prototype's getters will pick those up until they get overridden in the instance.
let creatingObjectProperties;

let currentPropertyFrozen;


export class BaseValue {
  get $info() {return this.$truss.info;}
  get $store() {return this.$truss.store;}  // access indirectly to leave dependency trace
  get $now() {return this.$truss.now;}

  $newKey() {return this.$truss.newKey();}

  $intercept(actionType, callbacks) {
    if (this.$destroyed) throw new Error('Object already destroyed');
    const unintercept = this.$truss.intercept(actionType, callbacks);
    const uninterceptAndRemoveFinalizer = () => {
      unintercept();
      this.$off('hook:destroyed', uninterceptAndRemoveFinalizer);
    };
    this.$on('hook:destroyed', uninterceptAndRemoveFinalizer);
    return uninterceptAndRemoveFinalizer;
  }

  $connect(scope, connections) {
    if (this.$destroyed) throw new Error('Object already destroyed');
    if (!connections) {
      connections = scope;
      scope = undefined;
    }
    const connector = this.$truss.connect(scope, wrapConnections(this, connections));
    const originalDestroy = connector.destroy;
    const destroy = () => {
      this.$off('hook:destroyed', destroy);
      return originalDestroy.call(connector);
    };
    this.$on('hook:destroyed', destroy);
    connector.destroy = destroy;
    return connector;
  }

  $peek(target, callback) {
    if (this.$destroyed) throw new Error('Object already destroyed');
    const promise = promiseFinally(
      this.$truss.peek(target, callback), () => {this.$off('hook:destroyed', promise.cancel);}
    );
    this.$on('hook:destroyed', promise.cancel);
    return promise;
  }

  $observe(subjectFn, callbackFn, options) {
    if (this.$destroyed) throw new Error('Object already destroyed');
    let unobserveAndRemoveFinalizer;

    const unobserve = this.$truss.observe(() => {
      this.$$touchThis();
      return subjectFn.call(this);
    }, callbackFn.bind(this), {...options, vm: this});

    unobserveAndRemoveFinalizer = () => {  // eslint-disable-line prefer-const
      unobserve();
      this.$off('hook:destroyed', unobserveAndRemoveFinalizer);
    };
    this.$on('hook:destroyed', unobserveAndRemoveFinalizer);
    return unobserveAndRemoveFinalizer;
  }

  $when(expression, options) {
    if (this.$destroyed) throw new Error('Object already destroyed');
    const promise = this.$truss.when(() => {
      this.$$touchThis();
      return expression.call(this);
    }, options);
    promiseFinally(promise, () => {this.$off('hook:destroyed', promise.cancel);});
    this.$on('hook:destroyed', promise.cancel);
    return promise;
  }
}


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
  get $hidden() {return false;}  // eslint-disable-line lodash/prefer-constant
  get $empty() {return _.isEmpty(this.$data);}
  get $keys() {return _.keys(this.$data);}
  get $values() {return _.values(this.$data);}
  get $ready() {return this.$ref.ready;}
  get $overridden() {return false;}  // eslint-disable-line lodash/prefer-constant

  $nextTick() {
    if (this.$destroyed) throw new Error('Object already destroyed');
    const promise = this.$truss.nextTick();
    promiseFinally(promise, () => {this.$off('hook:destroyed', promise.cancel);});
    this.$on('hook:destroyed', promise.cancel);
    return promise;
  }

  $freezeComputedProperty() {
    if (!_.isBoolean(currentPropertyFrozen)) {
      throw new Error('Cannot freeze a computed property outside of its getter function');
    }
    currentPropertyFrozen = true;
  }

  get $lastComputedValue() {
    if (!_.isBoolean(currentPropertyFrozen)) {
      throw new Error(
        'Cannot use last computed value of a property outside of its getter function');
    }
    return LAST_COMPUTED_VALUE;
  }

  $set(value) {return this.$ref.set(value);}
  $update(values) {return this.$ref.update(values);}
  $override(values) {return this.$ref.override(values);}
  $commit(options, updateFn) {return this.$ref.commit(options, updateFn);}

  $$touchThis() {
    /* eslint-disable no-unused-expressions */
    if (this.__ob__) {
      this.__ob__.dep.depend();
    } else if (this.$parent) {
      (Object.hasOwn(this.$parent, '$data') ? this.$parent.$data : this.$parent)[this.$key];
    } else {
      this.$store;
    }
    /* eslint-enable no-unused-expressions */
  }

  get $destroyed() {  // eslint-disable-line lodash/prefer-constant
    return false;
  }

  $on(event, callback) {
    if (this.$destroyed) throw new Error('Object already destroyed');
    if (UNSUPPORTED_LIFECYCLE_HOOKS.has(event)) {
      throw new Error(`Models don't support the "${event}" lifecycle event`);
    }
    (this.$$hooks[event] = this.$$hooks[event] || []).push(callback);
    return this;
  }

  $once(event, callback) {
    const object = this;
    function cb(...args) {
      object.$off(event, cb);
      callback(...args);
    }
    cb.fn = callback;
    return this.$on(event, cb);
  }

  $off(event, callback) {
    if (event) {
      if (callback) {
        if (_.isArray(event)) {
          for (const ev of event) this.$off(ev, callback);
        } else if (this.$$hooks[event]) {
          const callbacks = this.$$hooks[event];
          for (let i = 0; i < callbacks.length; i++) {
            const cb = callbacks[i];
            if (cb === callback || cb.fn === callback) {
              callbacks.splice(i, 1);
              break;
            }
          }
        }
      } else {
        delete this.$$hooks[event];
      }
    } else {
      for (const key of _.keys(this.$$hooks)) delete this.$$hooks[key];
    }
    return this;
  }

  $emit(event, ...args) {
    if (_.has(this, '$$hooks')) {
      // Some callbacks remove themselves from the array, so clone it before iterating.
      _.forEach(_.clone(this.$$hooks[event]), callback => {
        if (callback.$once && callback.$once[event]) {
          callback.$once[event] -= 1;
          this.$off(event, callback);
        }
        callback(...args);
      });
    }
    return this;
  }

  get $$hooks() {
    Object.defineProperty(this, '$$hooks', {
      value: {}, writable: false, enumerable: false, configurable: false
    });
    return this.$$hooks;
  }
}

copyPrototype(BaseValue, Value);

_.forEach(Value.prototype, (prop, name) => {
  Object.defineProperty(
    Value.prototype, name, {value: prop, enumerable: false, configurable: false, writable: false});
});


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
  constructor(vue, debug) {
    this._vue = vue;
    this._trie = {Class: Value};
    this._debug = debug;
    Object.freeze(this);
  }

  init(classes, rootAcceptable) {
    if (_.isPlainObject(classes)) {
      _.forEach(classes, (Class, path) => {
        if (Class.$trussMount) return;
        Class.$$trussMount = Class.$$trussMount || [];
        Class.$$trussMount.push(path);
      });
      classes = _.values(classes);
      _.forEach(classes, Class => {
        if (!Class.$trussMount && Class.$$trussMount) {
          Class.$trussMount = Class.$$trussMount;
          delete Class.$$trussMount;
        }
      });
    }
    classes = _.uniq(classes);
    _.forEach(classes, Class => this._mountClass(Class, rootAcceptable));
    this._decorateTrie(this._trie);
  }

  destroy() {/* empty */}

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
    _.forEach(node.children, child => {
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
          if (_.isEqual(descriptor, Object.getOwnPropertyDescriptor(Value.prototype, name))) {
            continue;
          }
          throw new Error(`Property names starting with "$" are reserved: ${Class.name}.${name}`);
        }
        if (UNSUPPORTED_LIFECYCLE_METHODS.has(name) && _.isFunction(proto[name])) {
          throw new Error(`Models don't support the "${name}" lifecycle method`);
        }
        if (descriptor.get && !(computedProperties && computedProperties[name])) {
          (computedProperties || (computedProperties = {}))[name] = {
            name, fullName: `${proto.constructor.name}.${name}`, get: descriptor.get,
            set: descriptor.set
          };
        }
      }
      proto = Object.getPrototypeOf(proto);
    }
    for (const name of Object.getOwnPropertyNames(Value.prototype)) {
      if (name === 'constructor' || Object.hasOwn(Class.prototype, name)) continue;
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
    _.forEach(mounts, mount => {
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
      } else if (!_.has(mount, 'placeholder')) {
        mount.placeholder = {};
      }
      const targetMount = this._getMount(mount.path.replace(/\$[^/]*/g, '$'), true);
      if (targetMount.matcher && (
        targetMount.escapedKey === escapedKey ||
        targetMount.escapedKey.charAt(0) === '$' && escapedKey.charAt(0) === '$'
      )) {
        throw new Error(
          `Multiple classes mounted at ${mount.path}: ${targetMount.Class.name}, ${Class.name}`);
      }
      _.assign(
        targetMount, {Class, matcher, computedProperties, escapedKey},
        _.pick(mount, 'placeholder', 'local', 'keysUnsafe', 'hidden'));
    });
    _(allVariables).uniq().forEach(variable => {
      Object.defineProperty(Class.prototype, variable, {get() {
        return creatingObjectProperties ?
          creatingObjectProperties[variable] && creatingObjectProperties[variable].value :
          undefined;
      }});
    });
  }

  /**
   * Creates a Truss object and sets all its basic properties: path segment variables, user-defined
   * properties, and computed properties.  The latter two will be enumerable so that Vue will pick
   * them up and make the reactive.
   */
  createObject(path, properties) {
    const mount = this._getMount(path) || {Class: Value};
    try {
      if (mount.matcher) {
        const match = mount.matcher.match(path);
        for (const variable in match) {
          properties[variable] = {value: match[variable]};
        }
      }

      creatingObjectProperties = properties;
      const object = new mount.Class();
      creatingObjectProperties = null;

      if (angular.active) this._wrapProperties(object);

      if (mount.keysUnsafe) {
        properties.$data = {value: Object.create(null), configurable: true, enumerable: true};
      }
      if (mount.hidden) properties.$hidden = {value: true};
      if (mount.computedProperties) {
        _.forEach(mount.computedProperties, prop => {
          properties[prop.name] = this._buildComputedPropertyDescriptor(object, prop);
        });
      }

      return object;
    } catch (e) {
      e.extra = _.assign({mount, properties, className: mount.Class && mount.Class.name}, e.extra);
      throw e;
    }
  }

  _wrapProperties(object) {
    _.forEach(object, (value, key) => {
      const valueKey = '$_' + key;
      Object.defineProperties(object, {
        [valueKey]: {value, writable: true},
        [key]: {
          get: () => object[valueKey],
          set: arg => {object[valueKey] = arg; angular.digest();},
          enumerable: true, configurable: true
        }
      });
    });
  }

  _buildComputedPropertyDescriptor(object, prop) {
    const propertyStats = stats.for(prop.fullName);

    let value, pendingPromise;
    let writeAllowed = false;

    const initialize = () => {
      let unwatchNow = false;
      const compute = computeValue.bind(object, prop, propertyStats);
      compute.toString = _.constant(`compute ${prop.fullName}`);
      let unwatch = () => {unwatchNow = true;};
      unwatch = this._vue.$watch(compute, newValue => {
        if (object.$destroyed) {
          unwatch();
          return;
        }
        if (pendingPromise) {
          if (pendingPromise.cancel) pendingPromise.cancel();
          pendingPromise = undefined;
        }
        if (_.isObject(newValue) && _.isFunction(newValue.then)) {
          const promise = newValue.then(finalValue => {
            if (promise === pendingPromise) update(finalValue);
            // No need to angular.digest() here, since if we're running under Angular then we expect
            // promises to be aliased to its $q service, which triggers digest itself.
          }, error => {
            if (promise === pendingPromise && update(new ErrorWrapper(error)) &&
                !error.trussExpectedException) throw error;
          });
          pendingPromise = promise;
        } else if (update(newValue)) {
          angular.digest();
          if (newValue instanceof ErrorWrapper && !newValue.error.trussExpectedException) {
            throw newValue.error;
          }
        }
      }, {immediate: true});  // use immediate:true since watcher will run computeValue anyway
      // Hack to change order of computed property watchers.  By flipping their ids to be negative,
      // we ensure that they will settle before all other watchers, and also that children
      // properties will settle before their parents since values are often aggregated upwards.
      const watcher = _.last(this._vue._watchers || this._vue._scope.effects);
      watcher.id = -watcher.id;

      function update(newValue) {
        const startTime = performance.now();
        if (newValue instanceof FrozenWrapper) {
          newValue = newValue.value;
          unwatch();
          object.$off('hook:destroyed', unwatch);
        }
        if (newValue === LAST_COMPUTED_VALUE || isTrussEqual(value, newValue)) return;
        // console.log('updating', object.$key, prop.fullName, 'from', value, 'to', newValue);
        writeAllowed = true;
        object[prop.name] = newValue;
        writeAllowed = false;
        // Freeze the computed value so it can't be accidentally modified by a third party.  Ideally
        // we'd freeze it before setting it so that Vue wouldn't instrument the object recursively
        // (since it can't change anyway), but we actually need the instrumentation in case a client
        // tries to access an inexistent property off a computed pointer to an unfrozen value (e.g.,
        // a $truss-ified object).  When instrumented, Vue will add a dependency on the unfrozen
        // value in case the property is later added.  If uninstrumented, the dependency won't be
        // added and we won't be notified.  And Vue only instruments extensible objects...
        freeze(newValue);
        propertyStats.numUpdates += 1;
        propertyStats.updateTime += performance.now() - startTime;
        return true;
      }

      if (unwatchNow) {
        unwatch();
      } else {
        object.$on('hook:destroyed', unwatch);
      }

      object.$off('hook:created', initialize);
    };
    object.$on('hook:created', initialize);

    return {
      enumerable: true, configurable: true,
      get() {
        if (!writeAllowed && value instanceof ErrorWrapper) throw value.error;
        return value;
      },
      set(newValue) {
        if (writeAllowed) {
          value = newValue;
        } else if (prop.set) {
          prop.set.call(this, newValue);
        } else {
          throw new Error(`You cannot set a computed property: ${prop.name}`);
        }
      }
    };
  }

  destroyObject(object) {
    Object.defineProperty(
      object, '$destroyed', {value: true, enumerable: false, configurable: false});
  }

  emitLifecycleHook(object, hook) {
    if (_.isFunction(object[hook])) object[hook]();
    object.$emit(`hook:${hook}`);
  }

  isPlaceholder(path) {
    const mount = this._getMount(path);
    return mount && mount.placeholder;
  }

  isLocal(path, value) {
    // eslint-disable-next-line no-shadow
    const mount = this._getMount(path, false, mount => mount.local);
    if (mount && mount.local) return true;
    if (this._hasLocalProperties(mount, value)) {
      throw new Error('Write on a mix of local and remote tree paths.');
    }
    return false;
  }

  _hasLocalProperties(mount, value) {
    if (!mount) return false;
    if (mount.local) return true;
    if (!mount.localDescendants || !_.isObject(value)) return false;
    for (const key in value) {
      const local =
        this._hasLocalProperties(mount.children[escapeKey(key)] || mount.children.$, value[key]);
      if (local) return true;
    }
    return false;
  }

  forEachPlaceholderChild(path, iteratee) {
    const mount = this._getMount(path);
    _.forEach(mount && mount.children, child => {
      if (child.placeholder) iteratee(child);
    });
  }

  checkVueObject(object, path, checkedObjects) {
    const top = !checkedObjects;
    if (top) checkedObjects = new Set();
    const objectPropertyValues = new Map();
    const mount = this._findMount(candidate => candidate.Class === object.constructor);
    const targetProperties = _(object)
      .thru(Object.getOwnPropertyNames)
      .reject(key =>
        RESERVED_VALUE_PROPERTY_NAMES[key] || Object.hasOwn(Value.prototype, key) ||
        /^\$_/.test(key)
      )
      .reject(key => mount && mount.matcher && _.includes(mount.matcher.variables, key))
      .map(key => {
        let value;
        try {
          value = object[key];
          // Ignore builtin object types.
          if (value instanceof RegExp) return;
        } catch {
          // Ignore any values that hold exceptions, or otherwise throw on access -- we won't be
          // able to check them anyway.
          return;
        }
        const descriptor = Object.getOwnPropertyDescriptor(object, key);
        const computed =
          !descriptor.enumerable && descriptor.set && !Object.hasOwn(object, '$_' + key);
        return {key, value, descriptor, computed};
      })
      .compact()
      .value();

    for (const {key, value, descriptor, computed} of targetProperties) {
      if (!(_.isArray(object) && (/\d+/.test(key) || key === 'length'))) {
        if ('value' in descriptor || !descriptor.get) {
          throw new Error(
            `Value at ${path}, contained in a Firetruss object, has a rogue property: ${key}`);
        }
        if (object.$truss && descriptor.enumerable) {
          try {
            object[key] = value;
            throw new Error(
              `Firetruss object at ${path} has an enumerable non-Firebase property: ${key}`);
          } catch (e) {
            if (e.trussCode !== 'firebase_overwrite') throw e;
          }
        }
      }
      if (_.isObject(value)) {
        if (!checkedObjects.has(value) && !Object.isSealed(value) &&
            !(_.isFunction(value) || _.isElement(value) || value instanceof Promise)) {
          checkedObjects.add(value);
          this.checkVueObject(value, joinPath(path, escapeKey(key)), checkedObjects);
        }
        if (!computed && !value.$truss) objectPropertyValues.set(value, key);
      }
    }

    for (const {key, value, computed} of targetProperties) {
      if (computed && _.isObject(value) && !value.$truss) {
        const otherKey = objectPropertyValues.get(value);
        if (otherKey) {
          throw new Error(
            `Firetruss object at ${path} has properties ${key} ` +
            `and ${otherKey} with an aliased value`);
        }
      }
    }
  }
}


function computeValue(prop, propertyStats) {
  /* eslint-disable no-invalid-this */
  if (this.$destroyed) return;
  // Touch this object, since a failed access to a missing property doesn't get captured as a
  // dependency.
  this.$$touchThis();

  const oldPropertyFrozen = currentPropertyFrozen;
  currentPropertyFrozen = false;
  const startTime = performance.now();
  let value;
  try {
    try {
      value = prop.get.call(this);
    } catch (e) {
      value = new ErrorWrapper(e);
    } finally {
      propertyStats.computeTime += performance.now() - startTime;
      propertyStats.numRecomputes += 1;
    }
    if (currentPropertyFrozen) value = new FrozenWrapper(value);
    return value;
  } finally {
    currentPropertyFrozen = oldPropertyFrozen;
  }
  /* eslint-enable no-invalid-this */
}

function wrapConnections(object, connections) {
  if (!connections || connections instanceof Handle) return connections;
  if (_.isFunction(connections)) {
    const fn = function() {
      /* eslint-disable no-invalid-this */
      object.$$touchThis();
      return wrapConnections(object, connections.call(this));
      /* eslint-enable no-invalid-this */
    };
    fn.angularWatchSuppressed = true;
    return fn;
  }
  return _.mapValues(connections, descriptor => wrapConnections(object, descriptor));
}

function freeze(object) {
  if (_.isNil(object) || !_.isObject(object) || Object.isFrozen(object) || object.$truss) {
    return object;
  }
  object = Object.freeze(object);
  if (_.isArray(object)) return _.map(object, value => freeze(value));
  return _.mapValues(object, value => freeze(value));
}
