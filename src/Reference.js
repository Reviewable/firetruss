import {escapeKey, unescapeKey, makePathMatcher} from './utils/paths.js';

import _ from 'lodash';

/* eslint-disable no-use-before-define */

const EMPTY_ANNOTATIONS = {};
Object.freeze(EMPTY_ANNOTATIONS);


export class Handle {
  constructor(tree, path, annotations) {
    this._tree = tree;
    this._path = path.replace(/^\/*/, '/').replace(/\/$/, '') || '/';
    if (annotations) {
      this._annotations = annotations;
      Object.freeze(annotations);
    }
  }

  get $ref() {return this;}
  get key() {
    if (!this._key) this._key = unescapeKey(this._path.replace(/.*\//, ''));
    return this._key;
  }

  get path() {return this._path;}
  get _pathPrefix() {return this._path === '/' ? '' : this._path;}
  get parent() {
    return new Reference(this._tree, this._path.replace(/\/[^/]*$/, ''), this._annotations);
  }

  get annotations() {
    return this._annotations || EMPTY_ANNOTATIONS;
  }

  child() {
    if (!arguments.length) return this;
    const segments = [];
    for (const key of arguments) {
      if (_.isNil(key)) return;
      segments.push(escapeKey(key));
    }
    return new Reference(
      this._tree, `${this._pathPrefix}/${segments.join('/')}`,
      this._annotations
    );
  }

  children() {
    if (!arguments.length) return this;
    const escapedKeys = [];
    for (let i = 0; i < arguments.length; i++) {
      const arg = arguments[i];
      if (_.isArray(arg)) {
        const mapping = {};
        const subPath = this._pathPrefix + (escapedKeys.length ? `/${escapedKeys.join('/')}` : '');
        const rest = _.slice(arguments, i + 1);
        for (const key of arg) {
          const subRef =
            new Reference(this._tree, `${subPath}/${escapeKey(key)}`, this._annotations);
          const subMapping = subRef.children.apply(subRef, rest);
          if (subMapping) mapping[key] = subMapping;
        }
        return mapping;
      }
      if (_.isNil(arg)) return;
      escapedKeys.push(escapeKey(arg));
    }
    return new Reference(
      this._tree, `${this._pathPrefix}/${escapedKeys.join('/')}`, this._annotations);
  }

  peek(callback) {
    return this._tree.truss.peek(this, callback);
  }

  match(pattern) {
    return makePathMatcher(pattern).match(this.path);
  }

  test(pattern) {
    return makePathMatcher(pattern).test(this.path);
  }

  isEqual(that) {
    if (!(that instanceof Handle)) return false;
    return this._tree === that._tree && this.toString() === that.toString() &&
      _.isEqual(this._annotations, that._annotations);
  }

  belongsTo(truss) {
    return this._tree.truss === truss;
  }
}


export class Query extends Handle {
  constructor(tree, path, spec, annotations) {
    super(tree, path, annotations);
    this._spec = this._copyAndValidateSpec(spec);
    const queryTerms = _(this._spec)
      .map((value, key) => `${key}=${encodeURIComponent(JSON.stringify(value))}`)
      .sortBy()
      .join('&');
    this._string = `${this._path}?${queryTerms}`;
    Object.freeze(this);
  }

  // Vue-bound
  get ready() {
    return this._tree.isQueryReady(this);
  }

  get constraints() {
    return this._spec;
  }

  annotate(annotations) {
    return new Query(
      this._tree, this._path, this._spec, _.assign({}, this._annotations, annotations));
  }

  _copyAndValidateSpec(spec) {
    if (!spec.by) throw new Error('Query needs "by" clause: ' + JSON.stringify(spec));
    if (('at' in spec) + ('from' in spec) + ('to' in spec) > 1) {
      throw new Error(
        'Query must contain at most one of "at", "from", or "to" clauses: ' + JSON.stringify(spec));
    }
    if (('first' in spec) + ('last' in spec) > 1) {
      throw new Error(
        'Query must contain at most one of "first" or "last" clauses: ' + JSON.stringify(spec));
    }
    if (!_.some(['at', 'from', 'to', 'first', 'last'], clause => clause in spec)) {
      throw new Error(
        'Query must contain at least one of "at", "from", "to", "first", or "last" clauses: ' +
        JSON.stringify(spec));
    }
    spec = _.clone(spec);
    if (spec.by !== '$key' && spec.by !== '$value') {
      if (!(spec.by instanceof Reference)) {
        throw new Error('Query "by" value must be a reference: ' + spec.by);
      }
      let childPath = spec.by.toString();
      if (!_.startsWith(childPath, this._path)) {
        throw new Error(
          'Query "by" value must be a descendant of target reference: ' + spec.by);
      }
      childPath = childPath.slice(this._path.length).replace(/^\/?/, '');
      if (!_.includes(childPath, '/')) {
        throw new Error(
          'Query "by" value must not be a direct child of target reference: ' + spec.by);
      }
      spec.by = childPath.replace(/.*?\//, '');
    }
    Object.freeze(spec);
    return spec;
  }


  toString() {
    return this._string;
  }
}


export class Reference extends Handle {

  constructor(tree, path, annotations) {
    super(tree, path, annotations);
    Object.freeze(this);
  }

  get ready() {return this._tree.isReferenceReady(this);}  // Vue-bound
  get value() {return this._tree.getObject(this.path);}  // Vue-bound
  toString() {return this._path;}

  annotate(annotations) {
    return new Reference(this._tree, this._path, _.assign({}, this._annotations, annotations));
  }

  query(spec) {
    return new Query(this._tree, this._path, spec, this._annotations);
  }

  set(value) {
    this._checkForUndefinedPath();
    return this._tree.update(this, 'set', {[this.path]: value});
  }

  update(values) {
    this._checkForUndefinedPath();
    return this._tree.update(this, 'update', values);
  }

  override(value) {
    this._checkForUndefinedPath();
    return this._tree.update(this, 'override', {[this.path]: value});
  }

  commit(updateFunction) {
    this._checkForUndefinedPath();
    return this._tree.commit(this, updateFunction);
  }

  _checkForUndefinedPath() {
    if (this.path === '/undefined') throw new Error('Invalid path for operation: ' + this.path);
  }
}

export default Reference;
