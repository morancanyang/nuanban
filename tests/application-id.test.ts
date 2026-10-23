import { afterEach, describe, expect, it, vi } from 'vitest';
import { createLocalId } from '@nuanban/application';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('local id generation', () => {
  it('uses Web Crypto random bytes when randomUUID is unavailable', () => {
    vi.stubGlobal('crypto', {
      getRandomValues(values: Uint8Array) {
        values.fill(0xab);
        return values;
      },
    });

    expect(createLocalId()).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it('still generates a local id when Web Crypto is unavailable', () => {
    vi.stubGlobal('crypto', undefined);
    vi.spyOn(Math, 'random').mockReturnValue(0.5);

    expect(createLocalId()).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });
});
