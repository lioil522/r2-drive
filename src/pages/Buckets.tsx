import { useContext, useEffect, useState } from 'react';
import { Clock3, Copy, Database, Eye, EyeOff, FolderOpen, Gauge, Globe2, Link2, LockKeyhole, Plus, RefreshCw, Settings2, ShieldCheck, Trash2, Unplug, Zap, type LucideIcon } from 'lucide-react';
import type { Account, Bucket, Jurisdiction, StorageClass } from '../../shared/types';
import { formatBytes } from '../../shared/paths';
import { api, copyText } from '../api';
import { dateTime, navigate, ToastContext, useAction, useDriveStatus, useResource } from '../hooks';
import { Badge, Button, Card, CheckBox, ConfirmModal, Empty, ErrorBox, Field, IconButton, Loading, Menu, Modal, Notice, PageHeader, Tabs } from '../components/ui';

interface Zone { id: string; name: string }
interface DomainEntry { domain?: string; zoneId?: string; zoneName?: string; enabled?: boolean; minTLS?: string; status?: string }
interface QueueEntry { queue_id?: string; queue_name?: string; id?: string; name?: string }
interface MultipartEntry { key?: string; uploadId?: string; initiated?: string }
interface Metrics { storage: unknown; operations: { type: string; count: number }[]; classA: number; classB: number; periodStart: string; periodEnd: string; error?: string }
interface SettingProps { bucket: Bucket }

const corsSample = () => JSON.stringify({ rules: [{ id: 'r2-drive', allowed: { methods: ['GET', 'PUT', 'HEAD'], origins: [location.origin], headers: ['*'] }, exposeHeaders: ['ETag', 'Content-Length', 'Content-Range'], maxAgeSeconds: 3600 }] }, null, 2);
const lifecycleSample = JSON.stringify({ rules: [{ id: 'abort-incomplete', enabled: true, conditions: { prefix: '' }, abortMultipartUploadsTransition: { condition: { type: 'Age', maxAge: 604800 } } }] }, null, 2);
const lockSample = JSON.stringify({ rules: [{ id: 'retain-30d', enabled: true, prefix: '', condition: { type: 'Age', maxAgeSeconds: 2592000 } }] }, null, 2);
const eventSample = JSON.stringify({ rules: [{ actions: ['PutObject', 'DeleteObject', 'CompleteMultipartUpload'], prefix: '', suffix: '' }] }, null, 2);

