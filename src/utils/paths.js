import LruCache from './LruCache.js';
import _ from 'lodash';


const pathSegments = new LruCache(1000);
const pathMatchers = {};
const maxNumPathMatchers = 1000;


export function escapeKey(key) {
  if (!key) return key;
  // eslint-disable-next-line no-control-regex
  return key.toString().replace(/[\x00-\x1f\\.$#[\]\x7f/]/g, function(char) {
    return '\\' + _.padStart(char.charCodeAt(0).toString(16), 2, '0');
  });
}

export function unescapeKey(key) {
  if (!key) return key;
  return key.toString().replace(/\\[0-9a-f]{2}/gi, function(code) {
    return String.fromCharCode(parseInt(code.slice(1), 16));
  });
}

export function escapeKeys(object) {
  // isExtensible check avoids trying to escape references to Firetruss internals.
  if (!(_.isObject(object) && Object.isExtensible(object))) return object;
  let result = object;
  for (const key in object) {
    if (!Object.hasOwn(object, key)) continue;
    const value = object[key];
    const escapedKey = escapeKey(key);
    const escapedValue = escapeKeys(value);
    if (escapedKey !== key || escapedValue !== value) {
      if (result === object) result = _.clone(object);
      result[escapedKey] = escapedValue;
      if (result[key] === value) delete result[key];
    }
  }
  return result;
}

export function joinPath() {
  const segments = [];
  for (let segment of arguments) {
    if (!_.isString(segment)) segment = '' + segment;
    if (segment.charAt(0) === '/') segments.splice(0, segments.length);
    segments.push(segment);
  }
  if (segments[0] === '/') segments[0] = '';
  return segments.join('/');
}

export function splitPath(path, leaveSegmentsEscaped) {
  const key = (leaveSegmentsEscaped ? 'esc:' : '') + path;
  let segments = pathSegments.get(key);
  if (!segments) {
    segments = path.split('/');
    if (!leaveSegmentsEscaped) segments = _.map(segments, unescapeKey);
    pathSegments.set(key, segments);
  }
  return segments;
}


class PathMatcher {
  constructor(pattern) {
    this.variables = [];
    const prefixMatch = _.endsWith(pattern, '/$*');
    if (prefixMatch) pattern = pattern.slice(0, -3);
    const pathTemplate = pattern.replace(/\/\$[^/]*/g, match => {
      if (match.length > 1) this.variables.push(match.slice(1));
      return '\u0001';
    });
    Object.freeze(this.variables);
    if (/[.$#[\]]|\\(?![0-9a-f][0-9a-f])/i.test(pathTemplate)) {
      throw new Error('Path pattern has unescaped keys: ' + pattern);
    }
    this._regex = new RegExp(
      // eslint-disable-next-line no-control-regex
      '^' + pathTemplate.replace(/\u0001/g, '/([^/]+)') + (prefixMatch ? '($|/)' : '$'));
  }

  match(path) {
    this._regex.lastIndex = 0;
    const match = this._regex.exec(path);
    if (!match) return;
    const bindings = {};
    for (let i = 0; i < this.variables.length; i++) {
      bindings[this.variables[i]] = unescapeKey(match[i + 1]);
    }
    return bindings;
  }

  test(path) {
    return this._regex.test(path);
  }

  toString() {
    return this._regex.toString();
  }
}

export function makePathMatcher(pattern) {
  let matcher = pathMatchers[pattern];
  if (!matcher) {
    matcher = new PathMatcher(pattern);
    // Minimal pseudo-LRU behavior, since we don't expect to actually fill up the cache.
    if (_.size(pathMatchers) === maxNumPathMatchers) delete pathMatchers[_.keys(pathMatchers)[0]];
    pathMatchers[pattern] = matcher;
  }
  return matcher;
}
