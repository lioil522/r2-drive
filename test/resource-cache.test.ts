import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ResourceCache, type WatchOptions } from '../src/resource-cache';

describe('shared resource requests', () => {
  let cache: ResourceCache;

  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { cache?.clear(); vi.useRealTimers(); });

  it('shares cached data, in-flight requests and polling between views and dialogs', async () => {
    const loader = vi.fn(async () => ({ accounts: ['personal'] }));
    cache = new ResourceCache(loader);
    const options = () => ({ interval: 120_000, staleTime: 30_000 });
    const first = cache.subscribe('/status', () => {}, options);
    const second = cache.subscribe('/status', () => {}, options);
    await cache.load('/status');
    expect(loader).toHaveBeenCalledTimes(1);

    first(); second();
    const next = cache.subscribe('/status', () => {}, options);
    await cache.load('/status');
    expect(loader).toHaveBeenCalledTimes(1);
    expect(cache.getSnapshot('/status').data).toEqual({ accounts: ['personal'] });
    await vi.advanceTimersByTimeAsync(120_000);
    expect(loader).toHaveBeenCalledTimes(2);
    next();
  });

  it('polls quickly only while work is running and pauses hidden-page requests', async () => {
    let running = true;
    const loader = vi.fn(async () => ({ running }));
    cache = new ResourceCache(loader);
    const options = (): WatchOptions => ({
      interval: cache.getSnapshot<{ running: boolean }>('/status').data?.running ? 5000 : 120_000,
      staleTime: 30_000,
    });
    cache.subscribe('/status', () => {}, options);
    await cache.load('/status');
    await vi.advanceTimersByTimeAsync(5000);
    expect(loader).toHaveBeenCalledTimes(2);
    running = false;
    await vi.advanceTimersByTimeAsync(5000);
    expect(loader).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(119_999);
    expect(loader).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(1);
    expect(loader).toHaveBeenCalledTimes(4);

    cache.setActive(false);
    await vi.advanceTimersByTimeAsync(600_000);
    expect(loader).toHaveBeenCalledTimes(4);
    cache.setActive(true);
    await cache.load('/status');
    expect(loader).toHaveBeenCalledTimes(5);
    cache.setActive(true);
    await cache.load('/status');
    expect(loader).toHaveBeenCalledTimes(5);
  });

  it('does not overlap slow requests or create a retry loop on errors', async () => {
    let finish!: (value: unknown) => void;
    const loader = vi.fn(() => new Promise((resolve) => { finish = resolve; }));
    cache = new ResourceCache(loader);
    cache.subscribe('/status', () => {}, () => ({ interval: 5000, staleTime: 30_000 }));
    await vi.advanceTimersByTimeAsync(20_000);
    expect(loader).toHaveBeenCalledTimes(1);
    finish({ running: true });
    await cache.load('/status');
    await vi.advanceTimersByTimeAsync(4999);
    expect(loader).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(loader).toHaveBeenCalledTimes(2);
    finish({ running: true });
    await cache.load('/status');

    cache.clear();
    const failing = vi.fn(async () => { throw new Error('offline'); });
    cache = new ResourceCache(failing);
    cache.subscribe('/status', () => {}, () => ({ interval: 5000, staleTime: 30_000 }));
    await cache.load('/status');
    await vi.advanceTimersByTimeAsync(29_999);
    expect(failing).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(failing).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(59_999);
    expect(failing).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(failing).toHaveBeenCalledTimes(3);
  });

  it('coalesces mutations and discards a response started before invalidation', async () => {
    let finish!: (value: unknown) => void;
    const loader = vi.fn(() => new Promise((resolve) => { finish = resolve; }));
    const onUpdate = vi.fn();
    cache = new ResourceCache(loader,onUpdate);
    cache.subscribe('/status', () => {}, () => ({ interval: 120_000, staleTime: 30_000 }));
    await vi.advanceTimersByTimeAsync(0);
    cache.invalidate((path) => path === '/status');
    cache.invalidate((path) => path === '/status');
    finish({ stale: true });
    await cache.load('/status');
    expect(cache.getSnapshot('/status').data).toBeNull();
    expect(onUpdate).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(250);
    expect(loader).toHaveBeenCalledTimes(2);
    finish({ stale: false });
    await cache.load('/status');
    expect(cache.getSnapshot('/status').data).toEqual({ stale: false });
    expect(onUpdate).toHaveBeenCalledOnce();
  });

  it('reuses overview state only when no live status request or subscriber owns it', async () => {
    let finish!: (value: unknown) => void;
    const loader = vi.fn(() => new Promise((resolve) => { finish = resolve; }));
    cache = new ResourceCache(loader);
    cache.seed('/status',{ source: 'overview' });
    const unsubscribe = cache.subscribe('/status', () => {}, () => ({ interval: 120_000, staleTime: 30_000 }));
    await cache.load('/status');
    expect(loader).not.toHaveBeenCalled();
    cache.seed('/status',{ source: 'older overview' });
    expect(cache.getSnapshot('/status').data).toEqual({ source: 'overview' });
    unsubscribe();

    const pending = cache.load('/status',true);
    await vi.advanceTimersByTimeAsync(0);
    cache.seed('/status',{ source: 'older overview' });
    finish({ source: 'status request' });
    await pending;
    expect(cache.getSnapshot('/status').data).toEqual({ source: 'status request' });
  });

  it('clears private data on logout and ignores late responses from the previous session', async () => {
    let finish!: (value: unknown) => void;
    cache = new ResourceCache(() => new Promise((resolve) => { finish = resolve; }));
    cache.subscribe('/status', () => {}, () => ({ interval: 120_000, staleTime: 30_000 }));
    const pending = cache.load('/status');
    await vi.advanceTimersByTimeAsync(0);
    cache.clear();
    finish({ private: true });
    await pending;
    expect(cache.getSnapshot('/status').data).toBeNull();
    await vi.advanceTimersByTimeAsync(600_000);
    expect(cache.getSnapshot('/status').data).toBeNull();
  });

  it('refreshes cached data immediately with loading feedback and deduplicates manual clicks',async()=>{
    let finish!: (value:unknown)=>void;
    const loader=vi.fn().mockResolvedValueOnce({version:1}).mockImplementation(()=>new Promise((resolve)=>{finish=resolve;}));
    cache=new ResourceCache(loader);
    cache.subscribe('/files',()=>{},()=>({interval:120_000,staleTime:30_000}));
    await cache.load('/files');await cache.load('/files');expect(loader).toHaveBeenCalledTimes(1);
    const refresh=cache.refresh('/files');const duplicate=cache.refresh('/files');
    await vi.advanceTimersByTimeAsync(0);
    expect(loader).toHaveBeenCalledTimes(2);expect(cache.getSnapshot('/files')).toMatchObject({data:{version:1},loading:true});
    finish({version:2});await Promise.all([refresh,duplicate]);
    expect(cache.getSnapshot('/files')).toEqual({data:{version:2},loading:false,error:''});
  });

  it('replaces an old pending request on manual refresh and ignores its late response',async()=>{
    const requests:{signal:AbortSignal;finish:(value:unknown)=>void}[]=[];
    const loader=vi.fn((_path:string,signal:AbortSignal)=>new Promise((finish)=>requests.push({signal,finish})));
    cache=new ResourceCache(loader);
    cache.subscribe('/files',()=>{},()=>({interval:120_000,staleTime:30_000}));
    const previous=cache.load('/files');await vi.advanceTimersByTimeAsync(0);
    const refresh=cache.refresh('/files');await vi.advanceTimersByTimeAsync(0);
    expect(requests).toHaveLength(2);expect(requests[0].signal.aborted).toBe(true);
    requests[1].finish({fresh:true});await refresh;
    requests[0].finish({fresh:false});await previous;await vi.advanceTimersByTimeAsync(0);
    expect(cache.getSnapshot('/files').data).toEqual({fresh:true});
  });

  it('times out stalled requests and lets manual refresh bypass retry backoff',async()=>{
    const loader=vi.fn().mockImplementationOnce(()=>new Promise(()=>{})).mockResolvedValue({recovered:true});
    cache=new ResourceCache(loader);
    cache.subscribe('/files',()=>{},()=>({interval:5000,staleTime:30_000}));
    await vi.advanceTimersByTimeAsync(30_000);
    expect(cache.getSnapshot('/files').loading).toBe(false);expect(cache.getSnapshot('/files').error).toContain('请求超时');
    await cache.refresh('/files');expect(loader).toHaveBeenCalledTimes(2);
    expect(cache.getSnapshot('/files')).toEqual({data:{recovered:true},loading:false,error:''});
  });

  it('does not start a queued refresh after the session cache is cleared',async()=>{
    const loader=vi.fn(async()=>({private:true}));cache=new ResourceCache(loader);
    cache.seed('/files',{private:true});const refresh=cache.refresh('/files');cache.clear();await refresh;
    expect(loader).not.toHaveBeenCalled();expect(cache.getSnapshot('/files').data).toBeNull();
  });

  it('uses the remote-validation loader only for manual refresh, not normal polling',async()=>{
    const normal=vi.fn(async()=>({source:'index'}));const remote=vi.fn(async()=>({source:'R2 check'}));
    cache=new ResourceCache(normal);cache.subscribe('/files',()=>{},()=>({interval:5000,staleTime:30_000}));await cache.load('/files');
    await cache.refresh('/files',remote);expect(cache.getSnapshot('/files').data).toEqual({source:'R2 check'});
    await vi.advanceTimersByTimeAsync(5000);expect(remote).toHaveBeenCalledOnce();expect(normal).toHaveBeenCalledTimes(2);
    expect(cache.getSnapshot('/files').data).toEqual({source:'index'});
  });
});
