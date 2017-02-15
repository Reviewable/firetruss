export function escapeKey(key) {
  if (!key) return key;
  return key.toString().replace(/[\\\.\$\#\[\]\/]/g, function(char) {
    return '\\' + char.charCodeAt(0).toString(16);
  });
}

export function unescapeKey(key) {
  if (!key) return key;
  return key.toString().replace(/\\[0-9a-f]{2}/gi, function(code) {
    return String.fromCharCode(parseInt(code.slice(1), 16));
  });
}

export function wrapPromiseCallback(callback) {
  return function() {
    try {
      return Promise.resolve(callback.apply(this, arguments));
    } catch (e) {
      return Promise.reject(e);
    }
  };
}

export const TIMESTAMP = Object.freeze({'.sv': 'timestamp'});
export const ABORT_TRANSACTION_NOW = Object.freeze(Object.create(null));
