import { useContext, useEffect, useRef, useState } from 'react';
import { ArrowDownUp, ArrowLeft, ArrowRight, Check, ChevronRight, CloudUpload, Copy, Download, FolderInput, FolderPlus, Grid2X2, Home, Info, List, Pencil, RefreshCw, RotateCcw, Search, Share2, Star, Trash2, X } from 'lucide-react';
import type { DriveFile, FileList, Folder } from '../../shared/types';
import { formatBytes, joinPath, parentPath } from '../../shared/paths';
import { api } from '../api';
import { dateTime, IDLE_INTERVAL, navigate, ToastContext, useAction, useDriveStatus, useResource } from '../hooks';
import { Badge, Button, Card, CheckBox, ConfirmModal, Empty, ErrorBox, Field, FileIcon, IconButton, Loading, Menu, Modal, Notice, PageHeader } from '../components/ui';
import { FileDetails, PreviewDialog, ShareDialog, TransferDialog } from '../components/FileDialogs';
import { uploads } from '../upload-manager';
import { isSegmented } from '../../shared/segments';
import { refreshFileList } from '../file-refresh';

type Dialog={type:'preview'|'details'|'share';file:DriveFile}|{type:'transfer';files:DriveFile[]}|{type:'rename'|'move';file:DriveFile}|{type:'folder'|'folder-rename';folder?:Folder}|{type:'trash'|'permanent'|'restore';files:DriveFile[]}|{type:'folder-trash';folder:Folder};

