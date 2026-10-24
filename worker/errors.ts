export class AppError extends Error {
  constructor(public status: number, message: string) {
    super(`[R2D:${status}] ${message}`);
    this.name = 'AppError';
  }
}

export function assert(condition: unknown, message: string, status = 400): asserts condition {
  if (!condition) throw new AppError(status, message);
}

export function errorMessage(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).replace(/\[R2D:\d+\]\s*/g, '');
}

export function errorStatus(error: unknown): number {
  if (error instanceof AppError) return error.status;
  const encoded = (error instanceof Error ? error.message : String(error)).match(/\[R2D:(\d+)\]/);
  if (encoded) return Number(encoded[1]);
  if (error instanceof Error && ['AccessDenied', 'Unauthorized', 'InvalidAccessKeyId', 'SignatureDoesNotMatch'].includes(error.name)) return 403;
  return 500;
}

export async function readBounded(request: Request | Response, maxBytes = 256 * 1024): Promise<string> {
  const length = Number(request.headers.get('Content-Length'));
  if (length > maxBytes) throw new AppError(413, '请求数据过大');
  const reader = request.body?.getReader();
  if (!reader) return '';
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel();
        throw new AppError(413, '响应或请求数据过大');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}
