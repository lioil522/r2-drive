/// <reference types="@cloudflare/vitest-plugin/types" />
import { env, reset, runInDurableObject } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import worker from '../worker/index';
import { createFileToken, createSession, encrypt } from '../worker/crypto';
import type { Account, Bucket, DriveFile, Job, Share, UploadLink, UploadSession } from '../shared/types';
import type { JobExecution } from '../worker/job-types';
import { uploadPart, uploadPartNumbers } from '../shared/segments';
import { MockR2 } from './mock-r2';
import { createHash } from 'node:crypto';

const origin='https://drive.test';
let r2:MockR2;
let cookie:string;
let fetchSpy:ReturnType<typeof vi.spyOn>;
const checksum=(bytes:Uint8Array)=>createHash('sha256').update(bytes).digest('hex');

beforeEach(async()=>{r2=new MockR2();fetchSpy=vi.spyOn(globalThis,'fetch').mockImplementation(r2.fetch);cookie=`r2_session=${await createSession(env)}`;});
afterEach(async()=>{await reset();fetchSpy.mockRestore();});

async function request(path:string,method='GET',body?:unknown,authenticated=true,headers?:HeadersInit):Promise<Response>{
  return worker.fetch(new Request(`${origin}/api${path}`,{method,headers:{...(authenticated?{Cookie:cookie}:{}),...(body!==undefined?{'Content-Type':'application/json',Origin:origin}:{}),...headers},body:body===undefined?undefined:JSON.stringify(body)}),env);
}

async function setup(quotas=[50_000,50_000]){
  const catalog=env.CATALOG.getByName(env.DRIVE_ID);
  const accounts:Account[]=[];const buckets:Bucket[]=[];
  for(let index=0;index<quotas.length;index++){
    const id=crypto.randomUUID();const accountId=String(index+1).padStart(32,'a');
    const account:Account={id,name:`account-${index}`,accountId,priority:index,enabled:true,quotaBytes:quotas[index],safetyBytes:0,externalBytes:0,usedBytes:0,reservedBytes:0,availableBytes:quotas[index],hasApiToken:false,accessKeyHint:'test',syncState:'ready',syncCoverage:'selected',syncJobId:null,lastSyncedAt:Date.now(),lastError:null,createdAt:Date.now()};
    const encryptedSecrets=await encrypt({accessKeyId:'test-access',secretAccessKey:'test-secret'},env.ENCRYPTION_KEY,id);
    const bucket:Bucket={id:crypto.randomUUID(),accountId:id,name:`bucket-${index}`,jurisdiction:'default',storageClass:'Standard',inPool:true,ignored:false,priority:0,location:'',createdAt:Date.now(),usedBytes:0,objectCount:0};
    await runInDurableObject(catalog,(_instance,state)=>{
      state.storage.sql.exec('INSERT INTO accounts VALUES (?,?,?)',id,accountId,JSON.stringify({...account,encryptedSecrets,observedExternalBytes:0}));
      state.storage.sql.exec('INSERT INTO buckets VALUES (?,?,?,?,?)',bucket.id,id,bucket.name,bucket.jurisdiction,JSON.stringify(bucket));
    });
    accounts.push(account);buckets.push(bucket);
  }
  return {catalog,accounts,buckets};
}

async function start(body:Uint8Array,type='application/octet-stream'):Promise<UploadSession>{
  const response=await request('/uploads','POST',{path:'/large.bin',size:body.byteLength,contentType:type,allowSplit:true});
  expect(response.status,await response.clone().text()).toBe(201);return response.json();
}

async function putParts(session:UploadSession,body:Uint8Array,numbers=uploadPartNumbers(session)){
  for(let index=0;index<numbers.length;index+=8){
    const response=await request(`/uploads/${session.id}/urls`,'POST',{parts:numbers.slice(index,index+8)});
    expect(response.status,await response.clone().text()).toBe(200);
    const links=await response.json() as UploadLink[];
    for(const link of links){const part=uploadPart(session,link.partNumber);expect((await fetch(link.url,{method:'PUT',body:body.slice(part.offset,part.offset+part.size),headers:link.headers})).status).toBe(200);}
  }
}