export default function Buckets({ params }: { params: URLSearchParams }) {
  const status = useDriveStatus();
  const accounts = { ...status, data: status.data?.accounts };
  const buckets = { ...status, data: status.data?.buckets };
  const [filter, setFilter] = useState(params.get('account') || '');
  const [query, setQuery] = useState('');
  const [settingsId, setSettingsId] = useState<string | null>(params.get('bucket'));
  const [creating, setCreating] = useState(false);
  const [removing, setRemoving] = useState<Bucket | null>(null);
  const [ignoring, setIgnoring] = useState<Bucket | null>(null);
  const { busy, run } = useAction();
  const routeBucket = params.get('bucket');
  useEffect(() => { if (routeBucket) setSettingsId(routeBucket); }, [routeBucket]);
  const data = buckets.data || [];
  const list = data.filter((bucket) => (!filter || bucket.accountId === filter) && (!query || bucket.name.toLowerCase().includes(query.toLowerCase())));
  const selected = data.find((bucket) => bucket.id === settingsId);
  const closeSettings = () => { setSettingsId(null); if (routeBucket) navigate('buckets'); };
  const accountName = (id: string) => accounts.data?.find((account) => account.id === id)?.name || id;
  const togglePool = (bucket: Bucket) => void run(() => api(`/buckets/${bucket.id}`, { method: 'PATCH', body: { inPool: !bucket.inPool } }), bucket.inPool ? '已移出智能分配池' : '已加入智能分配池');
  const autoCors = (bucket: Bucket) => void run(() => api(`/buckets/${bucket.id}/cors-auto`, { method: 'POST', body: { origin: window.location.origin } }), '已为当前域名写入 CORS 规则');
  const remove = () => { if (!removing) return; void run(() => api(`/buckets/${removing.id}`, { method: 'DELETE' }), '存储桶已删除').then((result) => { if (result) { if (settingsId === removing.id) closeSettings(); setRemoving(null); } }); };
  const toggleIgnore = () => { if (!ignoring) return; void run(() => api(`/buckets/${ignoring.id}`, { method: 'PATCH', body: { ignored: !ignoring.ignored } }), ignoring.ignored ? '已取消屏蔽' : '已屏蔽存储桶').then((result) => { if (result) { if (settingsId === ignoring.id) closeSettings(); setIgnoring(null); } }); };
  return <>
    <PageHeader eyebrow="R2 BUCKETS" title="存储桶" description="管理每个账号下的 R2 桶：容量池、CORS、生命周期、自定义域名与事件通知。" actions={<><Button icon={RefreshCw} onClick={() => void buckets.reload()}>刷新</Button><Button variant="primary" icon={Plus} onClick={() => setCreating(true)} disabled={!accounts.data?.length}>新建存储桶</Button></>}/>
    {!accounts.data?.length&&!accounts.loading&&<Notice type="warning">还没有连接任何存储账号。先在「存储账号」中连接凭据，才能创建或管理存储桶。</Notice>}
    <Card className="buckets-toolbar"><div className="files-tools"><select className="sort-select" value={filter} onChange={(event) => setFilter(event.target.value)} aria-label="按账号筛选"><option value="">所有账号</option>{(accounts.data || []).map((account) => <option key={account.id} value={account.id}>{account.name}</option>)}</select><div className="search-input"><Globe2 size={15}/><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索存储桶…" aria-label="搜索存储桶"/></div></div><span className="bucket-count">{list.length} / {data.length} 个存储桶 · {data.filter((bucket) => bucket.inPool).length} 个参与智能分配</span></Card>
    {buckets.error&&<ErrorBox message={buckets.error} retry={() => void buckets.reload()}/>}
    {buckets.loading&&!buckets.data?<Loading/>:!data.length?<Card><Empty icon={Database} title="还没有存储桶" description="连接账号后创建新桶，或把已有桶加入容量池。参与分配的桶会按优先级接收文件。" action={<Button variant="primary" icon={Plus} onClick={() => setCreating(true)} disabled={!accounts.data?.length}>新建存储桶</Button>}/></Card>:!list.length?<Card><Empty icon={Database} title="没有匹配的存储桶" description="调整账号筛选或搜索关键词试试。"/></Card>:<div className="bucket-grid">{list.map((bucket) => <Card key={bucket.id} className="bucket-card"><div className="bucket-card-head"><span className="bucket-symbol"><Database size={21}/></span><div><h2>{bucket.name}</h2><p>{accountName(bucket.accountId)} · {bucket.jurisdiction === 'default' ? '默认区域' : bucket.jurisdiction.toUpperCase()}</p></div><Menu items={[{ label: '存储桶设置', icon: Settings2, disabled: bucket.ignored, action: () => setSettingsId(bucket.id) }, { label: '浏览对象', icon: FolderOpen, disabled: bucket.ignored, action: () => navigate(`files?bucket=${bucket.id}`) }, { label: '智能配置 CORS', icon: Zap, action: () => autoCors(bucket) }, { label: bucket.inPool ? '移出分配池' : '加入分配池', icon: bucket.inPool ? Unplug : Plus, action: () => togglePool(bucket) }, { label: bucket.ignored ? '取消屏蔽' : '屏蔽存储桶', icon: bucket.ignored ? Eye : EyeOff, action: () => setIgnoring(bucket) }, { label: '删除存储桶', icon: Trash2, danger: true, action: () => setRemoving(bucket) }]}/></div><div className="bucket-badges"><Badge color={bucket.inPool ? 'green' : 'gray'} dot>{bucket.inPool ? '参与分配' : '未纳管'}</Badge>{bucket.ignored && <Badge color="red" dot>已屏蔽</Badge>}<Badge color={bucket.storageClass === 'Standard' ? 'blue' : 'purple'}>{bucket.storageClass === 'Standard' ? '标准存储' : '低频存储'}</Badge>{bucket.priority > 0 && <Badge>优先级 {bucket.priority}</Badge>}</div><div className="bucket-metrics"><div><span>对象数</span><strong>{bucket.objectCount.toLocaleString()}</strong></div><div><span>已用容量</span><strong>{formatBytes(bucket.usedBytes)}</strong></div><div><span>创建时间</span><strong>{dateTime(bucket.createdAt)}</strong></div></div><div className="bucket-card-foot"><button className="text-link" disabled={bucket.ignored} onClick={() => navigate(`files?bucket=${bucket.id}`)}><FolderOpen size={14}/>浏览对象</button><Button variant="ghost" icon={Settings2} disabled={bucket.ignored} onClick={() => setSettingsId(bucket.id)}>设置</Button></div></Card>)}</div>}
    {creating&&<BucketForm accounts={accounts.data || []} onClose={() => setCreating(false)}/>}
    {selected&&<BucketSettings bucket={selected} accountName={accountName(selected.accountId)} onClose={closeSettings}/>}
    {removing&&<ConfirmModal title={`删除存储桶 ${removing.name}？`} description="将直接从 Cloudflare 删除这个 R2 存储桶，并从网盘索引中移除。R2 只允许删除空桶；请先迁移或永久删除其中的文件。此操作不可撤销。" confirm="删除存储桶" danger busy={busy} onClose={() => setRemoving(null)} onConfirm={remove}/>}
    {ignoring&&<ConfirmModal title={ignoring.ignored ? `取消屏蔽 ${ignoring.name}？` : `屏蔽 ${ignoring.name}？`} description={ignoring.ignored ? '取消屏蔽后，此桶会重新参与容量扫描与智能分配。' : '屏蔽后，此桶将不再参与容量扫描、文件索引与智能分配；其已在网盘中的文件索引会被移除，但 R2 中的对象不会被删除。之后可随时取消屏蔽恢复。'} confirm={ignoring.ignored ? '取消屏蔽' : '屏蔽存储桶'} danger={!ignoring.ignored} busy={busy} onClose={() => setIgnoring(null)} onConfirm={toggleIgnore}/>}
  </>;
}

