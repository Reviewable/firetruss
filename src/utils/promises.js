export function wrapPromiseCallback(callback) {
  return function() {
    try {
      // eslint-disable-next-line no-invalid-this
      return Promise.resolve(callback.apply(this, arguments));
    } catch (e) {
      return Promise.reject(e);
    }
  };
}

export function promiseCancel(promise, cancel) {
  promise = promiseFinally(promise, () => {cancel = null;});
  promise.cancel = () => {
    if (!cancel) return;
    cancel();
    cancel = null;
  };
  propagatePromiseProperty(promise, 'cancel');
  return promise;
}

function propagatePromiseProperty(promise, propertyName) {
  const originalThen = promise.then, originalCatch = promise.catch;
  promise.then = (onResolved, onRejected) => {
    const derivedPromise = originalThen.call(promise, onResolved, onRejected);
    derivedPromise[propertyName] = promise[propertyName];
    propagatePromiseProperty(derivedPromise, propertyName);
    return derivedPromise;
  };
  promise.catch = onRejected => {
    const derivedPromise = originalCatch.call(promise, onRejected);
    derivedPromise[propertyName] = promise[propertyName];
    propagatePromiseProperty(derivedPromise, propertyName);
    return derivedPromise;
  };
  return promise;
}

export function promiseFinally(promise, onFinally) {
  if (!onFinally) return promise;
  onFinally = wrapPromiseCallback(onFinally);
  return promise.then(result => {
    return onFinally().then(() => result);
  }, error => {
    return onFinally().then(() => Promise.reject(error));
  });
}
