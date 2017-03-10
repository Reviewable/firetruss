import Reference from './Reference.js';
import {makePathMatcher} from './utils.js';

import _ from 'lodash';
import performanceNow from 'performance-now';

// These are defined separately for each object so they're not included in Value below.
const RESERVED_VALUE_PROPERTY_NAMES = {$truss: true, $parent: true, $key: true, $path: true};

const computedPropertyStats = {};


class Value {
  get $ref() {
    Object.defineProperty(this, '$ref', {value: new Reference(this.$truss._tree, this.$path)});
  }
  get $refs() {return this.$ref;}
  get $keys() {return _.keys(this);}
  get $values() {return _.values(this);}
  get $root() {return this.$truss.root;}  // access indirectly to leave dependency trace
  get $ready() {return this.$ref.ready;}

  $watch(subjectFn, callbackFn, options) {
    let unwatchAndRemoveDestructor;

    const unwatch = this.$truss.watch(() => {
      this.$$touchThis();
      return subjectFn.call(this);
    }, callbackFn.bind(this), options);

    if (!this.$$finalizers) {
      Object.defineProperty(this, '$$finalizers', {
        value: [], writable: false, enumerable: false, configurable: false});
    }
    unwatchAndRemoveDestructor = () => {
      unwatch();
      _.pull(this.$$finalizers, unwatchAndRemoveDestructor);
    };
    this.$$finalizers.push(unwatchAndRemoveDestructor);
    return unwatchAndRemoveDestructor;
  }

  $set(value) {return this.$ref.set(value);}
  $update(values) {return this.$ref.update(values);}
  $override(values) {return this.$ref.override(values);}
  $commit(options, updateFn) {return this.$ref.commit(options, updateFn);}
}

class ComputedPropertyStats {
  constructor(name) {
    _.extend(this, {name, numRecomputes: 0, numUpdates: 0, runtime: 0});
  }
}

class ErrorWrapper {
  constructor(error) {
    this.error = error;
  }
}


export default class Modeler {
  constructor(classes) {
    this._mounts = _(classes).uniq().map(Class => this._mountClass(Class)).flatten().value();
    const patterns = _.map(this._mounts, mount => mount.matcher.toString());
    if (patterns.length !== _.uniq(patterns).length) {
      const badPaths = _(patterns)
        .groupBy()
        .map((group, key) =>
          group.length === 1 ? null : key.replace(/\(\[\^\/\]\+\)/g, '$').slice(1, -1))
        .compact()
        .value();
      throw new Error('Paths have multiple mounted classes: ' + badPaths.join(', '));
    }
  }

  destroy() {
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
      if (name === 'constructor' || Class.prototype.hasOwnProperty(name)) continue;
      Object.defineProperty(
        Class.prototype, name, Object.getOwnPropertyDescriptor(Value.prototype, name));
    }
    return computedProperties;
  }

  _mountClass(Class) {
    const computedProperties = this._augmentClass(Class);
    let mounts = Class.$trussMount;
    if (!mounts) throw new Error(`Class ${Class.name} lacks a $trussMount static property`);
    if (!_.isArray(mounts)) mounts = [mounts];
    return _.map(mounts, mount => {
      if (_.isString(mount)) mount = {path: mount};
      const matcher = makePathMatcher(mount.path);
      for (let variable of matcher.variables) {
        if (variable === '$' || variable.charAt(1) === '$') {
          throw new Error(`Invalid variable name: ${variable}`);
        }
        if (variable.charAt(0) === '$' && (
            _.has(Value.prototype, variable) || RESERVED_VALUE_PROPERTY_NAMES[variable]
        )) {
          throw new Error(`Variable name conflicts with built-in property or method: ${variable}`);
        }
      }
      const escapedKey = mount.path.match(/\/([^/]*)$/)[1];
      if (mount.placeholder && escapedKey.charAt(0) === '$') {
        throw new Error(
          `Class ${Class.name} mounted at wildcard ${escapedKey} cannot be a placeholder`);
      }
      return {Class, matcher, computedProperties, escapedKey, placeholder: mount.placeholder};
    });
  }

  /**
   * Creates a Truss object and sets all its basic properties: path segment variables, user-defined
   * properties, and computed properties.  The latter two will be enumerable so that Vue will pick
   * them up and make the reactive, so you should call _completeCreateObject once it's done so and
   * before any Firebase properties are added.
   */
  createObject(path, properties) {
    let Class = Value;
    let computedProperties;
    for (let mount of this._mounts) {
      const match = mount.matcher.match(path);
      if (match) {
        Class = mount.Class;
        computedProperties = mount.computedProperties;
        for (let variable in match) {
          properties[variable] = {
            value: match[variable], writable: false, configurable: false, enumerable: false
          };
        }
        break;
      }
    }

    const object = new Class();

    if (computedProperties) {
      _.each(computedProperties, prop => {
        properties[prop.name] = this._buildComputedPropertyDescriptor(object, prop);
      });
    }

    return object;
  }

  _buildComputedPropertyDescriptor(object, prop) {
    if (!computedPropertyStats[prop.fullName]) {
      Object.defineProperty(computedPropertyStats, prop.fullName, {
        value: new ComputedPropertyStats(prop.fullName), writable: false, enumerable: true,
        configurable: false
      });
    }
    const stats = computedPropertyStats[prop.fullName];

    let value;
    let writeAllowed = false;
    let firstCallback = true;

    if (!object.$$finalizers) {
      Object.defineProperty(object, '$$finalizers', {
        value: [], writable: false, enumerable: false, configurable: false});
    }
    if (!object.$$initializers) {
      Object.defineProperty(object, '$$initializers', {
        value: [], writable: false, enumerable: false, configurable: true});
    }
    object.$$initializers.push(vue => {
      object.$$finalizers.push(
        vue.$watch(computeValue.bind(object, prop, stats), newValue => {
          if (firstCallback) {
            stats.numUpdates += 1;
            value = newValue;
            firstCallback = false;
          } else {
            if (_.isEqual(value, newValue, isTrussValueEqual)) return;
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

  isPlaceholder(path) {
    // TODO: optimize by precomputing a single all-placeholder-paths regex
    return _.some(this._mounts, mount => mount.placeholder && mount.matcher.test(path));
  }

  forEachPlaceholderChild(path, iteratee) {
    _.each(this._mounts, mount => {
      if (mount.placeholder && mount.matcher.testParent(path)) {
        iteratee(mount.escapedKey, mount.placeholder);
      }
    });
  }

  static get computedPropertyStats() {
    return computedPropertyStats;
  }
}


function computeValue(prop, stats) {
  // jshint validthis: true
  // Touch this object, since a failed access to a missing property doesn't get captured as a
  // dependency.
  this.$$touchThis();

  const startTime = performanceNow();
  try {
    return prop.get.call(this);
  } catch (e) {
    return new ErrorWrapper(e);
  } finally {
    stats.runtime += performanceNow() - startTime;
    stats.numRecomputes += 1;
  }
  // jshint validthis: false
}

function isTrussValueEqual(a, b) {
  if (a && a.$truss || b && b.$truss) return a === b;
}
