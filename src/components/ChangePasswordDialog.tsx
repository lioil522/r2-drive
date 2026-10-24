import { useState } from 'react';
import { KeyRound } from 'lucide-react';
import { api } from '../api';
import { Button, Field, Modal } from './ui';

export default function ChangePasswordDialog({ onClose, onSuccess }: { onClose: () => void; onSuccess: () => void }) {
  const [oldPassword, setOldPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const save = async () => {
    if (newPassword !== confirm) { setError('两次输入的新密码不一致'); return; }
    setBusy(true); setError('');
    try {
      await api('/password', { method: 'POST', body: { oldPassword, newPassword } });
      onSuccess();
    } catch (failure) { setError(failure instanceof Error ? failure.message : '修改失败'); }
    finally { setBusy(false); }
  };

  return <Modal title="修改密码" subtitle="修改后其它登录会话将失效，当前会话保持。" onClose={onClose} footer={<><Button onClick={onClose}>取消</Button><Button variant="primary" icon={KeyRound} busy={busy} disabled={!oldPassword || !newPassword || !confirm} onClick={() => void save()}>确认修改</Button></>}>
    <form className="form-stack" onSubmit={(event) => { event.preventDefault(); void save(); }}>
      {error && <div className="error-box"><span>{error}</span></div>}
      <Field label="当前密码"><input type="password" value={oldPassword} onChange={(event) => setOldPassword(event.target.value)} autoComplete="current-password" autoFocus required disabled={busy}/></Field>
      <Field label="新密码" hint="至少 12 个字符"><input type="password" value={newPassword} onChange={(event) => setNewPassword(event.target.value)} placeholder="至少 12 个字符" autoComplete="new-password" required minLength={12} disabled={busy}/></Field>
      <Field label="确认新密码"><input type="password" value={confirm} onChange={(event) => setConfirm(event.target.value)} autoComplete="new-password" required disabled={busy}/></Field>
    </form>
  </Modal>;
}
