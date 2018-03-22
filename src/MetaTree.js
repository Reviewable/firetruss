import angular from './angularCompatibility.js';
import Vue from 'vue';
import _ from 'lodash';
import Reference from './Reference.js';
import {promiseFinally} from './utils/promises.js';


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
            Vue.set(this, key, Date.now() + this.timeOffset);
            angular.digest();
          };
          update();
          setInterval(update, intervalMillis);
        }
        return this[key];
      }
    }}});

    this._authsInProgress = {};

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
    this._authsInProgress[token] = true;
    return promiseFinally(
      this._dispatcher.execute(
        'auth', 'authenticate', new Reference(this._tree, '/'), token, () => {
          return this._bridge.authWithCustomToken(this._rootUrl, token, {rememberMe: true});
        }
      ),
      () => {delete this._authsInProgress[token];}
    );
  }

  unauthenticate() {
    this._authsInProgress.null = true;
    // Signal user change to null pre-emptively.  This is what the Firebase SDK does as well, since
    // it lets the app tear down user-required connections before the user is actually deauthed,
    // which can prevent spurious permission denied errors.
    return this._handleAuthChange(null).then(() => promiseFinally(
      this._dispatcher.execute(
        'auth', 'unauthenticate', new Reference(this._tree, '/'), undefined, () => {
          return this._bridge.unauth(this._rootUrl);
        }
      ),
      () => {delete this._authsInProgress.null;}
    ));
  }

  _handleAuthChange(user) {
    delete this._authsInProgress[user ? user.token : null];
    if (this.root.user === user || !_.isEmpty(this._authsInProgress)) return;
    return this._dispatcher.execute('auth', 'certify', new Reference(this._tree, '/'), user, () => {
      if (!_.isEmpty(this._authsInProgress)) return;
      if (user) Object.freeze(user);
      this.root.user = user;
      this.root.userid = user && user.uid;
      angular.digest();
    });
  }

  _connectInfoProperty(property, attribute) {
    const propertyUrl = `${this._rootUrl}/.info/${property}`;
    this._bridge.on(propertyUrl, propertyUrl, null, 'value', snap => {
      this.root[attribute] = snap.value;
      angular.digest();
    });
  }
}
