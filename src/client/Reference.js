'use strict';

import {escapeKey, unescapeKey} from './utils.js';

import _ from 'lodash';


export class Query {
  constructor(truss, path, terms) {
    this._truss = truss;
    this._path = path.replace(/^\/*/, '/').replace(/\/$/, '');
    this._terms = terms;  // warning: accessed directly by Coupler
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

  toString() {
    if (!this._string) {
      this._string = this._path;
      if (this._terms) {
        const queryTerms = this._terms.map(term => {
          let queryTerm = term[0];
          if (term.length > 1) {
            queryTerm +=
              '=' + encodeURIComponent(term.slice(1).map(x => JSON.stringify(x)).join(','));
          }
          return queryTerm;
        });
        queryTerms.sort();
        this._string += '?' + queryTerms.join('&');
      }
    }
    return this._string;
  }

  isEqual(that) {
    if (!(that instanceof Query)) return false;
    return this._truss === that._truss && this.toString() === that.toString();
  }

  belongsTo(truss) {
    return this._truss === truss;
  }

  orderByChild(ref) {
    if (ref._terms) {
      throw new Error('orderByChild must be called with a reference, not a query: ' + ref);
    }
    let relativePath = ref.toString();
    if (_.startsWith(relativePath, this._path)) {
      relativePath = relativePath.slice(this._path.length);
    }
    const terms = this._terms ? this._terms.slice() : [];
    terms.push(['orderByChild', relativePath]);
    return new Query(this._truss, this._path, terms);
  }
}

[
  'orderByKey', 'orderByValue', 'startAt', 'endAt', 'equalTo', 'limitToFirst', 'limitToLast'
].forEach(methodName => {
  Query.prototype[methodName] = function() {
    const term = Array.prototype.slice.call(arguments);
    term.unshift(methodName);
    const terms = this._terms ? this._terms.slice() : [];
    terms.push(term);
    return new Query(this._url, terms);
  };
});


// jshint latedef:false
export class Reference extends Query {
// jshint latedef:nofunc

  constructor(truss, path) {
    super(truss, path);
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
