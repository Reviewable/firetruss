import {escapeKey, unescapeKey} from './utils.js';

import _ from 'lodash';


export class Handle {
  constructor(tree, path) {
    this._tree = tree;
    this._path = path.replace(/^\/*/, '/').replace(/\/$/, '');
  }

  get key() {
    if (!this._key) this._key = unescapeKey(this._path.replace(/.*\//, ''));
    return this._key;
  }
  get path() {return this._path;}
  get parent() {return new Reference(this._tree, this._path.replace(/\/[^/]*$/, ''));}

  get annotations() {
    if (!this._annotations) this._annotations = {};
    return this._annotations;
  }

  peek(callback) {
    return this._tree.truss.peek(this, callback);
  }

  isEqual(that) {
    if (!(that instanceof Handle)) return false;
    return this._tree === that._tree && this.toString() === that.toString();
  }

  belongsTo(truss) {
    return this._tree.truss === truss;
  }
}


export class Query extends Handle {
  constructor(tree, path, spec) {
    super(tree, path);
    this._spec = this._copyAndValidateSpec(spec);
  }

  // Vue-bound
  get ready() {
    return this._tree.isQueryReady(this);
  }

  get constraints() {
    return this._spec;
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
      if (childPath.indexOf('/') === -1) {
        throw new Error(
          'Query "by" value must not be a direct child of target reference: ' + spec.by);
      }
      spec.by = childPath.replace(/.*?\//, '');
    }
    Object.freeze(spec);
    return spec;
  }


  toString() {
    if (!this._string) {
      const queryTerms = _(this._spec)
        .map((value, key) => `${key}=${encodeURIComponent(JSON.stringify(value))}`)
        .sortBy()
        .join('&');
      this._string = `${this._path}?${queryTerms}`;
    }
    return this._string;
  }
}


// jshint latedef:false
export class Reference extends Handle {
// jshint latedef:nofunc

  constructor(tree, path) {
    super(tree, path);
  }

  // Vue-bound
  get ready() {
    return this._tree.isReferenceReady(this);
  }

  toString() {
    return this._path;
  }

  child() {
    if (!arguments.length) return this;
    return new Reference(
      this._tree, `${this._path}/${_.map(arguments, key => escapeKey(key)).join('/')}`);
  }

  children() {
    if (!arguments.length) return this;
    const escapedKeys = [];
    _.each(arguments, (arg, i) => {
      if (_.isArray(arg)) {
        const mapping = {};
        const subPath = `${this._path}/${escapedKeys.join('/')}`;
        const rest = _.slice(arguments, i + 1);
        _.each(arg, key => {
          const subRef = new Reference(this._tree, `${subPath}/${escapeKey(key)}`);
          mapping[key] = subRef.children.apply(subRef, rest);
        });
        return mapping;
      } else {
        escapedKeys.push(escapeKey(arg));
      }
    });
    return new Reference(this._tree, `${this._path}/${escapedKeys.join('/')}`);
  }

  query(spec) {
    return new Query(this._tree, this._path, spec);
  }

  set(value) {}  // TODO: implement
  update(values) {}  // TODO: implement

  commit(options, updateFunction) {
    // TODO: revise
    // const options = {
    //   applyLocally: applyLocally === undefined ? updateFunction.applyLocally : applyLocally
    // };
    // ['nonsequential', 'safeAbort'].forEach(key => options[key] = updateFunction[key]);
    for (let key in options) {
      if (options.hasOwnProperty(key) && options[key] === undefined) {
        options[key] = Truss.DefaultTransactionOptions[key];
      }
    }

    // Hold the ref value live until transaction complete, otherwise it'll keep retrying on a null
    // value.
    this.on('value', noop);  // No error handling -- if this fails, so will the transaction.
    return trackSlowness(
      worker.transaction(this._url, updateFunction, options), 'write'
    ).then(result => {
      this.off('value', noop);
      return result;
    }, error => {
      this.off('value', noop);
      return Promise.reject(error);
    });
  }
}

export default Reference;
