export class ApiError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

export async function api<T>(path: string, options: { method?: string; body?: unknown; signal?: AbortSignal; invalidate?: boolean } = {}): Promise<T> {
  const response=await fetch(`/api${path}`,{method:options.method || 'GET',credentials:'same-origin',headers:options.body!==undefined?{'Content-Type':'application/json'}:undefined,body:options.body===undefined?undefined:JSON.stringify(options.body),signal:options.signal});
  const data=await response.json().catch(()=>({error:`服务返回 ${response.status}，请确认 API 已启动。`})) as T & {error?:string};
  if (!response.ok) {
    if (response.status===401 && path!=='/login') window.dispatchEvent(new Event('session-expired'));
    throw new ApiError(response.status,data.error || `请求失败 (${response.status})`);
  }
  if (options.invalidate!==false && !['GET','HEAD','OPTIONS'].includes(options.method || 'GET')) window.dispatchEvent(new CustomEvent('resource-changed',{detail:{path}}));
  return data;
}

export async function copyText(value: string): Promise<void> {
  await navigator.clipboard.writeText(value);
}

export function downloadJson(value: unknown, name: string): void {
  const url=URL.createObjectURL(new Blob([JSON.stringify(value,null,2)],{type:'application/json'}));
  const anchor=document.createElement('a');anchor.href=url;anchor.download=name;anchor.click();
  setTimeout(()=>URL.revokeObjectURL(url),1000);
}