function BucketForm({ accounts, onClose }: { accounts: Account[]; onClose: () => void }) {
  const [accountId, setAccountId] = useState(accounts[0]?.id || '');
  const [name, setName] = useState('');
  const [jurisdiction, setJurisdiction] = useState<Jurisdiction>('default');
  const [storageClass, setStorageClass] = useState<StorageClass>('Standard');
  const [existing, setExisting] = useState(false);
  const [inPool, setInPool] = useState(true);
  const { busy, run } = useAction();
  const save = () => void run(() => api('/buckets', { method: 'POST', body: { accountId, name, jurisdiction, storageClass, existing, inPool } }), existing ? '已连接现有存储桶，正在同步' : '存储桶已创建，正在同步').then((result) => { if (result) onClose(); });
  return <Modal title="新建存储桶" subtitle="创建全新的 R2 桶，或连接已有桶。" onClose={onClose} footer={<><Button onClick={onClose}>取消</Button><Button variant="primary" icon={Plus} busy={busy} disabled={!accountId || !name} onClick={save}>{existing ? '连接存储桶' : '创建存储桶'}</Button></>}>
    <form className="form-stack" onSubmit={(event) => { event.preventDefault(); save(); }}>
      <div className="form-grid"><Field label="所属账号"><select value={accountId} onChange={(event) => setAccountId(event.target.value)} required>{accounts.map((account) => <option key={account.id} value={account.id}>{account.name}</option>)}</select></Field><Field label="存储桶名称" hint="3–63 个字符，仅小写字母、数字和连字符。"><input value={name} onChange={(event) => setName(event.target.value.toLowerCase())} placeholder="my-drive-photos" required autoComplete="off" spellCheck={false}/></Field></div>
      <div className="form-grid"><Field label="区域约束"><select value={jurisdiction} onChange={(event) => setJurisdiction(event.target.value as Jurisdiction)}><option value="default">默认（自动）</option><option value="eu">欧盟 EU</option><option value="us">美国 US</option><option value="fedramp">FedRAMP</option></select></Field><Field label="存储类型"><select value={storageClass} onChange={(event) => setStorageClass(event.target.value as StorageClass)}><option value="Standard">Standard · 标准</option><option value="InfrequentAccess">Infrequent Access · 低频</option></select></Field></div>
      <div className="toggle-group"><CheckBox checked={existing} onChange={() => setExisting(!existing)} label="连接已有存储桶"/><div><strong>连接已有存储桶</strong><small>不创建新桶，只验证访问权限并加入索引。</small></div></div>
      <div className="toggle-group"><CheckBox checked={inPool} onChange={() => setInPool(!inPool)} label="加入智能分配池"/><div><strong>加入智能分配池</strong><small>参与上传时的自动选桶。低频存储不会进入默认分配池。</small></div></div>
      <Notice>创建操作通过 Cloudflare 管理 API 完成，账号需配置具备 Workers R2 Storage 权限的 API Token。若只填写了 S3 凭据，请使用「连接已有存储桶」。</Notice>
      <button type="submit" hidden/>
    </form>
  </Modal>;
}

