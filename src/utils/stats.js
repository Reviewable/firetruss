import {isTrussEqual} from './utils.js';

import _ from 'lodash';


class StatItem {
  constructor(name) {
    _.assign(this, {name, numRecomputes: 0, numUpdates: 0, computeTime: 0, updateTime: 0});
  }

  add(item) {
    this.computeTime += item.computeTime;
    this.updateTime += item.updateTime;
    this.numUpdates += item.numUpdates;
    this.numRecomputes += item.numRecomputes;
  }

  get runtime() {
    return this.computeTime + this.updateTime;
  }

  get runtimePerRecompute() {
    return this.numRecomputes ? this.computeTime / this.numRecomputes : 0;
  }

  get runtimePerUpdate() {
    return this.numUpdates ? this.updateTime / this.numUpdates : 0;
  }

  toLogParts(totals) {
    return [
      `${this.name}:`, ` ${(this.runtime / 1000).toFixed(2)}s`,
      `(${(this.runtime / totals.runtime * 100).toFixed(1)}%)`,
      ` ${this.numUpdates} upd /`, `${this.numRecomputes} runs`,
      `(${(this.numUpdates / this.numRecomputes * 100).toFixed(1)}%)`,
      ` ${this.runtimePerRecompute.toFixed(2)}ms / run`,
      ` ${this.runtimePerUpdate.toFixed(2)}ms / upd`
    ];
  }
}

class Stats {
  constructor() {
    this._items = {};
  }

  for(name) {
    if (!this._items[name]) this._items[name] = new StatItem(name);
    return this._items[name];
  }

  get list() {
    return _(this._items).values().sortBy(item => -item.runtime).value();
  }

  log(n = 10) {
    let stats = this.list;
    if (!stats.length) return;
    const totals = new StatItem('=== Total');
    _.forEach(stats, stat => {totals.add(stat);});
    stats = _.take(stats, n);
    const above = new StatItem('--- Above');
    _.forEach(stats, stat => {above.add(stat);});
    const lines = _.map(stats, item => item.toLogParts(totals));
    lines.push(above.toLogParts(totals));
    lines.push(totals.toLogParts(totals));
    const widths = _.map(_.range(lines[0].length), i => _(lines).map(line => line[i].length).max());
    _.forEach(lines, line => {
      console.log(_.map(line, (column, i) => _.padStart(column, widths[i])).join(' '));
    });
  }

  wrap(getter, className, propName) {
    const item = this.for(`${className}.${propName}`);
    return function() {
      /* eslint-disable no-invalid-this */
      const startTime = performance.now();
      const oldValue = this._computedWatchers && this._computedWatchers[propName].value;
      try {
        const newValue = getter.call(this);
        if (!isTrussEqual(oldValue, newValue)) item.numUpdates += 1;
        return newValue;
      } finally {
        item.computeTime += performance.now() - startTime;
        item.numRecomputes += 1;
      }
    };
  }
}

export default new Stats();
