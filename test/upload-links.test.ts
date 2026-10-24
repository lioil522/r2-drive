import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { UploadLinks } from '../src/upload-links';
import { UPLOAD_URL_TTL_SECONDS } from '../shared/paths';

function signer() {
  return vi.fn(async (parts: number[]) => parts.map((partNumber) => ({
    partNumber, url: `https://r2.example/${partNumber}`, headers: {}, expiresAt: Date.now() + UPLOAD_URL_TTL_SECONDS * 1000,
  })));
}

describe('batched multipart upload signatures', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('uses eight signing calls for 64 parts while consuming two parts at a time', async () => {
    const sign = signer();
    const links = new UploadLinks(sign);
    const parts = Array.from({ length: 64 }, (_, index) => index + 1);
    for (let index = 0; index < parts.length; index += 2) {
      const batch = parts.slice(index, index + 2);
      await links.ensure(batch, parts.slice(index, index + 8));
      expect(batch.map((number) => links.get(number).partNumber)).toEqual(batch);
    }
    expect(sign).toHaveBeenCalledTimes(8);
    expect(sign.mock.calls.every(([batch]) => batch.length === 8)).toBe(true);
  });

  it('renews expired prefetched links before uploading on a slow connection', async () => {
    const sign = signer();
    const links = new UploadLinks(sign);
    await links.ensure([1, 2], [1, 2, 3, 4, 5, 6, 7, 8]);
    await vi.advanceTimersByTimeAsync(14 * 60_000);
    await links.ensure([3, 4], [3, 4, 5, 6, 7, 8, 9, 10]);
    expect(sign).toHaveBeenCalledTimes(2);
    expect(sign.mock.calls[1][0]).toEqual([3, 4, 5, 6, 7, 8, 9, 10]);
    expect(links.get(3).expiresAt).toBeGreaterThan(Date.now() + 60_000);
  });

  it('deduplicates simultaneous renewals and only replaces a rejected signature', async () => {
    const sign = signer();
    const links = new UploadLinks(sign);
    await Promise.all([links.ensure([1, 2], [1, 2, 3, 4]), links.ensure([2])]);
    expect(sign).toHaveBeenCalledTimes(1);
    links.invalidate(2);
    await Promise.all([links.ensure([2]), links.ensure([2])]);
    expect(sign).toHaveBeenCalledTimes(2);
    expect(sign.mock.calls[1][0]).toEqual([2]);
    expect(links.get(1).partNumber).toBe(1);
  });

  it('supports empty files and resume batches with nonconsecutive part numbers', async () => {
    const sign = signer();
    const links = new UploadLinks(sign);
    await links.ensure([0]);
    expect(links.get(0).partNumber).toBe(0);
    await links.ensure([2, 7], [2, 7, 13, 24]);
    expect(sign.mock.calls[1][0]).toEqual([2, 7, 13, 24]);
  });

  it('can retry a failed signing request and rejects missing required links', async () => {
    const sign = signer().mockRejectedValueOnce(new Error('network failed'));
    const links = new UploadLinks(sign);
    await expect(links.ensure([1])).rejects.toThrow('network failed');
    await links.ensure([1]);
    expect(links.get(1).partNumber).toBe(1);
    await expect(new UploadLinks(async () => []).ensure([1])).rejects.toThrow('分片签名');
  });
});
