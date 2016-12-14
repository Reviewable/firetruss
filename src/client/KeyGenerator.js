'use strict';

const ALPHABET = '-0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ_abcdefghijklmnopqrstuvwxyz';

class KeyGenerator {
  constructor() {
    this._lastUniqueKeyTime = 0;
    this._lastRandomValues = [];
  }

  generateUniqueKey(now) {
    now = now || Date.now();
    const chars = new Array(20);
    let prefix = now;
    for (let i = 7; i >= 0; i--) {
      chars[i] = ALPHABET.charAt(prefix & 0x3f);
      prefix = Math.floor(prefix / 64);
    }
    if (now === this._lastUniqueKeyTime) {
      let i = 11;
      while (i >= 0 && this._lastRandomValues[i] === 63) {
        this._lastRandomValues[i] = 0;
        i -= 1;
      }
      if (i === -1) {
        throw new Error('Internal assertion failure: ran out of unique IDs for this millisecond');
      }
      this._lastRandomValues[i] += 1;
    } else {
      this._lastUniqueKeyTime = now;
      for (let i = 0; i < 12; i++) {
        // Make sure to leave some space for incrementing in the top nibble.
        this._lastRandomValues[i] = Math.floor(Math.random() * (i ? 64 : 16));
      }
    }
    for (let i = 0; i < 12; i++) {
      chars[i + 8] = ALPHABET[this._lastRandomValues[i]];
    }
    return chars.join('');
  }
}

export default KeyGenerator;
