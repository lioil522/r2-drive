import { UPLOAD_URL_BATCH, UPLOAD_URL_TTL_SECONDS } from '../shared/paths';
import type { UploadLink } from '../shared/types';

// 批量预取签名不改变上传并发；慢速上传与重试只重新签发过期的分片。
export class UploadLinks {
  private links = new Map<number, UploadLink & { expiresAt: number }>();
  private pending: Promise<void> | null = null;

  constructor(private sign: (parts: number[]) => Promise<UploadLink[]>) {}

  private fresh(partNumber: number): boolean {
    return (this.links.get(partNumber)?.expiresAt || 0) > Date.now() + 60_000;
  }

  async ensure(required: number[], ahead: number[] = required): Promise<void> {
    if (required.every((number) => this.fresh(number))) return;
    if (this.pending) {
      await this.pending;
      if (required.every((number) => this.fresh(number))) return;
    }
    const parts = [...new Set([...required, ...ahead])].filter((number) => !this.fresh(number)).slice(0, UPLOAD_URL_BATCH);
    const requestedAt = Date.now();
    const pending = this.sign(parts).then((links) => {
      for (const link of links) {
        if (!parts.includes(link.partNumber)) continue;
        this.links.set(link.partNumber, { ...link, expiresAt: Math.min(link.expiresAt ?? Infinity, requestedAt + UPLOAD_URL_TTL_SECONDS * 1000) });
      }
      if (!required.every((number) => this.fresh(number))) throw new Error('服务端未返回有效的分片签名，请重试上传。');
    }).finally(() => { if (this.pending === pending) this.pending = null; });
    this.pending = pending;
    await pending;
  }

  get(partNumber: number): UploadLink {
    const link = this.links.get(partNumber);
    if (!link || !this.fresh(partNumber)) throw new Error('分片签名已过期，请重试上传。');
    return link;
  }

  invalidate(partNumber: number): void { this.links.delete(partNumber); }
}
