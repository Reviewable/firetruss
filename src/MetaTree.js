import angular from './angularCompatibility.js';
import Vue from 'vue';
import _ from 'lodash';
import Reference from './Reference.js';


export default class MetaTree {
  constructor(rootUrl, tree, bridge, dispatcher) {
    this._rootUrl = rootUrl;
    this._tree = tree;
    this._dispatcher = dispatcher;
    this._bridge = bridge;
    this._vue = new Vue({data: {$root: {
      connected: undefined, timeOffset: 0, user: undefined, userid: undefined,
      nowAtInterval(intervalMillis) {
        const key = 'now' + intervalMillis;
        if (!this.hasOwnProperty(key)) {
          const update = () => {
            this[key] = Date.now() + this.timeOffset;
            angular.digest();
          };
          update();
          setInterval(() => update, intervalMillis);
        }
        return this[key];
      }
    }}});

    this._authTokensInProgress = [];

    bridge.onAuth(rootUrl, this._handleAuthChange, this);

    this._connectInfoProperty('serverTimeOffset', 'timeOffset');
    this._connectInfoProperty('connected', 'connected');
    Object.freeze(this);
  }

  get root() {
    return this._vue.$data.$root;
  }

  destroy() {
    this._bridge.offAuth(this._rootUrl, this._handleAuthChange, this);
    this._vue.$destroy();
  }

  authenticate(token) {
    this._authTokensInProgress.push(token);
    return this._dispatcher.execute('auth', 'authenticate', new Reference(this._tree, '/'), () => {
      return this._bridge.authWithCustomToken(this._rootUrl, token, {rememberMe: true});
    }).catch(e => {
      _.pull(this._authTokensInProgress, token);
      return Promise.reject(e);
    });
  }

  unauthenticate() {
    return this._dispatcher.execute(
      'auth', 'unauthenticate', new Reference(this._tree, '/'), () => {
        return this._bridge.unauth(this._rootUrl);
      }
    );
  }

  _handleAuthChange(user) {
    if (user) _.pull(this._authTokensInProgress, user.token);
    if (!user && this._authTokensInProgress.length) return;
    this.root.user = user;
    this.root.userid = user && user.uid;
    angular.digest();
  }

  _connectInfoProperty(property, attribute) {
    const propertyUrl = `${this._rootUrl}/.info/${property}`;
    this._bridge.on(propertyUrl, propertyUrl, null, 'value', snap => {
      this.root[attribute] = snap.value;
      angular.digest();
    });
  }
}
