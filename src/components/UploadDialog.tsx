import { useContext, useRef, useState, type InputHTMLAttributes } from 'react';
import { CloudUpload, FolderUp, Plus, X } from 'lucide-react';
import { formatBytes } from '../../shared/paths';
import { navigate, ToastContext, useDriveStatus } from '../hooks';
import { uploads } from '../upload-manager';
import { Button, CheckBox, Field, FileIcon, IconButton, Modal, Notice } from './ui';

const directoryInput = { webkitdirectory: '' } as unknown as InputHTMLAttributes<HTMLInputElement>;

export default function UploadDialog({parent='/',bucketId,onClose}:{parent?:string;bucketId?:string;onClose:()=>void}) {
  const [files,setFiles]=useState<File[]>([]);const [destination,setDestination]=useState(parent);const [target,setTarget]=useState(bucketId||'');
  const [allowSplit,setAllowSplit]=useState(true);
  const fileInput=useRef<HTMLInputElement>(null);const folderInput=useRef<HTMLInputElement>(null);
  const status=useDriveStatus();const accounts={data:status.data?.accounts};const buckets={data:status.data?.buckets};const toast=useContext(ToastContext);
  const add=(items:File[])=>setFiles(previous=>[...previous,...items]);
  const ready=(accounts.data||[]).some(account=>account.enabled&&account.syncState==='ready');
  const upload=()=>{try{uploads.add(files,destination,target||undefined,!target&&allowSplit);toast(`已添加 ${files.length} 个上传文件`,'success');onClose();navigate('transfers');}catch(error){toast(error instanceof Error?error.message:'路径无效','error');}};
  return<Modal title="上传到你的云盘" subtitle="文件直传 R2，分片上传支持暂停、重试和断点续传。" onClose={onClose} wide footer={<><span className="footer-note">{files.length} 个文件 · {formatBytes(files.reduce((sum,file)=>sum+file.size,0))}</span><Button onClick={onClose}>取消</Button><Button variant="primary" icon={CloudUpload} disabled={!files.length||!ready} onClick={upload}>开始上传</Button></>}><div className="form-stack">
    <div className="upload-dropzone" onDragOver={event=>event.preventDefault()} onDrop={event=>{event.preventDefault();add(Array.from(event.dataTransfer.files));}}><span><CloudUpload size={37} strokeWidth={1.5}/></span><h3>把文件拖到这里</h3><p>或从你的电脑选择文件、整个文件夹</p><div><Button icon={Plus} onClick={()=>fileInput.current?.click()}>选择文件</Button><Button icon={FolderUp} onClick={()=>folderInput.current?.click()}>选择文件夹</Button></div><input ref={fileInput} hidden type="file" multiple onChange={event=>{add(Array.from(event.target.files||[]));event.target.value='';}}/><input ref={folderInput} hidden type="file" multiple {...directoryInput} onChange={event=>{add(Array.from(event.target.files||[]));event.target.value='';}}/></div>
    {files.length>0&&<div className="upload-file-list">{files.map((file,index)=><div key={`${file.name}-${index}`}><FileIcon name={file.name}/><span title={file.webkitRelativePath||file.name}>{file.webkitRelativePath||file.name}</span><small>{formatBytes(file.size)}</small><IconButton icon={X} label="移除文件" onClick={()=>setFiles(previous=>previous.filter((_,item)=>item!==index))}/></div>)}</div>}
    <div className="form-grid"><Field label="网盘目录"><input value={destination} onChange={event=>setDestination(event.target.value)} placeholder="/"/></Field><Field label="存储分配"><select value={target} onChange={event=>setTarget(event.target.value)}><option value="">智能分配 · 按账号优先级</option>{(accounts.data||[]).map(account=><optgroup key={account.id} label={`${account.name} · ${formatBytes(account.availableBytes)} 可用`}>{(buckets.data||[]).filter(bucket=>bucket.accountId===account.id).map(bucket=><option key={bucket.id} value={bucket.id} disabled={!account.enabled||account.syncState!=='ready'}>{bucket.name}</option>)}</optgroup>)}</select></Field></div>
      {!target&&<div className="toggle-group"><CheckBox checked={allowSplit} onChange={()=>setAllowSplit(value=>!value)} label="允许跨账号拆分"/><div><strong>空间不足时允许跨账号拆分</strong><small>优先整文件存放；单账号放不下时自动分段，下载时由网盘重组。</small></div></div>}
      {!ready?<Notice type="warning">请先添加账号并完成容量同步。上传前，在存储桶设置中为当前网盘域名配置 CORS。</Notice>:<Notice><strong>智能容量预占：</strong>上传前原子预留所有分段的空间，防止并发超额。指定存储桶时只使用该桶；同名文件自动添加序号。</Notice>}
  </div></Modal>;
}
