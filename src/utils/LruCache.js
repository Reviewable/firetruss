import _ from 'lodash';


class LruCacheItem {
  constructor(key, value) {
    this.key = key;
    this.value = value;
    this.touch();
  }

  touch() {
    this.timestamp = Date.now();
  }
}


export default class LruCache {
  constructor(maxSize, pruningSize) {
    this._items = Object.create(null);
    this._size = 0;
    this._maxSize = maxSize;
    this._pruningSize = pruningSize || Math.ceil(maxSize * 0.10);
  }

  has(key) {
    return Boolean(this._items[key]);
  }

  get(key) {
    const item = this._items[key];
    if (!item) return;
    item.touch();
    return item.value;
  }

  set(key, value) {
    const item = this._items[key];
    if (item) {
      item.value = value;
    } else {
      if (this._size >= this._maxSize) this._prune();
      this._items[key] = new LruCacheItem(key, value);
      this._size += 1;
    }
  }

  delete(key) {
    const item = this._items[key];
    if (!item) return;
    delete this._items[key];
    this._size -= 1;
  }

  _prune() {
    const itemsToPrune =
      _(this._items).toArray().sortBy('timestamp').take(this._pruningSize).value();
    for (const item of itemsToPrune) this.delete(item.key);
  }
}
