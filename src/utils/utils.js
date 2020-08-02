import _ from 'lodash';


export const SERVER_TIMESTAMP = Object.freeze({'.sv': 'timestamp'});

export function isTrussEqual(a, b) {
  return _.isEqualWith(a, b, isTrussValueEqual);
}

function isTrussValueEqual(a, b) {
  if (a === b || a === undefined || a === null || b === undefined || b === null ||
      a.$truss || b.$truss) return a === b;
  if (a.isEqual) return a.isEqual(b);
}

export function copyPrototype(a, b) {
  for (const prop of Object.getOwnPropertyNames(a.prototype)) {
    if (prop === 'constructor') continue;
    Object.defineProperty(b.prototype, prop, Object.getOwnPropertyDescriptor(a.prototype, prop));
  }
}
