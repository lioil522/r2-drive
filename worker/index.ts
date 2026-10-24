import { z } from 'zod';
import {
  CreateMultipartUploadCommand, CompleteMultipartUploadCommand, GetObjectCommand,
  PutObjectCommand, UploadPartCommand, DeleteBucketCommand, GetBucketEncryptionCommand, ListMultipartUploadsCommand, AbortMultipartUploadCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { DriveCatalog } from './catalog';
import { BackgroundJob } from './jobs';
import { AppError, assert, errorMessage, errorStatus, readBounded } from './errors';
import { createFileToken, createSession, isAuthenticated, sessionCookie, verifyFileToken } from './crypto';
import { fileResponse } from './content';
import { accountPatchSchema, accountSchema, body, bucketNameSchema, jurisdictionSchema, metadataSchema, pathSchema, transferSchema, uploadSchema } from './schemas';
import { cfApi, fromHead, head, listParts, s3, s3Metadata, testBucket } from './r2';
import { analytics, autoCors, corsSchema, domainSchema, enabledSchema, eventSchema, getBucketSetting, lifecycleSchema, lockSchema, putCors, redact } from './bucket-settings';
import type { DriveFile, ListOptions, UploadLink, UploadSession } from '../shared/types';
import { MAX_FILE_SEGMENTS, MAX_UPLOAD_PARTS, UPLOAD_URL_BATCH, UPLOAD_URL_TTL_SECONDS } from '../shared/paths';
import { uploadPart } from '../shared/segments';

export { DriveCatalog, BackgroundJob };

const idsSchema=z.object({ids:z.array(z.string().uuid()).min(1).max(200)});
const querySchema=z.object({parent:z.string().max(1000).optional(),search:z.string().max(300).optional(),view:z.enum(['all','recent','starred','trash','missing']).optional(),accountId:z.string().uuid().optional(),bucketId:z.string().uuid().optional(),page:z.coerce.number().int().min(1).max(1_000_000).optional(),pageSize:z.coerce.number().int().min(1).max(200).optional(),sort:z.enum(['name','size','modifiedAt']).optional(),direction:z.enum(['asc','desc']).optional()});

function json(value: unknown, status = 200, headers?: HeadersInit): Response {
  return Response.json(value,{status,headers:{'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer',...headers}});
}

function configured(env: Env): boolean {
  return Boolean(env.ENCRYPTION_KEY?.length>=32 && !env.ENCRYPTION_KEY.startsWith('replace-'));
}

const LOOPBACK_HOSTS=['localhost','127.0.0.1','::1'];
// 校验请求来源：生产环境必须同源；本地开发（前端/API 分端口时）允许同一回环地址上的其它端口。
function sameOrigin(request: Request, url: URL): boolean {
  const origin=request.headers.get('Origin');
  if (!origin) return request.headers.get('Sec-Fetch-Site')!=='cross-site';
  if (origin===url.origin) return true;
  if (LOOPBACK_HOSTS.includes(url.hostname)) {
    try { return LOOPBACK_HOSTS.includes(new URL(origin).hostname); }
    catch { return false; }
  }
  return false;
}

async function download(env: Env, file: DriveFile, origin: string, preview=false, expires=300, shareId?: string): Promise<string> {
  if (file.segments) {
    if (preview) return `${origin}/api/files/${encodeURIComponent(file.id)}/content?preview=1`;
    const token=await createFileToken(env,{fileId:file.id,etag:file.etag,expires:Date.now()+expires*1000,preview,...(shareId ? {shareId} : {})});
    return `${origin}/api/files/${encodeURIComponent(file.id)}/content?token=${encodeURIComponent(token)}`;
  }
  const connection=await env.CATALOG.getByName(env.DRIVE_ID).getConnection(file.bucketId);
  return getSignedUrl(s3(connection),new GetObjectCommand({Bucket:connection.bucket.name,Key:file.objectKey,ResponseContentDisposition:`${preview?'inline':'attachment'}; filename*=UTF-8''${encodeURIComponent(file.name)}`}),{expiresIn:expires});
}

async function uploadUrls(env: Env, session: UploadSession, parts: number[]): Promise<UploadLink[]> {
  const catalog=env.CATALOG.getByName(env.DRIVE_ID);
  if (session.segments) {
    const contentType=session.contentType || (await catalog.getFile(session.fileId)).metadata.contentType;
    const mapped=parts.map((number)=>{try{return {global:number,...uploadPart(session,number)};}catch{throw new AppError(400,'分片编号不正确');}});
    const contexts=new Map<number,{connection:Awaited<ReturnType<DriveCatalog['getConnection']>>;uploadId:string}>();
    for (const index of new Set(mapped.map((part)=>part.segment.index))) {
      const claim=await catalog.claimUploadSegment(session.id,index);
      const connection=await catalog.getConnection(claim.segment.bucketId).catch(async(error)=>{if(claim.token)await catalog.releaseUploadSegment(session.id,index,claim.token);throw error;});
      let uploadId=claim.segment.uploadId;
      if (claim.token) {
        try {
          const response=await s3(connection).send(new CreateMultipartUploadCommand({Bucket:connection.bucket.name,Key:claim.segment.objectKey,StorageClass:'STANDARD',ContentType:'application/octet-stream',Metadata:{'r2drive-layout':'segments-v1','r2drive-file-id':session.fileId,'r2drive-upload-id':session.id,'r2drive-path':encodeURIComponent(session.path),'r2drive-segment-index':String(index),'r2drive-segment-offset':String(claim.segment.offset),'r2drive-segment-size':String(claim.segment.size),'r2drive-logical-size':String(session.size),'r2drive-segment-count':String(session.segments.length),'r2drive-content-type':contentType}}));
          assert(response.UploadId,'R2 未返回 Upload ID',502);uploadId=response.UploadId;
          await catalog.attachUploadSegment(session.id,index,uploadId,claim.token);
        } catch(error) {
          if (uploadId) await s3(connection).send(new AbortMultipartUploadCommand({Bucket:connection.bucket.name,Key:claim.segment.objectKey,UploadId:uploadId})).catch(()=>undefined);
          await catalog.releaseUploadSegment(session.id,index,claim.token);throw error;
        }
      }
      assert(uploadId,'上传分段还未初始化',409);contexts.set(index,{connection,uploadId});
    }
    const expiresAt=Date.now()+UPLOAD_URL_TTL_SECONDS*1000;
    return Promise.all(mapped.map(async(part)=>{
      const {connection,uploadId}=contexts.get(part.segment.index)!;
      const command=new UploadPartCommand({Bucket:connection.bucket.name,Key:part.segment.objectKey,UploadId:uploadId,PartNumber:part.number,ContentLength:part.size});
      return {partNumber:part.global,url:await getSignedUrl(s3(connection),command,{expiresIn:UPLOAD_URL_TTL_SECONDS,signableHeaders:new Set(['content-length'])}),headers:{},expiresAt};
    }));
  }
  const connection=await catalog.getConnection(session.bucketId);
  const client=s3(connection);
  const expiresAt=Date.now()+UPLOAD_URL_TTL_SECONDS*1000;
  if (session.size===0) {
    const file=await catalog.getFile(session.fileId);
    assert(parts.length===1 && parts[0]===0,'空文件分片编号不正确');
    assert(!session.uploadId,'空文件上传状态无效',409);
    const command=new PutObjectCommand({Bucket:connection.bucket.name,Key:session.objectKey,ContentLength:0,ContentType:file.metadata.contentType,IfNoneMatch:'*',StorageClass:'STANDARD',Metadata:{'r2drive-path':encodeURIComponent(session.path),'r2drive-file-id':session.fileId,'r2drive-upload-id':session.id}});
    return [{partNumber:0,url:await getSignedUrl(client,command,{expiresIn:UPLOAD_URL_TTL_SECONDS,signableHeaders:new Set(['content-length','content-type'])}),headers:{'Content-Type':file.metadata.contentType,'If-None-Match':'*'},expiresAt}];
  }
  assert(session.uploadId,'上传还未初始化',409);
  const count=Math.ceil(session.size/session.partSize);
  return Promise.all(parts.map(async (partNumber) => {
    assert(partNumber>=1 && partNumber<=count,'分片编号不正确');
    const size=Math.min(session.partSize,session.size-(partNumber-1)*session.partSize);
    const command=new UploadPartCommand({Bucket:connection.bucket.name,Key:session.objectKey,UploadId:session.uploadId!,PartNumber:partNumber,ContentLength:size});
    return {partNumber,url:await getSignedUrl(client,command,{expiresIn:UPLOAD_URL_TTL_SECONDS,signableHeaders:new Set(['content-length'])}),headers:{},expiresAt};
  }));
}

async function completeUpload(env: Env, id: string): Promise<DriveFile> {
  const catalog=env.CATALOG.getByName(env.DRIVE_ID);
  const session=await catalog.beginCompleteUpload(id);
  if (session.status==='completed') return catalog.getFile(session.fileId);
  try {
    if (session.segments) {
      assert(session.segments.every((segment)=>segment.etag),'还有分段未完成合并',409);
      const file=await catalog.getFile(session.fileId);
      return await catalog.commitUpload(id,{size:session.size,etag:'segments',metadata:file.metadata});
    }
    const connection=await catalog.getConnection(session.bucketId);
    let actual=await head(connection,session.objectKey);
    if (!actual && session.uploadId) {
      const parts=await listParts(connection,session.objectKey,session.uploadId);
      const count=Math.ceil(session.size/session.partSize);
      assert(parts.length===count && parts.every((part,index) => part.partNumber===index+1 && part.size===Math.min(session.partSize,session.size-index*session.partSize)),'分片尚未上传完整或长度不正确，请继续上传',409);
      await s3(connection).send(new CompleteMultipartUploadCommand({Bucket:connection.bucket.name,Key:session.objectKey,UploadId:session.uploadId,MultipartUpload:{Parts:parts.map((part)=>({PartNumber:part.partNumber,ETag:part.etag}))}}));
      actual=await head(connection,session.objectKey);
    }
    assert(actual && actual.ContentLength===session.size && actual.Metadata?.['r2drive-upload-id']===session.id,'上传文件长度或归属校验失败',409);
    return await catalog.commitUpload(id,{size:actual.ContentLength!,etag:actual.ETag || '',metadata:fromHead(actual)});
  } catch (error) {await catalog.releaseCompleteUpload(id);throw error;}
}

async function completeUploadSegment(env: Env, id: string, index: number): Promise<void> {
  const catalog=env.CATALOG.getByName(env.DRIVE_ID);
  const session=await catalog.beginCompleteUpload(id);
  if (session.status==='completed') return;
  try {
    const segment=session.segments?.[index];assert(segment,'上传分段不存在',404);
    if (segment.etag) {await catalog.releaseCompleteUpload(id);return;}
    assert(segment.uploadId,'上传分段还未初始化',409);
    const connection=await catalog.getConnection(segment.bucketId);
    let actual=await head(connection,segment.objectKey);
    if (!actual) {
      const parts=await listParts(connection,segment.objectKey,segment.uploadId);
      assert(parts.length===segment.partCount && parts.every((part,offset)=>part.partNumber===offset+1 && part.size===Math.min(session.partSize,segment.size-offset*session.partSize)),'分段分片未上传完整或长度不正确',409);
      await s3(connection).send(new CompleteMultipartUploadCommand({Bucket:connection.bucket.name,Key:segment.objectKey,UploadId:segment.uploadId,MultipartUpload:{Parts:parts.map((part)=>({PartNumber:part.partNumber,ETag:part.etag}))}}));
      actual=await head(connection,segment.objectKey);
    }
    assert(actual && actual.ContentLength===segment.size && actual.ETag && actual.Metadata?.['r2drive-layout']==='segments-v1' && actual.Metadata?.['r2drive-upload-id']===id && actual.Metadata?.['r2drive-file-id']===session.fileId && actual.Metadata?.['r2drive-segment-index']===String(index) && actual.Metadata?.['r2drive-segment-offset']===String(segment.offset) && actual.Metadata?.['r2drive-segment-size']===String(segment.size) && actual.Metadata?.['r2drive-segment-count']===String(session.segments!.length) && actual.Metadata?.['r2drive-logical-size']===String(session.size),'上传分段长度或归属校验失败',409);
    await catalog.commitUploadSegment(id,index,{size:actual.ContentLength!,etag:actual.ETag!});
  } catch(error) {await catalog.releaseCompleteUpload(id);throw error;}
}

async function api(request: Request, env: Env): Promise<Response> {
  const url=new URL(request.url); const path=url.pathname; const method=request.method;
  const catalog=env.CATALOG.getByName(env.DRIVE_ID);
  if (!['GET','HEAD','OPTIONS'].includes(method)) {
    assert(sameOrigin(request,url),'请求来源不正确',403);
    assert(request.headers.get('Content-Type')?.includes('application/json') || method==='DELETE','请发送 application/json 请求',415);
  }
  if (path==='/api/session' && method==='GET') {
    const admin = await catalog.getAdminState();
    const auth = await isAuthenticated(request, env, (await catalog.getAdminCredentials())?.passwordHash);
    return json({ authenticated: auth, secretReady: configured(env), initialized: admin.initialized, appName: env.APP_NAME, username: admin.username });
  }
  if (path==='/api/setup' && method==='POST') {
    assert(configured(env),'请先在 Cloudflare 控制台设置 ENCRYPTION_KEY（Secret，至少 32 个字符）',503);
    const input = await body(request, z.object({ username: z.string().min(1).max(100), password: z.string().min(12).max(1000) }));
    assert(await catalog.rateLimit(`setup:${request.headers.get('CF-Connecting-IP') || 'local'}`,10,15*60*1000),'操作过于频繁，请 15 分钟后重试',429);
    await catalog.setupAdmin(input.username.trim(), input.password);
    const cred = await catalog.getAdminCredentials();
    assert(cred,'管理员初始化失败',500);
    return json({ ok: true, username: cred.username }, 200, { 'Set-Cookie': sessionCookie(request, await createSession(env, cred.username, cred.passwordHash)) });
  }
  if (path==='/api/login' && method==='POST') {
    assert(configured(env),'请先在 Cloudflare 控制台设置 ENCRYPTION_KEY（Secret，至少 32 个字符）',503);
    assert((await catalog.getAdminState()).initialized,'管理员尚未初始化，请先完成初始化设置',409);
    const input=await body(request,z.object({username:z.string().max(100),password:z.string().max(1000)}));
    assert(await catalog.rateLimit(`login:${request.headers.get('CF-Connecting-IP') || 'local'}`,15,15*60*1000),'登录尝试过多，请 15 分钟后重试',429);
    assert(await catalog.verifyAdmin(input.username.trim(), input.password),'用户名或密码不正确',401);
    const cred = await catalog.getAdminCredentials();
    assert(cred,'管理员数据缺失',500);
    return json({ok:true,username:cred.username},200,{'Set-Cookie':sessionCookie(request,await createSession(env,cred.username,cred.passwordHash))});
  }
  if (path==='/api/logout' && method==='POST') return json({ok:true},200,{'Set-Cookie':sessionCookie(request,'',0)});
  const publicShare=path.match(/^\/api\/public\/shares\/([^/]+)(?:\/(download))?$/);
  if (publicShare) {
    if (method==='GET' && !publicShare[2]) return json(await catalog.getPublicShare(publicShare[1]));
    if (method==='POST' && publicShare[2]) {
      assert(await catalog.rateLimit(`share:${publicShare[1]}:${request.headers.get('CF-Connecting-IP') || 'local'}`,20,15*60*1000),'请求过于频繁，请稍后重试',429);
      const input=await body(request,z.object({password:z.string().max(200).default('')}));
      return json({url:await download(env,await catalog.redeemShare(publicShare[1],input.password),url.origin,false,60,publicShare[1])});
    }
  }
  const contentRoute=path.match(/^\/api\/files\/([^/]+)\/content$/);
  if (contentRoute && ['GET','HEAD'].includes(method)) {
    if (!url.searchParams.has('token')) {
      assert(await isAuthenticated(request,env,(await catalog.getAdminCredentials())?.passwordHash),'请先登录网盘',401);
      return fileResponse(request,await catalog.getDownloadFile(contentRoute[1]),catalog,url.searchParams.get('preview')==='1');
    }
    const token=await verifyFileToken(env,url.searchParams.get('token') || '');
    assert(token && token.fileId===contentRoute[1],'下载链接已过期或无效',403);
    const file=await catalog.getDownloadFile(token.fileId,token.shareId);assert(file.etag===token.etag,'文件已发生变化，请重新获取下载链接',409);
    return fileResponse(request,file,catalog,token.preview);
  }
  assert(await isAuthenticated(request,env,(await catalog.getAdminCredentials())?.passwordHash),'请先登录网盘',401);
  if (method==='GET') {
    if (path==='/api/status') return json(await catalog.status());
    if (path==='/api/dashboard') return json(await catalog.dashboard());
    if (path==='/api/accounts') return json(await catalog.getAccounts());
    if (path==='/api/buckets') return json(await catalog.getBuckets());
    if (path==='/api/files') {
      const result=querySchema.safeParse(Object.fromEntries(url.searchParams)); assert(result.success,'文件列表查询参数无效');
      return json(await catalog.listFiles(result.data as ListOptions));
    }
    if (path==='/api/uploads') return json(await catalog.listUploads());
    if (path==='/api/jobs') return json(await catalog.listJobs());
    if (path==='/api/shares') return json(await catalog.listShares());
    if (path==='/api/audit') return json(await catalog.getAudit());
    if (path==='/api/export') return json(await catalog.exportManifest(Math.max(1,Number(url.searchParams.get('page')) || 1)));
  }
  if (path==='/api/jobs/clear' && method==='POST') return json({cleared:await catalog.clearFinishedJobs()});
  if (path==='/api/accounts' && method==='POST') return json(await catalog.addAccount(await body(request,accountSchema)),201);
  if (path==='/api/accounts/order' && method==='POST') {await catalog.reorderAccounts((await body(request,idsSchema)).ids);return json({ok:true});}
  const accountRoute=path.match(/^\/api\/accounts\/([^/]+)(?:\/(sync|test|metrics|zones|queues))?$/);
  if (accountRoute) {
    const [,id,action]=accountRoute;
    if (method==='PATCH' && !action) return json(await catalog.updateAccount(id,await body(request,accountPatchSchema)));
    if (method==='DELETE' && !action) {await catalog.removeAccount(id);return json({ok:true});}
    if (method==='POST' && action==='sync') return json(await catalog.startScan(id),202);
    if (method==='POST' && action==='test') {
      const results=[];
      for (const bucket of (await catalog.getBuckets(id)).slice(0,20)) {
        try {await testBucket(await catalog.getConnection(bucket.id));results.push({bucket:bucket.name,ok:true});}
        catch (error) {results.push({bucket:bucket.name,ok:false,error:errorMessage(error)});}
      }
      return json(results);
    }
    if (method==='GET' && action==='metrics') return json(await analytics(await catalog.getAccountConnection(id)));
    if (method==='GET' && action==='zones') {const connection=await catalog.getAccountConnection(id);return json(await cfApi(connection,`/zones?account.id=${connection.cloudflareAccountId}&per_page=50`));}
    if (method==='GET' && action==='queues') {const connection=await catalog.getAccountConnection(id);return json(await cfApi(connection,`/accounts/${connection.cloudflareAccountId}/queues?per_page=100`));}
  }
  if (path==='/api/buckets' && method==='POST') {
    const input=await body(request,z.object({accountId:z.string().uuid(),name:bucketNameSchema,jurisdiction:jurisdictionSchema.default('default'),storageClass:z.enum(['Standard','InfrequentAccess']).default('Standard'),location:z.string().max(20).optional(),existing:z.boolean().default(false),inPool:z.boolean().default(true)}));
    const account=(await catalog.getAccounts()).find((entry)=>entry.id===input.accountId);assert(account && account.syncState!=='scanning','账号正在同步或不存在',409);
    const connection=await catalog.getAccountConnection(input.accountId); connection.bucket={...connection.bucket,name:input.name,jurisdiction:input.jurisdiction};
    if (!input.existing) await cfApi(connection,`/accounts/${connection.cloudflareAccountId}/r2/buckets`,'POST',{name:input.name,locationHint:input.location || undefined,storageClass:input.storageClass});
    else await testBucket(connection);
    await catalog.registerBuckets(input.accountId,[input]);
    await catalog.startScan(input.accountId);return json(await catalog.getBuckets(input.accountId),201);
  }
  const bucketRoute=path.match(/^\/api\/buckets\/([^/]+)(?:\/(cors-auto|info|multipart|domains|events|settings)(?:\/([^/]+))?(?:\/([^/]+))?)?$/);
  if (bucketRoute) {
    const [,id,action,feature,detail]=bucketRoute;
    const connection=await catalog.getConnection(id);
    const base=`/accounts/${connection.cloudflareAccountId}/r2/buckets/${encodeURIComponent(connection.bucket.name)}`;
    if (method==='PATCH' && !action) {
      const input=await body(request,z.object({inPool:z.boolean().optional(),priority:z.number().int().min(0).max(1000).optional(),storageClass:z.enum(['Standard','InfrequentAccess']).optional(),ignored:z.boolean().optional()}));
      if (input.storageClass) await cfApi(connection,base,'PATCH',{storageClass:input.storageClass});
      return json(await catalog.updateBucket(id,input));
    }
    if (method==='DELETE' && !action) {
      const lease=await catalog.acquireBucketLease(id);
      try {await s3(connection).send(new DeleteBucketCommand({Bucket:connection.bucket.name}));await catalog.removeBucket(id);return json({ok:true});}
      finally {await catalog.releaseBucketLease(id,lease);}
    }
    if (method==='GET' && action==='info') {
      let encryption:unknown=null;
      try {encryption=await s3(connection).send(new GetBucketEncryptionCommand({Bucket:connection.bucket.name}));}catch { /* R2 still encrypts every object at rest if this API is unavailable. */ }
      return json({bucket:connection.bucket,encryption:encryption ? redact(encryption) : {algorithm:'AES-256',managedBy:'Cloudflare'},endpoint:connection.cloudflareAccountId+(connection.bucket.jurisdiction==='default'?'':'.'+connection.bucket.jurisdiction)+'.r2.cloudflarestorage.com'});
    }
    if (method==='POST' && action==='cors-auto') {
      const input=await body(request,z.object({origin:z.url().optional()}));const origin=input.origin || url.origin;
      assert(['https:','http:'].includes(new URL(origin).protocol),'CORS 来源必须是 HTTP 或 HTTPS');
      const lease=await catalog.acquireBucketLease(id);
      try {await autoCors(connection,new URL(origin).origin);return json({ok:true});}finally {await catalog.releaseBucketLease(id,lease);}
    }
    if (action==='settings' && feature) {
      if (method==='GET') return json(await getBucketSetting(connection,feature));
      const lease=await catalog.acquireBucketLease(id);
      try {
        if (method==='PUT' && feature==='cors') {await putCors(connection,await body(request,corsSchema));return json({ok:true});}
        const features:Record<string,{path:string;schema:z.ZodType}>={lifecycle:{path:'lifecycle',schema:lifecycleSchema},locks:{path:'lock',schema:lockSchema},'managed-domain':{path:'domains/managed',schema:enabledSchema},'local-uploads':{path:'local-uploads',schema:enabledSchema}};
        assert(features[feature],'此设置不支持修改',404);
        if (method==='PUT') {await cfApi(connection,`${base}/${features[feature].path}`,'PUT',await body(request,features[feature].schema));return json({ok:true});}
      } finally {await catalog.releaseBucketLease(id,lease);}
    }
    if (action==='domains') {
      if (method==='GET' && !feature) return json(await cfApi(connection,`${base}/domains/custom`));
      if (method==='POST' && !feature) return json(await cfApi(connection,`${base}/domains/custom`,'POST',await body(request,domainSchema)));
      if (method==='DELETE' && feature) {await cfApi(connection,`${base}/domains/custom/${encodeURIComponent(decodeURIComponent(feature))}`,'DELETE');return json({ok:true});}
      if (method==='PUT' && feature) {await cfApi(connection,`${base}/domains/custom/${encodeURIComponent(decodeURIComponent(feature))}`,'PUT',await body(request,z.object({enabled:z.boolean().optional(),minTLS:z.enum(['1.0','1.1','1.2','1.3']).optional(),ciphers:z.array(z.string().max(100)).optional()})));return json({ok:true});}
    }
    if (action==='events') {
      const eventBase=`/accounts/${connection.cloudflareAccountId}/event_notifications/r2/${encodeURIComponent(connection.bucket.name)}/configuration`;
      if (method==='GET' && !feature) return json(await cfApi(connection,eventBase));
      if (method==='PUT' && feature) {assert(/^[a-f0-9]{32}$/i.test(feature),'Queue ID 无效');await cfApi(connection,`${eventBase}/queues/${feature}`,'PUT',await body(request,eventSchema));return json({ok:true});}
      if (method==='DELETE' && feature) {assert(/^[a-f0-9]{32}$/i.test(feature),'Queue ID 无效');await cfApi(connection,`${eventBase}/queues/${feature}`,'DELETE',detail ? {ruleIds:[decodeURIComponent(detail)]}:undefined);return json({ok:true});}
    }
    if (action==='multipart') {
      if (method==='GET') {
        const response=await s3(connection).send(new ListMultipartUploadsCommand({Bucket:connection.bucket.name,MaxUploads:100}));
        return json({uploads:response.Uploads?.map((upload)=>({key:upload.Key,uploadId:upload.UploadId,initiated:upload.Initiated})),truncated:response.IsTruncated});
      }
      if (method==='DELETE') {
        const input=await body(request,z.object({key:z.string().max(1024),uploadId:z.string().max(2000)}));
        const lease=await catalog.acquireBucketLease(id);
        try {await s3(connection).send(new AbortMultipartUploadCommand({Bucket:connection.bucket.name,Key:input.key,UploadId:input.uploadId}));return json({ok:true});}
        finally {await catalog.releaseBucketLease(id,lease);}
      }
    }
  }
  if (path==='/api/folders' && method==='POST') return json(await catalog.createFolder((await body(request,z.object({path:pathSchema}))).path),201);
  const folderRoute=path.match(/^\/api\/folders\/([^/]+)$/);
  if (folderRoute) {
    if (method==='PATCH') {await catalog.renameFolder(folderRoute[1],(await body(request,z.object({path:pathSchema}))).path);return json({ok:true});}
    if (method==='DELETE') {await catalog.trashFolder(folderRoute[1]);return json({ok:true});}
  }
  if (path==='/api/files/delete' && method==='POST') return json(await catalog.startDelete((await body(request,idsSchema)).ids),202);
  if (path==='/api/files/refresh' && method==='POST') {
    await body(request,z.object({}));
    const result=querySchema.safeParse(Object.fromEntries(url.searchParams));assert(result.success,'文件列表查询参数无效');
    return json(await catalog.refreshFiles(result.data as ListOptions));
  }
  if (path==='/api/transfers' && method==='POST') return json(await catalog.startTransfer(await body(request,transferSchema)),202);
  const fileRoute=path.match(/^\/api\/files\/([^/]+)(?:\/(download|preview|text|metadata|shares))?$/);
  if (fileRoute) {
    const [,id,action]=fileRoute;
    const file=await catalog.getFile(id);
    if (method==='GET' && !action) return json(file);
    if (method==='PATCH' && !action) return json(await catalog.updateFile(id,await body(request,z.object({path:pathSchema.optional(),starred:z.boolean().optional(),status:z.enum(['trash','ready']).optional()}))));
    if (method==='GET' && ['download','preview','text','metadata'].includes(action)) {
      assert(['ready','busy'].includes(file.status),'文件暂时不可用',409);
      if (action==='download' || action==='preview') return json({url:await download(env,file,url.origin,action==='preview')});
      if (file.segments && action==='metadata') return json({metadata:file.metadata,size:file.size,etag:file.etag,storageClass:file.storageClass,segments:file.segments});
      if (file.segments && action==='text') {
        assert(file.size<=1024*1024,'文本预览最大支持 1 MB，请下载查看',413);
        return json({text:await readBounded(new Response(await catalog.readFileRange(file.id,0,file.size,file.etag)),1024*1024)});
      }
      const connection=await catalog.getConnection(file.bucketId);
      if (action==='metadata') {const actual=await head(connection,file.objectKey);assert(actual,'远端文件不存在',404);return json({metadata:fromHead(actual),size:actual.ContentLength,etag:actual.ETag,storageClass:actual.StorageClass==='STANDARD_IA'?'InfrequentAccess':'Standard'});}
      assert(file.size<=1024*1024,'文本预览最大支持 1 MB，请下载查看',413);
      const response=await s3(connection).send(new GetObjectCommand({Bucket:connection.bucket.name,Key:file.objectKey,IfMatch:file.etag}));
      assert(response.Body,'文件内容为空',404);
      return json({text:await readBounded(new Response(response.Body.transformToWebStream()),1024*1024)});
    }
    if (method==='PUT' && action==='metadata') {
      const input=await body(request,z.object({metadata:metadataSchema,storageClass:z.enum(['Standard','InfrequentAccess']).optional()}));
      if (file.segments && (!input.storageClass || file.segments.every((segment)=>segment.storageClass===input.storageClass))) return json(await catalog.updateSegmentedMetadata(id,input.metadata));
      return json(await catalog.startTransfer({fileIds:[id],targetBucketId:file.bucketId,mode:'move',...input}),202);
    }
    if (method==='POST' && action==='shares') return json(await catalog.createShare(id,await body(request,z.object({expiresIn:z.number().int().min(60).max(365*86400),password:z.string().max(100).optional(),maxDownloads:z.number().int().min(1).max(1_000_000).optional()}))),201);
  }
  if (path==='/api/uploads' && method==='POST') {
    const session=await catalog.reserveUpload(await body(request,uploadSchema));
    try {
      if (session.segments) return json(await catalog.attachUpload(session.id,null),201);
      const connection=await catalog.getConnection(session.bucketId);const file=await catalog.getFile(session.fileId);
      let uploadId:string|null=null;
      if (session.size>0) {
        const response=await s3(connection).send(new CreateMultipartUploadCommand({Bucket:connection.bucket.name,Key:session.objectKey,StorageClass:'STANDARD',...s3Metadata(file.metadata),Metadata:{'r2drive-path':encodeURIComponent(session.path),'r2drive-file-id':session.fileId,'r2drive-upload-id':session.id}}));
        assert(response.UploadId,'R2 未返回 Upload ID',502);uploadId=response.UploadId;
      }
      return json(await catalog.attachUpload(session.id,uploadId),201);
    } catch (error) {await catalog.cancelUpload(session.id);throw error;}
  }
  const segmentComplete=path.match(/^\/api\/uploads\/([^/]+)\/segments\/(\d+)\/complete$/);
  if (segmentComplete && method==='POST') {
    const index=Number(segmentComplete[2]);assert(index<MAX_FILE_SEGMENTS,'上传分段编号不正确');
    await completeUploadSegment(env,segmentComplete[1],index);return json({ok:true});
  }
  const uploadRoute=path.match(/^\/api\/uploads\/([^/]+)(?:\/(urls|parts|complete))?$/);
  if (uploadRoute) {
    const [,id,action]=uploadRoute;
    if (method==='GET' && !action) return json(await catalog.getUpload(id));
    if (method==='DELETE' && !action) return json(await catalog.cancelUpload(id),202);
    if (method==='GET' && action==='parts') {
      const session=await catalog.getUpload(id);assert(['uploading','completing','completed'].includes(session.status),'上传会话已经结束',409);
      if (session.segments) {
        const raw=url.searchParams.get('segment');assert(raw!==null && /^\d+$/.test(raw),'请指定上传分段编号');
        const segment=session.segments[Number(raw)];assert(segment,'上传分段不存在',404);
        if (segment.etag) return json(Array.from({length:segment.partCount},(_,offset)=>({partNumber:segment.firstPartNumber+offset,size:Math.min(session.partSize,segment.size-offset*session.partSize),etag:segment.etag})));
        return json(segment.uploadId ? (await listParts(await catalog.getConnection(segment.bucketId),segment.objectKey,segment.uploadId)).map((part)=>({...part,partNumber:segment.firstPartNumber+part.partNumber-1})) : []);
      }
      return json(session.uploadId && session.status!=='completed' ? await listParts(await catalog.getConnection(session.bucketId),session.objectKey,session.uploadId):[]);
    }
    if (method==='POST' && action==='urls') {
      const input=await body(request,z.object({parts:z.array(z.number().int().min(0).max(MAX_UPLOAD_PARTS)).min(1).max(UPLOAD_URL_BATCH).refine((parts)=>new Set(parts).size===parts.length,'分片编号不能重复')}));
      return json(await uploadUrls(env,await catalog.touchUpload(id),input.parts));
    }
    if (method==='POST' && action==='complete') return json(await completeUpload(env,id));
  }
  const jobRoute=path.match(/^\/api\/jobs\/([^/]+)(?:\/(pause|resume|cancel))?$/);
  if (jobRoute) {
    if (method==='GET' && !jobRoute[2]) return json(await catalog.getJob(jobRoute[1]));
    if (method==='POST' && jobRoute[2]) return json(await catalog.controlJob(jobRoute[1],jobRoute[2] as 'pause'|'resume'|'cancel'));
  }
  const shareRoute=path.match(/^\/api\/shares\/([^/]+)$/);
  if (shareRoute && method==='DELETE') {await catalog.removeShare(shareRoute[1]);return json({ok:true});}
  throw new AppError(404,'接口不存在');
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (!new URL(request.url).pathname.startsWith('/api/')) return env.ASSETS.fetch(request);
    try {return await api(request,env);}
    catch (error) {
      const status=errorStatus(error);
      const message=errorMessage(error);
      if (status>=500) console.error(JSON.stringify({event:'api-error',path:new URL(request.url).pathname,status,error:message}));
      return json({error:message},status);
    }
  },
} satisfies ExportedHandler<Env>;