async function finish(session:UploadSession):Promise<DriveFile>{
  if(session.segments)for(const part of session.segments){const response=await request(`/uploads/${session.id}/segments/${part.index}/complete`,'POST',{});expect(response.status,await response.clone().text()).toBe(200);}
  const response=await request(`/uploads/${session.id}/complete`,'POST',{});expect(response.status,await response.clone().text()).toBe(200);return response.json();
}

async function runJob(job:Job,limit=80):Promise<JobExecution>{
  const jobs=env.JOBS.getByName(`${env.DRIVE_ID}:${job.id}`);
  return runInDurableObject(jobs,async(instance,state)=>{
    await state.storage.deleteAlarm();const timer=vi.spyOn(state.storage,'setAlarm').mockResolvedValue();
    try {
      for(let index=0;index<limit;index++){
        const execution=JSON.parse(state.storage.sql.exec<{data:string}>('SELECT data FROM execution WHERE id=1').one().data) as JobExecution;
        if(['completed','cancelled','failed'].includes(execution.status))return execution;
        await instance.alarm();
      }
      throw new Error('Background job did not finish');
    } finally {timer.mockRestore();await state.storage.deleteAlarm();}
  });
}

async function stepJob(job:Job):Promise<JobExecution>{
  const jobs=env.JOBS.getByName(`${env.DRIVE_ID}:${job.id}`);
  return runInDurableObject(jobs,async(instance,state)=>{
    await state.storage.deleteAlarm();const timer=vi.spyOn(state.storage,'setAlarm').mockResolvedValue();
    try {await instance.alarm();return JSON.parse(state.storage.sql.exec<{data:string}>('SELECT data FROM execution WHERE id=1').one().data) as JobExecution;}
    finally {timer.mockRestore();await state.storage.deleteAlarm();}
  });
}

