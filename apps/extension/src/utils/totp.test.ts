import { describe, expect, it } from 'vitest';
import { generateTOTP } from './totp';

describe('generateTOTP', () => {
  it('matches the RFC 6238 SHA-1 test vector', async () => {
    const code = await generateTOTP(
      'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ',
      30,
      8,
      59,
    );

    expect(code).toBe('94287082');
  });
});
