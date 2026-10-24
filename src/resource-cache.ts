export interface ResourceSnapshot<T> {
  data: T | null;
  loading: boolean;
  error: string;
}

export interface WatchOptions {
  interval: number;
  staleTime: number;
}

type Listener = () => void;
interface Entry {
  path: string;
  snapshot: ResourceSnapshot<unknown>;
  hasData: boolean;
  updatedAt: number;
  settledAt: number;
  version: number;
  invalidatedAt: number | null;
  failures: number;
  promise: Promise<void> | null;
  manualPromise: Promise<void> | null;
  controller: AbortController | null;
  watchers: Map<Listener, () => WatchOptions>;
  timer: ReturnType<typeof setTimeout> | null;
  timerAt: number | null;
  lastUsedAt: number;
}

const empty: ResourceSnapshot<never> = { data: null, loading: false, error: '' };

// 每个资源只有一个请求和一个轮询计时器；数据只保存在当前页面的内存中。
export class ResourceCache {
  private entries = new Map<string, Entry>();
  private active = true;

  constructor(
    private loader: (path: string, signal: AbortSignal) => Promise<unknown>,
    private onUpdate?: (path: string, data: unknown, previous: unknown) => void,
    private maxEntries = 128,
  ) {}

  private entry(path: string): Entry {
    let entry = this.entries.get(path);
    if (!entry) {
      entry = {
        path, snapshot: { data: null, loading: true, error: '' }, hasData: false,
        updatedAt: 0, settledAt: Date.now(), version: 0, invalidatedAt: null, failures: 0,
        promise: null, manualPromise: null, controller: null, watchers: new Map(), timer: null, timerAt: null, lastUsedAt: Date.now(),
      };
      this.entries.set(path, entry);
      this.prune(path);
    }
    entry.lastUsedAt = Date.now();
    return entry;
  }

  getSnapshot<T>(path: string | null): ResourceSnapshot<T> {
    return path ? this.entry(path).snapshot as ResourceSnapshot<T> : empty;
  }

  subscribe(path: string, listener: Listener, options: () => WatchOptions): () => void {
    const entry = this.entry(path);
    entry.watchers.set(listener, options);
    if (this.active) void this.load(path);
    return () => {
      entry.watchers.delete(listener);
      this.schedule(entry);
      this.prune();
    };
  }

  private notify(entry: Entry): void {
    for (const listener of entry.watchers.keys()) listener();
  }

  private staleTime(entry: Entry): number {
    const times = [...entry.watchers.values()].map((options) => options().staleTime);
    return times.length ? Math.min(...times) : 30_000;
  }

  private retryDelay(entry: Entry): number {
    return entry.failures ? Math.min(120_000, 30_000 * 2 ** Math.min(entry.failures - 1, 2)) : 0;
  }

  async load(path: string, force = false, loader = this.loader, timeoutMs = 30_000): Promise<void> {
    const entry = this.entry(path);
    if (entry.promise) return entry.promise;
    if (!force && entry.invalidatedAt === null && (
      entry.failures ? Date.now() - entry.settledAt < this.retryDelay(entry) :
      entry.hasData && Date.now() - entry.updatedAt < this.staleTime(entry)
    )) {
      this.schedule(entry);
      return;
    }
    this.stopTimer(entry);
    const version = entry.version;
    const controller = new AbortController();
    entry.controller = controller;
    entry.invalidatedAt = null;
    let rejectAbort!: (reason: unknown) => void;
    const aborted = new Promise<never>((_resolve,reject)=>{rejectAbort=reject;});
    const onAbort = () => rejectAbort(controller.signal.reason || new Error('请求已取消'));
    controller.signal.addEventListener('abort',onAbort,{once:true});
    const timeout = setTimeout(()=>controller.abort(new Error('请求超时，请重新刷新')),timeoutMs);
    const request = Promise.resolve().then(() => {
      if (controller.signal.aborted) throw controller.signal.reason;
      return loader(path, controller.signal);
    });
    const promise = Promise.race([request,aborted]).then((data) => {
      if (entry.version !== version) return;
      const previous = entry.snapshot.data;
      entry.hasData = true;
      entry.updatedAt = Date.now();
      entry.failures = 0;
      entry.snapshot = { data, loading: false, error: '' };
      this.onUpdate?.(path,data,previous);
      this.notify(entry);
    }).catch((failure: unknown) => {
      if (entry.version !== version) return;
      entry.failures++;
      entry.snapshot = { ...entry.snapshot, loading: false, error: failure instanceof Error ? failure.message : '加载失败' };
      this.notify(entry);
    }).finally(() => {
      clearTimeout(timeout);
      controller.signal.removeEventListener('abort',onAbort);
      if (entry.promise !== promise) return;
      entry.promise = null;
      entry.controller = null;
      entry.settledAt = Date.now();
      this.schedule(entry);
      this.prune();
    });
    entry.promise = promise;
    entry.snapshot = { ...entry.snapshot, loading: true, error: '' };
    this.notify(entry);
    return promise;
  }

