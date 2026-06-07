import '@testing-library/jest-dom';

// jsdom does not implement IntersectionObserver; provide a no-op stub so
// framer-motion's viewport/whileInView feature does not throw in tests.
if (typeof IntersectionObserver === 'undefined') {
  global.IntersectionObserver = class IntersectionObserver {
    constructor() {}
    observe() {}
    unobserve() {}
    disconnect() {}
  };
}
