import type { FileList, FileRefreshResult } from '../shared/types';
import { api } from './api';
import { resourceCache } from './resources';

export async function refreshFileList(path: string): Promise<FileRefreshResult | null> {
  let result: FileRefreshResult | undefined;
  await resourceCache.refresh(path,async(_path,signal)=>{
    const query=path.includes('?') ? path.slice(path.indexOf('?')) : '';
    result=await api<FileRefreshResult>(`/files/refresh${query}`,{method:'POST',body:{},signal,invalidate:false});
    return result.list;
  },300_000);
  const snapshot=resourceCache.getSnapshot<FileList>(path);
  if (!result || snapshot.loading || snapshot.error) return null;
  resourceCache.setData('/status',result.status);
  resourceCache.setData(path,result.list);
  if (result.changedFiles) resourceCache.invalidate((key)=>(key.startsWith('/files') && key!==path) || key==='/dashboard' || key==='/shares');
  return result;
}
