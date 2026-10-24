import type { Bucket, DriveFile, FileMetadata } from '../shared/types';

export interface ScanObject { key: string; size: number; etag: string; modifiedAt: number; storageClass: 'Standard' | 'InfrequentAccess' }
export interface ScannedObject extends ScanObject { metadata: FileMetadata; logicalPath?: string; segment?: { fileId: string; index: number; offset: number; size: number; logicalSize: number; count: number; contentType?: string } }
export interface ScanBatch {
  connection: import('./r2').Connection;
  cachedKeys: string[];
  cachedCount: number;
  cachedBytes: number;
}

export interface TransferItem {
  source: DriveFile;
  targetFileId: string;
  targetBucketId: string;
  targetKey: string;
  targetPath: string;
  reservationId: string;
  mode: 'move' | 'copy';
  metadata?: FileMetadata;
  storageClass?: 'Standard' | 'InfrequentAccess';
}

export type JobPayload =
  | { type: 'scan'; id: string; driveId: string; accountId: string; buckets: Bucket[] }
  | { type: 'transfer'; id: string; driveId: string; items: TransferItem[] }
  | { type: 'delete'; id: string; driveId: string; files: DriveFile[] }
  | { type: 'upload-cleanup'; id: string; driveId: string; sessionId: string };

export interface StoredPart { partNumber: number; etag: string; size: number; sha256: string }

export interface TransferState {
  phase: 'prepare' | 'upload' | 'complete' | 'verify' | 'commit' | 'delete-source' | 'done';
  uploadId: string | null;
  partSize: number;
  parts: StoredPart[];
  verifyIndex: number;
  targetEtag: string;
  metadata: FileMetadata | null;
  committed: boolean;
  sourceCheckIndex?: number;
  deleteIndex?: number;
}

export interface ScanState {
  phase: 'discover' | 'list' | 'objects' | 'multipart' | 'multipart-parts' | 'finish';
  buckets: Bucket[];
  bucketIndex: number;
  continuation: string | null;
  objects: ScanObject[];
  objectIndex: number;
  count: number;
  bytes: number;
  coverage: 'account' | 'selected';
  pendingUploads: { key: string; uploadId: string }[];
  pendingIndex: number;
  partMarker: string | null;
  pendingBytes: number;
}

export interface JobExecution {
  payload: JobPayload;
  index: number;
  status: 'running' | 'paused' | 'failed' | 'completed' | 'cancelled';
  retries: number;
  cancelRequested: boolean;
  scan: ScanState | null;
  transfer: TransferState | null;
  deleteSegmentIndex?: number;
  cleanupIndex?: number;
}
