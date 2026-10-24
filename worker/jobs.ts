import { DurableObject } from 'cloudflare:workers';
import {
  AbortMultipartUploadCommand, CompleteMultipartUploadCommand, CreateMultipartUploadCommand,
  DeleteObjectCommand, GetObjectCommand, ListBucketsCommand, ListMultipartUploadsCommand,
  ListObjectsV2Command, ListPartsCommand, PutObjectCommand,
} from '@aws-sdk/client-s3';
import type { Bucket, FileMetadata, Job, Jurisdiction } from '../shared/types';
import { MAX_FILE_SEGMENTS, PART_SIZE, normalizePath } from '../shared/paths';
import { fileSegments } from '../shared/segments';
import { assert, AppError, errorMessage, errorStatus, readBounded } from './errors';
import { cfApi, cfEnvelope, endpoint, fromHead, head, s3, s3Metadata, signedFetch, type Connection } from './r2';
import { forwardAndHash, hashStream } from './streams';
import type { JobExecution, JobPayload, ScanState, ScannedObject, TransferItem, TransferState } from './job-types';

const jurisdictions: Jurisdiction[] = ['default','eu','us','fedramp'];

function segmentIdentity(metadata?: Record<string,string>): ScannedObject['segment'] {
  if (metadata?.['r2drive-layout']!=='segments-v1') return undefined;
  const number=(key:string)=>{const value=metadata[`r2drive-${key}`];assert(value!==undefined && /^\d+$/.test(value) && Number.isSafeInteger(Number(value)),'分段对象的布局元数据无效',409);return Number(value);};
  const index=number('segment-index');const offset=number('segment-offset');const size=number('segment-size');const logicalSize=number('logical-size');const count=number('segment-count');
  assert(count>1 && count<=MAX_FILE_SEGMENTS && index<count && size>0 && offset+size<=logicalSize && typeof metadata['r2drive-file-id']==='string','分段对象的布局元数据无效',409);
  return {fileId:metadata['r2drive-file-id'],index,offset,size,logicalSize,count,contentType:metadata['r2drive-content-type']};
}

