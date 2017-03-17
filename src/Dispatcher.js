import _ from 'lodash';
import {wrapPromiseCallback} from './utils.js';


const INTERCEPT_KEYS = [
  'read', 'write', 'auth', 'set', 'update', 'commit', 'connect', 'peek', 'all'
];

const EMPTY_ARRAY = [];


class SlowHandle {
  constructor(operation, delay, callback) {
    this._operation = operation;
    this._delay = delay;
    this._callback = callback;
    this._fired = false;
  }

  initiate() {
    this.cancel();
    this._fired = false;
    const elapsed = Date.now() - this._operation._startTimestamp;
    this._timeoutId = setTimeout(this._delay - elapsed, () => {
      this._fired = true;
      this._callback(this._operation);
    });
  }

  cancel() {
    if (this._fired) this._callback(this._operation);
    if (this._timeoutId) clearTimeout(this._timeoutId);
  }
}


class Operation {
  constructor(type, method, target) {
    this._type = type;
    this._method = method;
    this._target = target;
    this._ready = false;
    this._running = false;
    this._ended = false;
    this._tries = 0;
    this._startTimestamp = Date.now();
    this._slowHandles = [];
  }

  get type() {return this._type;}
  get method() {return this._method;}
  get target() {return this._target;}
  get ready() {return this._ready;}
  get running() {return this._running;}
  get ended() {return this._ended;}
  get tries() {return this._tries;}
  get error() {return this._error;}

  onSlow(delay, callback) {
    const handle = new SlowHandle(this, delay, callback);
    this._slowHandles.push(handle);
    handle.initiate();
  }

  _setRunning(value) {
    this._running = value;
  }

  _setEnded(value) {
    this._ended = value;
  }

  _markReady() {
    this._ready = true;
    this._tries = 0;
    _.each(this._slowHandles, handle => handle.cancel());
  }

  _clearReady() {
    this._ready = false;
    this._startTimestamp = Date.now();
    _.each(this._slowHandles, handle => handle.initiate());
  }

  _incrementTries() {
    this._tries++;
  }
}


export default class Dispatcher {
  constructor(bridge) {
    this._bridge = bridge;
    this._callbacks = {};
  }

  intercept(interceptKey, callbacks) {
    if (!_.contains(INTERCEPT_KEYS, interceptKey)) {
      throw new Error('Unknown intercept operation type: ' + interceptKey);
    }
    const badCallbackKeys =
      _.difference(_.keys(callbacks), ['onBefore', 'onAfter', 'onError', 'onFailure']);
    if (badCallbackKeys.length) {
      throw new Error('Unknown intercept callback types: ' + badCallbackKeys.join(', '));
    }
    const wrappedCallbacks = {
      onBefore: this._addCallback('onBefore', interceptKey, callbacks.onBefore),
      onAfter: this._addCallback('onAfter', interceptKey, callbacks.onAfter),
      onError: this._addCallback('onError', interceptKey, callbacks.onError),
      onFailure: this._addCallback('onFailure', interceptKey, callbacks.onFailure)
    };
    return this._removeCallbacks.bind(this, interceptKey, wrappedCallbacks);
  }

  _addCallback(stage, interceptKey, callback) {
    if (!callback) return;
    const key = this._getCallbacksKey(interceptKey, stage);
    const wrappedCallback = wrapPromiseCallback(callback);
    (this._callbacks[key] || (this._callbacks[key] = [])).push(wrappedCallback);
    return wrappedCallback;
  }

  _removeCallback(stage, interceptKey, wrappedCallback) {
    if (!wrappedCallback) return;
    const key = this._getCallbacksKey(interceptKey, stage);
    if (this._callbacks[key]) _.pull(this._callbacks[key], wrappedCallback);
  }

  _removeCallbacks(interceptKey, wrappedCallbacks) {
    _.each(wrappedCallbacks, (wrappedCallback, stage) => {
      this._removeCallback(stage, interceptKey, wrappedCallback);
    });
  }

  _getCallbacks(stage, operationType, method) {
    return [].concat(
      this._callbacks[this._getCallbacksKey(stage, method)] || EMPTY_ARRAY,
      this._callbacks[this._getCallbacksKey(stage, operationType)] || EMPTY_ARRAY,
      this._callbacks[this._getCallbacksKey(stage, 'all')] || EMPTY_ARRAY
    );
  }

  _getCallbacksKey(stage, interceptKey) {
    return `${stage}_${interceptKey}`;
  }

  execute(operationType, method, target, executor) {
    executor = wrapPromiseCallback(executor);
    const operation = this.createOperation(operationType, method, target);
    return this.begin(operation).then(() => {
      const executeWithRetries = () => {
        return executor().catch(e => this._retryOrEnd(operation, e).then(executeWithRetries));
      };
      return executeWithRetries();
    }).then(result => this.end(operation).then(() => result));
  }

  createOperation(operationType, method, target) {
    return new Operation(operationType, method, target);
  }

  begin(operation) {
    return Promise.all(_.map(
      this._getCallbacks('onBefore', operation.type, operation.method),
      onBefore => onBefore(operation)
    )).then(() => {
      if (!operation.ended) operation._setRunning(true);
    }, e => this.end(operation, e));
  }

  markReady(operation) {
    operation._markReady();
  }

  clearReady(operation) {
    operation._clearReady();
  }

  retry(operation, error) {
    operation._incrementTries();
    return Promise.all(_.map(
      this._getCallbacks('onError', operation.type, operation.method),
      onError => onError(operation, error)
    )).then(results => _.some(results));
  }

  _retryOrEnd(operation, error) {
    return this.retry(operation, error).then(result => {
      if (!result) return this.end(operation, error);
    }, e => this.end(operation, e));
  }

  end(operation, error) {
    if (operation.ended) return;
    operation._setRunning(false);
    operation._setEnded(true);
    if (error) operation._error = error;
    return Promise.all(_.map(
      this._getCallbacks('onAfter', operation.type, operation.method),
      onAfter => onAfter(operation)
    )).then(
      () => this._afterEnd(operation),
      e => {
        operation._error = e;
        return this._afterEnd(operation);
      }
    );
  }

  _afterEnd(operation) {
    this.markReady(operation);
    if (operation.error) {
      const onFailureCallbacks = this._getCallbacks('onFailure', operation.type, operation.method);
      return this._bridge.probeError(operation.error).then(() => {
        if (onFailureCallbacks) {
          setTimeout(0, () => {
            _.each(onFailureCallbacks, onFailure => onFailure(operation));
          });
        }
        return Promise.reject(operation.error);
      });
    }
  }
}

