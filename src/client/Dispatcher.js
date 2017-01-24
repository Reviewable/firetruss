import _ from 'lodash';


class SlowHandle {
  constructor(operation, delay, callback) {
    this._operation = operation;
    this._delay = delay;
    this._callback = callback;
    this._fired = false;
  }

  initiate() {
    this.cancel();
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
    this._startTimestamp = Date.now();
    this._slowHandles = [];
  }

  get type() {return this._type;}
  get method() {return this._method;}
  get target() {return this._target;}
  get ready() {return this._ready;}
  get error() {return this._error;}

  onSlow(delay, callback) {
    const handle = new SlowHandle(this, delay, callback);
    this._slowHandles.push(handle);
    handle.initiate();
  }

  _markReady() {
    this._ready = true;
    _.each(this._slowHandles, handle => handle.cancel());
  }

  _resetReady() {
    this._ready = false;
    this._startTimestamp = Date.now();
    _.each(this._slowHandles, handle => handle.initiate());
  }
}


export default class Dispatcher {
  constructor() {
    this._callbacks = {};
  }

  intercept(operationType, callbacks) {
    if (!_.contains(['read', 'write', 'auth'], operationType)) {
      throw new Error('Unknown intercept operation type: ' + operationType);
    }
    const badCallbackKeys =
      _.difference(_.keys(callbacks), ['onBefore', 'onAfter', 'onError', 'onFailure']);
    if (badCallbackKeys.length) {
      throw new Error('Unknown intercept callback types: ' + badCallbackKeys.join(', '));
    }
    this._addCallback('onBefore', operationType, callbacks.onBefore);
    this._addCallback('onAfter', operationType, callbacks.onAfter);
    this._addCallback('onError', operationType, callbacks.onError);
    this._addCallback('onFailure', operationType, callbacks.onFailure);
  }

  _addCallback(stage, operationType, callback) {
    if (!callback) return;
    const key = this._getCallbacksKey(operationType, stage);
    (this._callbacks[key] || (this._callbacks[key] = [])).push(this._wrap(callback));
  }

  _getCallbacks(stage, operationType) {
    return this._callbacks[this._getCallbacksKey(stage, operationType)];
  }

  _getCallbacksKey(stage, operationType) {
    return `${stage}_${operationType}`;
  }

  _wrap(callback) {
    return function() {
      try {
        return Promise.resolve(callback.apply(this, arguments));
      } catch (e) {
        return Promise.reject(e);
      }
    };
  }

  execute(operationType, method, target, executor) {
    executor = this._wrap(executor);
    const operation = new Operation(operationType, method, target);
    return this._begin(operation).then(
      () => {
        const executeWithRetries = () => {
          return executor().catch(e => this.retryOrEnd(operation, e).then(executeWithRetries));
        };
        return executeWithRetries();
      },
      e => this.end(operation, e)
    ).then(result => this.end(operation).then(() => result));
  }

  begin(operationType, method, target) {
    const operation = new Operation(operationType, method, target);
    return this._begin(operation).then(() => operation, e => this.end(operation, e));
  }

  _begin(operation) {
    return Promise.all(
      _.map(this._getCallbacks('onBefore', operation.type), onBefore => onBefore(operation))
    );
  }

  markReady(operation) {
    operation._markReady();
  }

  resetReady(operation) {
    operation._resetReady();
  }

  retryOrEnd(operation, error) {
    return Promise.all(
      _.map(this._getCallbacks('onError', operation.type), onError => onError(operation, error))
    ).then(
      results => {
        if (!_.some(results)) return this.end(operation, error);
      },
      e => this.end(operation, e)
    );
  }

  end(operation, error) {
    if (error) operation._error = error;
    return Promise.all(
      _.map(this._getCallbacks('onAfter', operation.type), onAfter => onAfter(operation))
    ).then(
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
      const onFailureCallbacks = this._getCallbacks('onFailure', operation.type);
      if (onFailureCallbacks) {
        setTimeout(0, () => {
          _.each(onFailureCallbacks, onFailure => onFailure(operation));
        });
      }
    }
    if (operation.error) return Promise.reject(operation.error);
  }
}