function BucketSettings({ bucket, accountName, onClose }: SettingProps & { accountName: string; onClose: () => void }) {
  const [tab, setTab] = useState('info');
  const tabs: { id: string; label: string; icon: LucideIcon }[] = [{ id: 'info', label: '概览', icon: Settings2 }, { id: 'cors', label: 'CORS', icon: Zap }, { id: 'lifecycle', label: '生命周期', icon: Clock3 }, { id: 'locks', label: '对象锁', icon: LockKeyhole }, { id: 'domains', label: '自定义域名', icon: Globe2 }, { id: 'events', label: '事件通知', icon: Link2 }, { id: 'multipart', label: '未完成分片', icon: Unplug }, { id: 'metrics', label: '用量统计', icon: Gauge }];
  return <Modal title={`${bucket.name} · 存储桶设置`} subtitle={`${accountName} · ${bucket.jurisdiction === 'default' ? '默认区域' : bucket.jurisdiction.toUpperCase()} · ${bucket.storageClass === 'Standard' ? '标准存储' : '低频存储'}`} wide onClose={onClose}><Tabs tabs={tabs} value={tab} onChange={setTab}/><div className="tab-panel">{tab === 'info' && <InfoTab bucket={bucket}/>}{tab === 'cors' && <CorsTab bucket={bucket}/>}{tab === 'lifecycle' && <JsonTab bucket={bucket} feature="lifecycle" title="生命周期规则" hint="自动中止未完成的分片上传，或按时间删除、转储对象。" sample={lifecycleSample}/>}{tab === 'locks' && <JsonTab bucket={bucket} feature="locks" title="对象锁规则" hint="为桶内对象设置保留期，避免在保留期内被删除或覆盖。" sample={lockSample}/>}{tab === 'domains' && <DomainsTab bucket={bucket}/>}{tab === 'events' && <EventsTab bucket={bucket}/>}{tab === 'multipart' && <MultipartTab bucket={bucket}/>}{tab === 'metrics' && <MetricsTab bucket={bucket}/>}</div></Modal>;
}

function InfoTab({ bucket }: SettingProps) {
  const info = useResource<{ bucket: Bucket; encryption: unknown; endpoint: string }>(`/buckets/${bucket.id}/info`);
  const [storageClass, setStorageClass] = useState<StorageClass>(bucket.storageClass);
  const { busy, run } = useAction();
  const toast = useContext(ToastContext);
  const saveClass = () => void run(() => api(`/buckets/${bucket.id}`, { method: 'PATCH', body: { storageClass } }), '存储类型已更新');
  return <div className="settings-section">
    {info.error&&<ErrorBox message={info.error} retry={() => void info.reload()}/>}
    {info.loading&&!info.data?<Loading/>:info.data&&<>
      <div className="settings-block"><h3><ShieldCheck size={17}/>连接信息</h3><dl className="detail-list">{[['S3 Endpoint', info.data.endpoint], ['存储桶名称', bucket.name], ['区域', bucket.jurisdiction === 'default' ? '自动（默认）' : bucket.jurisdiction.toUpperCase()], ['对象数量', bucket.objectCount.toLocaleString()], ['已用容量', formatBytes(bucket.usedBytes)], ['创建时间', dateTime(bucket.createdAt)]].map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}<button title="复制" onClick={() => void copyText(String(value)).then(() => toast('已复制', 'success')).catch(() => toast('复制失败', 'error'))}><Copy size={13}/></button></dd></div>)}</dl></div>
      <div className="settings-block"><h3>加密与存储类型</h3><p className="settings-hint">R2 在所有位置对静态数据加密。存储类型会应用到之后上传的对象。</p><pre className="code-block">{JSON.stringify(info.data.encryption, null, 2)}</pre><div className="settings-actions"><Field label="存储类型"><select value={storageClass} onChange={(event) => setStorageClass(event.target.value as StorageClass)}><option value="Standard">Standard · 标准（含免费额度）</option><option value="InfrequentAccess">Infrequent Access · 低频（付费）</option></select></Field><Button variant="primary" busy={busy} onClick={saveClass}>保存存储类型</Button></div></div>
    </>}
    <div className="settings-block"><h3>桶级开关</h3><FeatureToggle bucket={bucket} feature="managed-domain" label="R2 托管域名" description="允许通过 r2.dev 公共域名访问桶内容（仅建议测试使用）。"/><FeatureToggle bucket={bucket} feature="local-uploads" label="本地上传" description="允许通过 Cloudflare 边缘直接上传，而非统一走 S3 API。"/></div>
  </div>;
}

