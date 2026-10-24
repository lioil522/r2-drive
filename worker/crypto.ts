import { assert } from './errors';

const encoder = new TextEncoder();

export function toBase64(bytes: Uint8Array): string {
  return btoa(Array.from(bytes, (byte) => String.fromCharCode(byte)).join(''));
}

export function fromBase64(value: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(atob(value), (char) => char.charCodeAt(0));
}

export async function sha256(value: string): Promise<string> {
  const hash = await crypto.subtle.digest('SHA-256', encoder.encode(value));
  return Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export async function safeEqual(provided: string, expected: string): Promise<boolean> {
  const [left, right] = await Promise.all([
    crypto.subtle.digest('SHA-256', encoder.encode(provided)),
    crypto.subtle.digest('SHA-256', encoder.encode(expected)),
  ]);
  return crypto.subtle.timingSafeEqual(left, right);
}

async function encryptionKey(secret: string): Promise<CryptoKey> {
  assert(secret.length >= 32 && !secret.startsWith('replace-'), '请先配置 ENCRYPTION_KEY（至少 32 个字符）', 503);
  return crypto.subtle.importKey('raw', await crypto.subtle.digest('SHA-256', encoder.encode(secret)), 'AES-GCM', false, ['encrypt', 'decrypt']);
}

export async function encrypt(value: unknown, secret: string, context: string): Promise<string> {
  const key = await encryptionKey(secret);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: encoder.encode(context) }, key, encoder.encode(JSON.stringify(value)));
  return `v1.${toBase64(iv)}.${toBase64(new Uint8Array(data))}`;
}

export async function decrypt<T>(value: string, secret: string, context: string): Promise<T> {
  const [version, iv, ciphertext] = value.split('.');
  assert(version === 'v1' && iv && ciphertext, '凭据格式无效', 500);
  const key = await encryptionKey(secret);
  const data = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromBase64(iv), additionalData: encoder.encode(context) }, key, fromBase64(ciphertext));
  return JSON.parse(new TextDecoder().decode(data)) as T;
}

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', encoder.encode(`r2-drive-session:${secret}`), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}

export async function createSession(env: Env): Promise<string> {
  const payload = toBase64(encoder.encode(JSON.stringify({ expires: Date.now() + 7 * 24 * 60 * 60 * 1000, nonce: crypto.randomUUID(), passwordVersion: await sha256(env.ADMIN_PASSWORD) })));
  const signature = await crypto.subtle.sign('HMAC', await hmacKey(env.ENCRYPTION_KEY), encoder.encode(payload));
  return `${payload}.${toBase64(new Uint8Array(signature))}`;
}

export async function isAuthenticated(request: Request, env: Env): Promise<boolean> {
  if (!env.ADMIN_PASSWORD || !env.ENCRYPTION_KEY) return false;
  const session = request.headers.get('Cookie')?.split(';').map((part) => part.trim()).find((part) => part.startsWith('r2_session='))?.slice(11);
  if (!session) return false;
  try {
    const [payload, signature] = session.split('.');
    if (!payload || !signature) return false;
    if (!await crypto.subtle.verify('HMAC', await hmacKey(env.ENCRYPTION_KEY), fromBase64(signature), encoder.encode(payload))) return false;
    const data = JSON.parse(new TextDecoder().decode(fromBase64(payload))) as { expires: number; passwordVersion: string };
    return data.expires > Date.now() && await safeEqual(data.passwordVersion, await sha256(env.ADMIN_PASSWORD));
  } catch {
    return false;
  }
}

export function sessionCookie(request: Request, value: string, maxAge = 604800): string {
  const secure = new URL(request.url).protocol === 'https:' ? '; Secure' : '';
  return `r2_session=${value}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAge}${secure}`;
}

export interface FileToken { fileId: string; etag: string; expires: number; preview: boolean; shareId?: string }

export async function createFileToken(env: Env, value: FileToken): Promise<string> {
  const payload=toBase64(encoder.encode(JSON.stringify(value)));
  const key=await crypto.subtle.importKey('raw',encoder.encode(`r2-drive-content:${env.ENCRYPTION_KEY}`),{name:'HMAC',hash:'SHA-256'},false,['sign']);
  const signature=await crypto.subtle.sign('HMAC',key,encoder.encode(payload));
  return `${payload}.${toBase64(new Uint8Array(signature))}`;
}

export async function verifyFileToken(env: Env, token: string): Promise<FileToken | null> {
  try {
    if (token.length>4096) return null;
    const [payload,signature,...extra]=token.split('.');if(!payload || !signature || extra.length) return null;
    const key=await crypto.subtle.importKey('raw',encoder.encode(`r2-drive-content:${env.ENCRYPTION_KEY}`),{name:'HMAC',hash:'SHA-256'},false,['verify']);
    if (!await crypto.subtle.verify('HMAC',key,fromBase64(signature),encoder.encode(payload))) return null;
    const data=JSON.parse(new TextDecoder().decode(fromBase64(payload))) as FileToken;
    return typeof data.fileId==='string' && typeof data.etag==='string' && typeof data.preview==='boolean' && Number.isSafeInteger(data.expires) && data.expires>Date.now() && (data.shareId===undefined || typeof data.shareId==='string') ? data : null;
  } catch {return null;}
}
