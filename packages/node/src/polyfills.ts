/**
 * Polyfills for Node.js < 22 compatibility.
 * Must be imported before any other modules.
 */

// Promise.withResolvers (ES2024) — used by libp2p's it-queue dependency
if (typeof (Promise as any).withResolvers !== 'function') {
  (Promise as any).withResolvers = function <T>() {
    let resolve!: (value: T | PromiseLike<T>) => void;
    let reject!: (reason?: any) => void;
    const promise = new Promise<T>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    return { promise, resolve, reject };
  };
}
