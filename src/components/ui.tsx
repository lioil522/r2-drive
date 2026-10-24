import { useEffect, useRef, useState, type ButtonHTMLAttributes, type MouseEvent as ReactMouseEvent, type ReactNode } from 'react';
import { AlertCircle, Check, Cloud, Folder, LoaderCircle, MoreHorizontal, X, type LucideIcon } from 'lucide-react';
import { fileKind } from '../../shared/paths';
import { kinds } from './fileKinds';

export function Button({variant='secondary',busy=false,icon:Icon,children,className='',...props}:ButtonHTMLAttributes<HTMLButtonElement>&{variant?:'primary'|'secondary'|'ghost'|'danger';busy?:boolean;icon?:LucideIcon}) {
  return<button type="button" {...props} disabled={busy||props.disabled} className={`button button-${variant} ${className}`}>{busy?<LoaderCircle size={16} className="spin"/>:Icon?<Icon size={16}/>:null}{children}</button>;
}

export function IconButton({icon:Icon,label,busy=false,...props}:ButtonHTMLAttributes<HTMLButtonElement>&{icon:LucideIcon;label:string;busy?:boolean}) {
  return<button type="button" {...props} disabled={busy||props.disabled} aria-busy={busy||undefined} aria-label={label} title={label} className={`icon-button ${props.className||''}`}>{busy?<LoaderCircle size={17} className="spin"/>:<Icon size={17}/>}</button>;
}

export function Logo({small=false}:{small?:boolean}) {
  return<div className={`brand ${small?'brand-small':''}`}><span className="brand-symbol"><Cloud size={small?22:25} strokeWidth={2.3}/><span className="brand-spark"/></span>{!small&&<div><strong>R2<span>Drive</span></strong><small>MULTI-ACCOUNT CLOUD</small></div>}</div>;
}

export function PageHeader({eyebrow,title,description,actions}:{eyebrow?:string;title:string;description:string;actions?:ReactNode}) {
  return<div className="page-header"><div>{eyebrow&&<div className="eyebrow">{eyebrow}</div>}<h1>{title}</h1><p>{description}</p></div><div className="page-actions">{actions}</div></div>;
}

export function Card({children,className=''}:{children:ReactNode;className?:string}){return<section className={`card ${className}`}>{children}</section>;}

export function Empty({icon:Icon=Cloud,title,description,action}:{icon?:LucideIcon;title:string;description:string;action?:ReactNode}) {
  return<div className="empty-state"><div className="empty-art"><span/><span/><Icon size={37} strokeWidth={1.5}/></div><h3>{title}</h3><p>{description}</p>{action}</div>;
}

export function Loading(){return<div className="loading"><LoaderCircle size={22} className="spin"/><span>正在加载…</span></div>;}
export function ErrorBox({message,retry}:{message:string;retry?:()=>void}){return<div className="error-box"><AlertCircle size={18}/><span>{message}</span>{retry&&<button onClick={retry}>重试</button>}</div>;}
export function Notice({children,type='info'}:{children:ReactNode;type?:'info'|'warning'|'success'}){return<div className={`notice notice-${type}`}><AlertCircle size={17}/><div>{children}</div></div>;}

export function FileIcon({name,folder=false,large=false}:{name:string;folder?:boolean;large?:boolean}) {
  const kind=folder?'folder':fileKind(name);const Icon=folder?Folder:kinds[kind].icon;
  return<span className={`file-icon file-icon-${kind} ${large?'file-icon-large':''}`}><Icon size={large?30:21} strokeWidth={1.7}/></span>;
}

export function Badge({children,color='gray',dot=false}:{children:ReactNode;color?:string;dot?:boolean}){return<span className={`badge badge-${color}`}>{dot&&<i/>}{children}</span>;}
export function Progress({value,color='orange',className=''}:{value:number;color?:string;className?:string}){return<div className={`progress ${className}`}><div className={`progress-fill fill-${color}`} style={{width:`${Math.max(0,Math.min(100,value))}%`}}/></div>;}

