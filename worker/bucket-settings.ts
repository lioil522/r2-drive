import { GetBucketCorsCommand, PutBucketCorsCommand, DeleteBucketCorsCommand, type CORSRule } from '@aws-sdk/client-s3';
import { z } from 'zod';
import { assert, errorStatus, readBounded, AppError } from './errors';
import { cfApi, s3, type Connection } from './r2';

export const corsSchema=z.object({rules:z.array(z.object({
  id:z.string().max(200).optional(),
  allowed:z.object({methods:z.array(z.enum(['GET','PUT','POST','DELETE','HEAD'])).min(1),origins:z.array(z.string().min(1).max(500)).min(1),headers:z.array(z.string().max(200)).optional()}),
  exposeHeaders:z.array(z.string().max(200)).optional(),maxAgeSeconds:z.number().int().min(0).max(86400).optional(),
})).max(100)});
export type CorsConfig=z.infer<typeof corsSchema>;
const age=z.object({type:z.literal('Age'),maxAge:z.number().int().nonnegative()});
const date=z.object({type:z.literal('Date'),date:z.iso.datetime()});
export const lifecycleSchema=z.object({rules:z.array(z.object({
  id:z.string().min(1).max(200),enabled:z.boolean(),conditions:z.object({prefix:z.string().max(1024)}),
  abortMultipartUploadsTransition:z.object({condition:age}).optional(),
  deleteObjectsTransition:z.object({condition:z.union([age,date])}).optional(),
  storageClassTransitions:z.array(z.object({condition:z.union([age,date]),storageClass:z.literal('InfrequentAccess')})).optional(),
})).max(1000)});
export const lockSchema=z.object({rules:z.array(z.object({id:z.string().min(1).max(200),enabled:z.boolean(),prefix:z.string().max(1024).optional(),condition:z.union([z.object({type:z.literal('Age'),maxAgeSeconds:z.number().int().nonnegative()}),date,z.object({type:z.literal('Indefinite')})])})).max(1000)});
export const eventSchema=z.object({rules:z.array(z.object({actions:z.array(z.enum(['PutObject','CopyObject','DeleteObject','CompleteMultipartUpload','LifecycleDeletion'])).min(1),description:z.string().max(500).optional(),prefix:z.string().max(1024).optional(),suffix:z.string().max(1024).optional()})).min(1).max(100)});
export const enabledSchema=z.object({enabled:z.boolean()});
export const domainSchema=z.object({domain:z.string().regex(/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/i,'请填写有效的域名'),zoneId:z.string().regex(/^[a-f0-9]{32}$/i),enabled:z.boolean().default(true),minTLS:z.enum(['1.0','1.1','1.2','1.3']).optional()});

export async function getCors(connection: Connection): Promise<CorsConfig> {
  try {
    const response=await s3(connection).send(new GetBucketCorsCommand({Bucket:connection.bucket.name}));
    return {rules:(response.CORSRules || []).map((rule) => ({id:rule.ID,allowed:{methods:rule.AllowedMethods as CorsConfig['rules'][number]['allowed']['methods'],origins:rule.AllowedOrigins || [],headers:rule.AllowedHeaders},exposeHeaders:rule.ExposeHeaders,maxAgeSeconds:rule.MaxAgeSeconds}))};
  } catch (error) {
    if (error instanceof Error && ['NoSuchCORSConfiguration','NoSuchCORS'].includes(error.name)) return {rules:[]};
    throw error;
  }
}

export async function putCors(connection: Connection, config: CorsConfig): Promise<void> {
  const rules:CORSRule[]=config.rules.map((rule) => ({ID:rule.id,AllowedMethods:rule.allowed.methods,AllowedOrigins:rule.allowed.origins,AllowedHeaders:rule.allowed.headers,ExposeHeaders:rule.exposeHeaders,MaxAgeSeconds:rule.maxAgeSeconds}));
  if (!rules.length) await s3(connection).send(new DeleteBucketCorsCommand({Bucket:connection.bucket.name}));
  else await s3(connection).send(new PutBucketCorsCommand({Bucket:connection.bucket.name,CORSConfiguration:{CORSRules:rules}}));
}

