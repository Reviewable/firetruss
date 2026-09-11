import _ from 'lodash';
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
          };
          update();
          setInterval(update, intervalMillis);
        }
        return this[key];
      }
    }}});

    this._auth = {
      serial: 0, initialAuthChangeReceived: false,
      // `changePromise` is the scheduling tail, recovered so one failure can't wedge the queue;
      // `resultPromise` keeps the real outcome for callers that need to see a rejection.
      changePromise: Promise.resolve(), resultPromise: Promise.resolve(),
      // Depth of certifications whose interceptors are still running, so that a change triggered
      // from inside one can be told apart from a bridge callback that merely arrived while one
      // was in flight.
      certifyingDepth: 0
    };

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
        return promise.then(() => this._auth.resultPromise);
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
    // Serialize certifications.  The bridge doesn't await our auth listeners, so consecutive
    // callbacks would otherwise overlap:  a second certification could run its interceptors and
    // publish while an earlier one is still in its own onBefore, letting the two land out of
    // order.  The serial below can't catch that, since it only changes when the app itself calls
    // authenticate()/unauthenticate(), not between two callbacks from the bridge.  Note that the
    // duplicate-user check has to wait for our turn too, or a change queued behind a pending one
    // would be discarded by comparing against a root the queue hasn't updated yet.
    // An interceptor of a running certification may itself trigger an auth change, and queueing
    // that behind the certification whose interceptor is awaiting it would deadlock both.  Such a
    // change is already ordered by the interceptor that asked for it, so run it directly.  This
    // has to be decided here rather than inside the queued turn:  a bridge callback that merely
    // arrives while a certification is in flight is not nested, and must still take its turn.
    const nested = this._auth.certifyingDepth > 0;
    const promise = (nested ? Promise.resolve() : this._auth.changePromise).then(() => {
      if (this.root.user === user) return false;
      this._auth.certifyingDepth++;
      return this._dispatcher.execute(
        'auth', 'certify', new Reference(this._tree, '/'), user, () => {
          if (this.root.user === user || authSerial !== this._auth.serial) return false;
          if (user) Object.freeze(user);
          this.root.user = user;
          this.root.userid = user && user.uid;
          return true;
        }
      ).finally(() => {
        this._auth.certifyingDepth--;
      });
    });
    // Keep the queue moving if this certification fails, but don't let the recovered tail hide
    // the failure from authenticate(), which waits on the result instead.
    if (!nested) {
      this._auth.changePromise = promise.catch(_.noop);
      this._auth.resultPromise = promise;
    }
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
    });
  }
}