export function Modal({title,subtitle,children,onClose,wide=false,footer}:{title:string;subtitle?:string;children:ReactNode;onClose:()=>void;wide?:boolean;footer?:ReactNode}) {
  const panel=useRef<HTMLDivElement>(null);
  const previous=useRef(document.activeElement instanceof HTMLElement?document.activeElement:null);
  const close=useRef(onClose);close.current=onClose;
  useEffect(()=>{
    const before=document.body.style.overflow;document.body.style.overflow='hidden';
    if(panel.current&&!panel.current.contains(document.activeElement)){
      const field=panel.current.querySelector<HTMLElement>('input:not([disabled]):not([hidden]):not([type="hidden"]),textarea:not([disabled]),select:not([disabled])');
      (field||panel.current).focus({preventScroll:true});
    }
    const handler=(event:KeyboardEvent)=>{
      if(event.key==='Escape')close.current();
      if(event.key==='Tab'){
        const focusable=panel.current?.querySelectorAll<HTMLElement>('button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),a[href]');
        if(!focusable?.length)return;
        const first=focusable[0];const last=focusable[focusable.length-1];
        if(event.shiftKey && (document.activeElement===first||document.activeElement===panel.current)){event.preventDefault();last.focus();}
        else if(!event.shiftKey && document.activeElement===last){event.preventDefault();first.focus();}
      }
    };
    window.addEventListener('keydown',handler);
    return()=>{document.body.style.overflow=before;window.removeEventListener('keydown',handler);if(previous.current?.isConnected)previous.current.focus({preventScroll:true});};
  },[]);
  return<div className="modal-overlay" onMouseDown={(event)=>{if(event.target===event.currentTarget)onClose();}}><div className={`modal ${wide?'modal-wide':''}`} role="dialog" aria-modal="true" aria-label={title} ref={panel} tabIndex={-1}><header><div><h2>{title}</h2>{subtitle&&<p>{subtitle}</p>}</div><IconButton icon={X} label="关闭" onClick={onClose}/></header><div className="modal-body">{children}</div>{footer&&<footer>{footer}</footer>}</div></div>;
}

export function Field({label,hint,children,optional=false}:{label:string;hint?:string;children:ReactNode;optional?:boolean}){return<label className="field"><span>{label}{optional&&<small>可选</small>}</span>{children}{hint&&<small>{hint}</small>}</label>;}

// 打开一个菜单时关闭其它已打开的菜单（每个菜单的点击都 stopPropagation，全局监听互不可见）。
const activeMenuCloser:{current:(()=>void)|null}={current:null};

export function Menu({items}:{items:{label:string;icon?:LucideIcon;action:()=>void;danger?:boolean;disabled?:boolean}[]}) {
  const [open,setOpen]=useState(false);const [pos,setPos]=useState({top:0,left:0,maxHeight:400,up:false});const root=useRef<HTMLDivElement>(null);
  useEffect(()=>{if(!open)return;const close=(event:MouseEvent)=>{if(!root.current?.contains(event.target as Node))setOpen(false);};window.addEventListener('click',close);return()=>window.removeEventListener('click',close);},[open]);
  const toggle=(event:ReactMouseEvent)=>{
    event.stopPropagation();
    if(open){setOpen(false);activeMenuCloser.current=null;return;}
    activeMenuCloser.current?.();
    activeMenuCloser.current=()=>setOpen(false);
    const rect=(event.currentTarget as HTMLElement).getBoundingClientRect();const height=items.length*34+10;const up=rect.bottom+height+16>innerHeight&&rect.top>height+16;setPos({top:up?rect.top-6:rect.bottom+6,left:rect.right,maxHeight:up?rect.top-16:innerHeight-rect.bottom-16,up});setOpen(true);
  };
  return<div className="menu" ref={root}><IconButton icon={MoreHorizontal} label="更多操作" aria-expanded={open} onClick={toggle}/>{open&&<div className="menu-popover" style={{top:pos.top,left:pos.left,maxHeight:pos.maxHeight,transform:pos.up?'translate(-100%,-100%)':'translateX(-100%)'}}>{items.map(({icon:Icon,...item})=><button type="button" key={item.label} disabled={item.disabled} className={item.danger?'danger-text':''} onClick={(event)=>{event.stopPropagation();setOpen(false);activeMenuCloser.current=null;item.action();}}>{Icon&&<Icon size={15}/>}<span>{item.label}</span></button>)}</div>}</div>;
}

export function CheckBox({checked,onChange,label}:{checked:boolean;onChange:()=>void;label:string}){return<button type="button" role="checkbox" aria-label={label} aria-checked={checked} className={`check-box ${checked?'checked':''}`} onClick={(event)=>{event.stopPropagation();onChange();}}>{checked&&<Check size={12} strokeWidth={3}/>}</button>;}

export function Tabs({tabs,value,onChange}:{tabs:{id:string;label:string;icon?:LucideIcon}[];value:string;onChange:(id:string)=>void}){return<div className="tabs" role="tablist">{tabs.map(({id,label,icon:Icon})=><button type="button" key={id} role="tab" aria-selected={value===id} className={id===value?'active':''} onClick={()=>onChange(id)}>{Icon&&<Icon size={15}/>}<span>{label}</span></button>)}</div>;}

export function ConfirmModal({title,description,confirm='确认',danger=false,onConfirm,onClose,busy=false}:{title:string;description:string;confirm?:string;danger?:boolean;onConfirm:()=>void;onClose:()=>void;busy?:boolean}){return<Modal title={title} onClose={onClose} footer={<><Button onClick={onClose}>取消</Button><Button variant={danger?'danger':'primary'} busy={busy} onClick={onConfirm}>{confirm}</Button></>}><p className="confirm-description">{description}</p></Modal>;}