function FeatureToggle({ bucket, feature, label, description }: SettingProps & { feature: string; label: string; description: string }) {
  const setting = useResource<{ enabled?: boolean }>(`/buckets/${bucket.id}/settings/${feature}`);
  const { busy, run } = useAction();
  const enabled = Boolean(setting.data?.enabled);
  return <div className="toggle-row"><div><strong>{label}</strong><small>{description}</small>{setting.error&&<small className="danger-text">{setting.error}</small>}</div><button type="button" role="switch" aria-checked={enabled} aria-label={label} disabled={busy || setting.loading} className={`switch ${enabled ? 'switch-on' : ''}`} onClick={() => void run(() => api(`/buckets/${bucket.id}/settings/${feature}`, { method: 'PUT', body: { enabled: !enabled } }), '设置已保存')}><span/></button></div>;
}

function CorsTab({ bucket }: SettingProps) {
  const cors = useResource<unknown>(`/buckets/${bucket.id}/settings/cors`);
  const [text, setText] = useState(corsSample());
  const { busy, run } = useAction();
  useEffect(() => { if (cors.data) setText(JSON.stringify(cors.data, null, 2)); }, [cors.data]);
  const save = () => void run(() => api(`/buckets/${bucket.id}/settings/cors`, { method: 'PUT', body: JSON.parse(text) }), 'CORS 规则已保存');
  const automatic = () => void run(() => api(`/buckets/${bucket.id}/cors-auto`, { method: 'POST', body: {} }), '已为当前域名写入 CORS 规则').then(() => void cors.reload());
  return <div className="settings-section">{cors.error&&<ErrorBox message={cors.error} retry={() => void cors.reload()}/>}<Notice><strong>浏览器直传必须暴露 ETag。</strong> 上传分片后，前端需要读取响应头中的 ETag 才能合并文件。建议保留 id 为 r2-drive 的规则。</Notice><Field label="CORS 规则 · JSON"><textarea className="code-input json-editor" value={text} onChange={(event) => setText(event.target.value)} rows={16} spellCheck={false}/></Field><div className="settings-actions"><Button onClick={() => setText(corsSample())}>填入当前域名示例</Button><Button icon={Zap} onClick={automatic} disabled={busy}>自动配置</Button><Button variant="primary" busy={busy} onClick={save}>保存规则</Button></div></div>;
}

function JsonTab({ bucket, feature, title, hint, sample }: SettingProps & { feature: string; title: string; hint: string; sample: string }) {
  const setting = useResource<unknown>(`/buckets/${bucket.id}/settings/${feature}`);
  const [text, setText] = useState(sample);
  const { busy, run } = useAction();
  useEffect(() => { if (setting.data && typeof setting.data === 'object' && (setting.data as { rules?: unknown[] }).rules?.length) setText(JSON.stringify(setting.data, null, 2)); }, [setting.data]);
  const save = () => void run(() => api(`/buckets/${bucket.id}/settings/${feature}`, { method: 'PUT', body: JSON.parse(text) }), `${title}已保存`);
  return <div className="settings-section">{setting.error&&<ErrorBox message={setting.error} retry={() => void setting.reload()}/>}<Notice>{hint} 保存空规则会关闭此功能。</Notice><Field label={`${title} · JSON`}><textarea className="code-input json-editor" value={text} onChange={(event) => setText(event.target.value)} rows={16} spellCheck={false}/></Field><div className="settings-actions"><Button onClick={() => setText(sample)}>填入示例</Button><Button variant="primary" busy={busy} onClick={save}>保存设置</Button></div></div>;
}

