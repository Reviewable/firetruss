import angular from './angularCompatibility.js';
import Vue from 'vue';
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
        if (!Object.hasOwn(this, key)) {
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

    this._auth = {serial: 0, initialAuthChangeReceived: false, changePromise: Promise.resolve()};

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
    this._auth.serial++;
    return this._dispatcher.execute(
      'auth', 'authenticate', new Reference(this._tree, '/'), token, () => {
        const promise = token ?
          this._bridge.authWithCustomToken(this._rootUrl, token) :
          this._bridge.authAnonymously(this._rootUrl);
        return promise.then(() => this._auth.changePromise);
      }
    );
  }

  unauthenticate() {
    // Signal user change to null pre-emptively.  This is what the Firebase SDK does as well, since
    // it lets the app tear down user-required connections before the user is actually deauthed,
    // which can prevent spurious permission denied errors.
    this._auth.serial++;
    return this._handleAuthChange(null).then(approved => {
      // Bail if auth change callback initiated another authentication, since it will have already
      // sent the command to the bridge and sending our own now would incorrectly override it.
      if (!approved) return;
      return this._dispatcher.execute(
        'auth', 'unauthenticate', new Reference(this._tree, '/'), undefined, () => {
          return this._bridge.unauth(this._rootUrl);
        }
      );
    });
  }

  _handleAuthChange(user) {
    const supersededChange = !this._auth.initialAuthChangeReceived && this._auth.serial;
    if (user !== undefined) this._auth.initialAuthChangeReceived = true;
    if (supersededChange) return;
    const authSerial = this._auth.serial;
    if (this.root.user === user) return Promise.resolve(false);
    const promise = this._dispatcher.execute(
      'auth', 'certify', new Reference(this._tree, '/'), user, () => {
        if (this.root.user === user || authSerial !== this._auth.serial) return false;
        if (user) Object.freeze(user);
        this.root.user = user;
        this.root.userid = user && user.uid;
        angular.digest();
        return true;
      }
    );
    this._auth.changePromise = this._auth.changePromise.then(() => promise).catch();
    return promise;
  }

  _isAuthChangeStale(user) {
    return this.root.user === user;
  }

  _connectInfoProperty(property, attribute) {
    const url = new URL(this._rootUrl);
    url.pathname = encodeURI(`/.info/${property}`);
    this._bridge.on(url.href, url.href, null, 'value', snap => {
      this.root[attribute] = snap.value;
      angular.digest();
    });
  }
}
