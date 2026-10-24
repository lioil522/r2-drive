import { useState, type FormEvent } from 'react';
import { ArrowRight, Cloud, LockKeyhole, ShieldCheck, Sparkles } from 'lucide-react';
import { api } from '../api';
import { Button, Logo, Notice } from '../components/ui';

export default function Login({ configured, appName, onLogin }: { configured: boolean; appName: string; onLogin: () => void }) {
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true); setError('');
    try { await api('/login', { method: 'POST', body: { password } }); onLogin(); }
    catch (failure) { setError(failure instanceof Error ? failure.message : '登录失败'); }
    finally { setBusy(false); }
  };
  return <div className="login-shell">
    <div className="login-aside">
      <Logo/>
      <div className="login-pitch"><span className="eyebrow">MULTI-ACCOUNT CLOUD</span><h1>所有 R2 账号，<br/>一个云盘<span>。</span></h1><p>按优先级自动分配文件。空间不足时跳到下一个账号，小文件回填前面的剩余空间。</p></div>
      <ul className="login-points">
        <li><span className="stat-icon tint-orange"><ShieldCheck size={19}/></span><span><strong>凭据加密保存</strong><small>AES-GCM 加密，不离开服务端</small></span></li>
        <li><span className="stat-icon tint-blue"><LockKeyhole size={19}/></span><span><strong>私有分享链接</strong><small>短期签名 · 提取码 · 随时撤销</small></span></li>
        <li><span className="stat-icon tint-green"><Sparkles size={19}/></span><span><strong>容量自动编排</strong><small>上传前原子预占，杜绝并发超额</small></span></li>
      </ul>
      <div className="login-art" aria-hidden="true"><span className="login-art-ring"/><span className="login-art-ring second"/><div className="login-art-cloud"><Cloud size={54} strokeWidth={1.2}/><strong>{appName}</strong><small>ONE CONNECTED DRIVE</small></div></div>
    </div>
    <div className="login-panel">
      <div className="login-card">
        <div className="login-card-head"><span className="login-badge"><LockKeyhole size={14}/>管理入口</span><h2>欢迎回来</h2><p>输入管理员密码，进入你的多账号网盘。</p></div>
        {!configured&&<Notice type="warning"><strong>服务还没有完成初始化。</strong> 请先在项目目录设置两个 secret，然后刷新此页：<code className="inline-code">ADMIN_PASSWORD</code>（至少 12 个字符）和 <code className="inline-code">ENCRYPTION_KEY</code>（至少 32 个字符）。<pre className="code-block">npx wrangler secret put ADMIN_PASSWORD{'\n'}npx wrangler secret put ENCRYPTION_KEY</pre></Notice>}
        {error&&<div className="error-box"><span>{error}</span></div>}
        <form className="login-form" onSubmit={(event) => void submit(event)}><label className="field"><span>管理员密码</span><input type="password" value={password} onChange={(event) => setPassword(event.target.value)} placeholder="输入 ADMIN_PASSWORD" autoComplete="current-password" autoFocus required disabled={!configured}/></label><Button type="submit" variant="primary" busy={busy} disabled={!configured||!password} className="login-submit">进入网盘 <ArrowRight size={16}/></Button></form>
        <p className="login-hint">密码与加密密钥只保存在 Cloudflare Secret 中。忘记密码时，重新执行 <code className="inline-code">npx wrangler secret put ADMIN_PASSWORD</code> 即可覆盖。</p>
      </div>
    </div>
  </div>;
}
