import { api } from './api';
import type { UploadLink, UploadPart, UploadSession } from '../shared/types';
import { joinPath, UPLOAD_CONCURRENCY, UPLOAD_URL_BATCH } from '../shared/paths';
import { UploadLinks } from './upload-links';
import { uploadPart, uploadPartNumbers } from '../shared/segments';

export interface UploadTask {
  id:string;
  name:string;
  path:string;
  size:number;
  lastModified:number;
  fingerprint?:string;
  bucketId?:string;
  allowSplit?:boolean;
  session?:UploadSession;
  status:'queued'|'uploading'|'paused'|'needs-file'|'completing'|'completed'|'failed'|'cancelling'|'cancelled';
  progress:number;
  speed:number;
  error?:string;
  createdAt:number;
}

const storageKey='r2-drive-upload-sessions-v1';

class R2UploadError extends Error {
  constructor(public status:number,message:string){super(message);}
}

async function fingerprint(file:File):Promise<string>{
  const first=await file.slice(0,65536).arrayBuffer();const last=await file.slice(Math.max(0,file.size-65536)).arrayBuffer();
  const bytes=new Uint8Array(first.byteLength+last.byteLength);bytes.set(new Uint8Array(first));bytes.set(new Uint8Array(last),first.byteLength);
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),byte=>byte.toString(16).padStart(2,'0')).join('');
}

function put(url:string,body:Blob,headers:Record<string,string>,signal:AbortSignal,onProgress:(loaded:number)=>void):Promise<string>{
  return new Promise((resolve,reject)=>{
    const xhr=new XMLHttpRequest();xhr.open('PUT',url);xhr.timeout=5*60*1000;
    for(const [key,value]of Object.entries(headers))xhr.setRequestHeader(key,value);
    const abort=()=>xhr.abort();signal.addEventListener('abort',abort,{once:true});
    const cleanup=()=>signal.removeEventListener('abort',abort);
    xhr.upload.onprogress=event=>onProgress(event.loaded);
    xhr.onload=()=>{cleanup();if(xhr.status>=200&&xhr.status<300){const etag=xhr.getResponseHeader('ETag');if(!etag)reject(new Error('R2 未暴露 ETag。请在存储桶 CORS 中添加 ExposeHeaders: ETag。'));else resolve(etag);}else reject(new R2UploadError(xhr.status,`R2 上传失败 (${xhr.status})。${xhr.responseText.slice(0,200)}`));};
    xhr.onerror=()=>{cleanup();reject(new Error('无法连接 R2。请检查网络，并在存储桶设置中启用当前网盘域名的 CORS。'));};
    xhr.ontimeout=()=>{cleanup();reject(new Error('分片上传超时，可点击继续重试。'));};
    xhr.onabort=()=>{cleanup();reject(new DOMException('上传已暂停','AbortError'));};
    if(signal.aborted){reject(new DOMException('上传已暂停','AbortError'));return;}
    xhr.send(body);
  });
}

