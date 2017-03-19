import angularCompatibility from './angularCompatibility.js';
import Vue from 'vue';

export default class MetaTree {
  constructor(rootUrl, bridge) {
    this._rootUrl = rootUrl;
    this._bridge = bridge;
    this._vue = new Vue({data: {$root: {
      connected: undefined, timeOffset: 0, user: undefined, userid: undefined,
      updateNowAtIntervals(name, intervalMillis) {
        if (this.hasOwnProperty(name)) throw new Error(`Property "${name}" already defined`);
        Vue.set(this, name, Date.now() + this.timeOffset);
        setInterval(() => {
          this[name] = Date.now() + this.timeOffset;
        }, intervalMillis);
      }
    }}});

    if (angularCompatibility.active) {
      this._vue.$watch('$data', angularCompatibility.digest, {deep: true});
    }

    bridge.onAuth(rootUrl, this._handleAuthChange, this);

    this._connectInfoProperty('serverTimeOffset', 'timeOffset');
    this._connectInfoProperty('connected', 'connected');
  }

  get root() {
    return this._vue.$data.$root;
  }

  destroy() {
    this._bridge.offAuth(this._rootUrl, this._handleAuthChange, this);
    this._vue.$destroy();
  }

  _handleAuthChange(user) {
    this.root.user = user;
    this.root.userid = user && user.uid;
  }

  _connectInfoProperty(property, attribute) {
    const propertyUrl = `${this._rootUrl}/.info/${property}`;
    this._bridge.on(propertyUrl, propertyUrl, null, 'value', snap => {
      this.root[attribute] = snap.value;
    });
  }
}
