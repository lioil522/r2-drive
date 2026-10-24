import { Archive, Code2, File, FileText, Image, Music2, Video, type LucideIcon } from 'lucide-react';

export const kinds: Record<string, { icon: LucideIcon; label: string }> = {
  image: { icon: Image, label: '图片' },
  video: { icon: Video, label: '视频' },
  audio: { icon: Music2, label: '音频' },
  document: { icon: FileText, label: '文档' },
  archive: { icon: Archive, label: '压缩包' },
  code: { icon: Code2, label: '代码' },
  other: { icon: File, label: '其他' },
};

export function kindLabel(type: string): string {
  return kinds[type]?.label || '其他';
}
