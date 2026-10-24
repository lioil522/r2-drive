import { useState, type FormEvent } from 'react';
import { ArrowRight, Cloud, LockKeyhole, ShieldCheck, Sparkles } from 'lucide-react';
import { api } from '../api';
import { Button, Logo, Notice } from '../components/ui';

export default function Login({ secretReady, initialized, appName, onLogin }: { secretReady: boolean; initialized: boolean; appName: string; onLogin: () => void }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const setup = !initialized;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (setup && password !== confirm) { setError('两次输入的密码不一致'); return; }
    setBusy(true); setError('');
    try {
      if (setup) await api('/setup', { method: 'POST', body: { username, password } });
      else await api('/login', { method: 'POST', body: { username, password } });
      onLogin();
    } catch (failure) { setError(failure instanceof Error ? failure.message : (setup ? '初始化失败' : '登录失败')); }
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
        {!secretReady ? <>
          <div className="login-card-head"><span className="login-badge"><LockKeyhole size={14}/>尚未配置密钥</span><h2>还差最后一步</h2><p>需要先在 Cloudflare 控制台设置加密密钥，然后刷新此页。</p></div>
          <Notice type="warning"><strong>服务还没有完成初始化。</strong> 请在 Cloudflare 控制台的 <strong>Workers &amp; Pages → {appName} → Settings → Variables and Secrets</strong> 中添加一个 <strong>Secret</strong>：<code className="inline-code">ENCRYPTION_KEY</code>（至少 32 个字符）。它是用于加密 R2 账号凭据的根密钥，请保存好，后续不要更改。</Notice>
        </> : <>
          <div className="login-card-head"><span className="login-badge"><LockKeyhole size={14}/>{setup ? '初始化' : '管理入口'}</span><h2>{setup ? '创建管理员账号' : '欢迎回来'}</h2><p>{setup ? '设置管理员用户名和密码，完成网盘初始化。' : '输入管理员账号，进入你的多账号网盘。'}</p></div>
          {error && <div className="error-box"><span>{error}</span></div>}
          <form className="login-form" onSubmit={(event) => void submit(event)}>
            <label className="field"><span>管理员用户名</span><input type="text" value={username} onChange={(event) => setUsername(event.target.value)} placeholder="设置用户名" autoComplete="username" autoFocus required disabled={busy}/></label>
            <label className="field"><span>管理员密码</span><input type="password" value={password} onChange={(event) => setPassword(event.target.value)} placeholder={setup ? '设置密码（至少 12 个字符）' : '输入密码'} autoComplete={setup ? 'new-password' : 'current-password'} required disabled={busy}/></label>
            {setup && <label className="field"><span>确认密码</span><input type="password" value={confirm} onChange={(event) => setConfirm(event.target.value)} placeholder="再次输入密码" autoComplete="new-password" required disabled={busy}/></label>}
            <Button type="submit" variant="primary" busy={busy} disabled={!username || !password || (setup && !confirm)} className="login-submit">{setup ? '完成初始化' : '进入网盘'} <ArrowRight size={16}/></Button>
          </form>
        </>}
      </div>
    </div>
  </div>;
}
