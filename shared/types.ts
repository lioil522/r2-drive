export type Jurisdiction = 'default' | 'eu' | 'us' | 'fedramp';
export type StorageClass = 'Standard' | 'InfrequentAccess';
export type FileStatus = 'ready' | 'uploading' | 'busy' | 'trash' | 'missing';
export type JobStatus = 'queued' | 'running' | 'paused' | 'failed' | 'completed' | 'cancelled';
export type JobType = 'scan' | 'transfer' | 'delete' | 'upload-cleanup';

export interface Account {
  id: string;
  name: string;
  accountId: string;
  priority: number;
  enabled: boolean;
  quotaBytes: number;
  safetyBytes: number;
  externalBytes: number;
  usedBytes: number;
  reservedBytes: number;
  availableBytes: number;
  hasApiToken: boolean;
  accessKeyHint: string;
  syncState: 'pending' | 'scanning' | 'ready' | 'error';
  syncCoverage: 'selected' | 'account';
  syncJobId: string | null;
  lastSyncedAt: number | null;
  lastError: string | null;
  createdAt: number;
}

export interface Bucket {
  id: string;
  accountId: string;
  name: string;
  jurisdiction: Jurisdiction;
  storageClass: StorageClass;
  inPool: boolean;
  ignored: boolean;
  priority: number;
  location: string;
  createdAt: number;
  usedBytes: number;
  objectCount: number;
}

export interface FileMetadata {
  contentType: string;
  cacheControl?: string;
  contentDisposition?: string;
  contentEncoding?: string;
  contentLanguage?: string;
  custom?: Record<string, string>;
}

export interface FileSegment {
  index: number;
  offset: number;
  size: number;
  accountId: string;
  bucketId: string;
  objectKey: string;
  etag: string;
  status: 'uploading' | 'ready' | 'missing';
  storageClass: StorageClass;
  actualSize?: number;
}

export interface DriveFile {
  id: string;
  path: string;
  name: string;
  parent: string;
  accountId: string;
  bucketId: string;
  objectKey: string;
  size: number;
  etag: string;
  storageClass: StorageClass;
  metadata: FileMetadata;
  status: FileStatus;
  starred: boolean;
  deletedAt: number | null;
  createdAt: number;
  modifiedAt: number;
  lockJobId: string | null;
  isFolderMarker?: boolean;
  segments?: FileSegment[];
  segmentCount?: number;
}

export interface Folder {
  id: string;
  name: string;
  path: string;
  parent: string;
  createdAt: number;
}

export interface FileList {
  files: DriveFile[];
  folders: Folder[];
  total: number;
  page: number;
  pageSize: number;
}

export interface ListOptions {
  parent?: string;
  search?: string;
  view?: 'all' | 'recent' | 'starred' | 'trash' | 'missing';
  accountId?: string;
  bucketId?: string;
  page?: number;
  pageSize?: number;
  sort?: 'name' | 'size' | 'modifiedAt';
  direction?: 'asc' | 'desc';
}

export interface UploadSession {
  id: string;
  fileId: string;
  accountId: string;
  bucketId: string;
  objectKey: string;
  path: string;
  size: number;
  partSize: number;
  uploadId: string | null;
  status: 'initializing' | 'uploading' | 'completing' | 'completed' | 'cancelling' | 'cancelled';
  expiresAt: number;
  createdAt: number;
  finalizingUntil?: number;
  segments?: UploadSegment[];
  contentType?: string;
  segmentCount?: number;
}

export interface UploadSegment {
  index: number;
  offset: number;
  size: number;
  accountId: string;
  bucketId: string;
  objectKey: string;
  firstPartNumber: number;
  partCount: number;
  uploadId: string | null;
  etag: string | null;
  initToken?: string;
  initializingUntil?: number;
  cleaned?: boolean;
}

export interface UploadPart {
  partNumber: number;
  etag: string;
  size: number;
}

export interface UploadLink {
  partNumber: number;
  url: string;
  headers: Record<string, string>;
  expiresAt?: number;
}

export interface Job {
  id: string;
  type: JobType;
  title: string;
  status: JobStatus;
  progressBytes: number;
  totalBytes: number;
  doneItems: number;
  totalItems: number;
  error: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface Share {
  id: string;
  fileId: string;
  fileName: string;
  expiresAt: number;
  hasPassword: boolean;
  downloads: number;
  maxDownloads: number | null;
  createdAt: number;
}

export interface AuditEntry {
  id: number;
  action: string;
  detail: string;
  createdAt: number;
}

export interface DriveStatus {
  accounts: Account[];
  buckets: Bucket[];
  jobs: Job[];
  uploads: UploadSession[];
  hasActiveJobs: boolean;
}

export interface Dashboard extends DriveStatus {
  filesCount: number;
  trashBytes: number;
  totalBytes: number;
  usedBytes: number;
  reservedBytes: number;
  availableBytes: number;
  recent: DriveFile[];
  fileTypes: { type: string; bytes: number; count: number }[];
}

export interface FileCheckResult {
  checkedFiles: number;
  changedFiles: number;
  missingFiles: number;
  restoredFiles: number;
  skippedFiles: number;
  errors: {fileId:string;message:string}[];
}

export interface FileRefreshResult extends FileCheckResult {
  list: FileList;
  status: DriveStatus;
}

export interface AccountInput {
  name: string;
  accountId: string;
  accessKeyId?: string;
  secretAccessKey?: string;
  r2Token?: string;
  apiToken?: string;
  quotaBytes: number;
  safetyBytes: number;
  externalBytes: number;
  buckets: { name: string; jurisdiction: Jurisdiction; inPool: boolean }[];
}

export interface TransferInput {
  fileIds: string[];
  targetBucketId: string;
  mode: 'move' | 'copy';
  targetParent?: string;
  targetKey?: string;
  metadata?: FileMetadata;
  storageClass?: StorageClass;
}
