import { useState } from 'react';
import { KeyRound, Plus, ShieldCheck } from 'lucide-react';
import { api } from '../api';
import { useAction } from '../hooks';
import type { Account, AccountInput, Jurisdiction } from '../../shared/types';
import { GB } from '../../shared/paths';
import { Button, Field, Modal, Notice, Tabs } from './ui';

export default function AccountForm({onClose,account}:{onClose:()=>void;account?:Account}) {
  const [auth,setAuth]=useState('keys');
  const [name,setName]=useState(account?.name||'');const [accountId,setAccountId]=useState(account?.accountId||'');
  const [accessKey,setAccessKey]=useState('');const [secret,setSecret]=useState('');const [token,setToken]=useState('');const [apiToken,setApiToken]=useState('');
  const [quota,setQuota]=useState(String((account?.quotaBytes||10*GB)/GB));const [safety,setSafety]=useState(String((account?.safetyBytes??200_000_000)/1_000_000));
  const [external,setExternal]=useState(String((account?.externalBytes||0)/GB));const [buckets,setBuckets]=useState('');const [jurisdiction,setJurisdiction]=useState<Jurisdiction>('default');
  const {busy,run}=useAction();
  const save=async()=>{
    const result=await run(async()=>{
      if(account)return api<Account>(`/accounts/${account.id}`,{method:'PATCH',body:{name,quotaBytes:Math.round(Number(quota)*GB),safetyBytes:Math.round(Number(safety)*1_000_000),externalBytes:Math.round(Number(external)*GB),accessKeyId:accessKey||undefined,secretAccessKey:secret||undefined,apiToken:apiToken||undefined}});
      const input:AccountInput={name,accountId,accessKeyId:auth==='keys'?accessKey:undefined,secretAccessKey:auth==='keys'?secret:undefined,r2Token:auth==='token'?token:undefined,apiToken:apiToken||undefined,quotaBytes:Math.round(Number(quota)*GB),safetyBytes:Math.round(Number(safety)*1_000_000),externalBytes:Math.round(Number(external)*GB),buckets:buckets.split(/[\n,，]/).map(name=>name.trim()).filter(Boolean).map(name=>({name,jurisdiction,inPool:true}))};
      return api<Account>('/accounts',{method:'POST',body:input});
    },account?'账号设置已保存':'账号已添加，正在扫描文件与容量');
    if(result)onClose();
  };
  return<Modal title={account?'编辑存储账号':'连接 R2 存储账号'} subtitle="通过 API 凭据连接，日常使用无需登录 Cloudflare。" onClose={onClose} wide footer={<><Button onClick={onClose}>取消</Button><Button variant="primary" icon={account?ShieldCheck:Plus} busy={busy} onClick={()=>void save()}>{account?'保存设置':'连接并同步'}</Button></>}>
    <form onSubmit={event=>{event.preventDefault();void save();}} className="form-stack">
      <div className="form-grid"><Field label="账号备注"><input value={name} onChange={event=>setName(event.target.value)} placeholder="例如：个人存储 01" required autoComplete="off"/></Field><Field label="Cloudflare Account ID"><input value={accountId} onChange={event=>setAccountId(event.target.value)} placeholder="32 位 Account ID" disabled={Boolean(account)} autoComplete="off" spellCheck={false}/></Field></div>
      {!account&&<Tabs value={auth} onChange={setAuth} tabs={[{id:'keys',label:'Access Key 凭据',icon:KeyRound},{id:'token',label:'R2 API Token',icon:ShieldCheck}]}/>}
      {auth==='keys'||account?<div className="form-grid"><Field label="Access Key ID" hint={account?'留空表示保留当前凭据':undefined}><input value={accessKey} onChange={event=>setAccessKey(event.target.value)} placeholder={account?'•••••• 保留现有凭据':'创建 R2 Token 时获得'} autoComplete="off" spellCheck={false}/></Field><Field label="Secret Access Key" hint={account?'留空表示保留当前密钥':undefined}><input type="password" value={secret} onChange={event=>setSecret(event.target.value)} placeholder={account?'•••••• 保留现有密钥':'只展示一次的 Secret Access Key'} autoComplete="new-password"/></Field></div>:<Field label="R2 API Token" hint="填写 Token 原文。服务端验证后会转换为 S3 凭据。"><input type="password" value={token} onChange={event=>setToken(event.target.value)} placeholder="R2 Token value" autoComplete="new-password"/></Field>}
      <Field label="Cloudflare 管理 API Token" optional hint="完整的桶设置需要 Workers R2 Storage Read / Write；统计需要 Account Analytics Read。"><input type="password" value={apiToken} onChange={event=>setApiToken(event.target.value)} placeholder={account?'留空保留现有 Token':'用于管理桶设置、域名和统计（可选）'} autoComplete="new-password"/></Field>
      <div className="form-section-title">容量分配规则</div><div className="form-grid three"><Field label="账号容量上限 · GB"><input type="number" value={quota} onChange={event=>setQuota(event.target.value)} min="0.001" step="0.1"/></Field><Field label="安全余量 · MB"><input type="number" value={safety} onChange={event=>setSafety(event.target.value)} min="0" step="10"/></Field><Field label="未纳管占用 · GB" hint="凭据仅覆盖部分桶时，填写其他桶的占用。"><input type="number" value={external} onChange={event=>setExternal(event.target.value)} min="0" step="0.01"/></Field></div>
      {!account&&<><div className="form-section-title">存储桶</div><div className="form-grid"><Field label="已有存储桶名称" optional hint="多个名称用逗号分隔。管理权限的 Token 可自动发现桶。"><input value={buckets} onChange={event=>setBuckets(event.target.value)} placeholder="my-drive, my-backups"/></Field><Field label="存储区域约束"><select value={jurisdiction} onChange={event=>setJurisdiction(event.target.value as Jurisdiction)}><option value="default">默认（自动）</option><option value="eu">欧盟 EU</option><option value="us">美国 US</option><option value="fedramp">FedRAMP</option></select></Field></div></>}
      <Notice><strong>10 GB 免费额度按 Cloudflare 账号共享。</strong> 默认预留 200 MB。若账号还通过其他工具上传文件，请定期同步容量。凭据以 AES-GCM 加密后存储。</Notice>
      <button type="submit" hidden/>
    </form>
  </Modal>;
}
