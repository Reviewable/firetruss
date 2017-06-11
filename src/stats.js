import _ from 'lodash';


class StatItem {
  constructor(name) {
    _.extend(this, {name, numRecomputes: 0, numUpdates: 0, runtime: 0});
  }

  add(item) {
    this.runtime += item.runtime;
    this.numUpdates += item.numUpdates;
    this.numRecomputes += item.numRecomputes;
  }

  get runtimePerRecompute() {
    return this.numRecomputes ? this.runtime / this.numRecomputes : 0;
  }

  toLogParts(totals) {
    return [
      `${this.name}:`, ` ${(this.runtime / 1000).toFixed(2)}s`,
      `(${(this.runtime / totals.runtime * 100).toFixed(1)}%)`,
      ` ${this.numUpdates} upd /`, `${this.numRecomputes} runs`,
      `(${(this.numUpdates / this.numRecomputes * 100).toFixed(1)}%)`,
      ` ${this.runtimePerRecompute.toFixed(2)}ms / run`
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
    _.each(stats, stat => {totals.add(stat);});
    stats = _.take(stats, n);
    const above = new StatItem('--- Above');
    _.each(stats, stat => {above.add(stat);});
    const lines = _.map(stats, item => item.toLogParts(totals));
    lines.push(above.toLogParts(totals));
    lines.push(totals.toLogParts(totals));
    const widths = _.map(_.range(lines[0].length), i => _(lines).map(line => line[i].length).max());
    _.each(lines, line => {
      console.log(_.map(line, (column, i) => _.padLeft(column, widths[i])).join(' '));
    });
  }
}

export default new Stats();
