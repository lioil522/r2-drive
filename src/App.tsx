import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { AlertTriangle, ArrowUpDown, Clock3, Database, FolderOpen, LayoutDashboard, Link2, LogOut, Menu, Moon, Server, ShieldCheck, Star, Sun, Trash2, UploadCloud, X, type LucideIcon } from 'lucide-react';
import { api } from './api';
import { ToastContext, navigate, useHashRoute } from './hooks';
import { Button, IconButton, Loading, Logo } from './components/ui';
import Overview from './pages/Overview';
import Files from './pages/Files';
import MissingFiles from './pages/MissingFiles';
import Accounts from './pages/Accounts';
import Buckets from './pages/Buckets';
import Transfers from './pages/Transfers';
import Shares from './pages/Shares';
import Login from './pages/Login';
import PublicShare from './pages/PublicShare';
import AccountForm from './components/AccountForm';
import UploadDialog from './components/UploadDialog';

interface SessionInfo { authenticated: boolean; configured: boolean; appName: string }
interface ToastItem { id: string; message: string; type: 'success' | 'error' | 'info' }

const groups: { label: string; items: { id: string; label: string; icon: LucideIcon }[] }[] = [
  { label: '工作区', items: [{ id: 'overview', label: '概览', icon: LayoutDashboard }, { id: 'files', label: '我的文件', icon: FolderOpen }, { id: 'recent', label: '最近文件', icon: Clock3 }, { id: 'starred', label: '收藏', icon: Star }, { id: 'trash', label: '回收站', icon: Trash2 }, { id:'missing',label:'缺失文件',icon:AlertTriangle }] },
  { label: '存储管理', items: [{ id: 'accounts', label: '存储账号', icon: Database }, { id: 'buckets', label: '存储桶', icon: Server }] },
  { label: '活动记录', items: [{ id: 'transfers', label: '传输中心', icon: ArrowUpDown }, { id: 'shares', label: '我的分享', icon: Link2 }] },
];

function BootScreen({ message }: { message?: string }) {
  return <div className="boot-screen"><Logo/><Loading/>{message&&<p className="boot-error">{message}</p>}</div>;
}

export default function App() {
  const route = useHashRoute();
  const [session, setSession] = useState<SessionInfo | null>(null);
  const [sessionError, setSessionError] = useState('');
  const [dark, setDark] = useState(() => {
    const saved = localStorage.getItem('r2-drive-theme');
    if (saved) return saved === 'dark';
    return window.matchMedia('(prefers-color-scheme: dark)').matches;
  });
  useEffect(() => {
    document.documentElement.dataset.theme = dark ? 'dark' : 'light';
    localStorage.setItem('r2-drive-theme', dark ? 'dark' : 'light');
  }, [dark]);
  const loadSession = useCallback(() => {
    setSessionError('');
    void api<SessionInfo>('/session').then(setSession).catch((failure) => setSessionError(failure instanceof Error ? failure.message : '无法读取登录状态'));
  }, []);
  useEffect(() => { loadSession(); }, [loadSession]);
  useEffect(() => {
    const expire = () => setSession((current) => current ? { ...current, authenticated: false } : current);
    window.addEventListener('session-expired', expire);
    return () => window.removeEventListener('session-expired', expire);
  }, []);

  const share = /^s\/([^/?]+)/.exec(route);
  if (share) return <PublicShare id={share[1]}/>;
  if (!session) return <BootScreen message={sessionError || undefined}/>;
  if (!session.authenticated) return <Login configured={session.configured} appName={session.appName} onLogin={loadSession}/>;
  return <Shell route={route} session={session} onLogout={loadSession} dark={dark} onToggleDark={() => setDark((value) => !value)}/>;
}