export async function autoCors(connection: Connection, origin: string): Promise<void> {
  const config=await getCors(connection);
  const existing=config.rules.find((rule) => rule.id==='r2-drive');
  if (existing) { if (!existing.allowed.origins.includes(origin)) existing.allowed.origins.push(origin); existing.allowed.methods=['GET','PUT','HEAD']; existing.allowed.headers=['*']; existing.exposeHeaders=['ETag','Content-Length','Content-Range']; }
  else config.rules.push({id:'r2-drive',allowed:{origins:[origin],methods:['GET','PUT','HEAD'],headers:['*']},exposeHeaders:['ETag','Content-Length','Content-Range'],maxAgeSeconds:3600});
  await putCors(connection,config);
}

export async function getBucketSetting(connection: Connection, feature: string): Promise<unknown> {
  if (feature==='cors') return getCors(connection);
  const paths:Record<string,string>={lifecycle:'lifecycle',locks:'lock','managed-domain':'domains/managed','local-uploads':'local-uploads',sippy:'sippy'};
  assert(paths[feature],'此存储桶设置不存在',404);
  try { return redact(await cfApi(connection,`/accounts/${connection.cloudflareAccountId}/r2/buckets/${encodeURIComponent(connection.bucket.name)}/${paths[feature]}`)); }
  catch (error) { if (errorStatus(error)===404 || error instanceof Error && error.name==='NoSuchBucketLifecycleConfiguration') return feature==='lifecycle'||feature==='locks'?{rules:[]}:null; throw error; }
}

export function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value==='object') return Object.fromEntries(Object.entries(value).map(([key,entry]) => [key,/secret|password|token|private.?key|access.?key.?id|credential/i.test(key)?'[已隐藏]':redact(entry)]));
  return value;
}

export async function analytics(connection: Connection): Promise<{storage:unknown;operations:{type:string;count:number}[];classA:number;classB:number;periodStart:string;periodEnd:string;error?:string}> {
  const now=new Date(); const start=new Date(Date.UTC(now.getUTCFullYear(),now.getUTCMonth(),1));
  const storage=await cfApi(connection,`/accounts/${connection.cloudflareAccountId}/r2/metrics`);
  let operations:{type:string;count:number}[]=[]; let error:string|undefined;
  try {
    assert(connection.secrets.apiToken,'此功能需要 Analytics Read 权限',403);
    const response=await fetch('https://api.cloudflare.com/client/v4/graphql',{method:'POST',headers:{Authorization:`Bearer ${connection.secrets.apiToken}`,'Content-Type':'application/json'},signal:AbortSignal.timeout(20_000),body:JSON.stringify({query:'query R2Operations($accountTag: string!, $startDate: Time, $endDate: Time) { viewer { accounts(filter: {accountTag: $accountTag}) { r2OperationsAdaptiveGroups(limit: 1000, filter: {datetime_geq: $startDate, datetime_leq: $endDate}) { sum {requests} dimensions {actionType} } } } }',variables:{accountTag:connection.cloudflareAccountId,startDate:start.toISOString(),endDate:now.toISOString()}})});
    const result=JSON.parse(await readBounded(response)) as {errors?:{message:string}[];data?:{viewer:{accounts:{r2OperationsAdaptiveGroups:{sum:{requests:number};dimensions:{actionType:string}}[]}[]}}};
    if (!response.ok || result.errors?.length) throw new AppError(502,result.errors?.map((entry) => entry.message).join('；') || '统计查询失败');
    operations=result.data?.viewer.accounts[0]?.r2OperationsAdaptiveGroups.map((entry) => ({type:entry.dimensions.actionType,count:entry.sum.requests})) || [];
  } catch (failure) {error=failure instanceof Error?failure.message:'统计查询失败';}
  const a=new Set(['ListBuckets','PutBucket','ListObjects','ListObjectsV1','ListObjectsV2','PutObject','CopyObject','CompleteMultipartUpload','CreateMultipartUpload','UploadPart','UploadPartCopy','ListParts','ListMultipartUploads','PutBucketCors','PutBucketLifecycleConfiguration','LifecycleStorageTierTransition']);
  const b=new Set(['GetObject','HeadObject','HeadBucket','GetBucketCors','GetBucketLifecycleConfiguration','UsageSummary','GetBucketLocation','GetBucketEncryption']);
  return {storage,operations,classA:operations.filter((item)=>a.has(item.type)).reduce((sum,item)=>sum+item.count,0),classB:operations.filter((item)=>b.has(item.type)).reduce((sum,item)=>sum+item.count,0),periodStart:start.toISOString(),periodEnd:now.toISOString(),error};
}