export default function Files({view='all',params,onUpload}:{view?:'all'|'recent'|'starred'|'trash';params?:URLSearchParams;onUpload:(parent?:string,bucketId?:string)=>void}) {
  const [parent,setParent]=useState('/');const [search,setSearch]=useState('');const [query,setQuery]=useState('');const [page,setPage]=useState(1);const [layout,setLayout]=useState(localStorage.getItem('r2-drive-layout')||'list');const [sort,setSort]=useState('name');const [direction,setDirection]=useState('asc');const [selected,setSelected]=useState<Set<string>>(new Set());const [dialog,setDialog]=useState<Dialog|null>(null);const [input,setInput]=useState('');const [dragging,setDragging]=useState(false);const dragDepth=useRef(0);
  const bucketId=params?.get('bucket')||undefined;const accountId=params?.get('account')||undefined;
  const queryString=new URLSearchParams({parent,view,page:String(page),pageSize:'50',sort,direction,...query?{search:query}:{},...bucketId?{bucketId}:{},...accountId?{accountId}:{}}).toString();
  const status=useDriveStatus(15_000);
  const [refreshing,setRefreshing]=useState(false);
  const [checkError,setCheckError]=useState('');
  const resource=useResource<FileList>(`/files?${queryString}`,status.active?12000:IDLE_INTERVAL);
  const accounts={data:status.data?.accounts};const buckets={data:status.data?.buckets};
  const {busy,run}=useAction();const toast=useContext(ToastContext);const data=resource.data;
  const refresh=async()=>{
    if(refreshing)return;
    setRefreshing(true);
    setCheckError('');
    try {
      const result=await refreshFileList(`/files?${queryString}`);
      if (!result) return;
      if (result.errors.length) setCheckError(`部分文件未能完成远端校验：${result.errors.slice(0,3).map((error)=>error.message).join('；')}`);
      else toast(result.missingFiles ? `已刷新，${result.missingFiles} 个缺失文件已移至“缺失文件”` : '文件列表已刷新','success');
      setSelected((current)=>new Set([...current].filter((id)=>result.list.files.some((file)=>file.id===id))));
      const last=Math.max(1,Math.ceil(result.list.total/50));if(page>last)setPage(last);
    }
    finally {setRefreshing(false);}
  };
  const bucket=buckets.data?.find(bucket=>bucket.id===bucketId);
  const selectedFiles=(data?.files||[]).filter(file=>selected.has(file.id));
  useEffect(()=>{const timer=setTimeout(()=>{setQuery(search);setPage(1);},250);return()=>clearTimeout(timer);},[search]);
  useEffect(()=>{setSelected(new Set());},[parent,view,page,query,bucketId]);
  useEffect(()=>{const id=params?.get('open');if(id)void api<DriveFile>(`/files/${id}`).then(file=>setDialog({type:'preview',file})).catch(error=>toast(error.message,'error'));},[params?.get('open')]);
  const openPath=(path:string)=>{setParent(path);setPage(1);setSearch('');};
  const toggle=(id:string)=>setSelected(previous=>{const result=new Set(previous);result.has(id)?result.delete(id):result.add(id);return result;});
  const download=(file:DriveFile)=>void run(async()=>{const {url}=await api<{url:string}>(`/files/${file.id}/download`);location.assign(url);});
  const rename=(file:DriveFile,type:'rename'|'move')=>{setInput(type==='rename'?file.name:file.parent);setDialog({type,file});};
  const star=(file:DriveFile)=>void run(()=>api(`/files/${file.id}`,{method:'PATCH',body:{starred:!file.starred}}));
  const close=()=>setDialog(null);
  const apply=async()=>{
    if(!dialog)return;
    const result=await run(async()=>{
      if(dialog.type==='folder')return api('/folders',{method:'POST',body:{path:joinPath(parent,input)}});
      if(dialog.type==='folder-rename')return api(`/folders/${dialog.folder!.id}`,{method:'PATCH',body:{path:joinPath(dialog.folder!.parent,input)}});
      if(dialog.type==='rename'||dialog.type==='move')return api(`/files/${dialog.file.id}`,{method:'PATCH',body:{path:dialog.type==='rename'?joinPath(dialog.file.parent,input):joinPath(input,dialog.file.name)}});
      if(dialog.type==='folder-trash')return api(`/folders/${dialog.folder.id}`,{method:'DELETE'});
      if(dialog.type==='permanent')return api('/files/delete',{method:'POST',body:{ids:dialog.files.map(file=>file.id)}});
      if(dialog.type==='trash'||dialog.type==='restore'){for(const file of dialog.files)await api(`/files/${file.id}`,{method:'PATCH',body:{status:dialog.type==='trash'?'trash':'ready'}});return{ok:true};}
    },dialog.type==='permanent'?'永久删除任务已创建':'操作完成');
    if(result){close();setSelected(new Set());}
  };
  const fileMenu=(file:DriveFile)=>view==='trash'?[{label:'恢复文件',icon:RotateCcw,action:()=>setDialog({type:'restore',files:[file]})},{label:'永久删除',icon:Trash2,danger:true,action:()=>setDialog({type:'permanent',files:[file]})}]:[
    {label:'预览',icon:Search,action:()=>setDialog({type:'preview',file})},{label:'下载文件',icon:Download,action:()=>download(file)},
    {label:'分享',icon:Share2,action:()=>setDialog({type:'share',file})},{label:'重命名',icon:Pencil,disabled:file.status!=='ready',action:()=>rename(file,'rename')},
    {label:'移动到文件夹',icon:FolderInput,disabled:file.status!=='ready',action:()=>rename(file,'move')},{label:'迁移 / 复制到存储桶',icon:Copy,disabled:file.status!=='ready',action:()=>setDialog({type:'transfer',files:[file]})},
    {label:file.starred?'取消收藏':'收藏文件',icon:Star,disabled:file.status!=='ready',action:()=>star(file)},{label:'详细信息与元数据',icon:Info,action:()=>setDialog({type:'details',file})},{label:'移入回收站',icon:Trash2,danger:true,disabled:file.status!=='ready',action:()=>setDialog({type:'trash',files:[file]})},{label:'永久删除',icon:X,danger:true,disabled:file.status!=='ready',action:()=>setDialog({type:'permanent',files:[file]})},
  ];
  const title=bucket?bucket.name:view==='recent'?'最近文件':view==='starred'?'我的收藏':view==='trash'?'回收站':'我的文件';
  return<>
    <PageHeader eyebrow={bucket?'BUCKET OBJECTS':'YOUR FILES'} title={title} description={bucket?'查看此存储桶中的文件、实际对象键及元数据。':view==='trash'?'已删除的文件仍保留在 R2 中，永久删除后才会释放容量。':view==='recent'?'按最近修改时间查看文件。':view==='starred'?'把重要的文件放在这里，随时快速找到。':'自由整理文件夹，上传时自动选择容量充足的账号。'} actions={view==='all'?<><Button icon={FolderPlus} onClick={()=>{setInput('');setDialog({type:'folder'});}}>新建文件夹</Button><Button variant="primary" icon={CloudUpload} onClick={()=>onUpload(parent,bucketId)}>上传文件</Button></>:undefined}/>
    {bucket&&<div className="bucket-file-banner"><Badge color="orange">R2 存储桶</Badge><span>{accounts.data?.find(account=>account.id===bucket.accountId)?.name} / {bucket.name}</span><button className="text-link" onClick={()=>navigate(`bucket/${bucket.id}`)}>存储桶设置 <ArrowRight size={15}/></button></div>}
    {view==='trash'&&<Notice>回收站不会改变文件的远端对象键。恢复文件遇到同名路径时，会自动添加序号。</Notice>}
    {data?.files.some(isSegmented)&&<Notice>本页包含 {data.files.filter(isSegmented).length} 个跨账号分段文件。点击文件详情可查看每段所在账号、存储桶及对象键。</Notice>}
    <Card className={`files-card ${dragging?'files-dragging':''}`}>
      <div className="files-drop-area" onDragEnter={event=>{event.preventDefault();dragDepth.current++;if(view!=='trash')setDragging(true);}} onDragOver={event=>event.preventDefault()} onDragLeave={event=>{event.preventDefault();dragDepth.current--;if(dragDepth.current<=0)setDragging(false);}} onDrop={event=>{event.preventDefault();dragDepth.current=0;setDragging(false);if(view==='trash')return;const files=Array.from(event.dataTransfer.files);if(files.length){uploads.add(files,parent,bucketId);toast(`已添加 ${files.length} 个上传文件`,'info');}}}>
      {dragging&&<div className="drop-overlay"><CloudUpload size={45}/><strong>松开鼠标，上传到当前目录</strong><span>文件自动分配到容量充足的账号</span></div>}
      <div className="files-toolbar"><div className="breadcrumbs"><button onClick={()=>openPath('/')}><Home size={15}/>{bucket?'所有对象':'我的文件'}</button>{!bucketId&&parent.split('/').filter(Boolean).map((part,index,parts)=><span key={index}><ChevronRight size={13}/><button onClick={()=>openPath('/'+parts.slice(0,index+1).join('/'))}>{part}</button></span>)}</div><div className="files-tools"><div className="search-input"><Search size={15}/><input value={search} onChange={event=>setSearch(event.target.value)} placeholder="搜索文件…" aria-label="搜索文件"/>{search&&<button onClick={()=>setSearch('')}><X size={13}/></button>}</div><select className="sort-select" aria-label="文件排序" value={`${sort}:${direction}`} onChange={event=>{const[sort,direction]=event.target.value.split(':');setSort(sort);setDirection(direction);}}><option value="name:asc">名称 A–Z</option><option value="modifiedAt:desc">最近修改</option><option value="size:desc">文件从大到小</option><option value="size:asc">文件从小到大</option></select><div className="view-toggle"><IconButton icon={List} label="列表视图" className={layout==='list'?'active':''} onClick={()=>{setLayout('list');localStorage.setItem('r2-drive-layout','list');}}/><IconButton icon={Grid2X2} label="网格视图" className={layout==='grid'?'active':''} onClick={()=>{setLayout('grid');localStorage.setItem('r2-drive-layout','grid');}}/></div><IconButton icon={RefreshCw} label="刷新文件" busy={refreshing} onClick={()=>void refresh()}/></div></div>
      {selected.size>0&&<div className="selection-bar"><span><Check size={15}/>已选择 {selected.size} 个文件</span><div>{view==='trash'?<><Button variant="ghost" icon={RotateCcw} onClick={()=>setDialog({type:'restore',files:selectedFiles})}>恢复</Button><Button variant="ghost" icon={Trash2} onClick={()=>setDialog({type:'permanent',files:selectedFiles})}>永久删除</Button></>:<><Button variant="ghost" icon={Copy} onClick={()=>setDialog({type:'transfer',files:selectedFiles})}>迁移 / 复制</Button><Button variant="ghost" icon={Trash2} onClick={()=>setDialog({type:'trash',files:selectedFiles})}>移入回收站</Button></>}<IconButton icon={X} label="取消选择" onClick={()=>setSelected(new Set())}/></div></div>}
      {resource.error&&<ErrorBox message={resource.error} retry={()=>void refresh()}/>}
      {checkError&&<ErrorBox message={checkError} retry={()=>void refresh()}/>}
      {status.error&&status.error!==resource.error&&<ErrorBox message={status.error} retry={()=>void refresh()}/>}
      {resource.loading&&!data?<Loading/>:!data?.files.length&&!data?.folders.length?<Empty icon={view==='trash'?Trash2:view==='starred'?Star:CloudUpload} title={query?'没有找到匹配的文件':view==='trash'?'回收站是空的':view==='starred'?'收藏你常用的文件':'给文件一个新空间'} description={query?'试试其他文件名或关键词。':view==='trash'?'删除的文件会出现在这里。':view==='starred'?'在文件菜单中点击「收藏文件」，即可在这里快速访问。':'拖放文件到这里，或点击上传。我们会自动安排存储账号。'} action={view==='all'&&!query?<Button variant="primary" icon={CloudUpload} onClick={()=>onUpload(parent,bucketId)}>上传第一份文件</Button>:undefined}/>:layout==='list'?<div className="table-scroll"><table className="file-table"><thead><tr><th className="select-cell"><CheckBox checked={Boolean(data?.files.length)&&selected.size===data?.files.length} onChange={()=>setSelected(selected.size===data?.files.length?new Set():new Set(data?.files.map(file=>file.id)))} label="选择本页全部文件"/></th><th><button onClick={()=>{setSort('name');setDirection(direction==='asc'?'desc':'asc');}}>名称 <ArrowDownUp size={12}/></button></th><th>大小</th><th>{bucket?'R2 对象键':'存储位置'}</th><th>修改时间</th><th className="action-cell"/></tr></thead><tbody>{data?.folders.map(folder=><tr key={folder.id} className="folder-row"><td/><td><button className="file-name" onClick={()=>openPath(folder.path)}><FileIcon name={folder.name} folder/><span>{folder.name}</span></button></td><td>—</td><td>文件夹</td><td>{dateTime(folder.createdAt)}</td><td><Menu items={[{label:'重命名文件夹',icon:Pencil,action:()=>{setInput(folder.name);setDialog({type:'folder-rename',folder});}},{label:'移入回收站',icon:Trash2,danger:true,action:()=>setDialog({type:'folder-trash',folder})}]}/></td></tr>)}{data?.files.map(file=><tr key={file.id} className={selected.has(file.id)?'selected':''} onDoubleClick={()=>view!=='trash'&&setDialog({type:'preview',file})}><td><CheckBox checked={selected.has(file.id)} onChange={()=>toggle(file.id)} label={`选择 ${file.name}`}/></td><td><button className="file-name" onClick={()=>setDialog({type:'details',file})}><FileIcon name={file.name}/><span><strong>{file.name}</strong>{query&&<small>{file.parent}</small>}</span>{file.starred&&<Star size={13} className="star-filled"/>}{file.status==='busy'&&<Badge color="blue">处理中</Badge>}</button></td><td className="muted">{formatBytes(file.size)}</td><td><div className="file-location">{bucket?<code title={file.objectKey}>{file.objectKey}</code>:<><i className={`location-dot color-${(accounts.data?.findIndex(account=>account.id===file.accountId)||0)%4}`}/><span>{accounts.data?.find(account=>account.id===file.accountId)?.name||'存储账号'}<small>{buckets.data?.find(bucket=>bucket.id===file.bucketId)?.name}</small></span></>}</div></td><td className="muted nowrap">{dateTime(file.modifiedAt)}</td><td><Menu items={fileMenu(file)}/></td></tr>)}</tbody></table></div>:<div className="file-grid">{data?.folders.map(folder=><div className="file-grid-item folder-grid-item" key={folder.id}><button onClick={()=>openPath(folder.path)}><FileIcon name={folder.name} folder large/><strong>{folder.name}</strong><small>文件夹</small></button><Menu items={[{label:'重命名',icon:Pencil,action:()=>{setInput(folder.name);setDialog({type:'folder-rename',folder});}},{label:'移入回收站',icon:Trash2,danger:true,action:()=>setDialog({type:'folder-trash',folder})}]}/></div>)}{data?.files.map(file=><div className={`file-grid-item ${selected.has(file.id)?'selected':''}`} key={file.id}><div className="grid-item-tools"><CheckBox checked={selected.has(file.id)} label={`选择 ${file.name}`} onChange={()=>toggle(file.id)}/><Menu items={fileMenu(file)}/></div><button onClick={()=>view!=='trash'&&setDialog({type:'preview',file})}><FileIcon name={file.name} large/><strong>{file.name}</strong><small>{formatBytes(file.size)} · {dateTime(file.modifiedAt)}</small></button>{file.starred&&<Star size={13} className="star-filled grid-star"/>}</div>)}</div>}
      <div className="files-footer"><span>{data?.folders.length||0} 个文件夹 · {data?.total||0} 个文件</span><div><IconButton icon={ArrowLeft} label="上一页" disabled={page<=1} onClick={()=>setPage(page-1)}/><span>第 {page} / {Math.max(1,Math.ceil((data?.total||0)/50))} 页</span><IconButton icon={ArrowRight} label="下一页" disabled={page*50>=(data?.total||0)} onClick={()=>setPage(page+1)}/></div></div>
      </div>
    </Card>
    {dialog?.type==='preview'&&<PreviewDialog file={dialog.file} onClose={close}/>}
    {dialog?.type==='details'&&<FileDetails file={dialog.file} accounts={accounts.data||[]} buckets={buckets.data||[]} onClose={close}/>}
    {dialog?.type==='share'&&<ShareDialog file={dialog.file} onClose={close}/>}
    {dialog?.type==='transfer'&&<TransferDialog files={dialog.files} accounts={accounts.data||[]} buckets={buckets.data||[]} onClose={close}/>}
    {dialog&&['rename','move','folder','folder-rename'].includes(dialog.type)&&<Modal title={dialog.type==='move'?'移动到文件夹':dialog.type==='folder'?'新建文件夹':'重命名'} onClose={close} footer={<><Button onClick={close}>取消</Button><Button variant="primary" busy={busy} onClick={()=>void apply()}>保存</Button></>}><form onSubmit={event=>{event.preventDefault();void apply();}}><Field label={dialog.type==='move'?'目标文件夹路径':'名称'} hint={dialog.type==='move'?'例如 /照片/2026，目标文件夹会自动创建。':undefined}><input autoFocus value={input} onChange={event=>setInput(event.target.value)} required/></Field><button hidden type="submit"/></form></Modal>}
    {dialog&&['trash','permanent','restore','folder-trash'].includes(dialog.type)&&<ConfirmModal title={dialog.type==='permanent'?'永久删除文件？':dialog.type==='restore'?'恢复选中的文件？':'移入回收站？'} description={dialog.type==='permanent'?'R2 中的文件将永久删除并释放容量，此操作不可撤销。相关分享也会失效。':dialog.type==='restore'?'文件恢复到原目录；遇到同名路径时会自动添加序号。':'文件会保留在 R2 中，可从回收站恢复；容量将在永久删除后释放。'} confirm={dialog.type==='permanent'?'永久删除':dialog.type==='restore'?'恢复文件':'移入回收站'} danger={dialog.type!=='restore'} busy={busy} onClose={close} onConfirm={()=>void apply()}/>}
  </>;
}
