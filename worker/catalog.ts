import { DurableObject } from 'cloudflare:workers';
import { createHash } from 'node:crypto';
import { AbortMultipartUploadCommand, DeleteObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import type {
  Account, AccountInput, AuditEntry, Bucket, Dashboard, DriveFile, FileList, FileMetadata,
  DriveStatus, FileCheckResult, FileRefreshResult, FileSegment, Folder, Job, ListOptions, Share, TransferInput, UploadSegment, UploadSession,
} from '../shared/types';
import { allocationBytes, fileKind, fileName, joinPath, MAX_FILE_SEGMENTS, normalizePath, OBJECT_OVERHEAD, parentPath, PART_SIZE, UPLOAD_TTL } from '../shared/paths';
import { completeSegmentLayout, fileSegments, segmentRanges } from '../shared/segments';
import { decrypt, encrypt, safeEqual, sha256 } from './crypto';
import { AppError, assert, errorMessage } from './errors';
import { fromHead, head, resolveToken, s3, type AccountSecrets, type Connection } from './r2';
import type { JobPayload, ScanBatch, ScanObject, ScannedObject, TransferItem } from './job-types';

type JsonRow = { id: string; data: string };
type AccountRecord = Omit<Account, 'usedBytes' | 'reservedBytes' | 'availableBytes'> & { encryptedSecrets: string; observedExternalBytes: number };
type ShareRecord = Share & { passwordHash: string | null; passwordSalt: string };
type Receipt = { state: 'committed' | 'done'; fileId: string; source: DriveFile; target: DriveFile; mode: 'move' | 'copy'; deletedSourceSegments?: number[] };
type ObjectCheck = {exists:false} | {exists:true;size:number;etag:string;metadata:FileMetadata;storageClass:DriveFile['storageClass'];modifiedAt:number};
const emptyCheck = (): FileCheckResult => ({checkedFiles:0,changedFiles:0,missingFiles:0,restoredFiles:0,skippedFiles:0,errors:[]});

export class DriveCatalog extends DurableObject<Env> {
  private fileChecks = new Map<string,symbol>();
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    void ctx.blockConcurrencyWhile(async () => {
      this.ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS accounts (id TEXT PRIMARY KEY, cf_id TEXT NOT NULL UNIQUE, data TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS buckets (id TEXT PRIMARY KEY, account_id TEXT NOT NULL, name TEXT NOT NULL, jurisdiction TEXT NOT NULL, data TEXT NOT NULL, UNIQUE(account_id,name,jurisdiction));
        CREATE INDEX IF NOT EXISTS buckets_account ON buckets(account_id);
        CREATE TABLE IF NOT EXISTS files (id TEXT PRIMARY KEY, path TEXT NOT NULL, parent TEXT NOT NULL, account_id TEXT NOT NULL, bucket_id TEXT NOT NULL, object_key TEXT NOT NULL, size INTEGER NOT NULL, status TEXT NOT NULL, lock_job_id TEXT, scan_marker TEXT NOT NULL DEFAULT '', data TEXT NOT NULL, UNIQUE(bucket_id,object_key));
        CREATE UNIQUE INDEX IF NOT EXISTS files_active_path ON files(path) WHERE status NOT IN ('trash','missing');
        CREATE INDEX IF NOT EXISTS files_parent ON files(parent,status);
        CREATE INDEX IF NOT EXISTS files_account ON files(account_id,status);
        CREATE INDEX IF NOT EXISTS files_bucket ON files(bucket_id,status);
        CREATE INDEX IF NOT EXISTS files_job ON files(lock_job_id);
        CREATE TABLE IF NOT EXISTS file_segments (file_id TEXT NOT NULL,segment_index INTEGER NOT NULL,account_id TEXT NOT NULL,bucket_id TEXT NOT NULL,object_key TEXT NOT NULL,size INTEGER NOT NULL,etag TEXT NOT NULL,status TEXT NOT NULL,storage_class TEXT NOT NULL,scan_marker TEXT NOT NULL DEFAULT '',data TEXT NOT NULL,PRIMARY KEY(file_id,segment_index),UNIQUE(bucket_id,object_key));
        CREATE INDEX IF NOT EXISTS segments_account ON file_segments(account_id,status);
        CREATE INDEX IF NOT EXISTS segments_bucket ON file_segments(bucket_id,status);
        CREATE TABLE IF NOT EXISTS folders (id TEXT PRIMARY KEY, path TEXT NOT NULL UNIQUE, parent TEXT NOT NULL, data TEXT NOT NULL);
        CREATE INDEX IF NOT EXISTS folders_parent ON folders(parent);
        CREATE TABLE IF NOT EXISTS reservations (id TEXT PRIMARY KEY, account_id TEXT NOT NULL, bucket_id TEXT NOT NULL, bytes INTEGER NOT NULL, ref_id TEXT NOT NULL);
        CREATE INDEX IF NOT EXISTS reservations_account ON reservations(account_id);
        CREATE INDEX IF NOT EXISTS reservations_ref ON reservations(ref_id);
        CREATE TABLE IF NOT EXISTS reserved_paths (path TEXT PRIMARY KEY, job_id TEXT NOT NULL, ref_id TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS bucket_leases (bucket_id TEXT PRIMARY KEY, token TEXT NOT NULL, expires_at INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS uploads (id TEXT PRIMARY KEY, expires_at INTEGER NOT NULL, status TEXT NOT NULL, data TEXT NOT NULL);
        CREATE INDEX IF NOT EXISTS uploads_expiry ON uploads(status,expires_at);
        CREATE TABLE IF NOT EXISTS jobs (id TEXT PRIMARY KEY, status TEXT NOT NULL, created_at INTEGER NOT NULL, data TEXT NOT NULL, payload TEXT NOT NULL);
        CREATE INDEX IF NOT EXISTS jobs_status ON jobs(status,created_at);
        CREATE TABLE IF NOT EXISTS receipts (id TEXT PRIMARY KEY, data TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS shares (id TEXT PRIMARY KEY, file_id TEXT NOT NULL, expires_at INTEGER NOT NULL, data TEXT NOT NULL);
        CREATE INDEX IF NOT EXISTS shares_file ON shares(file_id);
        CREATE TABLE IF NOT EXISTS audit (id INTEGER PRIMARY KEY AUTOINCREMENT, action TEXT NOT NULL, detail TEXT NOT NULL, created_at INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS rate_limits (key TEXT PRIMARY KEY, count INTEGER NOT NULL, expires_at INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS admin (id INTEGER PRIMARY KEY, username TEXT NOT NULL, password_hash TEXT NOT NULL, password_salt TEXT NOT NULL, created_at INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS schema_version (version INTEGER PRIMARY KEY);
        INSERT OR IGNORE INTO schema_version VALUES (1);
      `);
    });
  }

  private get<T>(table: 'accounts' | 'buckets' | 'files' | 'folders' | 'uploads' | 'jobs' | 'shares' | 'receipts', id: string): T | null {
    const row = this.ctx.storage.sql.exec<JsonRow>(`SELECT id,data FROM ${table} WHERE id=?`, id).toArray()[0];
    return row ? JSON.parse(row.data) as T : null;
  }

  private accountRecord(id: string): AccountRecord {
    const account = this.get<AccountRecord>('accounts', id);
    assert(account, '账号不存在', 404);
    return account;
  }

  private bucketRecord(id: string): Bucket {
    const bucket = this.get<Bucket>('buckets', id);
    assert(bucket, '存储桶不存在', 404);
    return bucket;
  }

  private fileRecord(id: string): DriveFile {
    const file = this.get<DriveFile>('files', id);
    assert(file, '文件不存在', 404);
    return file;
  }

  private saveAccount(account: AccountRecord): void {
    this.ctx.storage.sql.exec('INSERT INTO accounts VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data', account.id, account.accountId, JSON.stringify(account));
  }

  private saveBucket(bucket: Bucket): void {
    this.ctx.storage.sql.exec('INSERT INTO buckets VALUES (?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data', bucket.id, bucket.accountId, bucket.name, bucket.jurisdiction, JSON.stringify(bucket));
  }

  private saveFile(file: DriveFile, scanMarker?: string): void {
    this.ctx.storage.transactionSync(() => {
      const marker = scanMarker ?? this.ctx.storage.sql.exec<{ scan_marker: string }>('SELECT scan_marker FROM files WHERE id=?', file.id).toArray()[0]?.scan_marker ?? '';
      this.ctx.storage.sql.exec(`INSERT INTO files(id,path,parent,account_id,bucket_id,object_key,size,status,lock_job_id,scan_marker,data) VALUES (?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET
        path=excluded.path,parent=excluded.parent,account_id=excluded.account_id,bucket_id=excluded.bucket_id,object_key=excluded.object_key,
        size=excluded.size,status=excluded.status,lock_job_id=excluded.lock_job_id,scan_marker=excluded.scan_marker,data=excluded.data`,
      file.id, file.path, file.parent, file.accountId, file.bucketId, file.objectKey, file.size, file.status, file.lockJobId, marker, JSON.stringify(file));
      if (!file.segments) this.ctx.storage.sql.exec('DELETE FROM file_segments WHERE file_id=?',file.id);
      else for (const segment of file.segments) {
        const status = file.status === 'uploading' ? 'uploading' : segment.status;
        this.ctx.storage.sql.exec(`INSERT INTO file_segments(file_id,segment_index,account_id,bucket_id,object_key,size,etag,status,storage_class,data) VALUES (?,?,?,?,?,?,?,?,?,?)
          ON CONFLICT(file_id,segment_index) DO UPDATE SET account_id=excluded.account_id,bucket_id=excluded.bucket_id,object_key=excluded.object_key,size=excluded.size,etag=excluded.etag,status=excluded.status,storage_class=excluded.storage_class,data=excluded.data,
          scan_marker=CASE WHEN file_segments.bucket_id!=excluded.bucket_id OR file_segments.object_key!=excluded.object_key THEN '' ELSE file_segments.scan_marker END
          WHERE file_segments.data!=excluded.data OR file_segments.status!=excluded.status`,
        file.id,segment.index,segment.accountId,segment.bucketId,segment.objectKey,segment.actualSize ?? segment.size,segment.etag,status,segment.storageClass,JSON.stringify(segment));
      }
    });
  }

  private deleteFile(id: string): void {
    this.ctx.storage.sql.exec('DELETE FROM file_segments WHERE file_id=?',id);
    this.ctx.storage.sql.exec('DELETE FROM files WHERE id=?',id);
  }

  private segmentedEtag(segments: FileSegment[]): string {
    return `"segments-${createHash('sha256').update(JSON.stringify(segments.map(({index,offset,size,bucketId,objectKey,etag})=>({index,offset,size,bucketId,objectKey,etag})))).digest('hex')}"`;
  }

  private assertFileAccountsIdle(file: DriveFile): void {
    for (const id of new Set(fileSegments(file).map((segment)=>segment.accountId))) assert(this.accountRecord(id).syncState !== 'scanning','文件所在账号正在扫描',409);
  }

  private busySegment(accountId?: string, bucketId?: string): boolean {
    return this.ctx.storage.sql.exec(`SELECT s.file_id FROM file_segments s JOIN files f ON f.id=s.file_id WHERE ${accountId ? 's.account_id' : 's.bucket_id'}=? AND (f.lock_job_id IS NOT NULL OR f.status='uploading') LIMIT 1`,accountId || bucketId!).toArray().length > 0;
  }

  private saveUpload(upload: UploadSession): void {
    this.ctx.storage.sql.exec('INSERT INTO uploads VALUES (?,?,?,?) ON CONFLICT(id) DO UPDATE SET expires_at=excluded.expires_at,status=excluded.status,data=excluded.data', upload.id, upload.expiresAt, upload.status, JSON.stringify(upload));
  }

  private recordAudit(action: string, detail: string): void {
    this.ctx.storage.sql.exec('INSERT INTO audit(action,detail,created_at) VALUES (?,?,?)', action, detail.slice(0,2000), Date.now());
  }

  private usage(accountId: string): { used: number; reserved: number } {
    const used = this.ctx.storage.sql.exec<{ total: number }>("SELECT COALESCE(SUM(bytes),0) total FROM (SELECT size+8192 bytes FROM files WHERE account_id=? AND status NOT IN ('uploading','missing') AND json_extract(data,'$.segments') IS NULL UNION ALL SELECT size+8192 bytes FROM file_segments WHERE account_id=? AND status='ready')", accountId,accountId).one().total;
    const reserved = this.ctx.storage.sql.exec<{ total: number }>('SELECT COALESCE(SUM(bytes),0) total FROM reservations WHERE account_id=?', accountId).one().total;
    return { used, reserved };
  }

  private publicAccount(record: AccountRecord, usage = this.usage(record.id)): Account {
    const { encryptedSecrets: _secrets, observedExternalBytes, ...account } = record;
    const { used, reserved } = usage;
    const external = Math.max(account.externalBytes, observedExternalBytes);
    return { ...account, externalBytes: external, usedBytes: used + external, reservedBytes: reserved, availableBytes: Math.max(0, account.quotaBytes-account.safetyBytes-external-used-reserved) };
  }

  getAccounts(): Account[] {
    const rows = this.ctx.storage.sql.exec<JsonRow>("SELECT id,data FROM accounts ORDER BY json_extract(data,'$.priority'),id").toArray();
    const used = new Map(this.ctx.storage.sql.exec<{account_id:string;total:number}>("SELECT account_id,COALESCE(SUM(bytes),0) total FROM (SELECT account_id,size+8192 bytes FROM files WHERE status NOT IN ('uploading','missing') AND json_extract(data,'$.segments') IS NULL UNION ALL SELECT account_id,size+8192 bytes FROM file_segments WHERE status='ready') GROUP BY account_id").toArray().map((row)=>[row.account_id,row.total]));
    const reserved = new Map(this.ctx.storage.sql.exec<{account_id:string;total:number}>('SELECT account_id,COALESCE(SUM(bytes),0) total FROM reservations GROUP BY account_id').toArray().map((row)=>[row.account_id,row.total]));
    return rows.map((row)=>this.publicAccount(JSON.parse(row.data) as AccountRecord,{used:used.get(row.id) || 0,reserved:reserved.get(row.id) || 0}));
  }

  getBuckets(accountId?: string): Bucket[] {
    const rows = accountId ? this.ctx.storage.sql.exec<JsonRow>('SELECT id,data FROM buckets WHERE account_id=? ORDER BY name', accountId).toArray() : this.ctx.storage.sql.exec<JsonRow>('SELECT id,data FROM buckets ORDER BY name').toArray();
    const query = `SELECT bucket_id,COALESCE(SUM(size),0) used,COUNT(*) count FROM (SELECT account_id,bucket_id,size FROM files WHERE status NOT IN ('uploading','missing') AND json_extract(data,'$.segments') IS NULL UNION ALL SELECT account_id,bucket_id,size FROM file_segments WHERE status='ready')${accountId ? ' WHERE account_id=?' : ''} GROUP BY bucket_id`;
    const usage = new Map(this.ctx.storage.sql.exec<{bucket_id:string;used:number;count:number}>(query,...(accountId ? [accountId] : [])).toArray().map((row)=>[row.bucket_id,row]));
    return rows.map((row) => {
      const bucket = JSON.parse(row.data) as Bucket;
      const totals = usage.get(bucket.id);
      return { ...bucket, ignored: bucket.ignored ?? false, usedBytes: totals?.used || 0, objectCount: totals?.count || 0 };
    });
  }

  async getConnection(bucketId: string): Promise<Connection> {
    const bucket = this.bucketRecord(bucketId);
    const account = this.accountRecord(bucket.accountId);
    return { cloudflareAccountId: account.accountId, bucket, secrets: await decrypt<AccountSecrets>(account.encryptedSecrets, this.env.ENCRYPTION_KEY, account.id) };
  }

  async getAccountConnection(accountId: string): Promise<Connection> {
    const account = this.accountRecord(accountId);
    const row = this.ctx.storage.sql.exec<JsonRow>('SELECT id,data FROM buckets WHERE account_id=? ORDER BY name LIMIT 1',accountId).toArray()[0];
    const bucket = row ? JSON.parse(row.data) as Bucket : { id: '', accountId, name: '', jurisdiction: 'default', storageClass: 'Standard', inPool: false, ignored: false, priority: 0, location: '', createdAt: 0, usedBytes: 0, objectCount: 0 } satisfies Bucket;
    return { cloudflareAccountId: account.accountId, bucket, secrets: await decrypt<AccountSecrets>(account.encryptedSecrets, this.env.ENCRYPTION_KEY, account.id) };
  }

  async addAccount(input: AccountInput): Promise<Account> {
    const id = crypto.randomUUID();
    const secrets = input.r2Token ? await resolveToken(input.accountId, input.r2Token) : { accessKeyId: input.accessKeyId!, secretAccessKey: input.secretAccessKey!, apiToken: input.apiToken };
    if (input.apiToken) secrets.apiToken = input.apiToken;
    const encryptedSecrets = await encrypt(secrets, this.env.ENCRYPTION_KEY, id);
    const account: AccountRecord = {
      id, name: input.name, accountId: input.accountId.toLowerCase(), priority: this.getAccounts().length,
      enabled: true, quotaBytes: input.quotaBytes, safetyBytes: input.safetyBytes, externalBytes: input.externalBytes,
      observedExternalBytes: 0, encryptedSecrets, accessKeyHint: secrets.accessKeyId.slice(-6), hasApiToken: Boolean(secrets.apiToken),
      syncState: 'pending', syncCoverage: 'selected', syncJobId: null, lastSyncedAt: null, lastError: null, createdAt: Date.now(),
    };
    this.ctx.storage.transactionSync(() => {
      assert(!this.ctx.storage.sql.exec('SELECT id FROM accounts WHERE cf_id=?', account.accountId).toArray().length, '这个 Cloudflare 账号已经添加');
      this.saveAccount(account);
      for (const item of input.buckets) this.saveBucket({ ...item, id: crypto.randomUUID(), accountId: id, storageClass: 'Standard', ignored: false, priority: 0, location: '', createdAt: Date.now(), usedBytes: 0, objectCount: 0 });
      this.recordAudit('添加账号', account.name);
    });
    await this.startScan(id);
    return this.publicAccount(this.accountRecord(id));
  }

  async updateAccount(id: string, patch: { name?: string; enabled?: boolean; quotaBytes?: number; safetyBytes?: number; externalBytes?: number; accessKeyId?: string; secretAccessKey?: string; apiToken?: string }): Promise<Account> {
    let replacement: string | null = null;
    let secrets: AccountSecrets | null = null;
    if (patch.accessKeyId || patch.secretAccessKey || patch.apiToken !== undefined) {
      const account = this.accountRecord(id);
      secrets = { ...await decrypt<AccountSecrets>(account.encryptedSecrets, this.env.ENCRYPTION_KEY, id) };
      if (patch.accessKeyId) secrets.accessKeyId = patch.accessKeyId;
      if (patch.secretAccessKey) secrets.secretAccessKey = patch.secretAccessKey;
      if (patch.apiToken !== undefined) secrets.apiToken = patch.apiToken || undefined;
      replacement = await encrypt(secrets, this.env.ENCRYPTION_KEY, id);
    }
    this.ctx.storage.transactionSync(() => {
      const account = this.accountRecord(id);
      for (const key of ['name','enabled','quotaBytes','safetyBytes','externalBytes'] as const) {
        const value = patch[key];
        if (value !== undefined) Object.assign(account, { [key]: value });
      }
      assert(account.safetyBytes < account.quotaBytes, '安全余量必须小于容量上限');
      const { used, reserved } = this.usage(id);
      if (patch.quotaBytes !== undefined || patch.safetyBytes !== undefined) assert(account.quotaBytes-account.safetyBytes-Math.max(account.externalBytes,account.observedExternalBytes) >= used+reserved, '新容量上限低于当前已用及预占容量');
      if (replacement && secrets) {
        assert(account.syncState !== 'scanning' && reserved === 0 && !this.busySegment(id) && !this.ctx.storage.sql.exec('SELECT id FROM files WHERE account_id=? AND lock_job_id IS NOT NULL LIMIT 1', id).toArray().length, '账号有运行中的任务，完成后再更新凭据', 409);
        account.encryptedSecrets = replacement; account.accessKeyHint = secrets.accessKeyId.slice(-6); account.hasApiToken = Boolean(secrets.apiToken);
      }
      this.saveAccount(account);
      this.recordAudit('更新账号', account.name);
    });
    return this.publicAccount(this.accountRecord(id));
  }

  reorderAccounts(ids: string[]): void {
    const accounts = this.getAccounts();
    assert(ids.length === accounts.length && new Set(ids).size === ids.length && ids.every((id) => accounts.some((account) => account.id === id)), '账号排序数据不完整');
    this.ctx.storage.transactionSync(() => ids.forEach((id,index) => this.saveAccount({ ...this.accountRecord(id), priority: index })));
  }

  removeAccount(id: string): void {
    this.ctx.storage.transactionSync(() => {
      const account = this.accountRecord(id);
      assert(account.syncState !== 'scanning', '请先停止容量扫描', 409);
      assert(!this.ctx.storage.sql.exec('SELECT file_id FROM file_segments WHERE account_id=? LIMIT 1',id).toArray().length,'账号中仍有跨账号文件分段，请先迁移或删除对应文件',409);
      assert(!this.ctx.storage.sql.exec("SELECT id FROM files WHERE account_id=? AND status != 'missing' LIMIT 1", id).toArray().length && this.usage(id).reserved === 0, '账号内仍有文件或任务，请先迁移或删除文件', 409);
      this.ctx.storage.sql.exec('DELETE FROM files WHERE account_id=?', id);
      this.ctx.storage.sql.exec('DELETE FROM buckets WHERE account_id=?', id);
      this.ctx.storage.sql.exec('DELETE FROM accounts WHERE id=?', id);
      this.recordAudit('移除账号', account.name);
    });
  }

  registerBuckets(accountId: string, entries: { name: string; jurisdiction: Bucket['jurisdiction']; storageClass?: Bucket['storageClass']; location?: string; inPool?: boolean }[]): Bucket[] {
    this.accountRecord(accountId);
    this.ctx.storage.transactionSync(() => {
      for (const entry of entries) {
        const row = this.ctx.storage.sql.exec<JsonRow>('SELECT id,data FROM buckets WHERE account_id=? AND name=? AND jurisdiction=?', accountId, entry.name, entry.jurisdiction).toArray()[0];
        const previous = row ? JSON.parse(row.data) as Bucket : null;
        this.saveBucket({ id: previous?.id || crypto.randomUUID(), accountId, name: entry.name, jurisdiction: entry.jurisdiction, storageClass: entry.storageClass || previous?.storageClass || 'Standard', inPool: entry.inPool ?? previous?.inPool ?? true, ignored: previous?.ignored ?? false, priority: previous?.priority || 0, location: entry.location || previous?.location || '', createdAt: previous?.createdAt || Date.now(), usedBytes: 0, objectCount: 0 });
      }
    });
    return this.getBuckets(accountId);
  }

  updateBucket(id: string, patch: { inPool?: boolean; storageClass?: Bucket['storageClass']; priority?: number; ignored?: boolean }): Bucket {
    const bucket = this.bucketRecord(id);
    if (patch.ignored !== undefined && patch.ignored !== bucket.ignored) {
      const account = this.accountRecord(bucket.accountId);
      assert(account.syncState !== 'scanning', '账号正在扫描，请稍后再操作', 409);
      if (patch.ignored) {
        assert(!this.ctx.storage.sql.exec('SELECT file_id FROM file_segments WHERE bucket_id=? LIMIT 1',id).toArray().length,'桶中仍有跨账号文件分段，请先迁移或删除对应文件',409);
        assert(!this.ctx.storage.sql.exec("SELECT id FROM files WHERE bucket_id=? AND status IN ('uploading','busy') LIMIT 1", id).toArray().length, '存储桶有进行中的上传或迁移，请先完成或取消', 409);
        this.ctx.storage.sql.exec('DELETE FROM shares WHERE file_id IN (SELECT id FROM files WHERE bucket_id=?)', id);
        this.ctx.storage.sql.exec('DELETE FROM files WHERE bucket_id=?', id);
        this.ctx.storage.sql.exec('DELETE FROM reservations WHERE bucket_id=?', id);
        bucket.inPool = false;
      }
      this.recordAudit(patch.ignored ? '屏蔽存储桶' : '取消屏蔽存储桶', bucket.name);
    }
    this.saveBucket({ ...bucket, ...patch });
    return this.bucketRecord(id);
  }

  assertBucketIdle(id: string): void {
    const bucket = this.bucketRecord(id);
    assert(this.accountRecord(bucket.accountId).syncState !== 'scanning', '账号正在扫描', 409);
    assert(!this.busySegment(undefined,id) && !this.ctx.storage.sql.exec('SELECT id FROM files WHERE bucket_id=? AND lock_job_id IS NOT NULL LIMIT 1', id).toArray().length && !this.ctx.storage.sql.exec('SELECT id FROM reservations WHERE bucket_id=? LIMIT 1', id).toArray().length, '存储桶仍有未完成任务', 409);
  }

  acquireBucketLease(id: string): string {
    return this.ctx.storage.transactionSync(() => {
      this.assertBucketIdle(id);
      assert(!this.ctx.storage.sql.exec('SELECT bucket_id FROM bucket_leases WHERE bucket_id=? AND expires_at>?',id,Date.now()).toArray().length,'存储桶设置正在更新',409);
      const token=crypto.randomUUID();
      this.ctx.storage.sql.exec('INSERT INTO bucket_leases VALUES (?,?,?) ON CONFLICT(bucket_id) DO UPDATE SET token=excluded.token,expires_at=excluded.expires_at',id,token,Date.now()+120_000);
      return token;
    });
  }

  releaseBucketLease(id: string, token: string): void {
    this.ctx.storage.sql.exec('DELETE FROM bucket_leases WHERE bucket_id=? AND token=?',id,token);
  }

  private bucketIsLeased(id: string): boolean {
    return this.ctx.storage.sql.exec('SELECT bucket_id FROM bucket_leases WHERE bucket_id=? AND expires_at>?',id,Date.now()).toArray().length>0;
  }

  removeBucket(id: string): void {
    this.assertBucketIdle(id);
    assert(!this.ctx.storage.sql.exec('SELECT file_id FROM file_segments WHERE bucket_id=? LIMIT 1',id).toArray().length,'桶中仍有跨账号文件分段，请先删除对应文件',409);
    this.ctx.storage.sql.exec('DELETE FROM files WHERE bucket_id=?', id);
    this.ctx.storage.sql.exec('DELETE FROM shares WHERE file_id NOT IN (SELECT id FROM files)');
    this.ctx.storage.sql.exec('DELETE FROM buckets WHERE id=?', id);
    this.recordAudit('删除存储桶', id);
  }

  private uniquePath(desired: string, excludedId?: string): string {
    let candidate = normalizePath(desired);
    const name = fileName(candidate);
    const parent = parentPath(candidate);
    const dot = name.lastIndexOf('.');
    const base = dot > 0 ? name.slice(0,dot) : name;
    const extension = dot > 0 ? name.slice(dot) : '';
    let index = 2;
    while (this.ctx.storage.sql.exec("SELECT id FROM files WHERE path=? AND status NOT IN ('trash','missing') AND id != ?", candidate, excludedId || '').toArray().length || this.ctx.storage.sql.exec('SELECT id FROM folders WHERE path=?', candidate).toArray().length || this.ctx.storage.sql.exec('SELECT path FROM reserved_paths WHERE path=?',candidate).toArray().length) {
      candidate = joinPath(parent, `${base} (${index++})${extension}`);
      assert(index < 10000, '同名文件过多');
    }
    return candidate;
  }

  private ensureFolders(path: string): void {
    let current = normalizePath(path);
    while (current !== '/') {
      assert(!this.ctx.storage.sql.exec("SELECT id FROM files WHERE path=? AND status NOT IN ('trash','missing')", current).toArray().length && !this.ctx.storage.sql.exec('SELECT path FROM reserved_paths WHERE path=?',current).toArray().length, '目录路径被同名文件或传输任务占用', 409);
      const folder: Folder = { id: crypto.randomUUID(), path: current, name: fileName(current), parent: parentPath(current), createdAt: Date.now() };
      this.ctx.storage.sql.exec('INSERT OR IGNORE INTO folders VALUES (?,?,?,?)', folder.id, folder.path, folder.parent, JSON.stringify(folder));
      current = folder.parent;
    }
  }

  createFolder(path: string): Folder {
    path = normalizePath(path);
    assert(path !== '/', '根目录已经存在');
    this.ctx.storage.transactionSync(() => { this.ensureFolders(path); this.recordAudit('创建文件夹', path); });
    return JSON.parse(this.ctx.storage.sql.exec<JsonRow>('SELECT id,data FROM folders WHERE path=?', path).one().data) as Folder;
  }

  renameFolder(id: string, destination: string): void {
    destination = normalizePath(destination);
    this.ctx.storage.transactionSync(() => {
      const folder = this.get<Folder>('folders', id);
      assert(folder, '文件夹不存在', 404);
      assert(destination !== '/' && !destination.startsWith(folder.path + '/') && destination !== folder.path, '目标文件夹路径无效');
      assert(!this.ctx.storage.sql.exec('SELECT id FROM folders WHERE path=?', destination).toArray().length, '目标文件夹已存在', 409);
      const descendants = this.ctx.storage.sql.exec<JsonRow>('SELECT id,data FROM folders WHERE path=? OR substr(path,1,?)=? ORDER BY length(path)', folder.path, folder.path.length+1, folder.path+'/').toArray();
      const files = this.ctx.storage.sql.exec<JsonRow>('SELECT id,data FROM files WHERE substr(path,1,?)=?', folder.path.length+1, folder.path+'/').toArray().map((row) => JSON.parse(row.data) as DriveFile);
      assert(files.length <= 5000, '文件夹超过 5000 个文件，请分批移动');
      for (const file of files) { assert(!file.lockJobId && file.status !== 'uploading', '文件夹中有未完成的任务', 409); this.assertFileAccountsIdle(file); }
      assert(!this.ctx.storage.sql.exec('SELECT path FROM reserved_paths WHERE substr(path,1,?)=?',folder.path.length+1,folder.path+'/').toArray().length,'文件夹中有传输任务预占路径',409);
      this.ensureFolders(parentPath(destination));
      for (const row of descendants) {
        const item = JSON.parse(row.data) as Folder;
        item.path = destination + item.path.slice(folder.path.length); item.name = fileName(item.path); item.parent = parentPath(item.path);
        this.ctx.storage.sql.exec('UPDATE folders SET path=?,parent=?,data=? WHERE id=?', item.path, item.parent, JSON.stringify(item), item.id);
      }
      for (const file of files) {
        file.path = destination + file.path.slice(folder.path.length); file.name = fileName(file.path); file.parent = parentPath(file.path); file.modifiedAt = Date.now();
        this.saveFile(file);
      }
      this.recordAudit('移动文件夹', `${folder.path} → ${destination}`);
    });
  }

  trashFolder(id: string): void {
    this.ctx.storage.transactionSync(() => {
      const folder = this.get<Folder>('folders', id);
      assert(folder, '文件夹不存在', 404);
      const files = this.ctx.storage.sql.exec<JsonRow>('SELECT id,data FROM files WHERE substr(path,1,?)=?', folder.path.length+1, folder.path+'/').toArray().map((row) => JSON.parse(row.data) as DriveFile);
      for (const file of files) {
        assert(!file.lockJobId && file.status !== 'uploading', '文件夹中有未完成的任务', 409); this.assertFileAccountsIdle(file);
        if (file.status === 'ready') { file.status = 'trash'; file.deletedAt = Date.now(); this.saveFile(file); }
      }
      this.ctx.storage.sql.exec('DELETE FROM folders WHERE path=? OR substr(path,1,?)=?', folder.path, folder.path.length+1, folder.path+'/');
      this.recordAudit('文件夹移入回收站', folder.path);
    });
  }

  listFiles(options: ListOptions = {}): FileList {
    const conditions: string[] = [];
    const bindings: (string | number)[] = [];
    if (options.view === 'trash') conditions.push("status='trash'");
    else if (options.view === 'missing') conditions.push("status='missing'");
    else conditions.push("status NOT IN ('trash','missing','uploading')");
    conditions.push("COALESCE(json_extract(data,'$.isFolderMarker'),0)=0");
    if (options.view === 'starred') conditions.push("json_extract(data,'$.starred')=1");
    if (options.search) { conditions.push("instr(lower(json_extract(data,'$.name')),lower(?))>0"); bindings.push(options.search); }
    else if (!options.bucketId && (!options.view || options.view === 'all')) { conditions.push('parent=?'); bindings.push(normalizePath(options.parent || '/')); }
    if (options.accountId) { conditions.push('(account_id=? OR EXISTS(SELECT 1 FROM file_segments s WHERE s.file_id=files.id AND s.account_id=?))'); bindings.push(options.accountId,options.accountId); }
    if (options.bucketId) { conditions.push('(bucket_id=? OR EXISTS(SELECT 1 FROM file_segments s WHERE s.file_id=files.id AND s.bucket_id=?))'); bindings.push(options.bucketId,options.bucketId); }
    const where = conditions.join(' AND ');
    const pageSize = Math.min(Math.max(options.pageSize || 50,1),200);
    const page = Math.max(options.page || 1,1);
    const sort = options.view === 'recent' ? "json_extract(data,'$.modifiedAt')" : options.sort === 'size' ? 'size' : options.sort === 'modifiedAt' ? "json_extract(data,'$.modifiedAt')" : "json_extract(data,'$.name') COLLATE NOCASE";
    const direction = options.view === 'recent' || options.direction === 'desc' ? 'DESC' : 'ASC';
    const files = this.ctx.storage.sql.exec<JsonRow>(`SELECT id,json_remove(data,'$.segments') data FROM files WHERE ${where} ORDER BY ${sort} ${direction},id LIMIT ? OFFSET ?`, ...bindings, pageSize, (page-1)*pageSize).toArray().map((row) => JSON.parse(row.data) as DriveFile);
    const total = this.ctx.storage.sql.exec<{ count: number }>(`SELECT COUNT(*) count FROM files WHERE ${where}`, ...bindings).one().count;
    const folders = options.bucketId || (options.view && options.view !== 'all') ? [] : options.search ? this.ctx.storage.sql.exec<JsonRow>("SELECT id,data FROM folders WHERE instr(lower(json_extract(data,'$.name')),lower(?))>0 ORDER BY path LIMIT 200", options.search).toArray().map((row) => JSON.parse(row.data) as Folder) : this.ctx.storage.sql.exec<JsonRow>('SELECT id,data FROM folders WHERE parent=? ORDER BY path LIMIT 200', normalizePath(options.parent || '/')).toArray().map((row) => JSON.parse(row.data) as Folder);
    return { files, folders, total, page, pageSize };
  }

  getFile(id: string): DriveFile { return this.fileRecord(id); }

  async inspectObject(bucketId: string, key: string): Promise<ObjectCheck> {
    const actual=await head(await this.getConnection(bucketId),key,AbortSignal.timeout(15_000));
    if (!actual) return {exists:false};
    assert(Number.isSafeInteger(actual.ContentLength) && actual.ContentLength!>=0 && actual.ETag,'远端对象的长度或校验信息不完整',502);
    return {exists:true,size:actual.ContentLength!,etag:actual.ETag!,metadata:fromHead(actual),storageClass:actual.StorageClass==='STANDARD_IA'?'InfrequentAccess':'Standard',modifiedAt:actual.LastModified?.getTime() || 0};
  }

  async revalidateFile(id: string): Promise<FileCheckResult> {
    const result=emptyCheck();
    const snapshot=this.get<DriveFile>('files',id);
    if (!snapshot || snapshot.lockJobId || ['busy','uploading'].includes(snapshot.status)) {result.skippedFiles=1;return result;}
    const segments=fileSegments(snapshot);
    const accounts=[...new Set(segments.map((segment)=>segment.accountId))];
    const synced=new Map(accounts.map((accountId)=>{const account=this.get<AccountRecord>('accounts',accountId);return [accountId,{time:account?.lastSyncedAt,state:account?.syncState}];}));
    if ([...synced.values()].some((account)=>!account.state)) {result.errors.push({fileId:id,message:`${snapshot.name}：存储账号不存在，无法完成远端校验`});return result;}
    if ([...synced.values()].some((account)=>account.state==='scanning')) {result.skippedFiles=1;return result;}
    const token=Symbol();this.fileChecks.set(id,token);
    const identity=(file:DriveFile)=>JSON.stringify({size:file.size,etag:file.etag,segments:fileSegments(file).map(({index,offset,size,accountId,bucketId,objectKey,etag,status,actualSize})=>({index,offset,size,accountId,bucketId,objectKey,etag,status,actualSize}))});
    try {
      const self=this.env.CATALOG.get(this.ctx.id);
      const checks:ObjectCheck[]=[];
      for (let offset=0;offset<segments.length;offset+=4) checks.push(...await Promise.all(segments.slice(offset,offset+4).map((segment)=>self.inspectObject(segment.bucketId,segment.objectKey))));
      return this.ctx.storage.transactionSync(()=>{
        const current=this.get<DriveFile>('files',id);
        const changedAccount=accounts.some((accountId)=>{const account=this.get<AccountRecord>('accounts',accountId);return !account || account.syncState==='scanning' || account.lastSyncedAt!==synced.get(accountId)!.time;});
        if (!current || this.fileChecks.get(id)!==token || current.lockJobId || ['busy','uploading'].includes(current.status) || changedAccount || identity(current)!==identity(snapshot)) {result.skippedFiles=1;return result;}
        const before=JSON.stringify(current);const wasMissing=current.status==='missing';
        if (current.segments) {
          current.segments.forEach((segment,index)=>{
            const check=checks[index];
            if (!check.exists) {segment.status='missing';return;}
            segment.status='ready';segment.etag=check.etag;segment.storageClass=check.storageClass;
            if (check.size!==segment.size) segment.actualSize=check.size;else delete segment.actualSize;
            current.modifiedAt=Math.max(current.modifiedAt,check.modifiedAt);
          });
          current.status=completeSegmentLayout(current) ? current.deletedAt ? 'trash' : 'ready' : 'missing';
          current.etag=this.segmentedEtag(current.segments);
        } else {
          const check=checks[0];
          if (!check.exists) current.status='missing';
          else {
            current.size=check.size;current.etag=check.etag;current.metadata=check.metadata;current.storageClass=check.storageClass;
            current.status=current.deletedAt ? 'trash' : 'ready';current.modifiedAt=Math.max(current.modifiedAt,check.modifiedAt);
          }
        }
        if (wasMissing && current.status!=='missing') {current.path=this.uniquePath(current.path,current.id);current.name=fileName(current.path);current.parent=parentPath(current.path);this.ensureFolders(current.parent);}
        result.checkedFiles=1;
        result.missingFiles=current.status==='missing' ? 1 : 0;
        result.restoredFiles=wasMissing && current.status!=='missing' ? 1 : 0;
        if (JSON.stringify(current)!==before) {
          this.saveFile(current);result.changedFiles=1;
          if (!wasMissing && current.status==='missing') this.recordAudit('发现远端文件缺失',current.path);
          else if (result.restoredFiles) this.recordAudit('找回远端文件',current.path);
        }
        return result;
      });
    } catch (error) {
      result.errors.push({fileId:id,message:`${snapshot.name}：${errorMessage(error)}`});return result;
    } finally {if(this.fileChecks.get(id)===token)this.fileChecks.delete(id);}
  }

  async refreshFiles(options: ListOptions): Promise<FileRefreshResult> {
    const initial=this.listFiles(options);const result=emptyCheck();
    const self=this.env.CATALOG.get(this.ctx.id);
    for (let offset=0;offset<initial.files.length;offset+=3) {
      const batch=await Promise.all(initial.files.slice(offset,offset+3).map((file)=>self.revalidateFile(file.id)));
      for (const check of batch) {
        result.checkedFiles+=check.checkedFiles;result.changedFiles+=check.changedFiles;result.missingFiles+=check.missingFiles;
        result.restoredFiles+=check.restoredFiles;result.skippedFiles+=check.skippedFiles;result.errors.push(...check.errors);
      }
    }
    return {...result,list:this.listFiles(options),status:this.status()};
  }

  getDownloadFile(id: string, shareId?: string): DriveFile {
    if (shareId) {
      const share=this.get<ShareRecord>('shares',shareId);
      assert(share && share.fileId===id && share.expiresAt>Date.now(),'分享已过期或已撤销',403);
    }
    const file=this.fileRecord(id);
    assert(['ready','busy'].includes(file.status) && (!file.segments || completeSegmentLayout(file)),'文件或分段暂不可用',409);
    return file;
  }

  async readFileSegment(id: string, index: number, start: number, length: number, version: string): Promise<ReadableStream<Uint8Array>> {
    const file=this.getDownloadFile(id);assert(file.etag===version,'文件在读取过程中已发生变化',409);
    const segment=fileSegments(file).find((part)=>part.index===index);assert(segment,'文件分段不存在',404);
    assert(Number.isSafeInteger(start) && Number.isSafeInteger(length) && start>=0 && length>0 && start+length<=segment.size,'文件读取范围不正确',416);
    const connection=await this.getConnection(segment.bucketId);
    const response=await s3(connection).send(new GetObjectCommand({Bucket:connection.bucket.name,Key:segment.objectKey,IfMatch:segment.etag,Range:`bytes=${start}-${start+length-1}`}));
    const body=response.Body?.transformToWebStream();
    try {
      assert(body && response.ContentLength===length && response.ETag===segment.etag,'文件分段长度或校验信息不符',409);
      if (response.ContentRange) assert(Number(response.ContentRange.split('/')[1])===segment.size,'文件分段已改变',409);
      return body;
    } catch(error) {await body?.cancel().catch(()=>undefined);throw error;}
  }

  async readFileRange(id: string, start: number, length: number, version: string): Promise<ReadableStream<Uint8Array>> {
    const file=this.getDownloadFile(id);assert(file.etag===version,'文件已发生变化',409);
    assert(Number.isSafeInteger(start) && Number.isSafeInteger(length) && start>=0 && length>=0 && start+length<=file.size,'文件读取范围不正确',416);
    if (!length) return new ReadableStream({start(controller){controller.close();}});
    const ranges=segmentRanges(file,start,length);
    if (ranges.length===1) return this.readFileSegment(id,ranges[0].segment.index,ranges[0].start,ranges[0].length,version);
    const stream=new FixedLengthStream(length);
    const self=this.env.CATALOG.get(this.ctx.id);
    const pump=(async()=>{
      for (const range of ranges) {
        // 每段独立 RPC，保持外部子请求数有界；pipeTo 由运行时流式转发，不缓冲整文件。
        const body=await self.readFileSegment(id,range.segment.index,range.start,range.length,version);
        await body.pipeTo(stream.writable,{preventClose:true});
      }
      await stream.writable.close();
    })();
    void pump.catch((error)=>stream.writable.abort(error).catch(()=>undefined));
    return stream.readable;
  }

  updateSegmentedMetadata(id: string, metadata: FileMetadata): DriveFile {
    return this.ctx.storage.transactionSync(()=>{
      const file=this.fileRecord(id);assert(file.segments && file.status==='ready' && !file.lockJobId,'文件暂不可更新',409);
      this.assertFileAccountsIdle(file);
      file.metadata=metadata;file.modifiedAt=Date.now();this.saveFile(file);this.recordAudit('更新分段文件元数据',file.path);
      return file;
    });
  }

  updateFile(id: string, patch: { path?: string; starred?: boolean; status?: 'trash' | 'ready' }): DriveFile {
    return this.ctx.storage.transactionSync(() => {
      const file = this.fileRecord(id);
      assert(!file.lockJobId && ['ready','trash','missing'].includes(file.status), '文件正被任务占用', 409);
      this.assertFileAccountsIdle(file);
      if (patch.starred !== undefined) file.starred = patch.starred;
      if (patch.path) {
        const path = normalizePath(patch.path);
        assert(path !== '/' && this.uniquePath(path,id) === path, '目标路径已存在', 409);
        this.ensureFolders(parentPath(path)); file.path = path; file.parent = parentPath(path); file.name = fileName(path); file.modifiedAt = Date.now();
      }
      if (patch.status === 'trash') { file.status = 'trash'; file.deletedAt = Date.now(); }
      if (patch.status === 'ready') {
        assert(file.status !== 'missing', '远端文件缺失，不能恢复', 409);
        file.path = this.uniquePath(file.path,id); file.parent = parentPath(file.path); file.name = fileName(file.path);
        this.ensureFolders(file.parent); file.status = 'ready'; file.deletedAt = null;
      }
      this.saveFile(file); this.recordAudit(patch.status === 'trash' ? '移入回收站' : patch.status === 'ready' ? '恢复文件' : '更新文件', file.path);
      return file;
    });
  }

  private reserve(account: AccountRecord, bucket: Bucket, bytes: number, id: string, refId: string): void {
    const available = this.publicAccount(account).availableBytes;
    assert(account.enabled && account.syncState === 'ready', '账号未启用或容量尚未同步', 409);
    assert(!this.bucketIsLeased(bucket.id),'存储桶设置正在更新，请稍后重试',409);
    assert(bytes <= available, '目标账号剩余容量不足（包含预占容量及安全余量）', 409);
    this.ctx.storage.sql.exec('INSERT INTO reservations VALUES (?,?,?,?,?)', id, account.id, bucket.id, bytes, refId);
  }

  async reserveUpload(input: { path: string; size: number; contentType: string; bucketId?: string; allowSplit?: boolean }): Promise<UploadSession> {
    const session = this.ctx.storage.transactionSync(() => {
      const accounts = this.getAccounts();
      let bucket: Bucket | undefined;
      const plan: {bucket:Bucket;size:number}[] = [];
      if (input.bucketId) bucket = this.bucketRecord(input.bucketId);
      else {
        for (const account of accounts) {
          if (!account.enabled || account.syncState !== 'ready' || account.availableBytes < allocationBytes(input.size)) continue;
          bucket = this.getBuckets(account.id).filter((item) => item.inPool && !item.ignored && item.storageClass === 'Standard' && !this.bucketIsLeased(item.id)).sort((left,right) => left.priority-right.priority)[0];
          if (bucket) break;
        }
      }
      if (bucket) plan.push({bucket,size:input.size});
      else if (input.allowSplit && !input.bucketId && input.size > 0) {
        let remaining = input.size;
        for (const account of accounts) {
          if (!account.enabled || account.syncState !== 'ready' || account.availableBytes <= OBJECT_OVERHEAD) continue;
          const candidate = this.getBuckets(account.id).filter((item)=>item.inPool && !item.ignored && item.storageClass==='Standard' && !this.bucketIsLeased(item.id)).sort((left,right)=>left.priority-right.priority)[0];
          if (!candidate) continue;
          const size = Math.min(remaining,account.availableBytes-OBJECT_OVERHEAD);
          plan.push({bucket:candidate,size}); remaining-=size;
          if (!remaining) break;
        }
        assert(remaining===0,'容量池的总可用空间不足，请添加账号、同步容量或释放空间',409);
        assert(plan.length<=MAX_FILE_SEGMENTS,`单文件最多支持 ${MAX_FILE_SEGMENTS} 个跨账号分段`,413);
      }
      assert(plan.length, '没有账号能容纳此文件。可启用跨账号拆分，或添加账号、同步容量及释放空间。', 409);
      const id = crypto.randomUUID();
      const fileId = crypto.randomUUID();
      const path = this.uniquePath(input.path);
      this.ensureFolders(parentPath(path));
      const first = plan[0].bucket;
      const partSize=Math.max(PART_SIZE,Math.ceil(input.size/9999/(5*1024*1024))*(5*1024*1024));
      let offset=0; let firstPartNumber=1;
      const segments: UploadSegment[] = plan.map((entry,index)=>{
        const partCount=Math.ceil(entry.size/partSize);
        const segment: UploadSegment={index,offset,size:entry.size,accountId:entry.bucket.accountId,bucketId:entry.bucket.id,objectKey:plan.length>1 ? `drive/${fileId}/segments/${String(index).padStart(4,'0')}` : `drive/${fileId}/${fileName(path)}`,firstPartNumber,partCount,uploadId:null,etag:null};
        this.reserve(this.accountRecord(entry.bucket.accountId),entry.bucket,allocationBytes(entry.size),plan.length>1 ? `${id}:${index}` : id,id);
        offset+=entry.size; firstPartNumber+=partCount;
        return segment;
      });
      const file: DriveFile = {
        id: fileId, path, name: fileName(path), parent: parentPath(path), accountId: first.accountId, bucketId: first.id,
        objectKey: segments[0].objectKey, size: input.size, etag: '', storageClass: 'Standard', metadata: { contentType: input.contentType },
        status: 'uploading', starred: false, deletedAt: null, createdAt: Date.now(), modifiedAt: Date.now(), lockJobId: null,
      };
      if (plan.length>1) {
        file.segmentCount=segments.length;
        file.segments=segments.map(({index,offset,size,accountId,bucketId,objectKey})=>({index,offset,size,accountId,bucketId,objectKey,etag:'',status:'uploading',storageClass:'Standard'}));
      }
      this.saveFile(file);
      const session: UploadSession = { id, fileId, accountId: first.accountId, bucketId: first.id, objectKey: file.objectKey, path, size: input.size, partSize, uploadId: null, status: 'initializing', expiresAt: Date.now()+UPLOAD_TTL, createdAt: Date.now(),contentType:input.contentType,...(plan.length>1 ? {segments} : {}) };
      this.saveUpload(session);
      return session;
    });
    await this.schedule();
    return session;
  }

  getUpload(id: string): UploadSession {
    const session = this.get<UploadSession>('uploads', id);
    assert(session, '上传会话不存在', 404);
    return session;
  }

  listUploads(): UploadSession[] {
    return this.ctx.storage.sql.exec<JsonRow & {segment_count:number|null}>("SELECT id,json_remove(data,'$.segments') data,json_array_length(data,'$.segments') segment_count FROM uploads WHERE status NOT IN ('completed','cancelled') ORDER BY expires_at LIMIT 200").toArray().map((row) => {
      const session=JSON.parse(row.data) as UploadSession;
      if (row.segment_count) session.segmentCount=row.segment_count;
      return session;
    });
  }

  attachUpload(id: string, uploadId: string | null): UploadSession {
    const session = this.getUpload(id);
    assert(session.status === 'initializing' || session.status === 'uploading', '上传状态已经变更', 409);
    session.uploadId = uploadId; session.status = 'uploading'; this.saveUpload(session); return session;
  }

  claimUploadSegment(id: string, index: number): {segment:UploadSegment;token:string|null} {
    const session=this.getUpload(id);
    assert(session.status==='uploading' && session.expiresAt>Date.now(),'上传会话已过期或已结束',409);
    const segment=session.segments?.[index];assert(segment,'上传分段不存在',404);
    assert(!segment.etag && !segment.cleaned,'上传分段已经结束',409);
    if (segment.uploadId) return {segment,token:null};
    assert((segment.initializingUntil || 0)<Date.now(),'分段正在初始化，请稍后重试',409);
    segment.initToken=crypto.randomUUID();segment.initializingUntil=Date.now()+120_000;
    this.saveUpload(session);
    return {segment,token:segment.initToken};
  }

  attachUploadSegment(id: string, index: number, uploadId: string, token: string): UploadSegment {
    const session=this.getUpload(id);const segment=session.segments?.[index];
    assert(session.status==='uploading' && segment?.initToken===token,'分段初始化状态已经改变',409);
    segment.uploadId=uploadId;delete segment.initToken;delete segment.initializingUntil;
    this.saveUpload(session);return segment;
  }

  releaseUploadSegment(id: string, index: number, token: string): void {
    const session=this.getUpload(id);const segment=session.segments?.[index];
    if (segment?.initToken===token) {delete segment.initToken;delete segment.initializingUntil;this.saveUpload(session);}
  }

  commitUploadSegment(id: string, index: number, actual: {size:number;etag:string}): void {
    this.ctx.storage.transactionSync(()=>{
      const session=this.getUpload(id);const segment=session.segments?.[index];
      assert(segment && actual.size===segment.size && actual.etag,'上传分段长度或校验信息不正确',409);
      assert(session.status==='completing','分段合并状态不正确',409);
      segment.etag=actual.etag;
      const file=this.fileRecord(session.fileId);assert(file.status==='uploading' && file.segments?.[index],'上传文件状态不正确',409);
      file.segments[index].etag=actual.etag;file.segments[index].status='ready';this.saveFile(file);
      session.status='uploading';session.finalizingUntil=0;session.expiresAt=Date.now()+UPLOAD_TTL;this.saveUpload(session);
    });
  }

  async touchUpload(id: string): Promise<UploadSession> {
    const session = this.getUpload(id);
    assert(session.status === 'uploading' && session.expiresAt > Date.now(), '上传会话已过期或已结束', 409);
    session.expiresAt = Date.now()+UPLOAD_TTL; this.saveUpload(session); await this.schedule(); return session;
  }

  beginCompleteUpload(id: string): UploadSession {
    const session = this.getUpload(id);
    assert(session.status === 'uploading' || session.status === 'completed' || session.status === 'completing', '上传会话已经结束或正在清理', 409);
    if (session.status !== 'completed') {
      assert(session.status!=='completing' || (session.finalizingUntil || 0)<Date.now(),'上传正在合并，请稍后刷新',409);
      session.status = 'completing'; session.finalizingUntil=Date.now()+120_000; session.expiresAt = Date.now()+UPLOAD_TTL; this.saveUpload(session);
    }
    return session;
  }

  releaseCompleteUpload(id: string): void {
    const session=this.getUpload(id);
    if (session.status==='completing') {session.status='uploading';session.finalizingUntil=0;this.saveUpload(session);}
  }

  commitUpload(id: string, actual: { size: number; etag: string; metadata: FileMetadata }): DriveFile {
    return this.ctx.storage.transactionSync(() => {
      const session = this.getUpload(id);
      if (session.status === 'completed') return this.fileRecord(session.fileId);
      assert(session.status === 'completing', '上传提交状态无效', 409);
      assert(actual.size === session.size, '实际文件大小与预占大小不符', 409);
      const file = this.fileRecord(session.fileId);
      if (session.segments) {
        assert(session.segments.every((segment)=>segment.etag) && completeSegmentLayout(file),'还有分段未完成合并',409);
        file.etag=this.segmentedEtag(file.segments!);
      } else file.etag=actual.etag;
      file.metadata = actual.metadata; file.status = 'ready'; file.modifiedAt = Date.now();
      this.saveFile(file);
      this.ctx.storage.sql.exec('DELETE FROM reservations WHERE ref_id=?', id);
      session.status = 'completed'; this.saveUpload(session); this.recordAudit('上传完成', file.path); return file;
    });
  }

  async cancelUpload(id: string): Promise<Job> {
    const session = this.getUpload(id);
    assert(session.status !== 'completed', '上传已完成', 409);
    assert(session.status!=='completing' || (session.finalizingUntil || 0)<Date.now(),'上传正在合并，请稍后重试取消',409);
    const jobId = `upload-cleanup-${id}`;
    const existing = this.get<Job>('jobs', jobId);
    if (existing) return existing;
    session.status = 'cancelling'; this.saveUpload(session);
    const payload: JobPayload = { type: 'upload-cleanup', id: jobId, driveId: this.env.DRIVE_ID, sessionId: id };
    const job = this.storeJob(payload, `清理上传 · ${fileName(session.path)}`, session.size, 1);
    await this.launch(payload); return job;
  }

  async cleanupUpload(id: string, segmentIndex=0): Promise<boolean> {
    const session = this.getUpload(id);
    if (session.status === 'cancelled' || session.status === 'completed') return true;
    if (session.segments) {
      const segment=session.segments[segmentIndex];assert(segment,'上传分段不存在',404);
      if (!segment.cleaned) {
        const connection=await this.getConnection(segment.bucketId);
        if (segment.uploadId) {
          try {await s3(connection).send(new AbortMultipartUploadCommand({Bucket:connection.bucket.name,Key:segment.objectKey,UploadId:segment.uploadId}));}
          catch(error) {if (!(error instanceof Error && error.name==='NoSuchUpload')) throw error;}
        }
        const object=await head(connection,segment.objectKey);
        if (object) {
          assert(object.Metadata?.['r2drive-upload-id']===id && object.Metadata?.['r2drive-segment-index']===String(segmentIndex) && (!segment.etag || object.ETag===segment.etag),'分段对象已由其他客户端修改，不能自动清理',409);
          await s3(connection).send(new DeleteObjectCommand({Bucket:connection.bucket.name,Key:segment.objectKey}));
        }
      }
      return this.ctx.storage.transactionSync(()=>{
        const current=this.getUpload(id);assert(current.status!=='completed','上传已完成，不能清理',409);
        current.segments![segmentIndex].cleaned=true;
        this.ctx.storage.sql.exec('DELETE FROM reservations WHERE id=?',`${id}:${segmentIndex}`);
        const done=current.segments!.every((part)=>part.cleaned);
        if (done) {current.status='cancelled';this.deleteFile(current.fileId);this.ctx.storage.sql.exec('DELETE FROM reservations WHERE ref_id=?',id);}
        this.saveUpload(current);return done;
      });
    }
    const connection = await this.getConnection(session.bucketId);
    if (session.uploadId) {
      try { await s3(connection).send(new AbortMultipartUploadCommand({ Bucket: connection.bucket.name, Key: session.objectKey, UploadId: session.uploadId })); }
      catch (error) { if (!(error instanceof Error && error.name === 'NoSuchUpload')) throw error; }
    }
    const object = await head(connection, session.objectKey);
    if (object) {
      assert(object.Metadata?.['r2drive-upload-id'] === id, '检测到其他客户端修改了上传对象，请同步并手动检查', 409);
      await s3(connection).send(new DeleteObjectCommand({ Bucket: connection.bucket.name, Key: session.objectKey }));
    }
    this.ctx.storage.transactionSync(() => {
      const current = this.getUpload(id);
      assert(current.status !== 'completed', '上传已完成，不能清理', 409);
      current.status = 'cancelled'; this.saveUpload(current);
      this.deleteFile(current.fileId);
      this.ctx.storage.sql.exec('DELETE FROM reservations WHERE ref_id=?', current.id);
    });
    return true;
  }

  async startScan(accountId: string): Promise<Job> {
    const payload = this.ctx.storage.transactionSync(() => {
      const account = this.accountRecord(accountId);
      if (account.syncState === 'scanning' && account.syncJobId) {
        const row = this.ctx.storage.sql.exec<{ payload: string }>('SELECT payload FROM jobs WHERE id=?', account.syncJobId).one();
        return JSON.parse(row.payload) as JobPayload;
      }
      assert(this.usage(accountId).reserved === 0 && !this.busySegment(accountId) && !this.ctx.storage.sql.exec('SELECT id FROM files WHERE account_id=? AND lock_job_id IS NOT NULL LIMIT 1', accountId).toArray().length, '账号有上传或迁移任务，请完成后再扫描容量', 409);
      assert(!this.ctx.storage.sql.exec('SELECT b.id FROM buckets b JOIN bucket_leases l ON b.id=l.bucket_id WHERE b.account_id=? AND l.expires_at>?',accountId,Date.now()).toArray().length,'存储桶设置正在更新，请稍后同步容量',409);
      const payload: JobPayload = { type: 'scan', id: crypto.randomUUID(), driveId: this.env.DRIVE_ID, accountId, buckets: this.getBuckets(accountId).filter((bucket) => !bucket.ignored) };
      account.syncState = 'scanning'; account.syncJobId = payload.id; account.lastError = null; this.saveAccount(account);
      this.storeJob(payload, `容量同步 · ${account.name}`, 0, 0);
      return payload;
    });
    await this.launch(payload); return this.getJob(payload.id);
  }

  lookupObject(bucketId: string, key: string): DriveFile | null {
    const segment=this.ctx.storage.sql.exec<{file_id:string}>('SELECT file_id FROM file_segments WHERE bucket_id=? AND object_key=?',bucketId,key).toArray()[0];
    if (segment) return this.fileRecord(segment.file_id);
    const row = this.ctx.storage.sql.exec<JsonRow>('SELECT id,data FROM files WHERE bucket_id=? AND object_key=?', bucketId,key).toArray()[0];
    return row ? JSON.parse(row.data) as DriveFile : null;
  }

  applyScan(jobId: string, bucketId: string, objects: ScannedObject[]): void {
    this.ctx.storage.transactionSync(() => {
      const bucket = this.bucketRecord(bucketId);
      const account = this.accountRecord(bucket.accountId);
      assert(account.syncJobId === jobId && account.syncState === 'scanning', '容量扫描已被替换', 409);
      for (const object of objects) {
        const indexed=this.ctx.storage.sql.exec<{file_id:string;segment_index:number}>('SELECT file_id,segment_index FROM file_segments WHERE bucket_id=? AND object_key=?',bucketId,object.key).toArray()[0];
        if (indexed || object.segment) {this.applyScannedSegment(jobId,bucket,object,indexed);continue;}
        const previous = this.lookupObject(bucketId,object.key);
        let desired: string;
        try { desired = normalizePath(object.logicalPath || '/'+object.key); } catch { desired = joinPath('/导入文件', crypto.randomUUID()); }
        const path = previous && previous.status !== 'missing' ? previous.path : this.uniquePath(desired,previous?.id);
        const isFolderMarker = object.size === 0 && object.key.endsWith('/');
        if (isFolderMarker) this.ensureFolders(desired);
        else this.ensureFolders(parentPath(path));
        const file: DriveFile = {
          id: previous?.id || crypto.randomUUID(), path: isFolderMarker ? this.uniquePath(joinPath('/.r2-folder-markers', `${bucket.id}-${encodeURIComponent(object.key)}`), previous?.id) : path,
          name: fileName(path), parent: parentPath(path), accountId: bucket.accountId, bucketId, objectKey: object.key,
          size: object.size, etag: object.etag, storageClass: object.storageClass, metadata: object.metadata,
          status: previous?.status === 'trash' ? 'trash' : 'ready', starred: previous?.starred || false, deletedAt: previous?.deletedAt || null,
          createdAt: previous?.createdAt || object.modifiedAt, modifiedAt: previous && previous.etag === object.etag ? previous.modifiedAt : object.modifiedAt,
          lockJobId: null, isFolderMarker,
        };
        this.saveFile(file,jobId);
      }
    });
  }

  private applyScannedSegment(jobId: string, bucket: Bucket, object: ScannedObject, indexed?: {file_id:string;segment_index:number}): void {
    const identity=object.segment;
    let file=indexed ? this.fileRecord(indexed.file_id) : this.get<DriveFile>('files',identity!.fileId);
    if (!file) {
      assert(identity && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(identity.fileId),'分段对象的文件标识无效',409);
      const path=normalizePath(object.logicalPath || `/恢复文件/${identity.fileId}`);
      file={id:identity.fileId,path,name:fileName(path),parent:parentPath(path),accountId:bucket.accountId,bucketId:bucket.id,objectKey:object.key,size:identity.logicalSize,etag:'',storageClass:object.storageClass,metadata:{contentType:identity.contentType || 'application/octet-stream'},status:'missing',starred:false,deletedAt:null,createdAt:object.modifiedAt,modifiedAt:object.modifiedAt,lockJobId:null,segments:[],segmentCount:identity.count};
    }
    assert(file.segments && !file.lockJobId && file.status!=='uploading','分段对象与文件索引冲突',409);
    const index=indexed?.segment_index ?? identity!.index;
    let segment=file.segments.find((part)=>part.index===index);
    if (!segment) {
      assert(identity && file.size===identity.logicalSize && file.segmentCount===identity.count,'分段布局与文件索引不符',409);
      segment={index,offset:identity.offset,size:identity.size,accountId:bucket.accountId,bucketId:bucket.id,objectKey:object.key,etag:object.etag,status:'ready',storageClass:object.storageClass};
      file.segments.push(segment);file.segments.sort((left,right)=>left.index-right.index);
    }
    assert(segment.bucketId===bucket.id && segment.objectKey===object.key,'同一文件分段出现在不同存储位置',409);
    segment.etag=object.etag;segment.status='ready';segment.storageClass=object.storageClass;
    if (object.size!==segment.size) segment.actualSize=object.size;else delete segment.actualSize;
    const valid=completeSegmentLayout(file);
    if (valid) {
      if (file.status==='missing') {file.path=this.uniquePath(file.path,file.id);file.parent=parentPath(file.path);file.name=fileName(file.path);this.ensureFolders(file.parent);}
      file.status=file.deletedAt ? 'trash' : 'ready';
      const first=file.segments[0];file.accountId=first.accountId;file.bucketId=first.bucketId;file.objectKey=first.objectKey;
    } else file.status='missing';
    file.etag=this.segmentedEtag(file.segments);file.modifiedAt=Math.max(file.modifiedAt,object.modifiedAt);
    this.saveFile(file);
    this.ctx.storage.sql.exec('UPDATE file_segments SET scan_marker=? WHERE file_id=? AND segment_index=?',jobId,file.id,index);
  }

  async prepareScanBatch(jobId: string, bucketId: string, objects: ScanObject[]): Promise<ScanBatch> {
    assert(objects.length <= 100,'扫描批次过大');
    const bucket = this.bucketRecord(bucketId);
    const account = this.accountRecord(bucket.accountId);
    assert(account.syncJobId === jobId && account.syncState === 'scanning','容量扫描已被替换',409);
    const cachedKeys: string[] = [];
    let cachedBytes = 0;
    let changed = 0;
    for (const object of objects) {
      const row = this.ctx.storage.sql.exec<{id:string;segment_index:number|null;scan_marker:string;size:number;etag:string;status:string;storage_class:string}>(`SELECT file_id id,segment_index,scan_marker,size,etag,status,storage_class FROM file_segments WHERE bucket_id=? AND object_key=? UNION ALL SELECT id,NULL,scan_marker,size,json_extract(data,'$.etag'),status,json_extract(data,'$.storageClass') FROM files WHERE bucket_id=? AND object_key=? AND json_extract(data,'$.segments') IS NULL LIMIT 1`,bucketId,object.key,bucketId,object.key).toArray()[0];
      if (row && row.etag === object.etag && ['ready','trash'].includes(row.status) && row.size === object.size && row.storage_class === object.storageClass) {
        if (row.scan_marker !== jobId) {
          if (row.segment_index===null) this.ctx.storage.sql.exec('UPDATE files SET scan_marker=? WHERE id=?',jobId,row.id);
          else this.ctx.storage.sql.exec('UPDATE file_segments SET scan_marker=? WHERE file_id=? AND segment_index=?',jobId,row.id,row.segment_index);
        }
        cachedKeys.push(object.key); cachedBytes+=object.size;
      } else {
        if (changed >= 6) break;
        changed++;
      }
    }
    const connection = await this.getConnection(bucketId);
    return {connection,cachedKeys,cachedCount:cachedKeys.length,cachedBytes};
  }

  commitScanBatch(jobId: string, bucketId: string, objects: ScannedObject[], progress: {count:number;bytes:number}): void {
    this.ctx.storage.transactionSync(() => {
      this.applyScan(jobId,bucketId,objects);
      this.reportJob(jobId,{doneItems:progress.count,progressBytes:progress.bytes,totalItems:progress.count,totalBytes:progress.bytes,error:null});
    });
  }

  finishScan(jobId: string, accountId: string, coverage: 'account' | 'selected', accountMetricBytes: number | null, pendingBytes = 0): void {
    this.ctx.storage.transactionSync(() => {
      const account = this.accountRecord(accountId);
      assert(account.syncJobId === jobId, '扫描任务无效', 409);
      const missing = this.ctx.storage.sql.exec<JsonRow>("SELECT id,data FROM files WHERE account_id=? AND scan_marker != ? AND status != 'missing' AND json_extract(data,'$.segments') IS NULL", accountId,jobId).toArray();
      for (const row of missing) { const file = JSON.parse(row.data) as DriveFile; file.status = 'missing'; this.saveFile(file); }
      const missingSegments=this.ctx.storage.sql.exec<{file_id:string;segment_index:number}>("SELECT file_id,segment_index FROM file_segments WHERE account_id=? AND scan_marker!=? AND status!='missing'",accountId,jobId).toArray();
      for (const row of missingSegments) {
        const file=this.fileRecord(row.file_id);const segment=file.segments!.find((part)=>part.index===row.segment_index)!;
        segment.status='missing';file.status='missing';this.saveFile(file);
      }
      const { used } = this.usage(accountId);
      account.observedExternalBytes = Math.max(pendingBytes,accountMetricBytes === null ? 0 : accountMetricBytes-used);
      account.syncState = 'ready'; account.syncCoverage = coverage; account.syncJobId = null; account.lastSyncedAt = Date.now(); account.lastError = null;
      this.saveAccount(account); this.recordAudit('容量同步完成', account.name);
    });
  }

  async startTransfer(input: TransferInput): Promise<Job> {
    const payload = this.ctx.storage.transactionSync(() => {
      const target = this.bucketRecord(input.targetBucketId);
      const account = this.accountRecord(target.accountId);
      assert(account.syncState === 'ready', '目标账号需要先完成容量同步', 409);
      assert(this.ctx.storage.sql.exec("SELECT id FROM jobs WHERE status IN ('queued','running') AND json_extract(data,'$.type')='transfer'").toArray().length < 3, '已有 3 个传输任务正在运行，请等待完成后再创建新任务',409);
      const id = crypto.randomUUID();
      const items: TransferItem[] = [];
      let payloadBytes=0;
      for (const sourceId of [...new Set(input.fileIds)]) {
        const source = this.fileRecord(sourceId);
        assert(source.status === 'ready' && !source.lockJobId, '文件正被占用或不在可用状态', 409);
        this.assertFileAccountsIdle(source);
        assert(!source.segments || completeSegmentLayout(source),'源文件分段不完整',409);
        const targetFileId = input.mode === 'move' ? source.id : crypto.randomUUID();
        const reservationId = `${id}:${items.length}`;
        const desiredPath = input.targetParent ? joinPath(input.targetParent,source.name) : source.path;
        const targetPath = input.mode === 'move' && desiredPath === source.path ? source.path : this.uniquePath(desiredPath, input.mode === 'move' ? source.id : undefined);
        const targetKey = input.targetKey || `drive/${crypto.randomUUID()}/${fileName(targetPath)}`;
        assert(!(source.bucketId === target.id && source.objectKey === targetKey), '目标对象键与源对象键相同');
        assert(!this.lookupObject(target.id,targetKey), '目标对象键已经存在', 409);
        this.reserve(account,target,allocationBytes(source.size),reservationId,id);
        if (targetPath !== source.path || input.mode === 'copy') this.ctx.storage.sql.exec('INSERT INTO reserved_paths VALUES (?,?,?)',targetPath,id,reservationId);
        this.ensureFolders(parentPath(targetPath));
        source.status = 'busy'; source.lockJobId = id; this.saveFile(source);
        items.push({ source: { ...source, status: 'ready', lockJobId: null }, targetFileId, targetBucketId: target.id, targetKey, targetPath, reservationId, mode: input.mode, metadata: input.metadata, storageClass: input.storageClass });
        payloadBytes+=JSON.stringify(items[items.length-1]).length;
        assert(payloadBytes<1_400_000,'批量任务元数据过大，请减少一次选择的文件数',413);
      }
      const payload: JobPayload = { type: 'transfer', id, driveId: this.env.DRIVE_ID, items };
      assert(JSON.stringify(payload).length < 1_500_000, '批量任务元数据过大，请减少一次选择的文件数');
      this.storeJob(payload, `${input.mode === 'move' ? '迁移' : '复制'} ${items.length} 个文件 → ${target.name}`, items.reduce((sum,item) => sum+item.source.size,0),items.length);
      this.recordAudit('创建传输任务', id); return payload;
    });
    await this.launch(payload); return this.getJob(payload.id);
  }

  commitTransfer(jobId: string, index: number, item: TransferItem, result: { etag: string; metadata: FileMetadata }): Receipt {
    return this.ctx.storage.transactionSync(() => {
      const receiptId = `${jobId}:${index}`;
      const existing = this.get<Receipt>('receipts',receiptId);
      if (existing) return existing;
      const source = this.fileRecord(item.source.id);
      assert(source.lockJobId === jobId && source.bucketId === item.source.bucketId && source.objectKey === item.source.objectKey, '源文件位置已变更', 409);
      const bucket = this.bucketRecord(item.targetBucketId);
      const target: DriveFile = { ...source, segments:undefined,segmentCount:undefined,id: item.targetFileId, path: item.targetPath, parent: parentPath(item.targetPath), name: fileName(item.targetPath), accountId: bucket.accountId, bucketId: bucket.id, objectKey: item.targetKey, etag: result.etag, metadata: result.metadata, storageClass: item.storageClass || 'Standard', modifiedAt: Date.now(), status: item.mode === 'move' ? 'busy' : 'ready', lockJobId: item.mode === 'move' ? jobId : null };
      if (item.mode === 'copy') { source.status = 'ready'; source.lockJobId = null; this.saveFile(source); }
      this.saveFile(target);
      this.ctx.storage.sql.exec('DELETE FROM reserved_paths WHERE ref_id=?',item.reservationId);
      this.ctx.storage.sql.exec('DELETE FROM reservations WHERE id=?',item.reservationId);
      if (item.mode === 'move') for (const segment of fileSegments(item.source)) this.ctx.storage.sql.exec('INSERT INTO reservations VALUES (?,?,?,?,?)',item.source.segments ? `source:${receiptId}:${segment.index}` : `source:${receiptId}`,segment.accountId,segment.bucketId,allocationBytes(segment.size),jobId);
      const receipt: Receipt = { state: item.mode === 'copy' ? 'done' : 'committed', fileId: target.id, source: item.source,target,mode: item.mode };
      this.ctx.storage.sql.exec('INSERT INTO receipts VALUES (?,?)',receiptId,JSON.stringify(receipt));
      return receipt;
    });
  }

  preserveTransferSource(jobId: string, index: number, actual: { size:number;etag:string;metadata:FileMetadata }): void {
    this.ctx.storage.transactionSync(() => {
      const receiptId = `${jobId}:${index}`;
      const receipt = this.get<Receipt>('receipts',receiptId);
      assert(receipt,'迁移提交记录不存在',409);
      if (receipt.state === 'done') return;
      if (!this.lookupObject(receipt.source.bucketId,receipt.source.objectKey)) {
        const path = this.uniquePath(joinPath(receipt.source.parent,`源副本-${receipt.source.name}`));
        this.ensureFolders(parentPath(path));
        this.saveFile({ ...receipt.source,id:crypto.randomUUID(),path,parent:parentPath(path),name:fileName(path),size:actual.size,etag:actual.etag,metadata:actual.metadata,status:'ready',lockJobId:null });
      }
      this.ctx.storage.sql.exec('DELETE FROM reservations WHERE id=?',`source:${receiptId}`);
      const file = this.fileRecord(receipt.fileId); file.status='ready'; file.lockJobId=null; this.saveFile(file);
      receipt.state='done'; this.ctx.storage.sql.exec('UPDATE receipts SET data=? WHERE id=?',JSON.stringify(receipt),receiptId);
      this.recordAudit('迁移取消并保留源副本',receipt.source.path);
    });
  }

  getTransferReceipt(jobId: string, index: number): Receipt | null { return this.get<Receipt>('receipts',`${jobId}:${index}`); }

  commitTransferSourceSegment(jobId: string, index: number, segmentIndex: number): void {
    this.ctx.storage.transactionSync(()=>{
      const receiptId=`${jobId}:${index}`;const receipt=this.get<Receipt>('receipts',receiptId);
      assert(receipt && receipt.state==='committed' && receipt.source.segments?.some((segment)=>segment.index===segmentIndex),'迁移源分段记录不存在',409);
      receipt.deletedSourceSegments ||= [];
      if (!receipt.deletedSourceSegments.includes(segmentIndex)) receipt.deletedSourceSegments.push(segmentIndex);
      this.ctx.storage.sql.exec('UPDATE receipts SET data=? WHERE id=?',JSON.stringify(receipt),receiptId);
      this.ctx.storage.sql.exec('DELETE FROM reservations WHERE id=?',`source:${receiptId}:${segmentIndex}`);
    });
  }

  finishTransferSource(jobId: string, index: number): void {
    this.ctx.storage.transactionSync(() => {
      const receiptId = `${jobId}:${index}`;
      const receipt = this.get<Receipt>('receipts',receiptId);
      assert(receipt, '迁移提交记录不存在', 409);
      if (receipt.state === 'done') return;
      const file = this.fileRecord(receipt.fileId);
      file.status = 'ready'; file.lockJobId = null; this.saveFile(file);
      this.ctx.storage.sql.exec('DELETE FROM reservations WHERE id=?',`source:${receiptId}`);
      for (const segment of receipt.source.segments || []) this.ctx.storage.sql.exec('DELETE FROM reservations WHERE id=?',`source:${receiptId}:${segment.index}`);
      receipt.state = 'done'; this.ctx.storage.sql.exec('UPDATE receipts SET data=? WHERE id=?',JSON.stringify(receipt),receiptId);
      this.recordAudit('文件迁移完成', file.path);
    });
  }

  releaseTransferItem(jobId: string, item: TransferItem): void {
    this.ctx.storage.transactionSync(() => {
      const source = this.get<DriveFile>('files',item.source.id);
      if (source?.lockJobId === jobId && source.objectKey === item.source.objectKey && source.bucketId === item.source.bucketId) { source.status = 'ready'; source.lockJobId = null; this.saveFile(source); }
      this.ctx.storage.sql.exec('DELETE FROM reservations WHERE id=?',item.reservationId);
      this.ctx.storage.sql.exec('DELETE FROM reserved_paths WHERE ref_id=?',item.reservationId);
    });
  }

  async startDelete(ids: string[]): Promise<Job> {
    const payload = this.ctx.storage.transactionSync(() => {
      const id = crypto.randomUUID();
      const files:DriveFile[]=[];let payloadBytes=0;
      for (const fileId of new Set(ids)) {
        const file=this.fileRecord(fileId);payloadBytes+=JSON.stringify(file).length;
        assert(payloadBytes<1_400_000,'批量删除元数据过大，请减少一次选择的文件数',413);
        assert(!file.lockJobId && file.status !== 'uploading', '文件被未完成任务占用',409);
        this.assertFileAccountsIdle(file);
        file.lockJobId = id; file.status = 'busy'; this.saveFile(file);
        files.push(file);
      }
      const payload: JobPayload = { type: 'delete',id,driveId: this.env.DRIVE_ID,files };
      assert(JSON.stringify(payload).length<1_500_000,'批量删除元数据过大，请减少一次选择的文件数',413);
      this.storeJob(payload,`永久删除 ${files.length} 个文件`,files.reduce((sum,file) => sum+file.size,0),files.length); return payload;
    });
    await this.launch(payload); return this.getJob(payload.id);
  }

  commitDelete(jobId: string, fileId: string): void {
    this.ctx.storage.transactionSync(() => {
      const file = this.get<DriveFile>('files',fileId);
      if (!file) return;
      assert(file.lockJobId === jobId, '文件删除任务不匹配',409);
      this.ctx.storage.sql.exec('DELETE FROM shares WHERE file_id=?',fileId);
      this.deleteFile(fileId);
      this.recordAudit('永久删除文件',file.path);
    });
  }

  deleteFilePending(jobId: string, fileId: string): boolean {
    const row=this.ctx.storage.sql.exec<{lock_job_id:string|null}>('SELECT lock_job_id FROM files WHERE id=?',fileId).toArray()[0];
    if (!row) return false;
    assert(row.lock_job_id===jobId,'文件删除任务不匹配',409);return true;
  }

  commitDeleteSegment(jobId: string, fileId: string, index: number): void {
    this.ctx.storage.transactionSync(()=>{
      const file=this.fileRecord(fileId);assert(file.lockJobId===jobId && file.segments?.some((part)=>part.index===index),'文件删除分段不匹配',409);
      file.segments!.find((part)=>part.index===index)!.status='missing';this.saveFile(file);
    });
  }

  releaseDelete(jobId: string, file: DriveFile): void {
    const current = this.get<DriveFile>('files',file.id);
    if (current?.lockJobId === jobId) { current.lockJobId = null; current.status = current.segments && !completeSegmentLayout(current) ? 'missing' : current.deletedAt ? 'trash' : 'ready'; this.saveFile(current); }
  }

  private storeJob(payload: JobPayload, title: string, totalBytes: number, totalItems: number): Job {
    const job: Job = { id: payload.id,type: payload.type,title,status:'queued',progressBytes:0,totalBytes,doneItems:0,totalItems,error:null,createdAt:Date.now(),updatedAt:Date.now() };
    this.ctx.storage.sql.exec('INSERT INTO jobs VALUES (?,?,?,?,?)',job.id,job.status,job.createdAt,JSON.stringify(job),JSON.stringify(payload)); return job;
  }

  private async launch(payload: JobPayload): Promise<void> {
    try { await this.env.JOBS.getByName(`${payload.driveId}:${payload.id}`).init(payload); }
    catch (error) { this.reportJob(payload.id,{ status: 'failed',error: `任务启动失败，可点击重试：${errorMessage(error)}` }); }
    await this.schedule();
  }

  getJob(id: string): Job {
    const job = this.get<Job>('jobs',id); assert(job,'任务不存在',404); return job;
  }

  listJobs(limit = 100): Job[] {
    return this.ctx.storage.sql.exec<JsonRow>('SELECT id,data FROM jobs ORDER BY created_at DESC LIMIT ?',Math.min(Math.max(limit,1),200)).toArray().map((row) => JSON.parse(row.data) as Job);
  }

  clearFinishedJobs(): number {
    const rows = this.ctx.storage.sql.exec<{ id: string }>("SELECT id FROM jobs WHERE status IN ('completed','cancelled','failed')").toArray();
    if (!rows.length) return 0;
    this.ctx.storage.sql.exec("DELETE FROM jobs WHERE status IN ('completed','cancelled','failed')");
    return rows.length;
  }

  reportJob(id: string, patch: Partial<Pick<Job,'status' | 'progressBytes' | 'totalBytes' | 'doneItems' | 'totalItems' | 'error'>>): Job {
    const job = { ...this.getJob(id),...patch,updatedAt:Date.now() };
    this.ctx.storage.sql.exec('UPDATE jobs SET status=?,data=? WHERE id=?',job.status,JSON.stringify(job),id);
    if (job.type === 'scan' && ['failed','cancelled'].includes(job.status)) {
      const row = this.ctx.storage.sql.exec<{ payload:string }>('SELECT payload FROM jobs WHERE id=?',id).one();
      const payload = JSON.parse(row.payload) as Extract<JobPayload,{type:'scan'}>;
      const account = this.accountRecord(payload.accountId);
      if (account.syncJobId === id) { account.syncState = 'error'; account.lastError = patch.error || '容量扫描被中止，请重新扫描'; this.saveAccount(account); }
    }
    return job;
  }

  async controlJob(id: string, action: 'pause' | 'resume' | 'cancel'): Promise<Job> {
    const job = this.getJob(id);
    assert(!['completed','cancelled'].includes(job.status),'任务已经结束',409);
    const payload = JSON.parse(this.ctx.storage.sql.exec<{payload:string}>('SELECT payload FROM jobs WHERE id=?',id).one().payload) as JobPayload;
    if (action === 'resume' && payload.type === 'scan') {
      const account = this.accountRecord(payload.accountId);
      assert(account.syncJobId === id,'扫描已被新任务替代',409);
      assert(this.usage(account.id).reserved===0 && !this.busySegment(account.id) && !this.ctx.storage.sql.exec('SELECT id FROM files WHERE account_id=? AND lock_job_id IS NOT NULL LIMIT 1',account.id).toArray().length,'账号有未完成上传或迁移，不能恢复扫描',409);
      account.syncState = 'scanning'; account.lastError = null; this.saveAccount(account);
    }
    await this.env.JOBS.getByName(`${this.env.DRIVE_ID}:${id}`).init(payload);
    await this.env.JOBS.getByName(`${this.env.DRIVE_ID}:${id}`).control(action);
    await this.schedule(); return this.getJob(id);
  }

  async createShare(fileId: string, input: { expiresIn: number; password?: string; maxDownloads?: number }): Promise<Share> {
    const file = this.getDownloadFile(fileId);
    assert(file.status === 'ready' || file.status === 'busy','文件不在可分享状态',409);
    const id = crypto.randomUUID(); const salt = crypto.randomUUID();
    const share: ShareRecord = { id,fileId,fileName:file.name,expiresAt:Date.now()+input.expiresIn*1000,hasPassword:Boolean(input.password),passwordHash:input.password ? await sha256(`${salt}:${input.password}`) : null,passwordSalt:salt,downloads:0,maxDownloads:input.maxDownloads || null,createdAt:Date.now() };
    this.ctx.storage.sql.exec('INSERT INTO shares VALUES (?,?,?,?)',id,fileId,share.expiresAt,JSON.stringify(share)); this.recordAudit('创建分享',file.path);
    const { passwordHash:_hash,passwordSalt:_salt,...publicShare } = share; return publicShare;
  }

  listShares(): Share[] {
    return this.ctx.storage.sql.exec<JsonRow>('SELECT id,data FROM shares ORDER BY expires_at DESC LIMIT 200').toArray().map((row) => { const { passwordHash:_hash,passwordSalt:_salt,...share } = JSON.parse(row.data) as ShareRecord; return share; });
  }

  removeShare(id: string): void { this.ctx.storage.sql.exec('DELETE FROM shares WHERE id=?',id); this.recordAudit('撤销分享',id); }

  getPublicShare(id: string): { name: string; size: number; contentType: string; expiresAt: number; hasPassword: boolean; segmented: boolean } {
    const share = this.get<ShareRecord>('shares',id); assert(share && share.expiresAt > Date.now(),'分享不存在或已过期',404);
    assert(share.maxDownloads === null || share.downloads < share.maxDownloads,'分享访问次数已用完',410);
    const file = this.getDownloadFile(share.fileId);
    return { name:file.name,size:file.size,contentType:file.metadata.contentType,expiresAt:share.expiresAt,hasPassword:share.hasPassword,segmented:Boolean(file.segments) };
  }

  async redeemShare(id: string, password: string): Promise<DriveFile> {
    const share = this.get<ShareRecord>('shares',id); assert(share && share.expiresAt > Date.now(),'分享不存在或已过期',404);
    if (share.passwordHash) assert(await safeEqual(await sha256(`${share.passwordSalt}:${password}`),share.passwordHash),'提取码错误',403);
    return this.ctx.storage.transactionSync(() => {
      const current = this.get<ShareRecord>('shares',id); assert(current && current.expiresAt > Date.now(),'分享已过期',404);
      assert(current.maxDownloads === null || current.downloads < current.maxDownloads,'分享访问次数已用完',410);
      const file = this.getDownloadFile(current.fileId);
      current.downloads++; this.ctx.storage.sql.exec('UPDATE shares SET data=? WHERE id=?',JSON.stringify(current),id); return file;
    });
  }

  rateLimit(key: string, limit: number, windowMs: number): boolean {
    const now = Date.now();
    const row = this.ctx.storage.sql.exec<{count:number;expires_at:number}>('SELECT count,expires_at FROM rate_limits WHERE key=?',key).toArray()[0];
    if (!row || row.expires_at <= now) { this.ctx.storage.sql.exec('INSERT INTO rate_limits VALUES (?,1,?) ON CONFLICT(key) DO UPDATE SET count=1,expires_at=excluded.expires_at',key,now+windowMs); return true; }
    if (row.count >= limit) return false;
    this.ctx.storage.sql.exec('UPDATE rate_limits SET count=count+1 WHERE key=?',key); return true;
  }

  getAdminState(): { initialized: boolean; username: string } {
    const row = this.ctx.storage.sql.exec<{username:string}>('SELECT username FROM admin WHERE id=1').toArray()[0];
    return { initialized: Boolean(row), username: row?.username || '' };
  }

  getAdminCredentials(): { username: string; passwordHash: string } | null {
    const row = this.ctx.storage.sql.exec<{username:string;password_hash:string}>('SELECT username,password_hash FROM admin WHERE id=1').toArray()[0];
    return row ? { username: row.username, passwordHash: row.password_hash } : null;
  }

  async setupAdmin(username: string, password: string): Promise<void> {
    assert(!this.getAdminState().initialized,'管理员已初始化',409);
    const salt = crypto.randomUUID();
    const passwordHash = await sha256(`${password}:${salt}`);
    this.ctx.storage.sql.exec('INSERT INTO admin VALUES (1,?,?,?,?)',username,passwordHash,salt,Date.now());
  }

  async verifyAdmin(username: string, password: string): Promise<boolean> {
    const row = this.ctx.storage.sql.exec<{username:string;password_hash:string;password_salt:string}>('SELECT username,password_hash,password_salt FROM admin WHERE id=1').toArray()[0];
    if (!row) return false;
    if (row.username !== username) return false;
    const passwordHash = await sha256(`${password}:${row.password_salt}`);
    return safeEqual(passwordHash, row.password_hash);
  }

  async changePassword(username: string, oldPassword: string, newPassword: string): Promise<void> {
    const row = this.ctx.storage.sql.exec<{username:string;password_hash:string;password_salt:string}>('SELECT username,password_hash,password_salt FROM admin WHERE id=1').toArray()[0];
    assert(row,'管理员尚未初始化',409);
    assert(row.username === username,'用户名不匹配',403);
    const oldHash = await sha256(`${oldPassword}:${row.password_salt}`);
    assert(await safeEqual(oldHash, row.password_hash),'当前密码不正确',401);
    const salt = crypto.randomUUID();
    const newHash = await sha256(`${newPassword}:${salt}`);
    this.ctx.storage.sql.exec('UPDATE admin SET password_hash=?,password_salt=? WHERE id=1',newHash,salt);
  }

  getAudit(): AuditEntry[] { return this.ctx.storage.sql.exec<{id:number;action:string;detail:string;created_at:number}>('SELECT * FROM audit ORDER BY id DESC LIMIT 200').toArray().map((row) => ({id:row.id,action:row.action,detail:row.detail,createdAt:row.created_at})); }

  private hasActiveJobs(): boolean {
    return this.ctx.storage.sql.exec("SELECT id FROM jobs WHERE status IN ('queued','running') LIMIT 1").toArray().length > 0;
  }

  status(): DriveStatus {
    return { accounts:this.getAccounts(),buckets:this.getBuckets(),jobs:this.listJobs(),uploads:this.listUploads(),hasActiveJobs:this.hasActiveJobs() };
  }

  dashboard(): Dashboard {
    const accounts = this.getAccounts(); const buckets = this.getBuckets();
    const totals = this.ctx.storage.sql.exec<{count:number;trash:number}>("SELECT COUNT(CASE WHEN status IN ('ready','busy') AND COALESCE(json_extract(data,'$.isFolderMarker'),0)=0 THEN 1 END) count,COALESCE(SUM(CASE WHEN status='trash' THEN size ELSE 0 END),0) trash FROM files").one();
    const kinds = this.ctx.storage.sql.exec<{ name:string;bytes:number;count:number }>("SELECT json_extract(data,'$.name') name,SUM(size) bytes,COUNT(*) count FROM files WHERE status IN ('ready','busy') GROUP BY lower(substr(json_extract(data,'$.name'),instr(json_extract(data,'$.name'),'.'))) LIMIT 1000").toArray();
    const grouped = new Map<string,{type:string;bytes:number;count:number}>();
    for (const item of kinds) { const type = fileKind(item.name); const previous = grouped.get(type) || {type,bytes:0,count:0}; previous.bytes+=item.bytes; previous.count+=item.count; grouped.set(type,previous); }
    return {
      accounts,buckets,uploads:this.listUploads(),hasActiveJobs:this.hasActiveJobs(),filesCount:totals.count,trashBytes:totals.trash,
      totalBytes:accounts.reduce((sum,item) => sum+item.quotaBytes,0),usedBytes:accounts.reduce((sum,item) => sum+item.usedBytes,0),
      reservedBytes:accounts.reduce((sum,item) => sum+item.reservedBytes,0),availableBytes:accounts.reduce((sum,item) => sum+item.availableBytes,0),
      jobs:this.listJobs(),recent:this.listFiles({view:'recent',pageSize:6}).files,fileTypes:[...grouped.values()],
    };
  }

  exportManifest(page = 1): { accounts: Account[]; buckets: Bucket[]; files: FileList; exportedAt: number } {
    const files=this.ctx.storage.sql.exec<JsonRow>('SELECT id,data FROM files ORDER BY id LIMIT 200 OFFSET ?',(Math.max(page,1)-1)*200).toArray().map((row) => JSON.parse(row.data) as DriveFile);
    const total=this.ctx.storage.sql.exec<{count:number}>('SELECT COUNT(*) count FROM files').one().count;
    return { accounts:this.getAccounts(),buckets:this.getBuckets(),files:{files,folders:[],total,page,pageSize:200},exportedAt:Date.now() };
  }

  private async schedule(): Promise<void> {
    const activeUploads = this.ctx.storage.sql.exec<{time:number}>('SELECT MIN(expires_at) time FROM uploads WHERE status NOT IN (\'completed\',\'cancelled\',\'cancelling\')').one().time;
    const hasQueued = this.ctx.storage.sql.exec('SELECT id FROM jobs WHERE status=\'queued\' LIMIT 1').toArray().length > 0;
    const now = Date.now();
    const target = Math.min(activeUploads || now+24*60*60*1000,hasQueued ? now+60_000 : now+24*60*60*1000);
    const previous = await this.ctx.storage.getAlarm();
    if (previous === null || previous > target) await this.ctx.storage.setAlarm(Math.max(now+1000,target));
  }

  async alarm(): Promise<void> {
    const expired = this.ctx.storage.sql.exec<JsonRow>("SELECT id,data FROM uploads WHERE expires_at <= ? AND status NOT IN ('completed','cancelled','cancelling') LIMIT 10",Date.now()).toArray();
    for (const row of expired) await this.cancelUpload(row.id);
    const queued = this.ctx.storage.sql.exec<{payload:string}>("SELECT payload FROM jobs WHERE status='queued' LIMIT 10").toArray();
    for (const row of queued) await this.launch(JSON.parse(row.payload) as JobPayload);
    for (const account of this.getAccounts()) {
      if (account.enabled && account.syncState === 'ready' && (account.lastSyncedAt || 0) < Date.now()-24*60*60*1000) {
        try { await this.startScan(account.id); } catch (error) { if (!(error instanceof AppError && error.status === 409)) console.error(JSON.stringify({event:'auto-scan-error',accountId:account.id,error:errorMessage(error)})); }
      }
    }
    this.ctx.storage.sql.exec('DELETE FROM rate_limits WHERE expires_at < ?',Date.now());
    this.ctx.storage.sql.exec('DELETE FROM audit WHERE id NOT IN (SELECT id FROM audit ORDER BY id DESC LIMIT 1000)');
    await this.schedule();
  }
}
