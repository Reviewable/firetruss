import _ from 'lodash';
import Vue from 'vue';
import Reference from './Reference.js';


// Thrown by `authenticate()` when a `certify` interceptor rejected the candidate user.  The
// candidate is never published, and the sign-out that clears it out runs before this is raised, so
// a failure of that sign-out takes precedence over this error.
export const AUTH_REJECTED = 'AUTH_REJECTED';


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
      // Set once the app has issued an auth call of its own, so that the bridge's initial auth
      // change callback can be ignored as superseded.  A counter isn't needed:  client calls are
      // fully serialized below, and callbacks are assigned to whichever call is outstanding.
      callIssued: false,
      initialAuthChangeReceived: false,
      // Certifications are serialized on this promise.  A client-issued auth call takes ownership
      // of it for as long as it runs, so that every callback it provokes is finished before the
      // call resolves.
      changePromise: Promise.resolve(),
      // The first certification failure seen while a client-issued call owns the queue, so that
      // the call can report it.  The queue itself always recovers, so that one bad certification
      // can't wedge the ones behind it.
      pendingFailure: undefined
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
    return this._runAuthCall(() => this._dispatcher.execute(
      'auth', 'authenticate', new Reference(this._tree, '/'), token, () => {
        return token ?
          this._bridge.authWithCustomToken(this._rootUrl, token) :
          this._bridge.authAnonymously(this._rootUrl);
      }
    ));
  }

  unauthenticate() {
    return this._runAuthCall(() => this._signOut());
  }

  // Runs a client-issued auth call with exclusive ownership of the certification queue.  Every
  // auth change callback that arrives from the moment the call is made until it finishes belongs
  // to it:  the bridge can deliver a callback and resolve the call's RPC in the same batch, and
  // the worker's `userToJson` doesn't guarantee that callbacks arrive in invocation order, so
  // waiting on the queue as it stands when the call finishes is what ties the two together.
  // Nested calls are not supported;  a `certify` interceptor that needs to reject its user returns
  // `false` instead of signing out itself.
  _runAuthCall(run) {
    this._auth.callIssued = true;
    // Claim the queue synchronously, since the bridge can deliver a callback in the same tick as
    // the call.  Waiting for the previous tail to settle before claiming it would leave those
    // callbacks on the old tail, where this call would never see their outcome.  Failures left
    // over from before the claim belong to whoever was waiting on them, so they're swallowed here.
    const previousTail = this._auth.changePromise;
    this._auth.changePromise = Promise.resolve();
    this._auth.pendingFailure = undefined;
    return previousTail.catch(_.noop).then(() => run()).then(
      result => this._finishAuthCall().then(() => result),
      // The call's own failure wins over any certification failure it provoked:  a forced sign-out
      // that couldn't reach the bridge matters more than the rejection that triggered it.
      error => this._finishAuthCall().then(() => Promise.reject(error))
    );
  }

  // Waits for the certification queue to stop growing, not merely for its current tail:  settling
  // one certification can enqueue the next one, and a call must not finish while any of them is
  // still in flight.
  _settleChangePromise() {
    const tail = this._auth.changePromise;
    return tail.catch(_.noop).then(() => {
      if (this._auth.changePromise !== tail) return this._settleChangePromise();
    });
  }

  // Finishes out a client-issued call by blocking on the queue as it then stands, so that every
  // callback the call provoked has certified before it resolves, and surfacing any certification
  // failure among them to the caller.
  _finishAuthCall() {
    return this._settleChangePromise().then(() => {
      const failure = this._auth.pendingFailure;
      this._auth.pendingFailure = undefined;
      if (failure) return Promise.reject(failure);
    });
  }

  _handleAuthChange(user) {
    const supersededChange = !this._auth.initialAuthChangeReceived && this._auth.callIssued;
    if (user !== undefined) this._auth.initialAuthChangeReceived = true;
    if (supersededChange) return;
    // Serialize certifications.  The bridge doesn't await our auth listeners, so consecutive
    // callbacks would otherwise overlap:  a second certification could run its interceptors and
    // publish while an earlier one is still in its own onBefore, letting the two land out of
    // order.  The duplicate-user check has to wait for our turn too, or a change queued behind a
    // pending one would be discarded by comparing against a root the queue hasn't updated yet.
    const promise = this._auth.changePromise.catch(_.noop).then(() => {
      if (this.root.user === user) return false;
      return this._certify(user);
    });
    // Keep the queue moving if this certification fails, but hold on to the failure so that a
    // client-issued call waiting on the queue can report it.
    this._auth.changePromise = promise.catch(error => {
      if (!this._auth.pendingFailure) this._auth.pendingFailure = error;
    });
    return promise;
  }

  // Runs the certification for a candidate user.  A `certify` interceptor rejects the candidate by
  // returning literal `false` from `onBefore`;  every handler is awaited before the verdict is
  // acted on, so a rejecting handler can't race another handler's asynchronous key setup.  A
  // rejected user is never published:  it's signed out from within this turn instead, so that the
  // sign-out doesn't queue behind the certification that asked for it.
  _certify(user) {
    return this._dispatcher.execute(
      'auth', 'certify', new Reference(this._tree, '/'), user, onBeforeResults => {
        if (user && _.some(onBeforeResults, result => result === false)) return 'rejected';
        if (this.root.user === user) return false;
        if (user) Object.freeze(user);
        this.root.user = user;
        this.root.userid = user && user.uid;
        return true;
      }
    ).then(outcome => {
      if (outcome !== 'rejected') return outcome;
      // Clear out the rejected candidate before reporting it.  A failure here is the more urgent
      // one, so let it through in place of the rejection.
      return this._signOut().then(() => {
        const error = new Error('Authentication rejected');
        error.code = AUTH_REJECTED;
        return Promise.reject(error);
      });
    });
  }

  // The guts of `unauthenticate()`, usable from inside a certification turn.  The whole flow is
  // wrapped in an `auth/unauthenticate` operation, null certification included, so that every
  // logout failure reaches an `onFailure` with `op.method === 'unauthenticate'` even when the
  // enclosing authentication error is caught.
  _signOut() {
    return this._dispatcher.execute(
      'auth', 'unauthenticate', new Reference(this._tree, '/'), undefined, () => {
        // Signal the user change to null pre-emptively.  This is what the Firebase SDK does as
        // well, since it lets the app tear down user-required connections before the user is
        // actually deauthed, which can prevent spurious permission denied errors.  An already-null
        // client user says nothing about the worker, which may well still be signed in, so the
        // bridge sign-out below runs either way.
        return this._certify(null).then(() => this._bridge.unauth(this._rootUrl));
      }
    );
  }

  _connectInfoProperty(property, attribute) {
    const url = new URL(this._rootUrl);
    url.pathname = encodeURI(`/.info/${property}`);
    this._bridge.on(url.href, url.href, null, 'value', snap => {
      this.root[attribute] = snap.value;
    });
  }
}
