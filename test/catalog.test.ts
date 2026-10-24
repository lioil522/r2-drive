/// <reference types="@cloudflare/vitest-plugin/types" />
import { env, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

const MB = 1024 * 1024;

function accountRecord(id: string, priority: number, quotaBytes: number) {
  const now = Date.now();
  return {
    id, name: id, accountId: id, priority, enabled: true, quotaBytes, safetyBytes: 16 * MB,
    externalBytes: 0, observedExternalBytes: 0, encryptedSecrets: '', accessKeyHint: '',
    hasApiToken: false, syncState: 'ready', syncCoverage: 'selected', syncJobId: null,
    lastSyncedAt: now, lastError: null, createdAt: now,
  };
}

function bucketRecord(id: string, accountId: string) {
  return {
    id, accountId, name: `${id}-bucket`, jurisdiction: 'default', storageClass: 'Standard',
    inPool: true, priority: 0, location: '', createdAt: Date.now(), usedBytes: 0, objectCount: 0,
  };
}

async function setup(name: string, accounts: { id: string; priority: number; quotaBytes: number }[]) {
  const stub = env.CATALOG.get(env.CATALOG.idFromName(name));
  await runInDurableObject(stub, (_instance, state) => {
    for (const account of accounts) {
      const record = accountRecord(account.id, account.priority, account.quotaBytes);
      state.storage.sql.exec('INSERT INTO accounts VALUES (?,?,?)', record.id, record.accountId, JSON.stringify(record));
      const bucket = bucketRecord(record.id, record.id);
      state.storage.sql.exec('INSERT INTO buckets VALUES (?,?,?,?,?)', bucket.id, bucket.accountId, bucket.name, bucket.jurisdiction, JSON.stringify(bucket));
    }
  });
  return stub;
}

describe('DriveCatalog capacity allocation', () => {
  it('skips a full account for a large file and backfills it for a later small file', async () => {
    const stub = await setup('allocation-order', [
      { id: 'small', priority: 0, quotaBytes: 300 * MB },
      { id: 'large', priority: 1, quotaBytes: 1024 * MB },
    ]);

    const big = await stub.reserveUpload({ path: '/big.bin', size: 400 * MB, contentType: 'application/octet-stream' });
    const small = await stub.reserveUpload({ path: '/small.bin', size: 100 * MB, contentType: 'application/octet-stream' });

    expect(big.accountId).toBe('large');
    expect(small.accountId).toBe('small');

    await stub.attachUpload(small.id, 'upload-small');
    await stub.beginCompleteUpload(small.id);
    const file = await stub.commitUpload(small.id, { size: 100 * MB, etag: 'etag-small', metadata: { contentType: 'application/octet-stream' } });
    expect(file.status).toBe('ready');

    const accounts = await stub.getAccounts();
    const target = accounts.find((account) => account.id === 'small')!;
    expect(target.usedBytes).toBe(100 * MB + 8192);
    expect(target.reservedBytes).toBe(0);
    expect(target.availableBytes).toBe(300 * MB - 16 * MB - (100 * MB + 8192));
  });

  it('rejects a file larger than every account', async () => {
    const stub = await setup('allocation-oversize', [
      { id: 'only', priority: 0, quotaBytes: 300 * MB },
    ]);

    await runInDurableObject(stub, async (instance) => {
      await expect(instance.reserveUpload({ path: '/huge.bin', size: 2048 * MB, contentType: 'application/octet-stream' })).rejects.toThrow();
    });
  });

  it('serializes concurrent reservations so quota is never oversubscribed', async () => {
    const stub = await setup('allocation-concurrent', [
      { id: 'shared', priority: 0, quotaBytes: 300 * MB },
    ]);

    const results = await Promise.allSettled(
      Array.from({ length: 3 }, (_, index) =>
        stub.reserveUpload({ path: `/concurrent-${index}.bin`, size: 100 * MB, contentType: 'application/octet-stream' })),
    );

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(2);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);

    const [account] = await stub.getAccounts();
    expect(account.reservedBytes).toBe(2 * (100 * MB + 8192));
  });
});
