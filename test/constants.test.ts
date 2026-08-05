import * as zlib from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { BASE_HEADERS, buildAcceptEncoding } from '../src/constants.js';

describe('Accept-Encoding', () => {
  it('advertises only encodings this runtime can decode', () => {
    const decodable = new Set(['gzip', 'deflate']);
    if (typeof zlib.brotliDecompressSync === 'function') decodable.add('br');
    if (typeof (zlib as { zstdDecompressSync?: unknown }).zstdDecompressSync === 'function') {
      decodable.add('zstd');
    }

    const advertised = BASE_HEADERS['Accept-Encoding']!.split(', ');
    for (const encoding of advertised) {
      expect(decodable.has(encoding)).toBe(true);
    }
    expect(advertised).toContain('gzip');
    expect(advertised).toContain('deflate');
  });

  it('omits zstd when the runtime cannot decode it', () => {
    expect(buildAcceptEncoding({ br: true, zstd: false })).toBe('gzip, deflate, br');
    expect(buildAcceptEncoding({ br: false, zstd: false })).toBe('gzip, deflate');
  });

  it('keeps Chrome ordering when everything is decodable', () => {
    expect(buildAcceptEncoding({ br: true, zstd: true })).toBe('gzip, deflate, br, zstd');
  });
});
