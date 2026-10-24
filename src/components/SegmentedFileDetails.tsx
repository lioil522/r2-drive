import { useContext, useState } from 'react';
import { Copy, Save } from 'lucide-react';
import type { Account, Bucket, DriveFile, FileMetadata } from '../../shared/types';
import { formatBytes } from '../../shared/paths';
import { fileSegments, isSegmented } from '../../shared/segments';
import { api, copyText } from '../api';
import { dateTime, ToastContext, useAction, useResource } from '../hooks';
import { Badge, Button, ErrorBox, Field, Loading, Modal, Notice, Tabs } from './ui';

export default function SegmentedFileDetails({file,accounts,buckets,onClose}:{file:DriveFile;accounts:Account[];buckets:Bucket[];onClose:()=>void}) {
  const resource=useResource<DriveFile>(`/files/${file.id}`);
  const [tab,setTab]=useState('details');
  const [metadata,setMetadata]=useState<FileMetadata>(file.metadata);
  const [custom,setCustom]=useState(JSON.stringify(file.metadata.custom || {},null,2));
  const {busy,run}=useAction();const toast=useContext(ToastContext);
  const current=resource.data;
  const copy=(value:string)=>void copyText(value).then(()=>toast('已复制','success')).catch(()=>toast('复制失败','error'));
  const save=()=>void run(()=>api(`/files/${file.id}/metadata`,{method:'PUT',body:{metadata:{...metadata,custom:JSON.parse(custom) as Record<string,string>}}}),'分段文件元数据已保存').then((result)=>{if(result)onClose();});
  return <Modal title={isSegmented(file)?'跨账号文件信息':'缺失文件信息'} subtitle={file.name} onClose={onClose} wide>
    <Notice>{isSegmented(file)?'这是一个逻辑文件，数据分布在多个 R2 对象中。下载和预览会自动流式重组，重命名和移动目录不会拆散分段索引。':'远端对象当前缺失。可同步容量重新查找对象，或从缺失文件页面永久清理索引。'}</Notice>
    <Tabs tabs={[{id:'details',label:'基本信息'},{id:'segments',label:'分段位置'},{id:'metadata',label:'HTTP 元数据'}]} value={tab} onChange={setTab}/>
    {resource.error&&<ErrorBox message={resource.error} retry={()=>void resource.reload()}/>}
    {!current?<Loading/>:tab==='details'?<dl className="detail-list">
      {([['网盘路径',current.path],['文件状态',current.status==='missing'?'缺失':current.status==='busy'?'任务处理中':'可用'],['文件大小',formatBytes(current.size)],['分段数量',`${fileSegments(current).length} / ${current.segmentCount || 1}`],['存储账号',String(new Set(fileSegments(current).map((part)=>part.accountId)).size)],['创建时间',dateTime(current.createdAt)],['修改时间',dateTime(current.modifiedAt)],['文件版本',current.etag]]).map(([label,value])=><div key={label}><dt>{label}</dt><dd>{value}<button title="复制" onClick={()=>copy(value)}><Copy size={13}/></button></dd></div>)}
    </dl>:tab==='segments'?<div className="table-scroll"><table className="file-table"><thead><tr><th>分段</th><th>账号 / 桶</th><th>文件偏移</th><th>大小</th><th>状态</th><th>对象键</th></tr></thead><tbody>
      {fileSegments(current).map((part)=><tr key={part.index}><td>{part.index+1}</td><td>{accounts.find((account)=>account.id===part.accountId)?.name || part.accountId}<small>{buckets.find((bucket)=>bucket.id===part.bucketId)?.name || part.bucketId}</small></td><td>{formatBytes(part.offset)}</td><td>{formatBytes(part.size)}</td><td><Badge color={part.status==='ready'&&(part.actualSize ?? part.size)===part.size?'green':'red'}>{part.status!=='ready'?'缺失':(part.actualSize ?? part.size)!==part.size?'长度异常':'可用'}</Badge></td><td><code>{part.objectKey}</code><button title="复制对象键" onClick={()=>copy(part.objectKey)}><Copy size={13}/></button></td></tr>)}
    </tbody></table></div>:<div className="form-stack">
      <Notice>元数据保存在逻辑文件索引中，用于重组后的文件响应。各分段使用独立对象键；需要改变存储位置或存储类型时，可迁移到容量充足的目标桶。</Notice>
      <div className="form-grid"><Field label="Content-Type"><input value={metadata.contentType} onChange={(event)=>setMetadata({...metadata,contentType:event.target.value})}/></Field><Field label="Cache-Control" optional><input value={metadata.cacheControl || ''} onChange={(event)=>setMetadata({...metadata,cacheControl:event.target.value})}/></Field><Field label="Content-Disposition" optional><input value={metadata.contentDisposition || ''} onChange={(event)=>setMetadata({...metadata,contentDisposition:event.target.value})}/></Field><Field label="Content-Encoding" optional><input value={metadata.contentEncoding || ''} onChange={(event)=>setMetadata({...metadata,contentEncoding:event.target.value})}/></Field><Field label="Content-Language" optional><input value={metadata.contentLanguage || ''} onChange={(event)=>setMetadata({...metadata,contentLanguage:event.target.value})}/></Field></div>
      <Field label="自定义元数据 · JSON"><textarea className="code-input" value={custom} onChange={(event)=>setCustom(event.target.value)} rows={5}/></Field><Button icon={Save} variant="primary" busy={busy} disabled={current.status!=='ready'} onClick={save}>保存元数据</Button>
    </div>}
  </Modal>;
}
