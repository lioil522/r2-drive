import { createHash } from 'node:crypto';

interface StoredObject { body: Uint8Array; etag: string; metadata: Record<string,string>; type: string; modified: number }
interface Multipart { key: string; metadata: Record<string,string>; type: string; parts: Map<number,{body:Uint8Array;etag:string}> }

const xml=(value:string)=>value.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;');
const result=(body:string,status=200)=>new Response(body,{status,headers:{'Content-Type':'application/xml'}});
const error=(code:string,status:number)=>result(`<Error><Code>${code}</Code><Message>${code}</Message></Error>`,status);
const digest=(body:Uint8Array)=>`"${createHash('md5').update(body).digest('hex')}"`;

// In-memory S3 protocol fixture: exercises the real SDK, signatures and multipart API.
export class MockR2 {
  objects=new Map<string,StoredObject>();
  multiparts=new Map<string,Multipart>();
  calls:{method:string;key:string}[]=[];
  failCreateForBucket: string | null = null;
  private sequence=0;

  fetch=async(input:RequestInfo|URL,init?:RequestInit):Promise<Response>=>{
    const request=input instanceof Request ? input : new Request(input,init);
    const url=new URL(request.url);
    if (!url.hostname.endsWith('.r2.cloudflarestorage.com')) throw new Error(`Unexpected network request: ${url.origin}`);
    const key=`${url.hostname}${decodeURIComponent(url.pathname)}`;
    const method=request.method;
    this.calls.push({method,key});
    const uploadId=url.searchParams.get('uploadId');
    if (method==='POST' && url.searchParams.has('uploads')) {
      if(this.failCreateForBucket && url.pathname.startsWith(`/${this.failCreateForBucket}/`)){this.failCreateForBucket=null;return error('AccessDenied',403);}
      const metadata:Record<string,string>={};
      request.headers.forEach((value,name)=>{if(name.startsWith('x-amz-meta-'))metadata[name.slice(11)]=value;});
      const id=`upload-${++this.sequence}`;
      this.multiparts.set(id,{key,metadata,type:request.headers.get('Content-Type') || 'application/octet-stream',parts:new Map()});
      return result(`<InitiateMultipartUploadResult><UploadId>${id}</UploadId></InitiateMultipartUploadResult>`);
    }
    if(method==='GET' && url.pathname==='/')return result('<ListAllMyBucketsResult><Buckets></Buckets></ListAllMyBucketsResult>');
    if(method==='GET' && url.searchParams.get('list-type')==='2'){
      const prefix=`${url.hostname}${decodeURIComponent(url.pathname).replace(/\/$/,'')}/`;
      const contents=[...this.objects].filter(([path])=>path.startsWith(prefix)).map(([path,object])=>`<Contents><Key>${xml(path.slice(prefix.length))}</Key><Size>${object.body.byteLength}</Size><ETag>${xml(object.etag)}</ETag><LastModified>${new Date(object.modified).toISOString()}</LastModified><StorageClass>STANDARD</StorageClass></Contents>`).join('');
      return result(`<ListBucketResult><IsTruncated>false</IsTruncated>${contents}</ListBucketResult>`);
    }
    if(method==='GET' && url.searchParams.has('uploads')){
      const prefix=`${url.hostname}${decodeURIComponent(url.pathname).replace(/\/$/,'')}/`;
      const uploads=[...this.multiparts].filter(([,upload])=>upload.key.startsWith(prefix)).map(([id,upload])=>`<Upload><Key>${xml(upload.key.slice(prefix.length))}</Key><UploadId>${id}</UploadId></Upload>`).join('');
      return result(`<ListMultipartUploadsResult><IsTruncated>false</IsTruncated>${uploads}</ListMultipartUploadsResult>`);
    }
    if (uploadId) {
      const multipart=this.multiparts.get(uploadId);
      if (!multipart || multipart.key!==key) return error('NoSuchUpload',404);
      if (method==='PUT') {
        const body=new Uint8Array(await request.arrayBuffer());const etag=digest(body);
        multipart.parts.set(Number(url.searchParams.get('partNumber')),{body,etag});
        return new Response(null,{headers:{ETag:etag}});
      }
      if (method==='GET') {
        const parts=[...multipart.parts].sort(([left],[right])=>left-right).map(([number,part])=>`<Part><PartNumber>${number}</PartNumber><Size>${part.body.byteLength}</Size><ETag>${xml(part.etag)}</ETag></Part>`).join('');
        return result(`<ListPartsResult><IsTruncated>false</IsTruncated>${parts}</ListPartsResult>`);
      }
      if (method==='POST') {
        const source=await request.text();
        const numbers=[...source.matchAll(/<PartNumber>(\d+)<\/PartNumber>/g)].map((match)=>Number(match[1]));
        if (!numbers.length || numbers.some((number)=>!multipart.parts.has(number))) return error('InvalidPart',400);
        const size=numbers.reduce((sum,number)=>sum+multipart.parts.get(number)!.body.byteLength,0);
        const body=new Uint8Array(size);let offset=0;
        for(const number of numbers){const part=multipart.parts.get(number)!;body.set(part.body,offset);offset+=part.body.byteLength;}
        const etag=`"${createHash('md5').update(body).digest('hex')}-${numbers.length}"`;
        this.objects.set(key,{body,etag,metadata:multipart.metadata,type:multipart.type,modified:Date.now()});
        this.multiparts.delete(uploadId);
        return result(`<CompleteMultipartUploadResult><ETag>${xml(etag)}</ETag></CompleteMultipartUploadResult>`);
      }
      if (method==='DELETE'){this.multiparts.delete(uploadId);return new Response(null,{status:204});}
    }
    if(method==='PUT'){
      if(request.headers.get('If-None-Match')==='*' && this.objects.has(key))return error('PreconditionFailed',412);
      const body=new Uint8Array(await request.arrayBuffer());const metadata:Record<string,string>={};
      request.headers.forEach((value,name)=>{if(name.startsWith('x-amz-meta-'))metadata[name.slice(11)]=value;});
      url.searchParams.forEach((value,name)=>{if(name.toLowerCase().startsWith('x-amz-meta-'))metadata[name.toLowerCase().slice(11)]=value;});
      const etag=digest(body);this.objects.set(key,{body,etag,metadata,type:request.headers.get('Content-Type') || 'application/octet-stream',modified:Date.now()});
      return new Response(null,{headers:{ETag:etag}});
    }
    const object=this.objects.get(key);
    if (method==='DELETE'){this.objects.delete(key);return new Response(null,{status:204});}
    if (!object) return method==='HEAD' ? new Response(null,{status:404}) : error('NoSuchKey',404);
    if (request.headers.has('If-Match') && request.headers.get('If-Match')!==object.etag) return error('PreconditionFailed',412);
    const headers=new Headers({'Content-Length':String(object.body.byteLength),ETag:object.etag,'Content-Type':object.type,'Last-Modified':new Date(object.modified).toUTCString()});
    for(const [name,value]of Object.entries(object.metadata))headers.set(`x-amz-meta-${name}`,value);
    if (method==='HEAD')return new Response(null,{headers});
    if (method==='GET'){
      const range=request.headers.get('Range');
      if(range){
        const match=/^bytes=(\d+)-(\d+)$/.exec(range);if(!match)return error('InvalidRange',416);
        const start=Number(match[1]);const end=Math.min(Number(match[2]),object.body.byteLength-1);
        if(start>end)return error('InvalidRange',416);
        const body=object.body.slice(start,end+1);headers.set('Content-Length',String(body.byteLength));headers.set('Content-Range',`bytes ${start}-${end}/${object.body.byteLength}`);
        return new Response(body,{status:206,headers});
      }
      return new Response(object.body,{headers});
    }
    throw new Error(`Unsupported S3 fixture operation: ${method} ${url}`);
  };
}
