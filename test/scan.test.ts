/// <reference types="@cloudflare/vitest-plugin/types" />
import { env, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it, vi } from 'vitest';
import { encrypt } from '../worker/crypto';
import type { JobExecution, JobPayload, ScannedObject } from '../worker/job-types';
import type { Account, Bucket, DriveFile, Job } from '../shared/types';

function scanObject(index: number): ScannedObject {
  return { key: `objects/${index}.bin`, size: 1024 + index, etag: `"etag-${index}"`, modifiedAt: Date.now(), storageClass: 'Standard', metadata: { contentType: 'application/octet-stream', custom: { label: `object-${index}` } } };
}

async function setupScan(name: string, objects: ScannedObject[]) {
  const stub = env.CATALOG.getByName(name);
  const jobId = `scan-${name}`;
  const accountId = `account-${name}`;
  const now = Date.now();
  const encryptedSecrets = await encrypt({ accessKeyId: 'test-access', secretAccessKey: 'test-secret' }, env.ENCRYPTION_KEY, accountId);
  const bucket: Bucket = { id: `bucket-${name}`, accountId, name: 'scan-bucket', jurisdiction: 'default', storageClass: 'Standard', inPool: true, ignored: false, priority: 0, location: '', createdAt: now, usedBytes: 0, objectCount: 0 };
  await runInDurableObject(stub, (instance, state) => {
    const account: Account & { encryptedSecrets: string; observedExternalBytes: number } = {
      id: accountId, name, accountId: 'a'.repeat(32), priority: 0, enabled: true, quotaBytes: 1_000_000_000, safetyBytes: 0, externalBytes: 0,
      usedBytes: 0, reservedBytes: 0, availableBytes: 1_000_000_000, hasApiToken: false, accessKeyHint: 'access', encryptedSecrets, observedExternalBytes: 0,
      syncState: 'scanning', syncCoverage: 'selected', syncJobId: jobId, lastSyncedAt: null, lastError: null, createdAt: now,
    };
    state.storage.sql.exec('INSERT INTO accounts VALUES (?,?,?)', account.id, account.accountId, JSON.stringify(account));
    state.storage.sql.exec('INSERT INTO buckets VALUES (?,?,?,?,?)', bucket.id, bucket.accountId, bucket.name, bucket.jurisdiction, JSON.stringify(bucket));
    const payload: JobPayload = { type: 'scan', id: jobId, driveId: name, accountId, buckets: [bucket] };
    const job: Job = { id: jobId, type: 'scan', title: name, status: 'running', progressBytes: 0, totalBytes: 0, doneItems: 0, totalItems: 0, error: null, createdAt: now, updatedAt: now };
    state.storage.sql.exec('INSERT INTO jobs VALUES (?,?,?,?,?)', job.id, job.status, now, JSON.stringify(job), JSON.stringify(payload));
    instance.applyScan(jobId, bucket.id, objects);
    state.storage.sql.exec("UPDATE files SET scan_marker='previous-scan'");
  });
  return { stub, jobId, accountId, bucket };
}

