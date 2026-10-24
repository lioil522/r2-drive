/// <reference types="@cloudflare/vitest-plugin/types" />
import { env, reset, runInDurableObject } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import worker from '../worker/index';
import { createSession, encrypt } from '../worker/crypto';
import type { Account, Bucket, DriveFile, FileList, FileRefreshResult, UploadLink, UploadSession } from '../shared/types';
import { uploadPart, uploadPartNumbers } from '../shared/segments';
import { MockR2 } from './mock-r2';

const origin='https://drive.test';
let storage:MockR2;let cookie:string;let fetchSpy:ReturnType<typeof vi.spyOn>;
beforeEach(async()=>{storage=new MockR2();fetchSpy=vi.spyOn(globalThis,'fetch').mockImplementation(storage.fetch);cookie=`r2_session=${await createSession(env)}`;});
afterEach(async()=>{await reset();fetchSpy.mockRestore();});

async function request(path:string,method='GET',body?:unknown,authenticated=true){
  return worker.fetch(new Request(`${origin}/api${path}`,{method,headers:{...(authenticated?{Cookie:cookie}:{}),...(body!==undefined?{'Content-Type':'application/json',Origin:origin}:{})},body:body===undefined?undefined:JSON.stringify(body)}),env);
}

async function setup(quotas=[200_000]){
  const catalog=env.CATALOG.getByName(env.DRIVE_ID);
  for(const [index,quotaBytes]of quotas.entries()){
    const id=crypto.randomUUID();const accountId=String(index+1).padStart(32,'b');
    const account:Account={id,accountId,name:`account-${index}`,priority:index,enabled:true,quotaBytes,safetyBytes:0,externalBytes:0,usedBytes:0,reservedBytes:0,availableBytes:quotaBytes,hasApiToken:false,accessKeyHint:'test',syncState:'ready',syncCoverage:'selected',syncJobId:null,lastSyncedAt:Date.now(),lastError:null,createdAt:Date.now()};
    const encryptedSecrets=await encrypt({accessKeyId:'test-access',secretAccessKey:'test-secret'},env.ENCRYPTION_KEY,id);
    const bucket:Bucket={id:crypto.randomUUID(),accountId:id,name:`refresh-bucket-${index}`,jurisdiction:'default',storageClass:'Standard',inPool:true,ignored:false,priority:0,location:'',createdAt:Date.now(),usedBytes:0,objectCount:0};
    await runInDurableObject(catalog,(_instance,state)=>{state.storage.sql.exec('INSERT INTO accounts VALUES (?,?,?)',id,accountId,JSON.stringify({...account,encryptedSecrets,observedExternalBytes:0}));state.storage.sql.exec('INSERT INTO buckets VALUES (?,?,?,?,?)',bucket.id,id,bucket.name,bucket.jurisdiction,JSON.stringify(bucket));});
  }
  return catalog;
}

async function upload(size=80_000):Promise<DriveFile>{
  const session=await (await request('/uploads','POST',{path:'/record.bin',size,contentType:'application/octet-stream',allowSplit:true})).json() as UploadSession;
  const bytes=new Uint8Array(size).fill(7);const numbers=uploadPartNumbers(session);
  for(let index=0;index<numbers.length;index+=8){
    const links=await (await request(`/uploads/${session.id}/urls`,'POST',{parts:numbers.slice(index,index+8)})).json() as UploadLink[];
    for(const link of links){const part=uploadPart(session,link.partNumber);await fetch(link.url,{method:'PUT',headers:link.headers,body:bytes.slice(part.offset,part.offset+part.size)});}
  }
  for(const segment of session.segments || [])expect((await request(`/uploads/${session.id}/segments/${segment.index}/complete`,'POST',{})).status).toBe(200);
  const response=await request(`/uploads/${session.id}/complete`,'POST',{});expect(response.status).toBe(200);return response.json();
}

async function refresh(query=''):Promise<FileRefreshResult>{
  const response=await request(`/files/refresh${query}`,'POST',{});expect(response.status,await response.clone().text()).toBe(200);return response.json();
}

