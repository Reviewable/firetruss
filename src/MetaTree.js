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
      // Certifications are serialized on this promise, in the order the bridge delivers them.
      changePromise: Promise.resolve(),
      // Counts auth change callbacks as the bridge delivers them.  A client-issued call records the
      // count when it's issued, so that a callback delivered before that point is recognized as
      // background work even though its certification may only run, or fail, later.
      changesDelivered: 0,
      // Client-issued auth calls are serialized on this one, which spans each call's whole
      // operation:  its interceptors, its RPC, and the certification result it reports.  Waiting
      // only on `changePromise` would let a second call's RPC go out while the first is still in
      // flight, since a call's own callback need not have arrived yet.
      callPromise: Promise.resolve(),
      // The collectors of the client-issued calls that have been made but haven't finished yet, in
      // call order.  Each collects the certification failure of the auth change that answers its
      // call, so that a call reports its own failure rather than one belonging to a background
      // callback or to a call batched alongside it.  The certification queue itself always recovers
      // from a failure, so one bad certification can't wedge the ones behind it.
      collectors: []
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
    return this._runAuthCall(collect => this._dispatcher.execute(
      'auth', 'authenticate', new Reference(this._tree, '/'), token, () => collect(
        () => token ?
          this._bridge.authWithCustomToken(this._rootUrl, token) :
          this._bridge.authAnonymously(this._rootUrl)
      )
    ));
  }

  unauthenticate() {
    return this._runAuthCall(collect => this._signOut(collect));
  }

  // Runs a client-issued auth call with exclusive ownership of the certification queue.  Calls are
  // serialized over their whole operation, since the bridge can deliver a callback and resolve the
  // call's RPC in the same batch, and the worker's `userToJson` doesn't guarantee that callbacks
  // arrive in invocation order.  Nested calls are not supported;  a `certify` interceptor that
  // needs to reject its user returns `false` instead of signing out itself.
  _runAuthCall(run) {
    this._auth.callIssued = true;
    // Reserve this call's collector synchronously, and enqueue it behind the calls already
    // outstanding.  The bridge can deliver a callback in the same tick as the call, before the
    // queue ahead of it has drained, and such a callback still belongs to this call;  opening it
    // only once the call starts would make ownership depend on how many microtasks the drain takes,
    // and the drain would then swallow the call's own certification as a predecessor's.
    const collector = {
      failure: undefined,
      // Set once the call is actually running, so that a call still queued behind another doesn't
      // claim callbacks belonging to the one in front of it.  Calls are serialized, so at most one
      // collector is running at any time.
      running: false,
      // The call owns the auth change callbacks delivered within this half-open range of delivery
      // counts:  from the moment it was issued until the certifications it provoked have settled.
      // Recording both edges as delivery counts makes ownership a fact about the bridge's delivery
      // order alone, rather than about when a given callback's turn on the queue comes up.
      deliveredFrom: this._auth.changesDelivered,
      deliveredUntil: undefined
    };
    this._auth.collectors.push(collector);
    const previousCall = this._auth.callPromise;
    const result = previousCall.catch(_.noop).then(() => this._startAuthCall(run, collector));
    // Keep the queue moving even if this call fails, so one rejection can't wedge the calls behind
    // it.  The caller still sees the rejection through `result`.
    this._auth.callPromise = result.catch(_.noop);
    return result;
  }

  // Runs one call once it owns the queue.  Any certifications still in flight belong to whoever
  // came before, so they're drained to a standstill before this call runs:  resetting the chain
  // would orphan them, letting a stale certification publish after a newer callback was already
  // discarded as a duplicate against a root it hadn't updated yet.
  //
  // The call's collector, reserved when the call was issued, stops accepting callbacks once the
  // certifications it provoked have settled, so later background ones are left to the next call.
  _startAuthCall(run, collector) {
    // Mark the call running before the drain, not after it:  the drain can take an unpredictable
    // number of microtasks, and a callback provoked by this call may well be delivered during it.
    collector.running = true;
    return this._settleChangePromise().then(() => {
      // Every auth change delivered while the call runs is assigned to it, without trying to work
      // out which one answers it:  the pairing isn't guaranteed, and which side of the response a
      // change lands on is a detail of the Firebase SDK and the worker that we don't want to depend
      // on.  The window stays open until the call's certification queue goes quiet, so a change
      // delivered just after the response still counts as the call's own.
      const collect = issueRpc => Promise.resolve().then(issueRpc);
      return run(collect).then(
        result => this._reportCollectedFailure(collector).then(() => result),
        // The call's own failure wins over any certification failure it provoked:  a forced
        // sign-out that couldn't reach the bridge matters more than the rejection that caused it.
        // The certification queue still has to settle before the call reports anything.
        error => this._reportCollectedFailure(collector)
          .catch(_.noop).then(() => Promise.reject(error))
      );
    });
  }

  // Finds the call a delivered callback is assigned to:  the running call whose window covers it.
  // A callback delivered before the running call was issued, or after that call finished, or while
  // no call is running at all, is background work and belongs to no call.
  _findCollector(ordinal) {
    return _.find(this._auth.collectors, candidate =>
      candidate.running && ordinal >= candidate.deliveredFrom &&
      (_.isUndefined(candidate.deliveredUntil) || ordinal < candidate.deliveredUntil));
  }

  // Waits for the certification queue to stop growing, not merely for its current tail:  settling
  // one certification can enqueue the next one, and a call must not start or finish while any of
  // them is still in flight.
  _settleChangePromise() {
    const tail = this._auth.changePromise;
    return tail.catch(_.noop).then(() => {
      if (this._auth.changePromise !== tail) return this._settleChangePromise();
    });
  }

  // Finishes a call by letting the certifications it accepted run to a standstill and then
  // reporting the first of their failures.
  _reportCollectedFailure(collector) {
    return this._settleChangePromise().then(() => {
      // Close the window only now:  everything the call provoked has certified, so anything
      // delivered from here on belongs to whoever runs next.
      collector.deliveredUntil = this._auth.changesDelivered;
      _.pull(this._auth.collectors, collector);
      if (collector.failure) return Promise.reject(collector.failure);
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
    const ordinal = this._auth.changesDelivered++;
    let collector;
    const promise = this._auth.changePromise.catch(_.noop).then(() => {
      collector = this._findCollector(ordinal);
      if (this.root.user === user) return false;
      return this._certify(user);
    });
    // Keep the queue moving if this certification fails, but hand the failure to the call it was
    // attributed to, if any, so that the call can report it.
    this._auth.changePromise = promise.catch(error => {
      if (collector && !collector.failure) collector.failure = error;
    });
    return promise;
  }

  // Runs the certification for a candidate user.  A `certify` interceptor rejects the candidate by
  // returning literal `false` from `onBefore`;  every handler is awaited before the verdict is
  // acted on, so a rejecting handler can't race another handler's asynchronous key setup.  A
  // rejected user is never published:  it's signed out from within this turn instead, so that the
  // sign-out doesn't queue behind the certification that asked for it.
  _certify(user) {
    // Recorded by the executor rather than read off the operation's result, so that the decision
    // survives a failure in the `certify` hooks that run after it.  An `onAfter` that throws must
    // not leave a rejected candidate signed in at the worker:  the sign-out is what keeps Firebase
    // and the client in step, and the app can't detect the mismatch if it never happens.
    let rejected = false;
    return this._dispatcher.execute(
      'auth', 'certify', new Reference(this._tree, '/'), user, onBeforeResults => {
        if (user && _.some(onBeforeResults, result => result === false)) {
          rejected = true;
          return 'rejected';
        }
        if (this.root.user === user) return false;
        if (user) Object.freeze(user);
        this.root.user = user;
        this.root.userid = user && user.uid;
        return true;
      }
    ).then(
      outcome => rejected ? this._signOutRejected() : outcome,
      // A hook failure after the candidate was rejected still has to clear it out.  The sign-out
      // reports its own failure if it has one, and otherwise the original hook error stands.
      error => {
        if (!rejected) return Promise.reject(error);
        return this._signOut().then(() => Promise.reject(error));
      }
    );
  }

  // Clears out a rejected candidate and reports the rejection.  A failure of the sign-out is the
  // more urgent one, so it's let through in place of the rejection.
  _signOutRejected() {
    return this._signOut().then(() => {
      const error = new Error('Authentication rejected');
      error.code = AUTH_REJECTED;
      return Promise.reject(error);
    });
  }

  // The guts of `unauthenticate()`, usable from inside a certification turn.  The whole flow is
  // wrapped in an `auth/unauthenticate` operation, null certification included, so that every
  // logout failure reaches an `onFailure` with `op.method === 'unauthenticate'` even when the
  // enclosing authentication error is caught.
  _signOut(collect = run => run()) {
    return this._dispatcher.execute(
      'auth', 'unauthenticate', new Reference(this._tree, '/'), undefined, () => collect(() => {
        // Signal the user change to null pre-emptively.  This is what the Firebase SDK does as
        // well, since it lets the app tear down user-required connections before the user is
        // actually deauthed, which can prevent spurious permission denied errors.  An already-null
        // client user says nothing about the worker, which may well still be signed in, so the
        // bridge sign-out below runs either way.
        return this._certify(null).then(() => this._bridge.unauth(this._rootUrl));
      })
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