describe('batched catalog scans', () => {
  it('advances the persisted background scan by 100 unchanged objects in one step', async () => {
    const objects = Array.from({ length: 100 }, (_, index) => scanObject(index));
    const { stub, jobId, accountId, bucket } = await setupScan('scan-background', objects);
    const jobs = env.JOBS.getByName('scan-background-job');
    const execution: JobExecution = {
      payload: { type: 'scan', id: jobId, driveId: 'scan-background', accountId, buckets: [bucket] },
      index: 0, status: 'running', retries: 0, cancelRequested: false, transfer: null,
      scan: { phase: 'objects', buckets: [bucket], bucketIndex: 0, continuation: null, objects, objectIndex: 0, count: 0, bytes: 0, coverage: 'selected', pendingUploads: [], pendingIndex: 0, partMarker: null, pendingBytes: 0 },
    };
    await runInDurableObject(jobs, (instance, state) => {
      state.storage.sql.exec('INSERT INTO execution VALUES (1,?)', JSON.stringify(execution));
      state.storage.sql.exec("INSERT INTO command VALUES (1,'run')");
      const fetch = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('unchanged objects must not use HEAD'));
      const save = vi.spyOn(state.storage, 'setAlarm').mockResolvedValue();
      return instance.alarm().finally(() => { fetch.mockRestore(); save.mockRestore(); });
    });
    const saved = await runInDurableObject(jobs, (_instance, state) => JSON.parse(state.storage.sql.exec<{ data: string }>('SELECT data FROM execution WHERE id=1').one().data) as JobExecution);
    expect(saved.scan).toMatchObject({ phase: 'multipart', objectIndex: 100, count: 100, bytes: objects.reduce((sum, object) => sum + object.size, 0) });
    expect(saved.retries).toBe(0);
    expect((await stub.getJob(jobId)).doneItems).toBe(100);
  });

  it('marks 100 unchanged objects without rewriting their metadata and tolerates replay', async () => {
    const objects = Array.from({ length: 100 }, (_, index) => scanObject(index));
    const { stub, jobId, accountId, bucket } = await setupScan('scan-unchanged', objects);
    const before = await runInDurableObject(stub, (_instance, state) => state.storage.sql.exec<{ data: string }>('SELECT data FROM files ORDER BY id').toArray());
    const batch = await stub.prepareScanBatch(jobId, bucket.id, objects);
    expect(batch.cachedCount).toBe(100);
    expect(batch.cachedBytes).toBe(objects.reduce((sum, object) => sum + object.size, 0));
    expect(batch.cachedKeys).toEqual(objects.map((object) => object.key));
    const replay = await stub.prepareScanBatch(jobId, bucket.id, objects);
    expect(replay.cachedCount).toBe(100);
    await stub.commitScanBatch(jobId, bucket.id, [], { count: batch.cachedCount, bytes: batch.cachedBytes });
    const after = await runInDurableObject(stub, (_instance, state) => state.storage.sql.exec<{ data: string }>('SELECT data FROM files ORDER BY id').toArray());
    expect(after).toEqual(before);
    expect((await stub.getJob(jobId)).doneItems).toBe(100);
    await stub.finishScan(jobId, accountId, 'selected', null);
    expect((await stub.listFiles({ bucketId: bucket.id, pageSize: 200 })).files).toHaveLength(100);
  });

  it('preserves trash, folders and missing-object behavior when scanning a mixed batch', async () => {
    const objects = Array.from({ length: 10 }, (_, index) => scanObject(index));
    const { stub, jobId, accountId, bucket } = await setupScan('scan-mixed', objects);
    const original = await stub.lookupObject(bucket.id, objects[0].key);
    await runInDurableObject(stub, (_instance, state) => {
      const file = JSON.parse(state.storage.sql.exec<{ data: string }>('SELECT data FROM files WHERE id=?', original!.id).one().data) as DriveFile;
      file.status = 'trash'; file.starred = true; file.deletedAt = Date.now(); file.path = '/kept-name.bin'; file.name = 'kept-name.bin'; file.parent = '/';
      state.storage.sql.exec('UPDATE files SET path=?,parent=?,status=?,data=? WHERE id=?', file.path, file.parent, file.status, JSON.stringify(file), file.id);
      const missing = JSON.parse(state.storage.sql.exec<{ data: string }>('SELECT data FROM files WHERE object_key=?', objects[2].key).one().data) as DriveFile;
      missing.status = 'missing';
      state.storage.sql.exec('UPDATE files SET status=?,data=? WHERE id=?', missing.status, JSON.stringify(missing), missing.id);
    });
    const changed = { ...objects[1], etag: '"changed"', metadata: { contentType: 'text/plain' } };
    const returned = objects[2];
    const marker = { ...scanObject(20), key: 'folder/', size: 0 };
    const listed = [objects[0], changed, returned, ...objects.slice(3, 9), marker];
    const batch = await stub.prepareScanBatch(jobId, bucket.id, listed);
    expect(batch.cachedKeys).not.toContain(changed.key);
    expect(batch.cachedKeys).not.toContain(returned.key);
    const refreshed = [changed, returned, marker];
    const bytes = batch.cachedBytes + refreshed.reduce((sum, object) => sum + object.size, 0);
    await stub.commitScanBatch(jobId, bucket.id, refreshed, { count: listed.length, bytes });
    await stub.finishScan(jobId, accountId, 'selected', null);
    expect(await stub.lookupObject(bucket.id, objects[0].key)).toMatchObject({ path: '/kept-name.bin', status: 'trash', starred: true });
    expect(await stub.lookupObject(bucket.id, changed.key)).toMatchObject({ etag: '"changed"', metadata: { contentType: 'text/plain' } });
    expect(await stub.lookupObject(bucket.id, returned.key)).toMatchObject({ status: 'ready' });
    expect(await stub.lookupObject(bucket.id, objects[9].key)).toMatchObject({ status: 'missing' });
    expect(await stub.lookupObject(bucket.id, marker.key)).toMatchObject({ isFolderMarker: true });
    expect((await stub.listFiles({ parent: '/' })).folders.some((folder) => folder.path === '/folder')).toBe(true);
  });

  it('leaves objects beyond the sixth HEAD lookup for the next step', async () => {
    const objects = Array.from({ length: 9 }, (_, index) => scanObject(index));
    const { stub, jobId, bucket } = await setupScan('scan-bounded', objects);
    const listed = objects.map((object, index) => index < 6 || index === 7 ? { ...object, etag: '"changed"' } : object);
    const batch = await stub.prepareScanBatch(jobId, bucket.id, listed);
    expect(batch.cachedKeys).toEqual([objects[6].key]);
    const markers = await runInDurableObject(stub, (_instance, state) => state.storage.sql.exec<{ object_key: string; scan_marker: string }>('SELECT object_key,scan_marker FROM files ORDER BY object_key').toArray());
    expect(markers.find((row) => row.object_key === objects[8].key)?.scan_marker).toBe('previous-scan');
    const next = await stub.prepareScanBatch(jobId, bucket.id, listed.slice(7));
    expect(next.cachedKeys).toEqual([objects[8].key]);
  });

  it('retries a failed HEAD without skipping objects or double-counting progress', async () => {
    const { stub, jobId, accountId, bucket } = await setupScan('scan-retry', []);
    const objects = [scanObject(0), scanObject(1)];
    const jobs = env.JOBS.getByName('scan-retry-job');
    const execution: JobExecution = {
      payload: { type: 'scan', id: jobId, driveId: 'scan-retry', accountId, buckets: [bucket] },
      index: 0, status: 'running', retries: 0, cancelRequested: false, transfer: null,
      scan: { phase: 'objects', buckets: [bucket], bucketIndex: 0, continuation: null, objects, objectIndex: 0, count: 0, bytes: 0, coverage: 'selected', pendingUploads: [], pendingIndex: 0, partMarker: null, pendingBytes: 0 },
    };
    await runInDurableObject(jobs, async (instance, state) => {
      state.storage.sql.exec('INSERT INTO execution VALUES (1,?)', JSON.stringify(execution));
      state.storage.sql.exec("INSERT INTO command VALUES (1,'run')");
      const save = vi.spyOn(state.storage, 'setAlarm').mockResolvedValue();
      const head = (index: number) => new Response(null, { headers: { 'Content-Length': String(objects[index].size), ETag: objects[index].etag, 'Content-Type': 'application/octet-stream' } });
      const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(head(0)).mockResolvedValue(new Response('<Error><Code>AccessDenied</Code></Error>', { status: 403, headers: { 'Content-Type': 'application/xml' } }));
      const log = vi.spyOn(console, 'error').mockImplementation(() => {});
      try {
        await instance.alarm();
        const failed = JSON.parse(state.storage.sql.exec<{ data: string }>('SELECT data FROM execution WHERE id=1').one().data) as JobExecution;
        expect(failed.scan).toMatchObject({ objectIndex: 0, count: 0, bytes: 0 });
        expect(failed.retries).toBe(1);
        fetch.mockReset(); fetch.mockResolvedValueOnce(head(0)).mockResolvedValueOnce(head(1));
        await instance.alarm();
        const recovered = JSON.parse(state.storage.sql.exec<{ data: string }>('SELECT data FROM execution WHERE id=1').one().data) as JobExecution;
        expect(recovered.scan).toMatchObject({ objectIndex: 2, count: 2, bytes: objects[0].size + objects[1].size, phase: 'multipart' });
        expect(recovered.retries).toBe(0);
      } finally { fetch.mockRestore(); save.mockRestore(); log.mockRestore(); }
    });
    expect((await stub.listFiles({ bucketId: bucket.id })).files).toHaveLength(2);
  });
});
