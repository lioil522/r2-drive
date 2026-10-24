import { createHash } from 'node:crypto';
import { assert } from './errors';

export async function hashStream(stream: ReadableStream<Uint8Array>, expected: number): Promise<string> {
  const hash = createHash('sha256');
  const reader = stream.getReader();
  let size = 0;
  try {
    while (true) {
      const {done,value} = await reader.read();
      if (done) break;
      size += value.byteLength;
      assert(size <= expected,'远端返回的数据大于请求范围',502);
      hash.update(value);
    }
    assert(size === expected,'远端数据长度与请求范围不符',502);
    return hash.digest('hex');
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

export async function forwardAndHash(stream: ReadableStream<Uint8Array>, writable: WritableStream<Uint8Array>, expected: number): Promise<string> {
  const hash = createHash('sha256');
  const reader = stream.getReader();
  const writer = writable.getWriter();
  let size = 0;
  try {
    while (true) {
      const {done,value} = await reader.read();
      if (done) break;
      size+=value.byteLength;
      assert(size <= expected,'远端返回的数据大于请求范围',502);
      hash.update(value);
      await writer.write(value);
    }
    assert(size === expected,'远端数据长度与请求范围不符',502);
    await writer.close();
    return hash.digest('hex');
  } catch (error) {
    await writer.abort(error).catch(() => undefined);
    throw error;
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock(); writer.releaseLock();
  }
}
