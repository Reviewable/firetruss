import {escapeKey, unescapeKey} from './utils.js';

import _ from 'lodash';


class Handle {
  constructor(truss, path) {
    this._truss = truss;
    this._path = path.replace(/^\/*/, '/').replace(/\/$/, '');
  }

  get key() {
    if (!this._key) this._key = unescapeKey(this._path.replace(/.*\//, ''));
    return this._key;
  }
  get path() {return this._path;}
  get parent() {return new Reference(this._truss, this._path.replace(/\/[^/]*$/, ''));}

  get ready() {}  // TODO: implement
  waitUntilReady() {}  // TODO: implement

  get() {
    // TODO: implement
    if (this.ready) return Promise.resolve();
    return trackSlowness(worker.once(this._url, this._terms, 'value'), 'read');
  }

  isEqual(that) {
    if (!(that instanceof Handle)) return false;
    return this._truss === that._truss && this.toString() === that.toString();
  }

  belongsTo(truss) {
    return this._truss === truss;
  }

}


export class Query extends Handle {
  constructor(truss, path, spec) {
    super(truss, path);
    this._spec = this._copyAndValidateSpec(spec);
  }

  _copyAndValidateSpec(spec) {
    if (!spec.by) throw new Error('Query needs "by" clause: ' + JSON.stringify(spec));
    if (!!spec.at + !!spec.from + !!spec.to > 1) {
      throw new Error(
        'Query must contain at most one of "at", "from", or "to" clauses: ' + JSON.stringify(spec));
    }
    if (!!spec.first + !!spec.last > 1) {
      throw new Error(
        'Query must contain at most one of "first" or "last" clauses: ' + JSON.stringify(spec));
    }
    return _.clone(spec);
  }

  get _terms() {  // warning: accessed directly by Coupler
    const terms = [];

    switch (this._spec.by) {
      case '$key': terms.push('orderByKey'); break;
      case '$value': terms.push('orderByValue'); break;
      default: {
        if (!(this._spec.by instanceof Reference)) {
          throw new Error('Query "by" value must be a reference: ' + this._spec.by);
        }
        let childPath = this._spec.by.toString();
        if (!_.startsWith(childPath, this._path)) {
          throw new Error(
            'Query "by" value must be a descendant of target reference: ' + this._spec.by);
        }
        childPath = childPath.slice(this._path.length).replace(/^\/?/, '');
        if (childPath.indexOf('/') === -1) {
          throw new Error(
            'Query "by" value must not be a direct child of target reference: ' + this._spec.by);
        }
        childPath = childPath.replace(/.*?\//, '');
        terms.push(['orderByChild', childPath]);
        break;
      }
    }

    if (this._spec.at) terms.push(['equalTo', this._spec.at]);
    else if (this._spec.from) terms.push(['startAt', this._spec.from]);
    else if (this._spec.to) terms.push(['endAt', this._spec.to]);

    if (this._spec.first) terms.push(['limitToFirst', this._spec.first]);
    else if (this._spec.last) terms.push(['limitToLast', this._spec.last]);

    return terms;
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

  constructor(truss, path) {
    super(truss, path);
  }

  toString() {
    return this._path;
  }

  child() {
    if (!arguments.length) return this;
    return new Reference(
      this._truss, `${this._path}/${_.map(arguments, key => escapeKey(key)).join('/')}`);
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
          const subRef = new Reference(this._truss, `${subPath}/${escapeKey(key)}`);
          mapping[key] = subRef.children.apply(subRef, rest);
        });
        return mapping;
      } else {
        escapedKeys.push(escapeKey(arg));
      }
    });
    return new Reference(this._truss, `${this._path}/${escapedKeys.join('/')}`);
  }

  query(spec) {
    return new Query(this._truss, this._path, spec);
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
