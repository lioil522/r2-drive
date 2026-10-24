import { useContext, useState } from 'react';
import { AlertTriangle, ArrowLeft, ArrowRight, Info, RefreshCw, Trash2 } from 'lucide-react';
import type { DriveFile, FileList } from '../../shared/types';
import { formatBytes } from '../../shared/paths';
import { api } from '../api';
import { IDLE_INTERVAL, ToastContext, useAction, useDriveStatus, useResource } from '../hooks';
import { refreshFileList } from '../file-refresh';
import { Button, Card, ConfirmModal, Empty, ErrorBox, FileIcon, IconButton, Loading, Notice, PageHeader } from '../components/ui';
import { FileDetails } from '../components/FileDialogs';

export default function MissingFiles() {
  const [page,setPage]=useState(1);const [details,setDetails]=useState<DriveFile|null>(null);const [removing,setRemoving]=useState<DriveFile|null>(null);
  const status=useDriveStatus();const {busy,run}=useAction();
  const files=useResource<FileList>(`/files?view=missing&page=${page}&pageSize=50`,status.active?12000:IDLE_INTERVAL);
  const [refreshing,setRefreshing]=useState(false);const [checkError,setCheckError]=useState('');const toast=useContext(ToastContext);
  const refresh=async()=>{
    if(refreshing)return;setRefreshing(true);setCheckError('');
    try {
      const result=await refreshFileList(`/files?view=missing&page=${page}&pageSize=50`);if(!result)return;
      if(result.errors.length)setCheckError(result.errors.slice(0,3).map((error)=>error.message).join('；'));
      else toast(result.restoredFiles ? `已找回 ${result.restoredFiles} 个文件` : '缺失文件列表已刷新','success');
      const last=Math.max(1,Math.ceil(result.list.total/50));if(page>last)setPage(last);
    } finally {setRefreshing(false);}
  };
  return <>
    <PageHeader title="缺失文件" eyebrow="MISSING OBJECTS" description="检查远端对象或分段缺失的文件，查看分段位置，或清理剩余对象释放空间。" actions={<Button icon={RefreshCw} busy={refreshing} onClick={()=>void refresh()}>刷新</Button>}/>
    <Notice>重新连接账号并同步容量可恢复已找回的分段。永久删除会一并清理仍存在的分段；取消批量删除会先完成当前文件的清理。</Notice>
    {files.error&&<ErrorBox message={files.error} retry={()=>void refresh()}/>}
    {checkError&&<ErrorBox message={checkError} retry={()=>void refresh()}/>}
    <Card>{files.loading&&!files.data?<Loading/>:!files.data?.files.length?<Empty icon={AlertTriangle} title="没有缺失文件" description="文件对象和已知分段均可用。"/>:<div className="table-scroll"><table className="file-table"><thead><tr><th>文件</th><th>逻辑大小</th><th>分段</th><th>操作</th></tr></thead><tbody>
      {files.data.files.map((file)=><tr key={file.id}><td><button className="file-name" onClick={()=>setDetails(file)}><FileIcon name={file.name}/><span>{file.name}<small>{file.path}</small></span></button></td><td>{formatBytes(file.size)}</td><td>{file.segmentCount || 1}</td><td><div className="row-actions"><IconButton icon={Info} label="查看位置" onClick={()=>setDetails(file)}/><IconButton icon={Trash2} label="清理剩余对象" onClick={()=>setRemoving(file)}/></div></td></tr>)}
    </tbody></table></div>}
    <div className="files-footer"><span>{files.data?.total || 0} 个缺失文件</span><div><IconButton icon={ArrowLeft} label="上一页" disabled={page<=1} onClick={()=>setPage(value=>value-1)}/><span>第 {page} 页</span><IconButton icon={ArrowRight} label="下一页" disabled={page*50>=(files.data?.total || 0)} onClick={()=>setPage(value=>value+1)}/></div></div></Card>
    {details&&<FileDetails file={details} accounts={status.data?.accounts || []} buckets={status.data?.buckets || []} onClose={()=>setDetails(null)}/>}
    {removing&&<ConfirmModal title={`永久清理 ${removing.name}？`} description="仍存在的远端对象与分段会被删除，文件索引与分享链接一并移除。此操作不可撤销。" confirm="清理剩余对象" danger busy={busy} onClose={()=>setRemoving(null)} onConfirm={()=>void run(()=>api('/files/delete',{method:'POST',body:{ids:[removing.id]}}),'清理任务已创建').then((result)=>{if(result)setRemoving(null);})}/>}
  </>;
}