describe('cross-account files',()=>{
  it('uploads one logical file, reassembles exact bytes and serves a cross-segment Range',async()=>{
    const {catalog,accounts,buckets}=await setup();
    const body=Uint8Array.from({length:80_000},(_,index)=>index%251);
    const session=await start(body);expect(session.segments).toHaveLength(2);
    expect((await catalog.listUploads())[0]).toMatchObject({segmentCount:2});expect((await catalog.listUploads())[0].segments).toBeUndefined();
    expect(session.segments!.map((part)=>part.size)).toEqual([41_808,38_192]);
    expect((await catalog.getAccounts()).map((account)=>account.reservedBytes)).toEqual([50_000,46_384]);
    await putParts(session,body);
    const file=await finish(session);expect(file.segments).toHaveLength(2);
    expect((await catalog.getAccounts()).map((account)=>account.usedBytes)).toEqual([50_000,46_384]);
    expect((await catalog.getAccounts()).every((account)=>account.reservedBytes===0)).toBe(true);
    for(const account of accounts)expect((await catalog.listFiles({accountId:account.id})).total).toBe(1);
    for(const bucket of buckets)expect((await catalog.listFiles({bucketId:bucket.id})).total).toBe(1);
    expect((await catalog.listFiles()).files[0]).toMatchObject({id:file.id,size:80_000,segmentCount:2});

    const link=await (await request(`/files/${file.id}/download`)).json() as {url:string};
    const response=await worker.fetch(new Request(link.url),env);expect(response.status).toBe(200);
    expect(response.headers.get('Content-Length')).toBe('80000');expect(checksum(new Uint8Array(await response.arrayBuffer()))).toBe(checksum(body));
    const range=await worker.fetch(new Request(link.url,{headers:{Range:'bytes=41800-41819'}}),env);
    expect(range.status).toBe(206);expect(range.headers.get('Content-Range')).toBe('bytes 41800-41819/80000');expect(new Uint8Array(await range.arrayBuffer())).toEqual(body.slice(41_800,41_820));
    const suffix=await worker.fetch(new Request(link.url,{headers:{Range:'bytes=-10'}}),env);expect(new Uint8Array(await suffix.arrayBuffer())).toEqual(body.slice(-10));
    const head=await worker.fetch(new Request(link.url,{method:'HEAD'}),env);expect(head.headers.get('Content-Length')).toBe('80000');expect(await head.text()).toBe('');
    const invalid=await worker.fetch(new Request(link.url,{headers:{Range:'bytes=80000-'}}),env);expect(invalid.status).toBe(416);
  });

  it('keeps a file whole when one account fits, and rolls back insufficient or concurrent pool allocations',async()=>{
    const {catalog}=await setup([50_000,50_000,200_000]);
    const session=await start(new Uint8Array(80_000));expect(session.segments).toBeUndefined();
    expect(session.accountId).toBe((await catalog.getAccounts())[2].id);
    await reset();r2.objects.clear();r2.multiparts.clear();const {catalog:pool}=await setup();
    const oversized=await request('/uploads','POST',{path:'/too-large.bin',size:90_000,allowSplit:true});expect(oversized.status).toBe(409);
    expect((await pool.getAccounts()).every((account)=>account.reservedBytes===0)).toBe(true);
    const results=await Promise.all([request('/uploads','POST',{path:'/a/file.bin',size:80_000,allowSplit:true}),request('/uploads','POST',{path:'/b/file.bin',size:80_000,allowSplit:true})]);
    expect(results.map((result)=>result.status).sort()).toEqual([201,409]);
    expect((await pool.getAccounts()).reduce((sum,account)=>sum+account.reservedBytes,0)).toBe(96_384);
    const count=await runInDurableObject(pool,(_instance,state)=>state.storage.sql.exec<{count:number}>('SELECT COUNT(*) count FROM files').one().count);expect(count).toBe(1);
  });

  it('resumes individual segments and releases reservations only when the logical file commits',async()=>{
    const {catalog}=await setup();const body=new Uint8Array(80_000).fill(7);const session=await start(body);
    await putParts(session,body,[1]);
    const parts=await (await request(`/uploads/${session.id}/parts?segment=0`)).json() as {partNumber:number;size:number}[];
    expect(parts).toEqual([expect.objectContaining({partNumber:1,size:41_808})]);
    expect((await request(`/uploads/${session.id}/segments/0/complete`,'POST',{})).status).toBe(200);
    expect((await catalog.getAccounts()).map((account)=>account.usedBytes)).toEqual([0,0]);
    const premature=await request(`/uploads/${session.id}/complete`,'POST',{});expect(premature.status).toBe(409);
    expect((await catalog.getUpload(session.id)).status).toBe('uploading');
    await putParts(session,body,[2]);const file=await finish(session);
    expect(file.size).toBe(80_000);expect((await catalog.getAccounts()).every((account)=>account.reservedBytes===0)).toBe(true);
    expect((await request(`/uploads/${session.id}/complete`,'POST',{})).status).toBe(200);
  });

  it('cleans up initialized and completed segments after a cancelled upload',async()=>{
    const {catalog}=await setup();const body=new Uint8Array(80_000);const session=await start(body);
    await putParts(session,body,[1]);await request(`/uploads/${session.id}/segments/0/complete`,'POST',{});
    const job=await (await request(`/uploads/${session.id}`,'DELETE')).json() as Job;
    expect((await runJob(job)).status).toBe('completed');
    expect((await catalog.getUpload(session.id)).status).toBe('cancelled');
    expect((await catalog.getAccounts()).every((account)=>account.reservedBytes===0 && account.usedBytes===0)).toBe(true);
    expect(r2.objects.size).toBe(0);expect(r2.multiparts.size).toBe(0);
  });

  it('shares and previews segmented files with token expiry, revocation and normal metadata updates',async()=>{
    const {catalog}=await setup();const body=new TextEncoder().encode('中文测试\n'.repeat(6000));const session=await start(body,'text/plain');
    await putParts(session,body);const file=await finish(session);
    const text=await (await request(`/files/${file.id}/text`)).json() as {text:string};expect(text.text).toBe(new TextDecoder().decode(body));
    const preview=await (await request(`/files/${file.id}/preview`)).json() as {url:string};
    expect((await worker.fetch(new Request(preview.url),env)).status).toBe(401);
    const inline=await worker.fetch(new Request(preview.url,{headers:{Cookie:cookie,Range:'bytes=0-9'}}),env);expect(inline.status).toBe(206);expect(inline.headers.get('Content-Disposition')).toContain('inline');await inline.arrayBuffer();
    const share=await (await request(`/files/${file.id}/shares`,'POST',{expiresIn:3600,password:'code',maxDownloads:1})).json() as Share;
    const publicInfo=await (await request(`/public/shares/${share.id}`,'GET',undefined,false)).json() as {segmented:boolean};expect(publicInfo.segmented).toBe(true);
    const wrong=await request(`/public/shares/${share.id}/download`,'POST',{password:'wrong'},false);expect(wrong.status).toBe(403);
    const signed=await (await request(`/public/shares/${share.id}/download`,'POST',{password:'code'},false)).json() as {url:string};
    expect(checksum(new Uint8Array(await (await worker.fetch(new Request(signed.url),env)).arrayBuffer()))).toBe(checksum(body));
    expect((await request(`/public/shares/${share.id}/download`,'POST',{password:'code'},false)).status).toBe(410);
    await request(`/shares/${share.id}`,'DELETE');expect((await worker.fetch(new Request(signed.url),env)).status).toBe(403);
    const expired=await createFileToken(env,{fileId:file.id,etag:file.etag,expires:Date.now()-1,preview:false});
    expect((await request(`/files/${file.id}/content?token=${encodeURIComponent(expired)}`,'GET',undefined,false)).status).toBe(403);
    await request(`/files/${file.id}`,'PATCH',{path:'/renamed.txt',starred:true});
    await request(`/files/${file.id}/metadata`,'PUT',{metadata:{contentType:'text/plain',custom:{note:'logical metadata'}}});
    expect(await catalog.getFile(file.id)).toMatchObject({path:'/renamed.txt',starred:true,metadata:{custom:{note:'logical metadata'}}});
  });

  it('deletes all segments and supports verified migration into a larger target bucket',async()=>{
    const {catalog,buckets}=await setup();const body=Uint8Array.from({length:80_000},(_,index)=>index%239);const session=await start(body);await putParts(session,body);const file=await finish(session);
    await runInDurableObject(catalog,(_instance,state)=>{
      const row=state.storage.sql.exec<{data:string}>('SELECT data FROM accounts WHERE id=?',buckets[0].accountId).one();const account=JSON.parse(row.data) as Account;
      account.quotaBytes=300_000;state.storage.sql.exec('UPDATE accounts SET data=? WHERE id=?',JSON.stringify(account),account.id);
    });
    const job=await (await request('/transfers','POST',{fileIds:[file.id],targetBucketId:buckets[0].id,mode:'move'})).json() as Job;
    const execution=await runJob(job);expect(execution.status,JSON.stringify(execution)).toBe('completed');
    const migrated=await catalog.getFile(file.id);expect(migrated.segments).toBeUndefined();expect(r2.objects.size).toBe(1);
    expect((await catalog.getAccounts()).map((account)=>account.usedBytes)).toEqual([88_192,0]);
    expect((await catalog.getAccounts()).every((account)=>account.reservedBytes===0)).toBe(true);
    const remaining=[...r2.objects.values()][0];expect(checksum(remaining.body)).toBe(checksum(body));
    const deletion=await (await request('/files/delete','POST',{ids:[file.id]})).json() as Job;
    expect((await runJob(deletion)).status).toBe('completed');expect(r2.objects.size).toBe(0);
    expect((await catalog.getAccounts()).every((account)=>account.usedBytes===0)).toBe(true);
  });

  it('finishes the current segmented deletion on cancellation and releases future files',async()=>{
    const {catalog}=await setup([50_000,50_000,50_000]);
    const body=new Uint8Array(80_000).fill(3);const session=await start(body);await putParts(session,body);const file=await finish(session);
    const smallSession=await start(new Uint8Array(1000));await putParts(smallSession,new Uint8Array(1000));const small=await finish(smallSession);
    const job=await (await request('/files/delete','POST',{ids:[file.id,small.id]})).json() as Job;
    const first=await stepJob(job);expect(first.deleteSegmentIndex).toBe(1);expect((await catalog.getAccounts()).map((account)=>account.usedBytes)).toEqual([0,46_384,9192]);
    await catalog.controlJob(job.id,'pause');expect((await stepJob(job)).status).toBe('paused');expect(r2.objects.size).toBe(2);
    await catalog.controlJob(job.id,'cancel');expect((await runJob(job)).status).toBe('cancelled');
    expect((await catalog.getAccounts()).map((account)=>account.usedBytes)).toEqual([0,0,9192]);
    expect(await catalog.getFile(small.id)).toMatchObject({status:'ready',lockJobId:null});
    expect((await catalog.listFiles()).files.map((item)=>item.id)).toEqual([small.id]);expect(r2.objects.size).toBe(1);
  });

  it('tracks missing segment bytes, restores a repaired layout and exposes missing files',async()=>{
    const {catalog,accounts}=await setup();const body=new Uint8Array(80_000).fill(4);const session=await start(body);await putParts(session,body);const file=await finish(session);
    const originalLink=await (await request(`/files/${file.id}/download`)).json() as {url:string};
    for(const account of accounts)expect((await runJob(await catalog.startScan(account.id))).status).toBe('completed');
    expect(await catalog.getFile(file.id)).toMatchObject({status:'ready',size:80_000});
    const key=[...r2.objects.keys()].find((key)=>key.endsWith(file.segments![1].objectKey))!;
    const object=r2.objects.get(key)!;const original=object.body;
    object.body=new Uint8Array(original.byteLength+1);object.etag='"resized"';object.modified=Date.now();
    expect((await runJob(await catalog.startScan(accounts[1].id))).status).toBe('completed');
    expect(await catalog.getFile(file.id)).toMatchObject({status:'missing'});
    expect((await catalog.getAccounts()).map((account)=>account.usedBytes)).toEqual([50_000,46_385]);
    const missing=await (await request('/files?view=missing')).json() as {files:DriveFile[]};expect(missing.files[0].id).toBe(file.id);
    expect((await worker.fetch(new Request(originalLink.url),env)).status).toBe(409);
    object.body=original;object.etag='"repaired"';object.modified=Date.now();
    expect((await runJob(await catalog.startScan(accounts[1].id))).status).toBe('completed');
    expect(await catalog.getFile(file.id)).toMatchObject({status:'ready'});
    const link=await (await request(`/files/${file.id}/download`)).json() as {url:string};
    expect(checksum(new Uint8Array(await (await worker.fetch(new Request(link.url),env)).arrayBuffer()))).toBe(checksum(body));
  });

  it('recovers one logical file from segment metadata when its index is missing',async()=>{
    const {catalog,accounts}=await setup();const body=new Uint8Array(80_000).fill(5);const session=await start(body);await putParts(session,body);const file=await finish(session);
    await runInDurableObject(catalog,(_instance,state)=>{state.storage.sql.exec('DELETE FROM file_segments WHERE file_id=?',file.id);state.storage.sql.exec('DELETE FROM files WHERE id=?',file.id);});
    expect((await runJob(await catalog.startScan(accounts[1].id))).status).toBe('completed');
    expect(await catalog.getFile(file.id)).toMatchObject({status:'missing',segmentCount:2});
    expect((await runJob(await catalog.startScan(accounts[0].id))).status).toBe('completed');
    const recovered=await catalog.getFile(file.id);expect(recovered).toMatchObject({status:'ready',path:file.path,size:80_000,segmentCount:2});
    expect((await catalog.listFiles()).total).toBe(1);
    const link=await (await request(`/files/${file.id}/download`)).json() as {url:string};
    expect(checksum(new Uint8Array(await (await worker.fetch(new Request(link.url),env)).arrayBuffer()))).toBe(checksum(body));
  });

  it('respects explicit destinations and leases, retries partial initialization and protects member accounts',async()=>{
    const {catalog,buckets,accounts}=await setup();
    expect((await request('/uploads','POST',{path:'/fixed.bin',size:80_000,bucketId:buckets[0].id,allowSplit:true})).status).toBe(409);
    const lease=await catalog.acquireBucketLease(buckets[0].id);
    expect((await request('/uploads','POST',{path:'/leased.bin',size:80_000,allowSplit:true})).status).toBe(409);await catalog.releaseBucketLease(buckets[0].id,lease);
    const body=new Uint8Array(80_000);const session=await start(body);
    expect((await request(`/uploads/${session.id}/urls`,'POST',{parts:[0]})).status).toBe(400);expect(r2.multiparts.size).toBe(0);
    r2.failCreateForBucket=buckets[1].name;
    expect((await request(`/uploads/${session.id}/urls`,'POST',{parts:[1,2]})).status).toBe(403);
    expect(r2.multiparts.size).toBe(1);expect((await catalog.getUpload(session.id)).segments![1].initToken).toBeUndefined();
    await putParts(session,body);const file=await finish(session);
    expect((await request(`/accounts/${accounts[1].id}`,'DELETE')).status).toBe(409);
    expect((await request(`/buckets/${buckets[1].id}`,'PATCH',{ignored:true})).status).toBe(409);
    expect(await catalog.getFile(file.id)).toMatchObject({status:'ready'});
  });

  it('copies segmented data without dropping source locations and expires unfinished uploads safely',async()=>{
    const {catalog,buckets}=await setup();const body=new Uint8Array(80_000).fill(6);const session=await start(body);await putParts(session,body);const file=await finish(session);
    await runInDurableObject(catalog,(_instance,state)=>{const account=JSON.parse(state.storage.sql.exec<{data:string}>('SELECT data FROM accounts WHERE id=?',buckets[0].accountId).one().data) as Account;account.quotaBytes=300_000;state.storage.sql.exec('UPDATE accounts SET data=? WHERE id=?',JSON.stringify(account),account.id);});
    const copy=await (await request('/transfers','POST',{fileIds:[file.id],targetBucketId:buckets[0].id,mode:'copy'})).json() as Job;
    expect((await runJob(copy)).status).toBe('completed');expect((await catalog.getFile(file.id)).segments).toHaveLength(2);expect(r2.objects.size).toBe(3);
    expect((await catalog.getAccounts()).map((account)=>account.usedBytes)).toEqual([138_192,46_384]);
    await reset();r2.objects.clear();r2.multiparts.clear();const {catalog:unfinished}=await setup();const pending=await start(body);await putParts(pending,body,[1]);
    await runInDurableObject(unfinished,async(instance,state)=>{const upload=JSON.parse(state.storage.sql.exec<{data:string}>('SELECT data FROM uploads WHERE id=?',pending.id).one().data) as UploadSession;upload.expiresAt=Date.now()-1;state.storage.sql.exec('UPDATE uploads SET expires_at=?,data=? WHERE id=?',upload.expiresAt,JSON.stringify(upload),upload.id);await instance.alarm();});
    const cleanup=(await unfinished.listJobs()).find((job)=>job.type==='upload-cleanup')!;expect((await runJob(cleanup)).status).toBe('completed');
    expect((await unfinished.getAccounts()).every((account)=>account.reservedBytes===0)).toBe(true);expect(r2.multiparts.size).toBe(0);
  });

  it('reassembles more than fifty small account segments through bounded streaming RPCs',async()=>{
    await setup(Array.from({length:60},()=>8200));const body=Uint8Array.from({length:450},(_,index)=>index%241);const session=await start(body);
    expect(session.segments!.length).toBeGreaterThan(50);await putParts(session,body);const file=await finish(session);
    const link=await (await request(`/files/${file.id}/download`)).json() as {url:string};
    expect(checksum(new Uint8Array(await (await worker.fetch(new Request(link.url),env)).arrayBuffer()))).toBe(checksum(body));
  },20_000);

  it('maps global parts to local multipart numbers across a non-aligned account boundary',async()=>{
    const MiB=1024*1024;await setup([17*MiB,17*MiB]);const body=new Uint8Array(21*MiB);
    body.fill(1,0,16*MiB);body.fill(2,16*MiB,17*MiB-8192);body.fill(3,17*MiB-8192);
    const session=await start(body);expect(uploadPartNumbers(session)).toEqual([1,2,3]);
    expect(uploadPart(session,2)).toMatchObject({number:2,offset:16*MiB,size:MiB-8192});
    expect(uploadPart(session,3)).toMatchObject({number:1,offset:17*MiB-8192,size:4*MiB+8192});
    await putParts(session,body);const file=await finish(session);
    const link=await (await request(`/files/${file.id}/download`)).json() as {url:string};
    const rangeStart=file.segments![0].size-1024;
    const range=await worker.fetch(new Request(link.url,{headers:{Range:`bytes=${rangeStart}-${rangeStart+4095}`}}),env);
    expect(new Uint8Array(await range.arrayBuffer())).toEqual(body.slice(rangeStart,rangeStart+4096));
  },20_000);

  it('resumes source cleanup from its receipt after an old job checkpoint and account removal',async()=>{
    const {catalog,buckets,accounts}=await setup([50_000,50_000,300_000]);await catalog.updateBucket(buckets[2].id,{inPool:false});
    const body=new Uint8Array(80_000).fill(8);const session=await start(body);await putParts(session,body);const file=await finish(session);
    const job=await (await request('/transfers','POST',{fileIds:[file.id],targetBucketId:buckets[2].id,mode:'move'})).json() as Job;
    for(let index=0;index<40;index++){const state=await stepJob(job);if(state.transfer?.phase==='delete-source')break;}
    const first=await stepJob(job);expect(first.transfer?.deleteIndex).toBe(1);
    await catalog.removeAccount(accounts[0].id);
    const jobs=env.JOBS.getByName(`${env.DRIVE_ID}:${job.id}`);
    await runInDurableObject(jobs,(_instance,state)=>{const execution=JSON.parse(state.storage.sql.exec<{data:string}>('SELECT data FROM execution WHERE id=1').one().data) as JobExecution;execution.transfer!.deleteIndex=0;state.storage.sql.exec('UPDATE execution SET data=? WHERE id=1',JSON.stringify(execution));});
    expect((await runJob(job)).status).toBe('completed');expect(r2.objects.size).toBe(1);
    expect((await catalog.getAccounts()).every((account)=>account.reservedBytes===0)).toBe(true);
  });

  it('keeps empty files compatible and isolates active document responses',async()=>{
    const {catalog}=await setup();const zero=await start(new Uint8Array());expect(zero.segments).toBeUndefined();
    await putParts(zero,new Uint8Array());const empty=await finish(zero);expect(empty.size).toBe(0);
    const body=new Uint8Array(75_000);const session=await start(body);await putParts(session,body);const file=await finish(session);
    const invalid=await request(`/files/${file.id}/metadata`,'PUT',{metadata:{contentType:'text/html\r\nInvalid: header'}});expect(invalid.status).toBe(400);
    await request(`/files/${file.id}/metadata`,'PUT',{metadata:{contentType:'image/svg+xml',contentDisposition:'inline'}});
    const link=await (await request(`/files/${file.id}/download`)).json() as {url:string};
    const response=await worker.fetch(new Request(link.url,{method:'HEAD'}),env);expect(response.headers.get('Content-Security-Policy')).toBe('sandbox');
    expect((await catalog.getAccounts()).every((account)=>account.reservedBytes===0)).toBe(true);
  });
});