export class BackgroundJob extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx,env);
    void ctx.blockConcurrencyWhile(async () => {
      this.ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS execution (id INTEGER PRIMARY KEY, data TEXT NOT NULL); CREATE TABLE IF NOT EXISTS command (id INTEGER PRIMARY KEY, value TEXT NOT NULL);');
    });
  }

  private state(): JobExecution | null {
    const row = this.ctx.storage.sql.exec<{data:string}>('SELECT data FROM execution WHERE id=1').toArray()[0];
    return row ? JSON.parse(row.data) as JobExecution : null;
  }

  private save(state: JobExecution): void {
    this.ctx.storage.sql.exec('INSERT INTO execution VALUES (1,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data',JSON.stringify(state));
  }

  private command(): string {
    return this.ctx.storage.sql.exec<{value:string}>('SELECT value FROM command WHERE id=1').toArray()[0]?.value || 'run';
  }

  async init(payload: JobPayload): Promise<void> {
    const previous = this.state();
    if (previous) {
      assert(previous.payload.id === payload.id && previous.payload.driveId === payload.driveId,'任务初始化身份不匹配');
      return;
    }
    const scan: ScanState | null = payload.type === 'scan' ? { phase:'discover',buckets:payload.buckets,bucketIndex:0,continuation:null,objects:[],objectIndex:0,count:0,bytes:0,coverage:'selected',pendingUploads:[],pendingIndex:0,partMarker:null,pendingBytes:0 } : null;
    this.ctx.storage.transactionSync(() => {
      this.save({payload,index:0,status:'running',retries:0,cancelRequested:false,scan,transfer:null});
      this.ctx.storage.sql.exec("INSERT INTO command VALUES (1,'run')");
    });
    await this.ctx.storage.setAlarm(Date.now()+100);
  }

  async control(action: 'pause' | 'resume' | 'cancel'): Promise<void> {
    const state = this.state(); assert(state,'任务不存在',404);
    assert(!['completed','cancelled'].includes(state.status),'任务已经结束',409);
    this.ctx.storage.sql.exec('UPDATE command SET value=? WHERE id=1',action === 'resume' ? 'run' : action);
    if (action === 'pause') { await this.catalog(state).reportJob(state.payload.id,{status:'paused'}); }
    else {
      await this.catalog(state).reportJob(state.payload.id,{status:'running',error:null});
      await this.ctx.storage.setAlarm(Date.now()+100);
    }
  }

  private catalog(state: JobExecution) { return this.env.CATALOG.getByName(state.payload.driveId); }

  private async report(state: JobExecution, patch: Partial<Pick<Job,'progressBytes'|'totalBytes'|'doneItems'|'totalItems'|'error'>> = {}): Promise<void> {
    const command = this.command();
    const status = command === 'pause' && state.status === 'running' ? 'paused' : state.status;
    await this.catalog(state).reportJob(state.payload.id,{status,...patch});
  }

  async alarm(): Promise<void> {
    const state = this.state();
    if (!state || ['completed','cancelled'].includes(state.status)) return;
    if (this.command() === 'pause') { state.status='paused'; this.save(state); return; }
    if (state.status==='failed' || state.status==='paused') state.retries=0;
    state.status='running';
    // A durable watchdog remains scheduled even if this invocation is interrupted.
    await this.ctx.storage.setAlarm(Date.now()+60_000);
    try {
      if (this.command() === 'cancel') await this.cancelStep(state);
      else if (state.payload.type === 'scan') await this.scanStep(state);
      else if (state.payload.type === 'transfer') await this.transferStep(state);
      else if (state.payload.type === 'delete') await this.deleteStep(state);
      else if (state.payload.type === 'upload-cleanup') {
        const done=await this.catalog(state).cleanupUpload(state.payload.sessionId,state.cleanupIndex || 0);
        if (done) {state.status='completed';await this.report(state,{doneItems:1,progressBytes:(await this.catalog(state).getJob(state.payload.id)).totalBytes});}
        else state.cleanupIndex=(state.cleanupIndex || 0)+1;
      }
      state.retries=0; this.save(state);
      if (['completed','cancelled'].includes(state.status)) await this.ctx.storage.deleteAlarm();
      else if (this.command() === 'pause') { state.status='paused'; this.save(state); await this.report(state); await this.ctx.storage.deleteAlarm(); }
      else await this.ctx.storage.setAlarm(Date.now()+100);
    } catch (error) {
      state.retries++;
      state.status = state.retries >= 5 ? 'failed' : 'running'; this.save(state);
      console.error(JSON.stringify({event:'background-job-error',jobId:state.payload.id,type:state.payload.type,retry:state.retries,error:errorMessage(error)}));
      await this.report(state,{error:errorMessage(error)});
      if (state.status === 'failed') await this.ctx.storage.deleteAlarm();
      else await this.ctx.storage.setAlarm(Date.now()+Math.min(60_000,2000*2**state.retries));
    }
  }

  private async scanStep(state: JobExecution): Promise<void> {
    assert(state.payload.type === 'scan' && state.scan,'扫描任务数据无效');
    const scan = state.scan;
    const catalog = this.catalog(state);
    if (scan.phase === 'discover') {
      let allBuckets: Bucket[] | null = null;
      const account = await catalog.getAccountConnection(state.payload.accountId);
      const jurisdiction = jurisdictions[scan.bucketIndex];
      const connection: Connection = {...account,bucket:{...account.bucket,jurisdiction}};
      try {
        if (connection.secrets.apiToken) {
          const suffix = scan.continuation ? `&cursor=${encodeURIComponent(scan.continuation)}` : '';
          const response = await cfEnvelope<{buckets:{name:string;jurisdiction?:Jurisdiction;storage_class?:Bucket['storageClass'];location?:string}[]}>(connection,`/accounts/${connection.cloudflareAccountId}/r2/buckets?per_page=1000${suffix}`);
          allBuckets=await catalog.registerBuckets(state.payload.accountId,response.result.buckets.map((bucket) => ({name:bucket.name,jurisdiction:bucket.jurisdiction || jurisdiction,storageClass:bucket.storage_class,location:bucket.location})));
          scan.continuation=response.result_info?.cursor || null;
          if (jurisdiction === 'default') scan.coverage='account';
        } else {
          const response = await s3(connection).send(new ListBucketsCommand({}));
          allBuckets=await catalog.registerBuckets(state.payload.accountId,(response.Buckets || []).map((bucket) => ({name:bucket.Name!,jurisdiction})));
          scan.continuation=null;
        }
      } catch (error) {
        const forbidden = errorStatus(error) === 403 || error instanceof Error && ['AccessDenied','Unauthorized','InvalidArgument','InvalidRequest','NoSuchBucket'].includes(error.name);
        if (!forbidden) throw error;
        if (jurisdiction === 'default') {
          scan.coverage='selected';
          if (!scan.buckets.length) throw new AppError(400,'凭据不能列出存储桶。请填写指定存储桶名称，或提供 R2 管理权限。');
          scan.bucketIndex=jurisdictions.length-1;
        }
        scan.continuation=null;
      }
      allBuckets ??= await catalog.getBuckets(state.payload.accountId);
      assert(allBuckets.length <= 1000,'账号有超过 1000 个桶，请使用独立账号或分批管理');
      if (!scan.continuation) scan.bucketIndex++;
      if (scan.bucketIndex >= jurisdictions.length) {
        assert(allBuckets.length,'没有找到存储桶，请先创建或填写已有存储桶名称');
        scan.buckets=allBuckets.filter((bucket)=>!bucket.ignored); scan.bucketIndex=0; scan.phase=scan.buckets.length?'list':'finish';
      }
      await this.report(state); return;
    }
    if (scan.phase === 'finish') {
      let metricBytes: number | null = null;
      const connection = await catalog.getAccountConnection(state.payload.accountId);
      if (connection.secrets.apiToken) {
        try {
          const metrics = await cfApi<Record<string,{published?:{payloadSize?:number;metadataSize?:number};uploaded?:{payloadSize?:number;metadataSize?:number}}>>(connection,`/accounts/${connection.cloudflareAccountId}/r2/metrics`);
          metricBytes=Object.values(metrics).reduce((sum,storage) => sum+(storage.published?.payloadSize || 0)+(storage.published?.metadataSize || 0)+(storage.uploaded?.payloadSize || 0)+(storage.uploaded?.metadataSize || 0),0);
        } catch (error) { if (errorStatus(error)!==403) throw error; }
      }
      await catalog.finishScan(state.payload.id,state.payload.accountId,scan.coverage,metricBytes,scan.pendingBytes);
      state.status='completed'; await this.report(state,{totalBytes:scan.bytes,progressBytes:scan.bytes,totalItems:scan.count,doneItems:scan.count,error:null}); return;
    }
    const bucket = scan.buckets[scan.bucketIndex];
    if (scan.phase === 'objects') {
      // 已同步对象一次最多处理 100 个；需要 HEAD 的对象每次最多 6 个。
      const batch = scan.objects.slice(scan.objectIndex,scan.objectIndex+100);
      const prepared = await catalog.prepareScanBatch(state.payload.id,bucket.id,batch);
      const cached = new Set(prepared.cachedKeys);
      const changed: ScannedObject[] = [];
      let fetched = 0;
      let processed = 0;
      for (const object of batch) {
        if (!cached.has(object.key)) {
          if (fetched >= 6) break;
          fetched++;
          const actual = await head(prepared.connection,object.key);
          if (!actual) { processed++; continue; }
          let logicalPath: string | undefined;
          try { if (actual.Metadata?.['r2drive-path']) logicalPath=normalizePath(decodeURIComponent(actual.Metadata['r2drive-path'])); } catch { /* Import by object key when metadata is malformed. */ }
          changed.push({...object,size:actual.ContentLength || 0,etag:actual.ETag || '',metadata:fromHead(actual),logicalPath,segment:segmentIdentity(actual.Metadata)});
        }
        processed++;
      }
      const count=scan.count+prepared.cachedCount+changed.length;
      const bytes=scan.bytes+prepared.cachedBytes+changed.reduce((sum,object)=>sum+object.size,0);
      await catalog.commitScanBatch(state.payload.id,bucket.id,changed,{count,bytes});
      scan.objectIndex+=processed; scan.count=count; scan.bytes=bytes;
      if (scan.objectIndex>=scan.objects.length) { scan.objects=[]; scan.phase=scan.continuation ? 'list' : 'multipart'; }
      return;
    }
    if (scan.phase === 'multipart-parts' && !scan.pendingUploads[scan.pendingIndex]) {
      scan.pendingUploads=[]; scan.bucketIndex++; scan.continuation=null;
      scan.phase=scan.bucketIndex>=scan.buckets.length ? 'finish' : 'list';
      return;
    }
    const connection = await catalog.getConnection(bucket.id);
    if (scan.phase === 'list') {
      const response = await s3(connection).send(new ListObjectsV2Command({Bucket:bucket.name,MaxKeys:100,ContinuationToken:scan.continuation || undefined}));
      scan.objects=(response.Contents || []).map((object) => ({key:object.Key!,size:object.Size || 0,etag:object.ETag || '',modifiedAt:object.LastModified?.getTime() || Date.now(),storageClass:object.StorageClass==='STANDARD_IA'?'InfrequentAccess':'Standard'}));
      scan.objectIndex=0; scan.continuation=response.IsTruncated ? response.NextContinuationToken || null : null; scan.phase='objects';
    } else if (scan.phase === 'multipart') {
      const response=await s3(connection).send(new ListMultipartUploadsCommand({Bucket:bucket.name,MaxUploads:100}));
      assert(!response.IsTruncated,'有超过 100 个未完成分片上传，请先清理后重试容量扫描');
      scan.pendingUploads=(response.Uploads || []).filter((upload) => upload.Key && upload.UploadId).map((upload) => ({key:upload.Key!,uploadId:upload.UploadId!}));
      scan.pendingIndex=0; scan.partMarker=null; scan.phase='multipart-parts';
    } else if (scan.phase === 'multipart-parts') {
      const upload=scan.pendingUploads[scan.pendingIndex];
      if (upload) {
        try {
          const response=await s3(connection).send(new ListPartsCommand({Bucket:bucket.name,Key:upload.key,UploadId:upload.uploadId,PartNumberMarker:scan.partMarker || undefined,MaxParts:1000}));
          scan.pendingBytes+=(response.Parts || []).reduce((sum,part) => sum+(part.Size || 0)+8192,0);
          scan.partMarker=response.IsTruncated ? response.NextPartNumberMarker || null : null;
        } catch (error) { if (!(error instanceof Error && error.name==='NoSuchUpload')) throw error; scan.partMarker=null; }
        if (!scan.partMarker) scan.pendingIndex++;
      }
    }
  }

  private async transferStep(state: JobExecution): Promise<void> {
    assert(state.payload.type==='transfer','传输任务数据无效');
    const item=state.payload.items[state.index];
    if (!item) { state.status='completed'; await this.report(state,{doneItems:state.payload.items.length,progressBytes:state.payload.items.reduce((sum,item) => sum+item.source.size,0),error:null}); return; }
    const transfer=state.transfer || {phase:'prepare',uploadId:null,partSize:Math.max(PART_SIZE,Math.ceil(item.source.size/9999/(5*1024*1024))*(5*1024*1024)),parts:[],verifyIndex:0,targetEtag:'',metadata:null,committed:false} satisfies TransferState;
    state.transfer=transfer;
    const existingReceipt=await this.catalog(state).getTransferReceipt(state.payload.id,state.index);
    if (existingReceipt && (existingReceipt.state==='done' || !transfer.committed)) { transfer.committed=true; transfer.phase=existingReceipt.state==='done' ? 'done' : 'delete-source'; }
    if (transfer.phase==='done') {
      state.index++;state.transfer=null;await this.report(state,{doneItems:state.index,error:null});return;
    }
    if (transfer.phase==='delete-source') {
      if (await this.deleteSource(state,item,existingReceipt?.deletedSourceSegments)) transfer.phase='done';
      return;
    }
    const target=await this.catalog(state).getConnection(item.targetBucketId);
    if (transfer.phase==='prepare') {
      const sources=fileSegments(item.source);const check=transfer.sourceCheckIndex || 0;
      if (check<sources.length) {
        const segment=sources[check];const connection=await this.catalog(state).getConnection(segment.bucketId);
        const actual=await head(connection,segment.objectKey);
        assert(actual && actual.ContentLength===segment.size && actual.ETag===segment.etag,'源文件分段已变更或缺失，请先取消任务并同步容量',409);
        transfer.metadata=item.metadata || (item.source.segments ? item.source.metadata : fromHead(actual));
        transfer.sourceCheckIndex=check+1;
        if (check+1<sources.length) return;
      }
      const existing=await head(target,item.targetKey);
      assert(!existing || existing.Metadata?.['r2drive-job-id']===state.payload.id,'目标对象键已存在，不能覆盖其他文件',409);
      assert(transfer.metadata,'源文件元数据不可用',409);
      const metadata={...transfer.metadata.custom,'r2drive-job-id':state.payload.id,'r2drive-file-id':item.targetFileId,'r2drive-path':encodeURIComponent(item.targetPath)};
      assert(new TextEncoder().encode(JSON.stringify(metadata)).length < 7500,'自定义元数据与路径过长，请缩短后重试');
      if (item.source.size===0) {
        const response=await s3(target).send(new PutObjectCommand({Bucket:target.bucket.name,Key:item.targetKey,Body:new Uint8Array(0),IfNoneMatch:'*',StorageClass:item.storageClass==='InfrequentAccess'?'STANDARD_IA':'STANDARD',...s3Metadata(transfer.metadata),Metadata:metadata}));
        transfer.targetEtag=response.ETag || ''; transfer.phase='verify';
      } else {
        const response=await s3(target).send(new CreateMultipartUploadCommand({Bucket:target.bucket.name,Key:item.targetKey,StorageClass:item.storageClass==='InfrequentAccess'?'STANDARD_IA':'STANDARD',...s3Metadata(transfer.metadata),Metadata:metadata}));
        assert(response.UploadId,'目标 R2 未返回 Upload ID',502);
        transfer.uploadId=response.UploadId; transfer.phase='upload';
      }
    } else if (transfer.phase==='upload') {
      const partNumber=transfer.parts.length+1;
      const start=(partNumber-1)*transfer.partSize;
      const size=Math.min(transfer.partSize,item.source.size-start);
      if (size<=0) { transfer.phase='complete'; return; }
      const body=await this.catalog(state).readFileRange(item.source.id,start,size,item.source.etag);
      const url=new URL(`${endpoint(target.cloudflareAccountId,target.bucket.jurisdiction)}/${encodeURIComponent(target.bucket.name)}/${item.targetKey.split('/').map(encodeURIComponent).join('/')}`);
      url.searchParams.set('uploadId',transfer.uploadId!); url.searchParams.set('partNumber',String(partNumber));
      const fixed=new FixedLengthStream(size);
      const controller=new AbortController();
      const forwarding=forwardAndHash(body,fixed.writable,size).catch((error) => {controller.abort();throw error;});
      let uploaded: Response;
      let digest: string;
      try {
        [uploaded,digest]=await Promise.all([
          signedFetch(target,url.toString(),{method:'PUT',body:fixed.readable,headers:{'Content-Length':String(size),'x-amz-content-sha256':'UNSIGNED-PAYLOAD'},signal:controller.signal}).then(async (value) => {
            if (!value.ok) { controller.abort(); await fixed.writable.abort().catch(() => undefined); throw new AppError(502,`目标分片上传失败 (${value.status})：${(await readBounded(value)).slice(0,200)}`); }
            return value;
          }),forwarding,
        ]);
      } catch (error) { controller.abort(); throw error; }
      const etag=uploaded.headers.get('ETag');
      await uploaded.body?.cancel(); assert(etag,'目标分片缺少 ETag',502);
      transfer.parts.push({partNumber,size,etag,sha256:digest});
      if (start+size===item.source.size) transfer.phase='complete';
      const before=state.payload.items.slice(0,state.index).reduce((sum,item) => sum+item.source.size,0);
      await this.report(state,{progressBytes:before+start+size,doneItems:state.index,error:null});
    } else if (transfer.phase==='complete') {
      const existing=await head(target,item.targetKey);
      if (existing && existing.Metadata?.['r2drive-job-id']===state.payload.id) transfer.targetEtag=existing.ETag || '';
      else {
        const response=await s3(target).send(new CompleteMultipartUploadCommand({Bucket:target.bucket.name,Key:item.targetKey,UploadId:transfer.uploadId!,MultipartUpload:{Parts:transfer.parts.map((part) => ({PartNumber:part.partNumber,ETag:part.etag}))}}));
        transfer.targetEtag=response.ETag || '';
      }
      transfer.phase='verify';
    } else if (transfer.phase==='verify') {
      const actual=await head(target,item.targetKey);
      assert(actual && actual.ContentLength===item.source.size && actual.Metadata?.['r2drive-job-id']===state.payload.id,'目标对象长度或归属校验失败',409);
      if (transfer.targetEtag) assert(actual.ETag===transfer.targetEtag,'目标对象在校验期间被修改',409);
      transfer.targetEtag=actual.ETag || '';
      const part=transfer.parts[transfer.verifyIndex];
      if (part) {
        const start=(part.partNumber-1)*transfer.partSize;
        const response=await s3(target).send(new GetObjectCommand({Bucket:target.bucket.name,Key:item.targetKey,Range:`bytes=${start}-${start+part.size-1}`,IfMatch:transfer.targetEtag}));
        assert(response.Body && response.ContentLength===part.size,'目标分片读取范围不符',502);
        const digest=await hashStream(response.Body.transformToWebStream(),part.size);
        assert(digest===part.sha256,`目标第 ${part.partNumber} 片 SHA-256 校验失败，源文件已保留`,409);
        transfer.verifyIndex++;
      }
      if (transfer.verifyIndex>=transfer.parts.length) {transfer.phase='commit';transfer.sourceCheckIndex=0;}
    } else if (transfer.phase==='commit') {
      const sources=fileSegments(item.source);const check=transfer.sourceCheckIndex || 0;
      if (check<sources.length) {
        const segment=sources[check];const connection=await this.catalog(state).getConnection(segment.bucketId);
        const actual=await head(connection,segment.objectKey);
        assert(actual && actual.ETag===segment.etag && actual.ContentLength===segment.size,'源文件在传输过程中被修改，已保留源文件',409);
        transfer.sourceCheckIndex=check+1;
        if (check+1<sources.length) return;
      }
      try {await this.catalog(state).commitTransfer(state.payload.id,state.index,item,{etag:transfer.targetEtag,metadata:transfer.metadata!});}
      catch(error) {transfer.sourceCheckIndex=0;throw error;}
      transfer.committed=true; transfer.phase=item.mode==='move'?'delete-source':'done';
    }
  }

  private async deleteSource(state: JobExecution, item: TransferItem, deleted: number[] = []): Promise<boolean> {
    const sources=fileSegments(item.source);let index=state.transfer?.deleteIndex || 0;
    while (deleted.includes(index)) index++;
    if (index>=sources.length) {await this.catalog(state).finishTransferSource(state.payload.id,state.index);return true;}
    const segment=sources[index];const connection=await this.catalog(state).getConnection(segment.bucketId);
    const actual=await head(connection,segment.objectKey);
    if (actual) {
      assert(actual.ETag===segment.etag && actual.ContentLength===segment.size,'源对象在迁移后被外部修改。请处理后重试，目标文件已保留。',409);
      await s3(connection).send(new DeleteObjectCommand({Bucket:connection.bucket.name,Key:segment.objectKey}));
    }
    if (item.source.segments) await this.catalog(state).commitTransferSourceSegment(state.payload.id,state.index,segment.index);
    state.transfer!.deleteIndex=index+1;
    if (index+1===sources.length) {await this.catalog(state).finishTransferSource(state.payload.id,state.index);return true;}
    return false;
  }

  private async deleteStep(state: JobExecution): Promise<void> {
    assert(state.payload.type==='delete','删除任务数据无效');
    const file=state.payload.files[state.index];
    if (!file) {state.status='completed';await this.report(state,{doneItems:state.payload.files.length,error:null});return;}
    if (!await this.catalog(state).deleteFilePending(state.payload.id,file.id)) {
      state.index++;state.deleteSegmentIndex=0;
      await this.report(state,{doneItems:state.index,progressBytes:state.payload.files.slice(0,state.index).reduce((sum,file)=>sum+file.size,0),error:null});return;
    }
    const segments=fileSegments(file);const index=state.deleteSegmentIndex || 0;const segment=segments[index];
    const connection=await this.catalog(state).getConnection(segment.bucketId);
    const actual=await head(connection,segment.objectKey);
    if (actual) {
      assert(actual.ETag===segment.etag && actual.ContentLength===(segment.actualSize ?? segment.size),'远端文件已被修改，请取消任务后同步容量再删除',409);
      await s3(connection).send(new DeleteObjectCommand({Bucket:connection.bucket.name,Key:segment.objectKey}));
    }
    if (file.segments) await this.catalog(state).commitDeleteSegment(state.payload.id,file.id,segment.index);
    if (index+1===segments.length) {await this.catalog(state).commitDelete(state.payload.id,file.id);state.index++;state.deleteSegmentIndex=0;}
    else state.deleteSegmentIndex=index+1;
    const before=state.payload.files.slice(0,state.index).reduce((sum,file)=>sum+file.size,0);
    const partial=state.deleteSegmentIndex ? segments.slice(0,state.deleteSegmentIndex).reduce((sum,part)=>sum+part.size,0) : 0;
    await this.report(state,{doneItems:state.index,progressBytes:before+partial,error:null});
  }

  private async cancelStep(state: JobExecution): Promise<void> {
    const catalog=this.catalog(state);
    if (state.payload.type==='upload-cleanup') {
      const done=await catalog.cleanupUpload(state.payload.sessionId,state.cleanupIndex || 0);
      if (!done) {state.cleanupIndex=(state.cleanupIndex || 0)+1;return;}
    }
    if (state.payload.type==='delete') {
      if (state.deleteSegmentIndex) {await this.deleteStep(state);return;}
      for (const file of state.payload.files.slice(state.index)) await catalog.releaseDelete(state.payload.id,file);
    }
    if (state.payload.type==='transfer') {
      const item=state.payload.items[state.index];
      if (item) {
        const receipt=await catalog.getTransferReceipt(state.payload.id,state.index);
        if (receipt?.state==='committed') {
          if (item.source.segments) {
            state.transfer ||= {phase:'delete-source',uploadId:null,partSize:PART_SIZE,parts:[],verifyIndex:0,targetEtag:'',metadata:null,committed:true};
            if (await this.deleteSource(state,item,receipt.deletedSourceSegments)) {state.index++;state.transfer=null;}
            return;
          }
          const source=await catalog.getConnection(item.source.bucketId);
          const actual=await head(source,item.source.objectKey);
          if (actual) await catalog.preserveTransferSource(state.payload.id,state.index,{size:actual.ContentLength || 0,etag:actual.ETag || '',metadata:fromHead(actual)});
          else await catalog.finishTransferSource(state.payload.id,state.index);
        } else if (!receipt) {
          const target=await catalog.getConnection(item.targetBucketId);
          if (state.transfer?.uploadId) {
            try {await s3(target).send(new AbortMultipartUploadCommand({Bucket:target.bucket.name,Key:item.targetKey,UploadId:state.transfer.uploadId}));}
            catch (error) {if (!(error instanceof Error && error.name==='NoSuchUpload')) throw error;}
          }
          const existing=await head(target,item.targetKey);
          if (existing) {
            assert(existing.Metadata?.['r2drive-job-id']===state.payload.id,'目标对象已由外部修改，不能自动删除。请处理后重试取消。',409);
            await s3(target).send(new DeleteObjectCommand({Bucket:target.bucket.name,Key:item.targetKey}));
          }
        }
        await catalog.releaseTransferItem(state.payload.id,item);
        state.index++; state.transfer=null; return;
      }
    }
    state.status='cancelled'; await this.report(state,{error:null});
  }
}
