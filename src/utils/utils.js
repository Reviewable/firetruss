import _ from 'lodash';


export const SERVER_TIMESTAMP = Object.freeze({'.sv': 'timestamp'});

export function isTrussEqual(a, b) {
  return _.isEqual(a, b, isTrussValueEqual);
}

function isTrussValueEqual(a, b) {
  if (a === b || a === undefined || a === null || b === undefined || b === null ||
      a.$truss || b.$truss) return a === b;
  if (a.isEqual) return a.isEqual(b);
}

