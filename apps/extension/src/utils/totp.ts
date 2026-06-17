export function decodeBase32(str: string): Uint8Array {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  const clean = str.replace(/\s+/g, '').replace(/=+$/, '').toUpperCase();
  const len = clean.length;
  const out = new Uint8Array(Math.floor((len * 5) / 8));
  let bits = 0;
  let value = 0;
  let index = 0;
  for (let i = 0; i < len; i++) {
    const char = clean[i]!;
    const val = alphabet.indexOf(char);
    if (val === -1) {
      throw new Error('Invalid base32 character');
    }
    value = (value << 5) | val;
    bits += 5;
    if (bits >= 8) {
      out[index++] = (value >>> (bits - 8)) & 255;
      bits -= 8;
    }
  }
  return out;
}

export async function generateTOTP(
  secret: string,
  period = 30,
  digits = 6,
  time = Math.floor(Date.now() / 1000)
): Promise<string> {
  const keyBytes = decodeBase32(secret);
  const epoch = Math.floor(time / period);
  const counterBytes = new Uint8Array(8);
  let temp = epoch;
  for (let i = 7; i >= 0; i--) {
    counterBytes[i] = temp & 255;
    temp = Math.floor(temp / 256);
  }

  const cryptoKey = await globalThis.crypto.subtle.importKey(
    'raw',
    keyBytes,
    { name: 'HMAC', hash: { name: 'SHA-1' } },
    false,
    ['sign']
  );

  const signature = await globalThis.crypto.subtle.sign(
    'HMAC',
    cryptoKey,
    counterBytes
  );

  const signatureBytes = new Uint8Array(signature);
  const offset = signatureBytes[signatureBytes.length - 1]! & 15;
  const binary =
    ((signatureBytes[offset]! & 127) << 24) |
    ((signatureBytes[offset + 1]! & 255) << 16) |
    ((signatureBytes[offset + 2]! & 255) << 8) |
    (signatureBytes[offset + 3]! & 255);

  const otp = binary % Math.pow(10, digits);
  return otp.toString().padStart(digits, '0');
}
