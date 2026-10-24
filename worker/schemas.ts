import { z } from 'zod';
import { GB, normalizePath } from '../shared/paths';
import { AppError, readBounded } from './errors';

const bytes = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const jurisdictionSchema = z.enum(['default', 'eu', 'us', 'fedramp']);
export const pathSchema = z.string().min(1).max(1000).transform((path, ctx) => {
  try { return normalizePath(path); } catch (error) {
    ctx.addIssue({ code: 'custom', message: error instanceof Error ? error.message : '路径无效' });
    return z.NEVER;
  }
});
export const bucketNameSchema = z.string().regex(/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/, '存储桶名称需为 3–63 个小写字母、数字、点或连字符');
export const metadataSchema = z.object({
  contentType: z.string().min(1).max(200).default('application/octet-stream'),
  cacheControl: z.string().max(1000).optional(),
  contentDisposition: z.string().max(1000).optional(),
  contentEncoding: z.string().max(200).optional(),
  contentLanguage: z.string().max(200).optional(),
  custom: z.record(z.string().regex(/^[a-z0-9_-]+$/i), z.string().max(2000)).optional(),
}).refine((data) => JSON.stringify(data).length <= 7000, '元数据总长度不能超过 7000 个字符').refine((data) => !Object.keys(data.custom || {}).some((key) => key.toLowerCase().startsWith('r2drive-')), 'r2drive- 是系统保留的元数据前缀').refine((data)=>[data.contentType,data.cacheControl,data.contentDisposition,data.contentEncoding,data.contentLanguage].every((value)=>!value || !/[\r\n\0]/.test(value)),'HTTP 元数据不能包含换行或空字符');

export const accountSchema = z.object({
  name: z.string().trim().min(1).max(80),
  accountId: z.string().regex(/^[a-f0-9]{32}$/i, 'Account ID 应为 32 位十六进制字符'),
  accessKeyId: z.string().trim().max(200).optional(),
  secretAccessKey: z.string().trim().max(500).optional(),
  r2Token: z.string().trim().max(1000).optional(),
  apiToken: z.string().trim().max(1000).optional(),
  quotaBytes: bytes.positive().default(10 * GB),
  safetyBytes: bytes.default(200_000_000),
  externalBytes: bytes.default(0),
  buckets: z.array(z.object({ name: bucketNameSchema, jurisdiction: jurisdictionSchema.default('default'), inPool: z.boolean().default(true) })).max(100).default([]),
}).refine((data) => data.safetyBytes < data.quotaBytes, '安全余量必须小于容量上限')
  .refine((data) => Boolean(data.r2Token || (data.accessKeyId && data.secretAccessKey)), '请填写 R2 Token 或 Access Key ID 和 Secret Access Key');

export const accountPatchSchema = z.object({
  name: z.string().trim().min(1).max(80).optional(),
  enabled: z.boolean().optional(),
  quotaBytes: bytes.positive().optional(),
  safetyBytes: bytes.optional(),
  externalBytes: bytes.optional(),
  accessKeyId: z.string().trim().min(1).max(200).optional(),
  secretAccessKey: z.string().trim().min(1).max(500).optional(),
  apiToken: z.string().trim().max(1000).optional(),
});

export const uploadSchema = z.object({
  path: pathSchema.refine((path) => path !== '/', '请指定文件名'),
  size: bytes.max(5 * 1024 ** 4 - 5 * 1024 ** 3),
  contentType: z.string().max(200).default('application/octet-stream'),
  bucketId: z.string().max(100).optional(),
  allowSplit: z.boolean().default(false),
});

export const transferSchema = z.object({
  fileIds: z.array(z.string().uuid()).min(1).max(200),
  targetBucketId: z.string().uuid(),
  mode: z.enum(['move', 'copy']).default('move'),
  targetParent: pathSchema.optional(),
  targetKey: z.string().min(1).refine((key) => new TextEncoder().encode(key).length <= 1024 && !/[\u0000-\u001f]/.test(key), '对象键无效').optional(),
  metadata: metadataSchema.optional(),
  storageClass: z.enum(['Standard','InfrequentAccess']).optional(),
}).refine((data) => (!data.targetKey && !data.metadata) || data.fileIds.length === 1, '对象键或元数据修改只能选择单个文件');

export async function body<T extends z.ZodType>(request: Request, schema: T): Promise<z.output<T>> {
  let json: unknown;
  try { json = JSON.parse(await readBounded(request)); } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError(400, '请求需要有效的 JSON 数据');
  }
  const result = schema.safeParse(json);
  if (!result.success) throw new AppError(400, result.error.issues.map((issue) => issue.message).join('；'));
  return result.data;
}