function DomainsTab({ bucket }: SettingProps) {
  const domains = useResource<unknown>(`/buckets/${bucket.id}/domains`);
  const zones = useResource<Zone[]>(`/accounts/${bucket.accountId}/zones`);
  const [domain, setDomain] = useState('');
  const [zoneId, setZoneId] = useState('');
  const { busy, run } = useAction();
  const list = Array.isArray(domains.data) ? domains.data as DomainEntry[] : ((domains.data as { domains?: DomainEntry[] } | null)?.domains || []);
  const add = () => void run(() => api(`/buckets/${bucket.id}/domains`, { method: 'POST', body: { domain, zoneId, enabled: true } }), '自定义域名已添加').then((result) => { if (result) { setDomain(''); void domains.reload(); } });
  const remove = (name: string) => void run(() => api(`/buckets/${bucket.id}/domains/${encodeURIComponent(name)}`, { method: 'DELETE' }), '域名已移除').then((result) => { if (result) void domains.reload(); });
  const toggle = (entry: DomainEntry) => void run(() => api(`/buckets/${bucket.id}/domains/${encodeURIComponent(entry.domain || '')}`, { method: 'PUT', body: { enabled: !entry.enabled } }), '域名状态已更新').then((result) => { if (result) void domains.reload(); });
  return <div className="settings-section">{domains.error&&<ErrorBox message={domains.error} retry={() => void domains.reload()}/>}{domains.loading&&!domains.data?<Loading/>:list.length?<div className="domain-list">{list.map((entry) => <div className="domain-row" key={entry.domain || entry.zoneId}><div><strong>{entry.domain || '未命名域名'}</strong><small>{entry.status || (entry.enabled ? '已启用' : '已停用')}{entry.minTLS && ` · 最低 TLS ${entry.minTLS}`}</small></div><Badge color={entry.enabled ? 'green' : 'gray'} dot>{entry.enabled ? '启用' : '停用'}</Badge><div className="row-actions"><button className="text-link" onClick={() => toggle(entry)}>{entry.enabled ? '停用' : '启用'}</button><IconButton icon={Trash2} label="移除域名" onClick={() => remove(entry.domain || '')}/></div></div>)}</div>:<p className="settings-hint">还没有绑定自定义域名。自定义域名需要域名已托管在同一个 Cloudflare 账号，并提供 Zone ID。</p>}
    <div className="settings-block"><h3>添加自定义域名</h3><div className="form-grid three"><Field label="域名"><input value={domain} onChange={(event) => setDomain(event.target.value)} placeholder="files.example.com" spellCheck={false}/></Field><Field label="Zone ID" hint={zones.error ? '无法加载 Zone 列表，请手动填写。' : '32 位十六进制 Zone ID。'}><input value={zoneId} onChange={(event) => setZoneId(event.target.value)} placeholder="Zone ID" spellCheck={false}/></Field><Field label="快速选择 Zone" optional><select value="" onChange={(event) => setZoneId(event.target.value)}><option value="">选择已托管域名</option>{(zones.data || []).map((zone) => <option key={zone.id} value={zone.id}>{zone.name}</option>)}</select></Field></div><div className="settings-actions"><Button variant="primary" icon={Globe2} busy={busy} disabled={!domain || !zoneId} onClick={add}>添加域名</Button></div></div>
  </div>;
}

function EventsTab({ bucket }: SettingProps) {
  const events = useResource<unknown>(`/buckets/${bucket.id}/events`);
  const queues = useResource<unknown>(`/accounts/${bucket.accountId}/queues`);
  const [queueId, setQueueId] = useState('');
  const [rules, setRules] = useState(eventSample);
  const { busy, run } = useAction();
  const queueList = (Array.isArray(queues.data) ? queues.data : (queues.data as { queues?: QueueEntry[] } | null)?.queues || []) as QueueEntry[];
  const attach = () => void run(() => api(`/buckets/${bucket.id}/events/${queueId}`, { method: 'PUT', body: JSON.parse(rules) }), '事件通知已配置').then((result) => { if (result) void events.reload(); });
  const detach = () => void run(() => api(`/buckets/${bucket.id}/events/${queueId}`, { method: 'DELETE' }), '事件通知已移除').then((result) => { if (result) void events.reload(); });
  return <div className="settings-section">{events.error&&<ErrorBox message={events.error} retry={() => void events.reload()}/>}<div className="settings-block"><h3>当前事件通知</h3>{events.loading&&!events.data?<Loading/>:<pre className="code-block">{events.data ? JSON.stringify(events.data, null, 2) : '尚未配置。'}</pre>}</div><div className="settings-block"><h3>绑定队列</h3><div className="form-grid"><Field label="Queue" hint={queues.error ? '无法加载队列列表，请手动填写 Queue ID。' : '选择同账号下的 Cloudflare Queue。'}><select value={queueId} onChange={(event) => setQueueId(event.target.value)}><option value="">选择队列</option>{queueList.map((queue) => { const id = queue.queue_id || queue.id || ''; return <option key={id} value={id}>{queue.queue_name || queue.name || id}</option>; })}</select></Field><Field label="Queue ID" hint="32 位十六进制。"><input value={queueId} onChange={(event) => setQueueId(event.target.value)} placeholder="Queue ID" spellCheck={false}/></Field></div><Field label="通知规则 · JSON"><textarea className="code-input json-editor" value={rules} onChange={(event) => setRules(event.target.value)} rows={8} spellCheck={false}/></Field><div className="settings-actions"><Button onClick={() => setRules(eventSample)}>填入示例</Button><Button variant="primary" icon={Link2} busy={busy} disabled={!queueId} onClick={attach}>保存通知</Button><Button variant="danger" busy={busy} disabled={!queueId} onClick={detach}>移除绑定</Button></div></div></div>;
}