class UploadManager {
  private tasks:UploadTask[]=[];
  private listeners=new Set<()=>void>();
  private activityListeners=new Set<()=>void>();
  private activity=false;
  private files=new Map<string,File>();
  private active=new Map<string,AbortController>();
  constructor(){
    try{this.tasks=(JSON.parse(localStorage.getItem(storageKey)||'[]') as UploadTask[]).filter(task=>task.id&&task.name).slice(-100).map(task=>({...task,status:['completed','cancelled'].includes(task.status)?task.status:'needs-file',speed:0}));}catch{this.tasks=[];}
  }
  subscribe=(listener:()=>void)=>{this.listeners.add(listener);return()=>this.listeners.delete(listener);};
  snapshot=()=>this.tasks;
  subscribeActivity=(listener:()=>void)=>{this.activityListeners.add(listener);return()=>this.activityListeners.delete(listener);};
  activitySnapshot=()=>this.activity;
  private update(id:string,patch:Partial<UploadTask>):void{
    this.tasks=this.tasks.map(task=>task.id===id?{...task,...patch}:task);
    if(patch.session||patch.status||patch.fingerprint){try{localStorage.setItem(storageKey,JSON.stringify(this.tasks.slice(-100)));}catch{/* A full browser store does not interrupt an in-flight upload. */}}
    for(const listener of this.listeners)listener();
    const activity=this.tasks.some(task=>['queued','uploading','completing','cancelling'].includes(task.status));
    if(activity!==this.activity){this.activity=activity;for(const listener of this.activityListeners)listener();}
  }
  add(files:File[],parent:string,bucketId?:string,allowSplit=!bucketId):void{
    const added=files.map(file=>{const id=crypto.randomUUID();this.files.set(id,file);return{id,name:file.name,path:joinPath(parent,file.webkitRelativePath||file.name),size:file.size,lastModified:file.lastModified,bucketId,allowSplit,status:'queued' as const,progress:0,speed:0,createdAt:Date.now()};});
    this.tasks=[...this.tasks,...added];this.update(added[0]?.id||'',{});this.pump();
  }
  private pump():void{
    if(this.active.size>=2)return;
    for(const task of this.tasks){
      if(this.active.size>=2)break;
      if(task.status==='queued'&&this.files.has(task.id)&&!this.active.has(task.id)){
        const controller=new AbortController();this.active.set(task.id,controller);
        void this.run(task.id,controller.signal).finally(()=>{this.active.delete(task.id);this.pump();});
      }
    }
  }
  private async run(id:string,signal:AbortSignal):Promise<void>{
    const file=this.files.get(id)!;let task=this.tasks.find(task=>task.id===id)!;
    this.update(id,{status:'uploading',error:undefined});
    try{
      const mark=await fingerprint(file);this.update(id,{fingerprint:mark});
      const resumed=Boolean(task.session);
      let session=task.session;
      if(!session){session=await api<UploadSession>('/uploads',{method:'POST',body:{path:task.path,size:file.size,contentType:file.type||'application/octet-stream',bucketId:task.bucketId,allowSplit:Boolean(task.allowSplit)}});this.update(id,{session,path:session.path});}
      else session=await api<UploadSession>(`/uploads/${session.id}`,{signal});
      if(session.status==='completed'){this.update(id,{status:'completed',progress:file.size,speed:0});return;}
      if(signal.aborted)throw new DOMException('上传已暂停','AbortError');
      const parts:UploadPart[]=[];
      if(resumed&&session.size){
        if(session.segments)for(const segment of session.segments){
          if(segment.etag)parts.push(...Array.from({length:segment.partCount},(_,index)=>({partNumber:segment.firstPartNumber+index,size:Math.min(session!.partSize,segment.size-index*session!.partSize),etag:segment.etag!})));
          else parts.push(...await api<UploadPart[]>(`/uploads/${session.id}/parts?segment=${segment.index}`,{signal}));
        }
        else parts.push(...await api<UploadPart[]>(`/uploads/${session.id}/parts`,{signal}));
      }
      let completed=parts.reduce((sum,part)=>sum+part.size,0);
      const started=Date.now();const initial=completed;const live=new Map<number,number>();
      const progress=()=>{const total=completed+[...live.values()].reduce((sum,value)=>sum+value,0);this.update(id,{progress:total,speed:Math.max(0,(total-initial)/Math.max(1,(Date.now()-started)/1000))});};
      const uploaded=new Set(parts.map((part)=>part.partNumber));
      const missing=uploadPartNumbers(session).filter(number=>!uploaded.has(number));
      const links=new UploadLinks((parts)=>api<UploadLink[]>(`/uploads/${session!.id}/urls`,{method:'POST',body:{parts},signal}));
      for(let index=0;index<missing.length;index+=UPLOAD_CONCURRENCY){
        if(signal.aborted)throw new DOMException('上传已暂停','AbortError');
        const batch=missing.slice(index,index+UPLOAD_CONCURRENCY);
        await links.ensure(batch,missing.slice(index,index+UPLOAD_URL_BATCH));
        const results=await Promise.allSettled(batch.map(async number=>{
          const range=uploadPart(session!,number);
          const blob=file.size===0?new Blob([],{type:file.type||'application/octet-stream'}):file.slice(range.offset,range.offset+range.size);
          for(let attempt=0;attempt<3;attempt++){
            await links.ensure([number]);const link=links.get(number);
            try{await put(link.url,blob,link.headers,signal,loaded=>{live.set(number,loaded);progress();});break;}
            catch(error){if(signal.aborted||attempt===2)throw error;if(error instanceof R2UploadError&&error.status===403)links.invalidate(number);live.delete(number);await new Promise(resolve=>setTimeout(resolve,1500*2**attempt));}
          }
          live.delete(number);completed+=blob.size;progress();
        }));
        const failure=results.find(result=>result.status==='rejected');
        if(failure?.status==='rejected')throw failure.reason;
      }
      if(signal.aborted)throw new DOMException('上传已暂停','AbortError');
      this.update(id,{status:'completing',progress:file.size,speed:0});
      if(session.segments)for(const segment of session.segments)if(!segment.etag)await api(`/uploads/${session.id}/segments/${segment.index}/complete`,{method:'POST',body:{}});
      await api(`/uploads/${session.id}/complete`,{method:'POST',body:{}});
      this.update(id,{status:'completed',progress:file.size,speed:0});this.files.delete(id);
    }catch(error){
      task=this.tasks.find(task=>task.id===id)!;
      if(task.status!=='cancelling')this.update(id,{status:signal.aborted?'paused':'failed',speed:0,error:signal.aborted?undefined:error instanceof Error?error.message:'上传失败'});
    }
  }
  pause(id:string):void{this.active.get(id)?.abort();const task=this.tasks.find(task=>task.id===id);if(task?.status==='queued')this.update(id,{status:'paused'});}
  resume(id:string):void{if(!this.files.has(id)){this.update(id,{status:'needs-file'});return;}this.update(id,{status:'queued',error:undefined});this.pump();}
  async reselect(id:string,file:File):Promise<void>{
    const task=this.tasks.find(task=>task.id===id);if(!task)return;
    if(file.name!==task.name||file.size!==task.size||(task.fingerprint&&await fingerprint(file)!==task.fingerprint))throw new Error('所选文件与原上传文件不匹配，请选择同一个文件。');
    this.files.set(id,file);this.resume(id);
  }
  async cancel(id:string):Promise<void>{
    this.update(id,{status:'cancelling'});this.active.get(id)?.abort();
    while(this.active.has(id))await new Promise(resolve=>setTimeout(resolve,100));
    const task=this.tasks.find(task=>task.id===id);if(!task)return;
    if(task.status==='completed')return;
    if(task.session){try{await api(`/uploads/${task.session.id}`,{method:'DELETE'});}catch(error){this.update(id,{status:'failed',error:error instanceof Error?error.message:'取消失败'});throw error;}}
    this.files.delete(id);this.update(id,{status:'cancelled',speed:0});
  }
  clearFinished():void{this.tasks=this.tasks.filter(task=>!['completed','cancelled'].includes(task.status));this.update('',{status:'queued'});}
}

export const uploads=new UploadManager();
