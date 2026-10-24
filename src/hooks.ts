import { createContext, useCallback, useContext, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { Dashboard, DriveStatus } from '../shared/types';
import { resourceCache } from './resources';
import { uploads } from './upload-manager';

export const ToastContext=createContext<(message:string,type?:'success'|'error'|'info')=>void>(()=>{});

interface ResourceOptions<T> { interval?: number | ((data: T | null) => number); staleTime?: number }
export const IDLE_INTERVAL=120_000;

export function useResource<T>(path: string | null, options: number | ResourceOptions<T> = 0) {
  const current=useRef(options);current.current=options;
  const subscribe=useCallback((listener:()=>void)=>path ? resourceCache.subscribe(path,listener,()=>{
    const settings=typeof current.current==='number' ? {interval:current.current} : current.current;
    const interval=settings.interval;
    return {interval:typeof interval==='function' ? interval(resourceCache.getSnapshot<T>(path).data) : interval || 0,staleTime:settings.staleTime ?? 30_000};
  }) : ()=>{},[path]);
  const snapshot=useSyncExternalStore(subscribe,useCallback(()=>resourceCache.getSnapshot<T>(path),[path]));
  const reload=useCallback(async()=>{
    if(!path)return false;
    await resourceCache.refresh(path);
    const current=resourceCache.getSnapshot<T>(path);
    return !current.loading && !current.error;
  },[path]);
  const setData=useCallback((value:T|null|((previous:T|null)=>T|null))=>{if(path)resourceCache.setData(path,value);},[path]);
  useEffect(()=>{if(path)resourceCache.reschedule(path);},[path,options]);
  return{...snapshot,setData,reload};
}

function hasRemoteActivity(data: DriveStatus | null): boolean {
  if (!data) return false;
  if (data.hasActiveJobs) return true;
  return data.uploads.some((session)=>{
    if (session.status==='cancelling') return true;
    const local=uploads.snapshot().find((task)=>task.session?.id===session.id);
    return !local || ['queued','uploading','completing','cancelling','completed'].includes(local.status);
  });
}

export function useDriveStatus(activeInterval=10_000) {
  const localActive=useSyncExternalStore(uploads.subscribeActivity,uploads.activitySnapshot);
  const resource=useResource<DriveStatus>('/status',{interval:(data)=>localActive || hasRemoteActivity(data) ? activeInterval : IDLE_INTERVAL});
  return{...resource,active:localActive || hasRemoteActivity(resource.data)};
}

export function useDashboard() {
  const localActive=useSyncExternalStore(uploads.subscribeActivity,uploads.activitySnapshot);
  return useResource<Dashboard>('/dashboard',{interval:(data)=>localActive || hasRemoteActivity(data) ? 15000 : IDLE_INTERVAL});
}

export function useAction() {
  const [busy,setBusy]=useState(false);
  const toast=useContext(ToastContext);
  const run=async<T,>(action:()=>Promise<T>,success?:string):Promise<T|undefined>=>{
    setBusy(true);
    try{const result=await action();if(success)toast(success,'success');return result;}
    catch(error){toast(error instanceof Error?error.message:'操作失败','error');return undefined;}
    finally{setBusy(false);}
  };
  return{busy,run};
}

export function useHashRoute() {
  const [route,setRoute]=useState(()=>location.hash.slice(2)||'overview');
  useEffect(()=>{const handler=()=>setRoute(location.hash.slice(2)||'overview');window.addEventListener('hashchange',handler);return()=>window.removeEventListener('hashchange',handler);},[]);
  return route;
}

export function navigate(route:string):void {location.hash=`/${route}`;}

export function dateTime(value:number):string {
  return new Intl.DateTimeFormat('zh-CN',{month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false}).format(value);
}

export function relativeTime(value:number):string {
  const minutes=Math.floor((Date.now()-value)/60000);
  if(minutes<1)return'刚刚';if(minutes<60)return`${minutes} 分钟前`;
  if(minutes<1440)return`${Math.floor(minutes/60)} 小时前`;
  if(minutes<10080)return`${Math.floor(minutes/1440)} 天前`;
  return dateTime(value);
}
