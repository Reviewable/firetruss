import _ from 'lodash';
import Vue from 'vue';
import Reference from './Reference.js';


// Thrown by `authenticate()` when a `certify` interceptor rejected the candidate user.  The
// candidate is never published, and the sign-out that clears it out runs before this is raised, so
// a failure of that sign-out takes precedence over this error.
export const AUTH_REJECTED = 'AUTH_REJECTED';


// Runs `after` once `promise` settles, either way, and preserves the original outcome.  `after` may
// return a promise, which is awaited;  if it rejects, its failure replaces a success but not an
// existing failure, since the original one is the more informative.
function settleThen(promise, after) {
  return promise.then(
    result => Promise.resolve(after()).then(() => result),
    error => Promise.resolve(after()).catch(_.noop).then(() => Promise.reject(error))
  );
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
      // The collector of the client-issued call whose request is currently in flight, if any:
      // calls are serialized, so there's at most one.  It gathers the failures of the
      // certifications delivered while that request was outstanding, so that the call reports its
      // own failure rather than a predecessor's or a later background one.  The certification queue
      // always recovers from a failure, so one bad certification can't wedge those behind it.
      collector: undefined
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
    const previousCall = this._auth.callPromise;
    const result = previousCall.catch(_.noop).then(() => this._startAuthCall(run));
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
  // A call owns the auth changes delivered between its request going out and that request settling.
  // Both edges are the request's own, which is what makes them meaningful:  a change delivered
  // before the request existed can't answer it, and one delivered after the response can't have
  // been provoked by it either.  Anything outside that interval is background work.
  _startAuthCall(run) {
    return this._settleChangePromise().then(() => {
      const collector = {failure: undefined};
      // Report the collected failure from inside the executor, so that the enclosing operation sees
      // it:  the certification answering a call is part of that call's outcome, so `authenticate`
      // interceptors have to get their `onError` and `onFailure` for it.  The operation's own
      // failure outranks a certification failure it provoked, since a forced sign-out that couldn't
      // reach the bridge matters more than the rejection that caused it.
      const collect = issueRpc => {
        // Opened here rather than before the drain:  until the request goes out, no callback can be
        // this call's answer, and claiming them made a background failure reject a successful call.
        this._auth.collector = collector;
        return settleThen(
          Promise.resolve().then(issueRpc), () => this._concludeAttempt(collector));
      };
      return settleThen(run(collect), () => {
        if (this._auth.collector === collector) this._auth.collector = undefined;
      });
    });
  }

  // Finds the call a certification is assigned to:  the one whose request is in flight, if any.  A
  // certification running before a request went out or after its response arrived is background
  // work, since it can't be that request's answer.
  _findCollector() {
    return this._auth.collector;
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

  // Concludes one attempt at a call, once its request has settled.  Ownership ends here, so that a
  // callback delivered afterwards belongs to whoever comes next, and then the certifications this
  // call already owns are awaited:  its own answer may still be in its interceptors, and that
  // outcome is part of the call's result.  The collector is left clean either way, since
  // `Dispatcher` reruns the executor to retry and this outcome says nothing about the next one.
  _concludeAttempt(collector) {
    if (this._auth.collector === collector) this._auth.collector = undefined;
    return this._settleOwnedCertifications(collector).then(() => {
      const failure = collector.failure;
      collector.failure = undefined;
      if (failure) return Promise.reject(failure);
    });
  }

  // Waits for the certifications assigned to this call, and only those.  Draining the whole chain
  // would also wait on the background ones behind them and adopt their failures.
  _settleOwnedCertifications(collector) {
    const owned = collector.owned;
    if (!owned || !owned.length) return Promise.resolve();
    collector.owned = [];
    return Promise.all(_.map(owned, promise => promise.catch(_.noop)))
      .then(() => this._settleOwnedCertifications(collector));
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
    // Attributed as it's delivered, not when its turn comes up:  ownership is about whether this
    // change arrived while a request was in flight, and by the time the turn runs that request may
    // have settled and handed the window to somebody else.
    const collector = this._findCollector();
    const promise = this._auth.changePromise.catch(_.noop).then(() => {
      if (this.root.user === user) return false;
      return this._certify(user);
    });
    // Keep the queue moving if this certification fails, but hand the failure to the call that owns
    // it, if any, so that the call can report it.  The first failure stands:  everything in the
    // window was provoked by that one request, so a later success says nothing about an earlier
    // failure, and the sign-out clearing a rejected candidate must not bury the rejection that
    // asked for it.
    if (collector) {
      collector.owned = (collector.owned || []).concat(promise);
      this._auth.changePromise = promise.catch(error => {
        if (!collector.failure) collector.failure = error;
      });
    } else {
      this._auth.changePromise = promise.catch(_.noop);
    }
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
    // Held so that a refusal is still seen when a sibling `onBefore` failed before the executor
    // could run:  `Dispatcher` records every handler's verdict on the operation either way.
    let certifying;
    const refuses = () => !!user && _.some(certifying.onBeforeResults, result => result === false);
    return this._dispatcher.execute(
      'auth', 'certify', new Reference(this._tree, '/'), user, onBeforeResults => {
        if (user && _.some(onBeforeResults, result => result === false)) return false;
        if (this.root.user === user) return false;
        if (user) Object.freeze(user);
        this.root.user = user;
        this.root.userid = user && user.uid;
        return true;
      },
      operation => {certifying = operation;}
    ).then(
      published => refuses() ? this._signOutRejected() : published,
      // A hook failure still has to clear out a candidate that was refused, whether the executor
      // got to record that or a sibling handler failed before it ran:  leaving the worker signed in
      // as a user the app refused desyncs it from the client with nothing to detect it.  The
      // sign-out reports its own failure if it has one, and otherwise the hook error stands.
      error => {
        if (refuses()) return this._signOut().then(() => Promise.reject(error));
        // A refusal can still be on its way from a handler slower than the one that failed.  The
        // operation's result is already decided, so the sign-out that refusal calls for happens out
        // of band rather than holding the caller behind a handler that may never settle.
        this._signOutLateRefusal(certifying, refuses);
        return Promise.reject(error);
      }
    );
  }

  // Signs the worker out if a `certify` handler refuses the candidate only after the certification
  // has already failed for another reason.  Nothing is waiting on this, so a failure here can only
  // be reported through the `unauthenticate` operation's own `onFailure`.
  //
  // The sign-out is queued behind the certifications in flight and skipped if anything has been
  // certified since:  by the time a slow refusal arrives, a newer candidate may already have been
  // published, and clearing that session would sign out a user nobody refused.  The refused
  // candidate itself is never published, so there's nothing else to compare against.
  _signOutLateRefusal(operation, refuses) {
    const publishedWhenFailed = this.root.user;
    operation.onBeforeSettled
      .then(() => this._settleChangePromise())
      .then(() => {
        if (refuses() && this.root.user === publishedWhenFailed) return this._signOut();
      })
      .catch(_.noop);
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
      'auth', 'unauthenticate', new Reference(this._tree, '/'), undefined, () => {
        // Signal the user change to null pre-emptively.  This is what the Firebase SDK does as
        // well, since it lets the app tear down user-required connections before the user is
        // actually deauthed, which can prevent spurious permission denied errors.  An already-null
        // client user says nothing about the worker, which may well still be signed in, so the
        // bridge sign-out below runs either way.
        //
        // Only the bridge request is wrapped:  this certification can wait on its own interceptors,
        // and a callback arriving during that wait predates the request, so it's background work
        // rather than this call's result.
        return this._certify(null).then(() => collect(() => this._bridge.unauth(this._rootUrl)));
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
