import _ from 'lodash';
import Vue from 'vue';
import Reference from './Reference.js';


// Thrown by `authenticate()` when a `certify` interceptor rejected the candidate user.  The
// candidate is never published, and the sign-out that clears it out runs before this is raised, so
// a failure of that sign-out takes precedence over this error.
export const AUTH_REJECTED = 'AUTH_REJECTED';


function isAuthRejection(error) {
  return Boolean(error) && error.code === AUTH_REJECTED;
}


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
      // Client-issued auth calls are serialized on this one, which spans each call's whole
      // operation:  its interceptors, its RPC, and the certification result it reports.  Waiting
      // only on `changePromise` would let a second call's RPC go out while the first is still in
      // flight, since a call's own callback need not have arrived yet.
      callPromise: Promise.resolve(),
      // Counts auth change callbacks as the bridge delivers them, so that a call can tell the ones
      // that predate it from the ones that might answer it.
      changesDelivered: 0,
      // The collector of the client-issued call that's currently running, if any.  It gathers the
      // certification failures of the turns that begin while the call runs, so that the call
      // reports its own failure rather than a predecessor's.  Held as a list so that a
      // certification running between two calls is attributed to neither.  The certification queue
      // always recovers from a failure, so one bad certification can't wedge those behind it.
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
    // The delivery count at the moment the call is issued.  A callback delivered before this point
    // was provoked by something else, even if its certification only runs, or fails, later;  one
    // delivered after it is either this call's answer or unsolicited, and those are
    // indistinguishable without a correlation id.
    const collector = {failure: undefined, deliveredFrom: this._auth.changesDelivered};
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
  _startAuthCall(run, collector) {
    // Register the collector before draining, so that a callback the bridge delivered before this
    // call got to run still reaches it.  Its delivery cutoff keeps the drain's own turns out:
    // those were provoked by whoever came before, and attributing them here is what made a
    // background failure reject an otherwise successful call.
    this._auth.collectors.push(collector);
    return this._settleChangePromise().then(() => {
      // Report the collected failure from inside the executor, so that the enclosing operation
      // sees it:  the certification answering a call is part of that call's outcome, so
      // `authenticate` interceptors have to get their `onError` and `onFailure` for it.  Every
      // change delivered from here until the queue goes quiet is assigned to the call, without
      // trying to work out which one answers it;  the pairing isn't guaranteed, and which side of
      // the response a change lands on is an SDK and worker detail we don't want to depend on.
      const collect = issueRpc => Promise.resolve()
        .then(issueRpc)
        .then(
          result => this._reportCollectedFailure(collector).then(() => result),
          // The operation's own failure outranks a certification failure it provoked:  a forced
          // sign-out that couldn't reach the bridge matters more than the rejection that caused it.
          // The queue still has to settle before the call reports anything.
          error => this._reportCollectedFailure(collector)
            .catch(_.noop).then(() => Promise.reject(error))
        );
      return run(collect).then(
        result => this._releaseCollector(collector).then(() => result),
        error => this._releaseCollector(collector).then(() => Promise.reject(error))
      );
    });
  }

  // Closes out a call's window once its operation has ended, so that later changes belong to
  // whoever runs next.  The failure itself was already reported from inside the operation.
  _releaseCollector(collector) {
    _.pull(this._auth.collectors, collector);
    return Promise.resolve();
  }

  // Finds the call a certification is assigned to:  the running call whose delivery cutoff the
  // callback falls at or after.  Calls are serialized, so there's at most one candidate;  one that
  // predates it, or arrives while no call runs, is background work and belongs to none.
  _findCollector(ordinal) {
    return _.find(this._auth.collectors, candidate => ordinal >= candidate.deliveredFrom);
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

  // Lets the certifications a call provoked run to a standstill and then reports the first of their
  // failures.  Called from inside the call's operation, so the failure reaches its interceptors.
  _reportCollectedFailure(collector) {
    return this._settleChangePromise().then(() => {
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
    // attributed to, if any, so that the call can report it.  A later auth change supersedes an
    // earlier one, since a call is answered by at most one:  a failure that a subsequent
    // certification overtook wasn't the call's outcome.  A rejection is exempt, because the
    // sign-out clearing the rejected candidate reports its own null change, and that cleanup must
    // not bury the rejection that asked for it.
    this._auth.changePromise = promise.then(
      () => {
        if (collector && !isAuthRejection(collector.failure)) collector.failure = undefined;
      },
      error => {
        if (collector && !isAuthRejection(collector.failure)) collector.failure = error;
      }
    );
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