function MultipartTab({ bucket }: SettingProps) {
  const uploads = useResource<{ uploads?: MultipartEntry[]; truncated?: boolean }>(`/buckets/${bucket.id}/multipart`);
  const { busy, run } = useAction();
  const abort = (entry: MultipartEntry) => void run(() => api(`/buckets/${bucket.id}/multipart`, { method: 'DELETE', body: { key: entry.key || '', uploadId: entry.uploadId || '' } }), '未完成分片上传已终止').then((result) => { if (result) void uploads.reload(); });
  const list = uploads.data?.uploads || [];
  return <div className="settings-section"><Notice>未完成的分片上传会占用 R2 存储空间但不出现在对象列表中。可在此手动终止，或通过生命周期规则自动清理。</Notice>{uploads.error&&<ErrorBox message={uploads.error} retry={() => void uploads.reload()}/>}{uploads.loading&&!uploads.data?<Loading/>:!list.length?<p className="settings-hint">没有未完成的分片上传。</p>:<div className="table-scroll"><table className="file-table"><thead><tr><th>对象键</th><th>Upload ID</th><th>开始时间</th><th>操作</th></tr></thead><tbody>{list.map((entry) => <tr key={entry.uploadId}><td><code>{entry.key}</code></td><td className="muted"><code>{entry.uploadId?.slice(0, 18)}…</code></td><td className="muted nowrap">{entry.initiated ? dateTime(Date.parse(entry.initiated)) : '—'}</td><td><Button variant="ghost" icon={Trash2} busy={busy} onClick={() => abort(entry)}>终止</Button></td></tr>)}</tbody></table></div>}{uploads.data?.truncated&&<p className="settings-hint">仅显示前 100 条，终止后刷新可继续查看。</p>}</div>;
}

function MetricsTab({ bucket }: SettingProps) {
  const metrics = useResource<Metrics>(`/accounts/${bucket.accountId}/metrics`);
  if (metrics.loading&&!metrics.data) return <Loading/>;
  if (metrics.error&&!metrics.data) return <ErrorBox message={metrics.error} retry={() => void metrics.reload()}/>;
  if (!metrics.data) return null;
  const operations = [...metrics.data.operations].sort((left, right) => right.count - left.count).slice(0, 12);
  return <div className="settings-section">{metrics.data.error&&<Notice type="warning">{metrics.data.error}</Notice>}<div className="metrics-grid"><div className="metric-card"><span>Class A 操作</span><strong>{metrics.data.classA.toLocaleString()}</strong><small>写入、列举、复制等</small></div><div className="metric-card"><span>Class B 操作</span><strong>{metrics.data.classB.toLocaleString()}</strong><small>读取、查询元数据等</small></div><div className="metric-card"><span>统计周期</span><strong>{dateTime(Date.parse(metrics.data.periodStart))}</strong><small>至 {dateTime(Date.parse(metrics.data.periodEnd))}</small></div></div><div className="settings-block"><h3>存储用量</h3><pre className="code-block">{JSON.stringify(metrics.data.storage, null, 2)}</pre></div>{operations.length>0&&<div className="settings-block"><h3>操作明细</h3><div className="table-scroll"><table className="file-table"><thead><tr><th>操作类型</th><th>请求数</th></tr></thead><tbody>{operations.map((item) => <tr key={item.type}><td>{item.type}</td><td className="muted">{item.count.toLocaleString()}</td></tr>)}</tbody></table></div></div>}</div>;
}
