export const GB = 1_000_000_000;
export const OBJECT_OVERHEAD = 8_192;
export const PART_SIZE = 16 * 1024 * 1024;
export const UPLOAD_URL_BATCH = 8;
export const UPLOAD_CONCURRENCY = 2;
export const UPLOAD_URL_TTL_SECONDS = 900;
export const UPLOAD_TTL = 24 * 60 * 60 * 1000;
export const MAX_FILE_SEGMENTS = 512;
export const MAX_UPLOAD_PARTS = 10_000 + MAX_FILE_SEGMENTS;

export function normalizePath(value: string): string {
  const pieces = value.replaceAll('\\', '/').normalize('NFC').split('/').filter(Boolean);
  if (pieces.some((part) => part === '.' || part === '..' || /[\u0000-\u001f]/.test(part))) {
    throw new Error('路径中不能包含 .、.. 或控制字符');
  }
  const path = '/' + pieces.join('/');
  if (new TextEncoder().encode(path).length > 1000) throw new Error('文件路径太长');
  return path;
}

export function parentPath(path: string): string {
  const normalized = normalizePath(path);
  return normalized.substring(0, normalized.lastIndexOf('/')) || '/';
}

export function fileName(path: string): string {
  return normalizePath(path).split('/').at(-1) || '';
}

export function joinPath(parent: string, name: string): string {
  return normalizePath(`${parent}/${name}`);
}

export function allocationBytes(size: number): number {
  return size + OBJECT_OVERHEAD;
}

export function formatBytes(value: number, decimals = 1): string {
  if (value === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const index = Math.min(Math.floor(Math.log(Math.abs(value)) / Math.log(1000)), units.length - 1);
  return `${(value / 1000 ** index).toFixed(index === 0 ? 0 : decimals)} ${units[index]}`;
}

export function fileKind(name: string): string {
  const extension = name.split('.').at(-1)?.toLowerCase() || '';
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'svg', 'heic', 'bmp'].includes(extension)) return 'image';
  if (['mp4', 'mov', 'mkv', 'webm', 'avi', 'm4v'].includes(extension)) return 'video';
  if (['mp3', 'wav', 'flac', 'aac', 'ogg', 'm4a'].includes(extension)) return 'audio';
  if (['pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'txt', 'md', 'csv'].includes(extension)) return 'document';
  if (['zip', 'rar', '7z', 'tar', 'gz'].includes(extension)) return 'archive';
  if (['js', 'ts', 'tsx', 'jsx', 'py', 'json', 'html', 'css', 'yaml', 'yml', 'sh', 'go', 'rs'].includes(extension)) return 'code';
  return 'other';
}

export function contentType(name: string): string {
  const extension = name.split('.').at(-1)?.toLowerCase() || '';
  const types: Record<string, string> = {
    png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
    svg: 'image/svg+xml', avif: 'image/avif', pdf: 'application/pdf', txt: 'text/plain', md: 'text/plain',
    json: 'application/json', csv: 'text/csv', html: 'text/html', css: 'text/css', js: 'text/javascript',
    mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime', mp3: 'audio/mpeg', wav: 'audio/wav',
    ogg: 'audio/ogg', flac: 'audio/flac', zip: 'application/zip', gz: 'application/gzip',
  };
  return types[extension] || 'application/octet-stream';
}
