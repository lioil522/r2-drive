import type { DriveFile } from '../shared/types';
import type { DriveCatalog } from './catalog';

export function byteRange(value: string | null, size: number): {start:number;length:number} | null {
  if (value===null) return {start:0,length:size};
  const match=/^bytes=(\d*)-(\d*)$/.exec(value.trim());
  if (!match || !size || !match[1] && !match[2]) return null;
  if (!match[1]) {
    const suffix=Number(match[2]);if(!Number.isSafeInteger(suffix) || suffix<=0) return null;
    const length=Math.min(suffix,size);return {start:size-length,length};
  }
  const start=Number(match[1]);const end=match[2] ? Math.min(Number(match[2]),size-1) : size-1;
  return Number.isSafeInteger(start) && Number.isSafeInteger(end) && start<size && end>=start ? {start,length:end-start+1} : null;
}

export async function fileResponse(request: Request, file: DriveFile, catalog: DurableObjectStub<DriveCatalog>, preview: boolean): Promise<Response> {
  const headers=new Headers({'Content-Type':file.metadata.contentType,'Content-Disposition':preview ? `inline; filename*=UTF-8''${encodeURIComponent(file.name)}` : file.metadata.contentDisposition || `attachment; filename*=UTF-8''${encodeURIComponent(file.name)}`,'Cache-Control':'private, no-store','Accept-Ranges':'bytes','ETag':file.etag,'Last-Modified':new Date(file.modifiedAt).toUTCString(),'X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer'});
  if (file.metadata.contentEncoding) headers.set('Content-Encoding',file.metadata.contentEncoding);
  if (file.metadata.contentLanguage) headers.set('Content-Language',file.metadata.contentLanguage);
  const type=file.metadata.contentType.split(';')[0].trim().toLowerCase();
  if (['text/html','application/xhtml+xml','image/svg+xml','application/xml','text/xml'].includes(type)) headers.set('Content-Security-Policy','sandbox');
  if (request.headers.get('If-None-Match')?.split(',').some((etag)=>etag.trim()===file.etag || etag.trim()==='*')) return new Response(null,{status:304,headers});
  const ifRange=request.headers.get('If-Range');
  const value=ifRange && ifRange!==file.etag && (!Number.isFinite(Date.parse(ifRange)) || Math.floor(Date.parse(ifRange)/1000)<Math.floor(file.modifiedAt/1000)) ? null : request.headers.get('Range');
  const range=byteRange(value,file.size);
  if (!range) {headers.set('Content-Range',`bytes */${file.size}`);return new Response(null,{status:416,headers});}
  headers.set('Content-Length',String(range.length));
  if (value!==null) headers.set('Content-Range',`bytes ${range.start}-${range.start+range.length-1}/${file.size}`);
  const body=request.method==='HEAD' ? null : await catalog.readFileRange(file.id,range.start,range.length,file.etag);
  return new Response(body,{status:value===null?200:206,headers,encodeBody:'manual'});
}
