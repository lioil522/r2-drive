import { useState, type FormEvent } from 'react';
import { Download, Link2, LockKeyhole, ShieldCheck } from 'lucide-react';
import { api } from '../api';
import { dateTime, useResource } from '../hooks';
import { formatBytes } from '../../shared/paths';
import { Button, ErrorBox, FileIcon, Loading, Logo, Notice } from '../components/ui';

interface ShareInfo { name: string; size: number; contentType: string; expiresAt: number; hasPassword: boolean; segmented?: boolean }

export default function PublicShare({ id }: { id: string }) {
  const share = useResource<ShareInfo>(`/public/shares/${encodeURIComponent(id)}`);
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState('');
  const download = async (event?: FormEvent) => {
    event?.preventDefault();
    setBusy(true); setFailure('');
    try {
      const result = await api<{ url: string }>(`/public/shares/${encodeURIComponent(id)}/download`, { method: 'POST', body: { password } });
      location.assign(result.url);
    } catch (error) { setFailure(error instanceof Error ? error.message : '无法获取下载链接'); }
    finally { setBusy(false); }
  };
  return <div className="public-shell">
    <header className="public-head"><a className="public-brand" href="#/overview"><Logo/></a><span className="public-tag"><Link2 size={14}/>私有分享</span></header>
    <main className="public-card">
      {share.loading&&!share.data?<Loading/>:share.error?<div className="public-error"><ErrorBox message={share.error}/><a className="text-link" href="#/overview">返回网盘首页</a></div>:share.data&&<>
        <div className="public-file"><FileIcon name={share.data.name} large/><div><h1>{share.data.name}</h1><p>{formatBytes(share.data.size)} · 有效期至 {dateTime(share.data.expiresAt)}</p></div><ShieldCheck size={23}/></div>
        {failure&&<Notice type="warning">{failure}</Notice>}
        <form className="public-actions" onSubmit={(event) => void download(event)}>
          {share.data.hasPassword&&<label className="field"><span>提取码</span><div className="input-icon"><LockKeyhole size={16}/><input value={password} onChange={(event) => setPassword(event.target.value)} placeholder="请输入分享者提供的提取码" autoComplete="off" required/></div></label>}
          <Button type="submit" variant="primary" icon={Download} busy={busy} className="public-download">{share.data.hasPassword?'验证并下载':'下载文件'}</Button>
        </form>
        <Notice>{share.data.segmented?'这是跨账号分段文件，下载时由网盘流式重组，支持断点范围读取。':'文件通过 R2 私有签名链接直接下载。'} 下载按钮即时签发一个 60 秒有效的私有链接。</Notice>
      </>}
    </main>
    <footer className="public-foot"><span>由 R2 Drive 提供私有分享</span><span>Cloudflare R2 · 私有文件分享</span></footer>
  </div>;
}
