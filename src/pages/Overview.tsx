import { ArrowRight, ArrowUpRight, Check, CloudUpload, Database, FileStack, FolderOpen, HardDrive, Layers3, Plus, ShieldCheck, Sparkles, Workflow } from 'lucide-react';
import type { Dashboard } from '../../shared/types';
import { formatBytes } from '../../shared/paths';
import { useDashboard, navigate, relativeTime } from '../hooks';
import { Badge, Button, Card, Empty, ErrorBox, FileIcon, Loading, PageHeader, Progress } from '../components/ui';
import { kindLabel } from '../components/fileKinds';

export default function Overview({onUpload,onAccount}:{onUpload:()=>void;onAccount:()=>void}) {
  const {data,loading,error,reload}=useDashboard();
  if(loading&&!data)return<Loading/>;
  if(error&&!data)return<ErrorBox message={error} retry={()=>void reload()}/>;
  if(!data)return null;
  const active=data.accounts.filter(account=>account.enabled);
  const percent=data.totalBytes?(data.usedBytes/data.totalBytes*100):0;
  const next=active.find(account=>account.syncState==='ready'&&account.availableBytes>0&&data.buckets.some(bucket=>bucket.accountId===account.id&&bucket.inPool));
  return<>
    <PageHeader eyebrow="YOUR CLOUD, CONNECTED" title="存储概览" description="所有账号，一个空间。文件由你掌控，容量交给我们安排。" actions={<><Button icon={Plus} onClick={onAccount}>添加账号</Button><Button variant="primary" icon={CloudUpload} onClick={onUpload}>上传文件</Button></>}/>
    {error&&<ErrorBox message={error} retry={()=>void reload()}/>}
    <div className="overview-hero">
      <div className="hero-copy"><Badge color="orange" dot>多账号智能存储池</Badge><h2>把分散的空间，<br/>变成一个云盘<span>。</span></h2><p>按顺序分配，自动跳过空间不足的账号。<br/>每一份剩余容量，都能被好好利用。</p><Button variant="primary" onClick={()=>navigate('files')} icon={FolderOpen}>打开我的文件 <ArrowRight size={15}/></Button></div>
      <div className="hero-art" aria-hidden="true"><div className="art-orbit orbit-one"/><div className="art-orbit orbit-two"/><div className="art-dot dot-one"/><div className="art-dot dot-two"/><div className="art-chip chip-one"><Database size={18}/><span>R2 · 01</span><i/></div><div className="art-chip chip-two"><Database size={18}/><span>R2 · 02</span><i/></div><div className="art-chip chip-three"><Database size={18}/><span>R2 · 03</span><i/></div><div className="art-cloud"><CloudUpload size={65} strokeWidth={1.3}/><span>One connected drive</span></div><div className="art-label"><Check size={13}/> 自动选择最合适的空间</div></div>
    </div>
    <div className="stats-grid">
      {[{label:'总存储容量',value:formatBytes(data.totalBytes),note:`${data.accounts.length} 个账号已连接`,icon:HardDrive,color:'orange'},{label:'已用空间',value:formatBytes(data.usedBytes),note:`${percent.toFixed(1)}% 容量已使用`,icon:Database,color:'blue'},{label:'可分配空间',value:formatBytes(data.availableBytes),note:data.reservedBytes?`${formatBytes(data.reservedBytes)} 正在预占`:'已扣除安全余量与预占',icon:Layers3,color:'green'},{label:'文件总数',value:data.filesCount.toLocaleString(),note:`${data.buckets.length} 个存储桶`,icon:FileStack,color:'purple'}].map(({icon:Icon,...stat})=><Card key={stat.label} className="stat-card"><div className="stat-heading"><span>{stat.label}</span><span className={`stat-icon tint-${stat.color}`}><Icon size={18}/></span></div><strong>{stat.value}</strong><small>{stat.note}</small></Card>)}
    </div>
    <div className="overview-columns">
      <Card className="pool-card"><div className="section-heading"><div><h2>存储账号池 <span className="count-pill">{data.accounts.length}</span></h2><p>按照优先级从上到下自动分配</p></div><button className="text-link" onClick={()=>navigate('accounts')}>管理账号 <ArrowUpRight size={15}/></button></div>
        {!data.accounts.length?<Empty icon={Database} title="连接你的第一个 R2 账号" description="添加 R2 凭据，现有文件会自动扫描并加入网盘。" action={<Button icon={Plus} onClick={onAccount}>添加存储账号</Button>}/>:<div className="pool-list">{data.accounts.slice(0,5).map((account,index)=><div className={`pool-row ${next?.id===account.id?'pool-row-next':''}`} key={account.id}><span className="pool-order">{String(index+1).padStart(2,'0')}</span><span className="account-symbol"><CloudUpload size={20}/></span><div className="pool-account"><div><strong>{account.name}</strong>{next?.id===account.id?<Badge color="green">优先分配</Badge>:account.syncState==='scanning'?<Badge color="blue">同步中</Badge>:!account.enabled?<Badge>已停用</Badge>:account.syncState==='error'?<Badge color="red">需同步</Badge>:null}</div><Progress value={account.usedBytes/account.quotaBytes*100} color={account.usedBytes/account.quotaBytes>.9?'red':'orange'}/><small>{formatBytes(account.usedBytes)} / {formatBytes(account.quotaBytes)}<span>可用 {formatBytes(account.availableBytes)}</span></small></div></div>)}</div>}
        <div className="allocation-note"><Sparkles size={16}/><span>大文件跳到下一个账号，小文件自动回填前面的空余空间。</span></div>
      </Card>
      <div className="overview-right"><Card className="distribution-card"><div className="section-heading"><div><h2>空间分布</h2><p>看看你的文件都放了什么</p></div><Layers3 size={18}/></div><div className="distribution-chart"><div className="donut" style={{background:distributionGradient(data.fileTypes)}}><div><small>文件占用</small><strong>{formatBytes(data.fileTypes.reduce((sum,item)=>sum+item.bytes,0))}</strong></div></div></div><div className="distribution-legend">{(data.fileTypes.length?data.fileTypes:[{type:'other',bytes:0,count:0}]).map((item,index)=><div key={item.type}><span><i style={{background:chartColors[index%chartColors.length]}}/>{kindLabel(item.type)}</span><strong>{formatBytes(item.bytes)}</strong></div>)}</div></Card><div className="safe-card"><span><ShieldCheck size={25}/></span><div><strong>文件私有，凭据加密</strong><p>短期签名直传，账号密钥保存在服务端。</p></div></div></div>
    </div>
    <div className="overview-bottom"><Card><div className="section-heading"><div><h2>最近文件</h2><p>继续处理最近上传的内容</p></div><button className="text-link" onClick={()=>navigate('recent')}>查看全部 <ArrowRight size={15}/></button></div>{!data.recent.length?<div className="mini-empty"><FolderOpen size={25}/><span>上传第一份文件，开始整理你的空间。</span></div>:<div className="recent-list">{data.recent.map(file=><button key={file.id} className="recent-item" onClick={()=>navigate(`files?open=${file.id}`)}><FileIcon name={file.name}/><span><strong>{file.name}</strong><small>{file.parent==='/'?'我的文件':file.parent}</small></span><small>{formatBytes(file.size)}</small><small>{relativeTime(file.modifiedAt)}</small><ArrowUpRight size={15}/></button>)}</div>}</Card><Card><div className="section-heading"><div><h2>后台任务</h2><p>扫描、传输和清理的最新进度</p></div><button className="text-link" onClick={()=>navigate('transfers')}>任务中心 <ArrowRight size={15}/></button></div>{!data.jobs.length?<div className="mini-empty"><Workflow size={25}/><span>一切就绪，暂时没有后台任务。</span></div>:<div className="recent-jobs">{data.jobs.slice(0,3).map(job=><div key={job.id}><span className={`job-symbol tint-${job.status==='completed'?'green':job.status==='failed'?'red':'blue'}`}>{job.status==='completed'?<Check size={17}/>:<Workflow size={17}/>}</span><div><strong>{job.title}</strong><small>{job.status==='completed'?'已完成':job.status==='failed'?'等待重试':job.status==='paused'?'已暂停':'进行中'} · {relativeTime(job.updatedAt)}</small></div></div>)}</div>}</Card></div>
  </>;
}

const chartColors=['#fb923c','#60a5fa','#a78bfa','#34d399','#fbbf24','#94a3b8'];
function distributionGradient(items:Dashboard['fileTypes']):string{
  const total=items.reduce((sum,item)=>sum+item.bytes,0);if(!total)return'conic-gradient(#f1f3f6 0deg 360deg)';
  let offset=0;return`conic-gradient(${items.map((item,index)=>{const start=offset;offset+=item.bytes/total*360;return`${chartColors[index%chartColors.length]} ${start}deg ${offset}deg`;}).join(',')})`;
}