function Shell({ route, session, onLogout, dark, onToggleDark }: { route: string; session: SessionInfo; onLogout: () => void; dark: boolean; onToggleDark: () => void }) {
  const [pathname, search = ''] = route.split('?');
  const params = new URLSearchParams(search);
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const [upload, setUpload] = useState<{ parent: string; bucketId?: string } | null>(null);
  const [addingAccount, setAddingAccount] = useState(false);
  const [navOpen, setNavOpen] = useState(false);
  const toast = useCallback((message: string, type: 'success' | 'error' | 'info' = 'info') => {
    const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    setToasts((list) => [...list, { id, message, type }]);
    window.setTimeout(() => setToasts((list) => list.filter((item) => item.id !== id)), 4600);
  }, []);
  const openUpload = (parent = '/', bucketId?: string) => setUpload({ parent, bucketId });
  const logout = async () => { try { await api('/logout', { method: 'POST', body: {} }); } finally { onLogout(); } };
  const go = (target: string) => { navigate(target); setNavOpen(false); };
  const activeKey = pathname.startsWith('bucket/') ? 'buckets' : pathname;

  const bucketRoute = /^bucket\/([^/?]+)/.exec(pathname);
  if (bucketRoute) params.set('bucket', bucketRoute[1]);

  let page: ReactNode;
  if (pathname === 'files') page = <Files params={params} onUpload={openUpload}/>;
  else if (pathname === 'recent') page = <Files view="recent" params={params} onUpload={openUpload}/>;
  else if (pathname === 'starred') page = <Files view="starred" params={params} onUpload={openUpload}/>;
  else if (pathname === 'trash') page = <Files view="trash" params={params} onUpload={openUpload}/>;
  else if (pathname === 'missing') page = <MissingFiles/>;
  else if (pathname === 'accounts') page = <Accounts onAdd={() => setAddingAccount(true)}/>;
  else if (pathname === 'buckets') page = <Buckets params={params}/>;
  else if (pathname === 'transfers') page = <Transfers onUpload={() => openUpload()}/>;
  else if (pathname === 'shares') page = <Shares/>;
  else page = <Overview onUpload={() => openUpload()} onAccount={() => setAddingAccount(true)}/>;

  return <ToastContext.Provider value={toast}>
      <div className="app-shell">
        <aside className={`app-sidebar ${navOpen ? 'open' : ''}`}>
          <div className="sidebar-head"><button className="sidebar-brand" onClick={() => go('overview')}><Logo/></button><IconButton icon={X} label="关闭菜单" className="sidebar-close" onClick={() => setNavOpen(false)}/></div>
          <nav className="sidebar-nav">{groups.map((group) => <div className="nav-group" key={group.label}><span className="nav-label">{group.label}</span>{group.items.map(({ id, label, icon: Icon }) => <button key={id} className={`nav-link ${activeKey === id || (id !== 'overview' && pathname.startsWith(`${id}/`)) ? 'active' : ''}`} onClick={() => go(id)}><Icon size={18}/><span>{label}</span></button>)}</div>)}</nav>
          <div className="sidebar-foot"><button type="button" className="theme-toggle" onClick={onToggleDark} aria-label={dark ? '切换到浅色模式' : '切换到暗色模式'}>{dark ? <Sun size={16}/> : <Moon size={16}/>}<span>{dark ? '浅色模式' : '暗色模式'}</span></button><div className="user-chip"><span><ShieldCheck size={17}/></span><div><strong>本地管理员</strong><small>{session.appName}</small></div><IconButton icon={LogOut} label="退出登录" onClick={() => void logout()}/></div><p>凭据加密 · 文件私有</p></div>
        </aside>
        {navOpen&&<div className="sidebar-overlay" onClick={() => setNavOpen(false)}/>}
        <div className="app-content">
          <div className="mobile-bar"><button className="mobile-menu" onClick={() => setNavOpen(true)} aria-label="打开菜单"><Menu size={20}/></button><Logo small/><Button variant="primary" icon={UploadCloud} onClick={() => openUpload()}>上传</Button></div>
          <main className="app-main" key={pathname}>{page}</main>
          <footer className="app-footer"><span>R2 Drive · 多账号存储池</span><span>上传直连 R2 · 跨账号分段自动重组 · 凭据加密存储</span></footer>
        </div>
      </div>
      {upload&&<UploadDialog parent={upload.parent} bucketId={upload.bucketId} onClose={() => setUpload(null)}/>}
      {addingAccount&&<AccountForm onClose={() => setAddingAccount(false)}/>}
      <div className="toast-stack">{toasts.map((item) => <div key={item.id} className={`toast toast-${item.type}`} role="status"><span>{item.type==='success'?'✓':item.type==='error'?'!':'i'}</span><span className="toast-message">{item.message}</span></div>)}</div>
  </ToastContext.Provider>;
}
