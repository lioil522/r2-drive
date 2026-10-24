import type { DriveFile, FileSegment, UploadSegment, UploadSession } from './types';

export function isSegmented(file: Pick<DriveFile, 'segments' | 'segmentCount'>): boolean {
  return Boolean(file.segments?.length || (file.segmentCount || 0) > 1);
}

export function fileSegments(file: DriveFile): FileSegment[] {
  return file.segments || [{ index: 0, offset: 0, size: file.size, accountId: file.accountId, bucketId: file.bucketId, objectKey: file.objectKey, etag: file.etag, status: file.status === 'missing' ? 'missing' : file.status === 'uploading' ? 'uploading' : 'ready', storageClass: file.storageClass }];
}

export function uploadSegments(session: UploadSession): UploadSegment[] {
  return session.segments || [{ index: 0, offset: 0, size: session.size, accountId: session.accountId, bucketId: session.bucketId, objectKey: session.objectKey, firstPartNumber: 1, partCount: Math.ceil(session.size / session.partSize), uploadId: session.uploadId, etag: null }];
}

export function uploadPart(session: UploadSession, partNumber: number): { segment: UploadSegment; number: number; offset: number; size: number } {
  if (session.size === 0 && partNumber === 0) return { segment: uploadSegments(session)[0], number: 0, offset: 0, size: 0 };
  const segment = uploadSegments(session).find((item) => partNumber >= item.firstPartNumber && partNumber < item.firstPartNumber + item.partCount);
  if (!segment) throw new Error('分片编号不正确');
  const number = partNumber - segment.firstPartNumber + 1;
  const offset = (number - 1) * session.partSize;
  return { segment, number, offset: segment.offset + offset, size: Math.min(session.partSize, segment.size - offset) };
}

export function uploadPartNumbers(session: UploadSession): number[] {
  if (!session.size) return [0];
  return uploadSegments(session).flatMap((segment) => Array.from({ length: segment.partCount }, (_, index) => segment.firstPartNumber + index));
}

export function completeSegmentLayout(file: DriveFile): boolean {
  const segments = fileSegments(file);
  if (segments.length !== (file.segmentCount || segments.length)) return false;
  let offset = 0;
  for (let index = 0; index < segments.length; index++) {
    const segment = segments[index];
    if (segment.index !== index || segment.offset !== offset || segment.status !== 'ready' || (segment.actualSize ?? segment.size) !== segment.size || !segment.etag) return false;
    offset += segment.size;
  }
  return offset === file.size;
}

export function segmentRanges(file: DriveFile, start: number, length: number): { segment: FileSegment; start: number; length: number }[] {
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(length) || start < 0 || length < 0 || start + length > file.size) throw new Error('文件读取范围不正确');
  const end = start + length;
  return fileSegments(file).flatMap((segment) => {
    const from = Math.max(start, segment.offset);
    const to = Math.min(end, segment.offset + segment.size);
    return to > from ? [{ segment, start: from - segment.offset, length: to - from }] : [];
  });
}