  async refresh(path: string, loader?: (path: string, signal: AbortSignal) => Promise<unknown>, timeoutMs = 30_000): Promise<void> {
    const entry = this.entry(path);
    if (entry.manualPromise) return entry.manualPromise;
    const promise = Promise.resolve().then(async()=>{
      if (entry.manualPromise!==promise) return;
      if (entry.promise) {
        entry.version++;
        entry.controller?.abort();
        entry.promise = null;
        entry.controller = null;
      }
      // 手动刷新不复用此前的后台请求；短时间重复点击仍共享同一个刷新。
      for (let attempt=0;attempt<2;attempt++) {
        if (entry.manualPromise!==promise) return;
        await this.load(path,true,loader,timeoutMs);
        if (entry.invalidatedAt===null) break;
      }
    });
    entry.manualPromise = promise;
    try {await promise;}
    finally {if(entry.manualPromise===promise)entry.manualPromise=null;}
  }

  setData<T>(path: string, value: T | null | ((previous: T | null) => T | null)): void {
    const entry = this.entry(path);
    entry.version++;
    const previous = entry.snapshot.data;
    const data = typeof value === 'function' ? (value as (previous: T | null) => T | null)(previous as T | null) : value;
    entry.hasData = true;
    entry.updatedAt = entry.settledAt = Date.now();
    entry.invalidatedAt = null;
    entry.failures = 0;
    entry.snapshot = { data, loading: false, error: '' };
    this.onUpdate?.(path,data,previous);
    this.notify(entry);
    this.schedule(entry);
  }

  seed<T>(path: string, data: T): void {
    const entry = this.entries.get(path);
    if (entry?.watchers.size || entry?.promise) return;
    this.setData(path,data);
  }

  invalidate(matches: (path: string) => boolean, delay = 250): void {
    for (const entry of this.entries.values()) {
      if (!matches(entry.path)) continue;
      entry.version++;
      entry.invalidatedAt = Math.min(entry.invalidatedAt ?? Infinity, Date.now() + delay);
      this.schedule(entry);
    }
  }

  clear(matches: (path: string) => boolean = () => true): void {
    for (const entry of this.entries.values()) {
      if (!matches(entry.path)) continue;
      entry.version++;
      entry.controller?.abort();
      entry.promise = null;
      entry.manualPromise = null;
      entry.controller = null;
      this.stopTimer(entry);
      entry.hasData = false;
      entry.updatedAt = 0;
      entry.settledAt = Date.now();
      entry.invalidatedAt = null;
      entry.failures = 0;
      entry.snapshot = { data: null, loading: true, error: '' };
      this.notify(entry);
      if (!entry.watchers.size) this.entries.delete(entry.path);
    }
  }

  setActive(active: boolean): void {
    this.active = active;
    for (const entry of this.entries.values()) {
      if (!active) this.stopTimer(entry);
      else if (entry.watchers.size) {
        const intervals = [...entry.watchers.values()].map((options) => options().interval).filter((interval) => interval > 0);
        const due = intervals.length > 0 && Date.now() - entry.settledAt >= Math.min(...intervals);
        void this.load(entry.path, due);
      }
    }
  }

  reschedule(path: string): void {
    const entry = this.entries.get(path);
    if (entry) this.schedule(entry);
  }

  private schedule(entry: Entry): void {
    if (!this.active || !entry.watchers.size || entry.promise) { this.stopTimer(entry); return; }
    const intervals = [...entry.watchers.values()].map((options) => options().interval).filter((interval) => interval > 0);
    const interval = intervals.length ? Math.min(...intervals) : 0;
    const at = entry.invalidatedAt ?? (interval ? entry.settledAt + Math.max(interval, this.retryDelay(entry)) : null);
    if (at === null) { this.stopTimer(entry); return; }
    if (entry.timerAt === at) return;
    this.stopTimer(entry);
    entry.timerAt = at;
    entry.timer = setTimeout(() => {
      entry.timer = null;
      entry.timerAt = null;
      void this.load(entry.path, true);
    }, Math.max(0, at - Date.now()));
  }

  private stopTimer(entry: Entry): void {
    if (entry.timer !== null) clearTimeout(entry.timer);
    entry.timer = null;
    entry.timerAt = null;
  }

  private prune(excludedPath?: string): void {
    if (this.entries.size <= this.maxEntries) return;
    const unused = [...this.entries.values()].filter((entry) => entry.path !== excludedPath && !entry.watchers.size && !entry.promise && !entry.manualPromise).sort((left, right) => left.lastUsedAt - right.lastUsedAt);
    for (const entry of unused) {
      if (this.entries.size <= this.maxEntries) break;
      this.stopTimer(entry);
      this.entries.delete(entry.path);
    }
  }
}
