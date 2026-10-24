import {
  S3Client, HeadObjectCommand, HeadBucketCommand, ListPartsCommand,
  type HeadObjectCommandOutput,
} from '@aws-sdk/client-s3';
import { AwsClient } from 'aws4fetch';
import type { Bucket, FileMetadata, Jurisdiction, UploadPart } from '../shared/types';
import { assert, AppError, readBounded } from './errors';
import { sha256 } from './crypto';

export interface AccountSecrets { accessKeyId: string; secretAccessKey: string; apiToken?: string }
export interface Connection { cloudflareAccountId: string; secrets: AccountSecrets; bucket: Bucket }

export function endpoint(accountId: string, jurisdiction: Jurisdiction = 'default'): string {
  const suffix = jurisdiction === 'default' ? '' : `.${jurisdiction}`;
  return `https://${accountId}${suffix}.r2.cloudflarestorage.com`;
}

export function s3(connection: Connection): S3Client {
  return new S3Client({
    region: 'auto', endpoint: endpoint(connection.cloudflareAccountId, connection.bucket.jurisdiction),
    credentials: connection.secrets, forcePathStyle: true, maxAttempts: 3,
    requestChecksumCalculation: 'WHEN_REQUIRED', responseChecksumValidation: 'WHEN_REQUIRED',
  });
}

export async function resolveToken(accountId: string, token: string): Promise<AccountSecrets> {
  for (const path of [`/accounts/${accountId}/tokens/verify`, '/user/tokens/verify']) {
    const response = await fetch(`https://api.cloudflare.com/client/v4${path}`, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(15_000) });
    const result = JSON.parse(await readBounded(response)) as { success: boolean; result?: { id: string; status: string } };
    if (response.ok && result.success && result.result?.status === 'active') {
      return { accessKeyId: result.result.id, secretAccessKey: await sha256(token), apiToken: token };
    }
  }
  throw new AppError(400, '无法验证 R2 Token。可直接填写创建 R2 Token 时给出的 Access Key ID 和 Secret Access Key。');
}

export async function testBucket(connection: Connection): Promise<void> {
  await s3(connection).send(new HeadBucketCommand({ Bucket: connection.bucket.name }));
}

export async function head(connection: Connection, key: string, signal?: AbortSignal): Promise<HeadObjectCommandOutput | null> {
  try { return await s3(connection).send(new HeadObjectCommand({ Bucket: connection.bucket.name, Key: key, ChecksumMode: 'ENABLED' }),signal ? {abortSignal:signal} : {}); }
  catch (error) {
    if (error instanceof Error && ('name' in error) && ['NotFound', 'NoSuchKey', 'NoSuchBucket'].includes(error.name)) return null;
    throw error;
  }
}

export function fromHead(value: HeadObjectCommandOutput): FileMetadata {
  return {
    contentType: value.ContentType || 'application/octet-stream', cacheControl: value.CacheControl,
    contentDisposition: value.ContentDisposition, contentEncoding: value.ContentEncoding,
    contentLanguage: value.ContentLanguage,
    custom: Object.fromEntries(Object.entries(value.Metadata || {}).filter(([key]) => !key.startsWith('r2drive-'))),
  };
}

export function s3Metadata(value: FileMetadata) {
  return {
    ContentType: value.contentType, CacheControl: value.cacheControl || undefined,
    ContentDisposition: value.contentDisposition || undefined, ContentEncoding: value.contentEncoding || undefined,
    ContentLanguage: value.contentLanguage || undefined, Metadata: value.custom,
  };
}

export async function listParts(connection: Connection, key: string, uploadId: string): Promise<UploadPart[]> {
  const parts: UploadPart[] = [];
  let marker: string | undefined;
  do {
    const response = await s3(connection).send(new ListPartsCommand({ Bucket: connection.bucket.name, Key: key, UploadId: uploadId, PartNumberMarker: marker }));
    parts.push(...(response.Parts || []).map((part) => ({ partNumber: part.PartNumber!, etag: part.ETag!, size: part.Size || 0 })));
    marker = response.IsTruncated ? response.NextPartNumberMarker : undefined;
    assert(parts.length <= 10_000, '分片数量超出上限');
  } while (marker);
  return parts.sort((left, right) => left.partNumber - right.partNumber);
}

// Bucket management is account-scoped and dynamic across accounts; no static R2 binding can represent it.
export async function cfEnvelope<T = unknown>(connection: Connection, path: string, method = 'GET', data?: unknown): Promise<{ result: T; result_info?: { cursor?: string; total_count?: number } }> {
  assert(connection.secrets.apiToken, '此功能需要 Cloudflare 管理 API Token（Workers R2 Storage 权限）', 403);
  assert(path.startsWith(`/accounts/${connection.cloudflareAccountId}/`) || path.startsWith('/zones?'), '无效的管理 API 路径');
  const headers = new Headers({ Authorization: `Bearer ${connection.secrets.apiToken}`, 'Content-Type': 'application/json' });
  if (connection.bucket.jurisdiction !== 'default') headers.set('cf-r2-jurisdiction', connection.bucket.jurisdiction);
  const response = await fetch(`https://api.cloudflare.com/client/v4${path}`, { method, headers, body: data === undefined ? undefined : JSON.stringify(data), signal: AbortSignal.timeout(20_000) });
  const text = await readBounded(response, 2 * 1024 * 1024);
  const payload = text ? JSON.parse(text) as { success: boolean; result: T; result_info?: { cursor?: string; total_count?: number }; errors?: { message: string }[] } : { success: response.ok, result: null as T };
  if (!response.ok || payload.success === false) throw new AppError(response.status === 401 || response.status === 403 ? 403 : 502, payload.errors?.map((error) => error.message).join('；') || `Cloudflare API 返回 ${response.status}`);
  return payload;
}

export async function cfApi<T = unknown>(connection: Connection, path: string, method = 'GET', data?: unknown): Promise<T> {
  return (await cfEnvelope<T>(connection,path,method,data)).result;
}

export async function signedFetch(connection: Connection, url: string, init: RequestInit): Promise<Response> {
  const client = new AwsClient({ ...connection.secrets, service: 's3', region: 'auto' });
  // Signing without retries preserves streamed request bodies; the durable job retries a whole part.
  return fetch(await client.sign(url, init));
}
