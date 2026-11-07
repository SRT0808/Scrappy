import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach, vi } from 'vitest';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  // Views are kept in the URL, so each test must start from the app root.
  window.history.replaceState(null, '', '/');
});