describe('manual remote file refresh',()=>{
  it('removes externally deleted objects from the visible list and releases their usage',async()=>{
    const catalog=await setup();const file=await upload();const calls=storage.calls.length;
    const key=[...storage.objects.keys()][0];const object=storage.objects.get(key)!;storage.objects.delete(key);
    const cached=await (await request('/files')).json() as FileList;expect(cached.total).toBe(1);expect(storage.calls).toHaveLength(calls);
    const result=await refresh();expect(result).toMatchObject({checkedFiles:1,missingFiles:1,changedFiles:1,errors:[]});
    expect(result.list.files).toEqual([]);expect(result.status.accounts[0].usedBytes).toBe(0);expect(await catalog.getFile(file.id)).toMatchObject({status:'missing'});
    storage.objects.set(key,object);
    const restored=await refresh('?view=missing');expect(restored.restoredFiles).toBe(1);expect(restored.list.files).toEqual([]);
    expect(await catalog.getFile(file.id)).toMatchObject({status:'ready',path:'/record.bin'});expect((await catalog.listFiles()).total).toBe(1);
  });

  it('checks all segments, preserves remaining physical usage and restores trash state',async()=>{
    const catalog=await setup([50_000,50_000]);const file=await upload();await catalog.updateFile(file.id,{status:'trash',starred:true});
    const key=[...storage.objects.keys()].find((key)=>key.endsWith(file.segments![0].objectKey))!;const object=storage.objects.get(key)!;storage.objects.delete(key);
    const result=await refresh('?view=trash');expect(result.missingFiles).toBe(1);expect(result.list.total).toBe(0);
    expect((await catalog.getAccounts()).map((account)=>account.usedBytes)).toEqual([0,46_384]);
    expect(await catalog.getFile(file.id)).toMatchObject({status:'missing',starred:true});
    storage.objects.set(key,object);const restored=await refresh('?view=missing');expect(restored.restoredFiles).toBe(1);
    expect(await catalog.getFile(file.id)).toMatchObject({status:'trash',starred:true});expect((await catalog.listFiles({view:'trash'})).total).toBe(1);
  });

  it('does not treat permission errors as deletion',async()=>{
    const catalog=await setup();const file=await upload();const used=(await catalog.getAccounts())[0].usedBytes;
    fetchSpy.mockImplementation(async(input:RequestInfo|URL,init?:RequestInit)=>{const req=input instanceof Request?input:new Request(input,init);return req.method==='HEAD'?new Response('<Error><Code>AccessDenied</Code></Error>',{status:403,headers:{'Content-Type':'application/xml'}}):storage.fetch(req);});
    const result=await refresh();expect(result.errors).toHaveLength(1);expect(result.missingFiles).toBe(0);expect(result.list.total).toBe(1);
    expect(await catalog.getFile(file.id)).toMatchObject({status:'ready'});expect((await catalog.getAccounts())[0].usedBytes).toBe(used);
  });

  it('skips active files instead of changing a running task',async()=>{
    const catalog=await setup();const file=await upload();
    await runInDurableObject(catalog,(_instance,state)=>{const current=JSON.parse(state.storage.sql.exec<{data:string}>('SELECT data FROM files WHERE id=?',file.id).one().data) as DriveFile;current.lockJobId='active-task';current.status='busy';state.storage.sql.exec('UPDATE files SET status=?,lock_job_id=?,data=? WHERE id=?',current.status,current.lockJobId,JSON.stringify(current),current.id);});
    storage.objects.clear();const calls=storage.calls.length;const result=await refresh();expect(result.skippedFiles).toBe(1);expect(result.missingFiles).toBe(0);expect(storage.calls).toHaveLength(calls);
    expect(await catalog.getFile(file.id)).toMatchObject({status:'busy',lockJobId:'active-task'});
  });

  it('merges user changes made while a remote check is pending',async()=>{
    const catalog=await setup();const file=await upload();let finish!:()=>void;let started=false;
    fetchSpy.mockImplementation(async(input:RequestInfo|URL,init?:RequestInit)=>{const req=input instanceof Request?input:new Request(input,init);if(req.method!=='HEAD')return storage.fetch(req);started=true;await new Promise<void>((resolve)=>{finish=resolve;});return new Response(null,{status:404});});
    const pending=catalog.revalidateFile(file.id);await vi.waitFor(()=>expect(started).toBe(true));
    await catalog.updateFile(file.id,{path:'/renamed.bin',starred:true});await runInDurableObject(catalog,()=>finish());await pending;
    expect(await catalog.getFile(file.id)).toMatchObject({path:'/renamed.bin',starred:true,status:'missing'});
  });

  it('ignores an older check after a newer one has completed',async()=>{
    const catalog=await setup();const file=await upload();let finish!:()=>void;let count=0;
    fetchSpy.mockImplementation(async(input:RequestInfo|URL,init?:RequestInit)=>{const req=input instanceof Request?input:new Request(input,init);if(req.method!=='HEAD'||++count>1)return storage.fetch(req);await new Promise<void>((resolve)=>{finish=resolve;});return new Response(null,{status:404});});
    const old=catalog.revalidateFile(file.id);await vi.waitFor(()=>expect(count).toBe(1));
    expect((await catalog.revalidateFile(file.id)).checkedFiles).toBe(1);await runInDurableObject(catalog,()=>finish());expect((await old).skippedFiles).toBe(1);
    expect(await catalog.getFile(file.id)).toMatchObject({status:'ready'});
  });

  it('requires authentication and valid refresh options',async()=>{
    await setup();await upload();const calls=storage.calls.length;
    expect((await request('/files/refresh','POST',{},false)).status).toBe(401);
    expect((await request('/files/refresh?pageSize=999','POST',{})).status).toBe(400);expect(storage.calls).toHaveLength(calls);
  });
});
