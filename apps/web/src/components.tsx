import { useEffect, useRef, useState, type ReactNode } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { X, ArrowRight, Check, Volume2, VolumeX } from 'lucide-react';
import { announce, useApp, safely } from './store';
import type { PetAppearance, PetKind } from '@nuanban/domain';
import { liliModel } from './three-d/builtin-models';
export function Pet({kind='cat',color='#D98347',action,className='',appearance}:{kind?:PetKind;color?:string;action?:string;className?:string;appearance?:PetAppearance}) {
  const preferences = useApp(state => state.snapshot?.preferences);
  if (kind === 'lili') return <img className={'pet pet-lili '+className} src={liliModel.posterUrl} width={1000} height={1250} alt="栗栗小鹿三维参考立绘，围着橙黄条纹围巾" draggable={false} style={{ objectFit: 'contain', animation: 'none' }} />;
  const tuning = appearance ?? (preferences?.pet === kind && preferences.petColor === color ? preferences.petAppearance : undefined);
  action = action ?? tuning?.action ?? 'idle';
  const eyes = tuning?.eyes ?? 'round';
  const mouth = tuning?.mouth ?? 'smile';
  return <svg className={'pet '+className+' action-'+action} viewBox="0 0 240 260" role="img" aria-label={kind==='cat'?'小橘猫暖暖':kind==='rabbit'?'小兔子暖暖':'小狗暖暖'}>
    <ellipse cx="122" cy="241" rx="68" ry="11" fill="#503A23" opacity=".08"/>
    <path d="M165 204c60 6 43-77 18-52" fill="none" stroke={color} strokeWidth="23" strokeLinecap="round"/>
    <path d="M75 146q-24 78 9 92h75q33-17 7-92" fill={color}/><ellipse cx="121" cy="195" rx="30" ry="36" fill="#FFE8C8"/>
    {kind==='rabbit'?<><ellipse cx="85" cy="52" rx="19" ry="48" fill={color} transform="rotate(-12 85 52)"/><ellipse cx="156" cy="52" rx="19" ry="48" fill={color} transform="rotate(12 156 52)"/><ellipse cx="85" cy="46" rx="8" ry="28" fill="#ECC0AC"/><ellipse cx="156" cy="46" rx="8" ry="28" fill="#ECC0AC"/></>:kind==='dog'?<><path d="M65 76Q23 40 34 118q13 27 37-7" fill="#A45B32"/><path d="M176 76q40-36 31 43-16 25-36-8" fill="#A45B32"/></>:<><path d="m61 88 5-64 44 38" fill={color}/><path d="m134 63 40-40 10 66" fill={color}/><path d="m73 63 3-20 18 17" fill="#EDB7A4"/><path d="m151 59 16-17 3 22" fill="#EDB7A4"/></>}
    <path d="M53 107c0-75 139-76 139 0 0 37-29 61-68 61-44 0-71-20-71-61" fill={color}/>
    <path d="m107 49 13 23 12-23" fill="#B55F36" opacity=".5"/>
    <g className="pet-eyes">{eyes==='happy'?<path d="M77 118q9-17 18 0m51 0q9-17 18 0" fill="none" stroke="#392A24" strokeWidth="5" strokeLinecap="round"/>:eyes==='sleepy'?<path d="M77 118h18m51 0h18" stroke="#392A24" strokeWidth="5" strokeLinecap="round"/>:<><ellipse cx="86" cy="116" rx="9" ry="11" fill="#392A24"/><ellipse cx="155" cy="116" rx="9" ry="11" fill="#392A24"/><circle cx="89" cy="112" r="3" fill="#FFF"/><circle cx="158" cy="112" r="3" fill="#FFF"/></>}</g>
    <ellipse cx="71" cy="132" rx="13" ry="7" fill="#ECAC86"/><ellipse cx="173" cy="132" rx="13" ry="7" fill="#ECAC86"/>
    <path d="m114 128 8 5 8-5" fill="#754330"/>{mouth==='open'?<ellipse cx="122" cy="143" rx="8" ry="7" fill="#754330"/>:mouth==='small'?<path d="M116 142h12" stroke="#754330" strokeWidth="3" strokeLinecap="round"/>:<path d="M122 135v6m0 0q-8 8-15 0m15 0q8 8 15 0" fill="none" stroke="#754330" strokeWidth="3" strokeLinecap="round"/>}
    <path d={action==='greeting'?'M79 172 57 153m106 18 15 27':action==='celebrating'?'M79 172 55 147m108 24 22-24':'M79 172 67 199m96-28 15 27'} stroke={color} strokeWidth="21" strokeLinecap="round"/><path d="M90 235h-9m69 0h11" stroke="#9A532F" strokeWidth="3" strokeLinecap="round"/>
    <path d="m83 159 36 13 40-13-9 18-31 1-32-1Z" fill="#6C8172"/><circle cx="120" cy="180" r="7" fill="#EAC966"/>
  </svg>;
}
export function Modal({open,onOpenChange,title,description,children}:{open:boolean;onOpenChange:(open:boolean)=>void;title:string;description?:string;children:ReactNode}) {
  const error=useApp(state=>state.error);
  const closeButton = useRef<HTMLButtonElement>(null);
  const returnFocus = useRef<HTMLElement | null>(null);
  useEffect(()=>{if(open)useApp.getState().clearError();},[open]);
  useEffect(() => {
    if (open) returnFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  }, [open]);
  return <Dialog.Root open={open} onOpenChange={onOpenChange}><Dialog.Portal><Dialog.Overlay className="modal-overlay"/><Dialog.Content className="modal" onOpenAutoFocus={event => { event.preventDefault(); closeButton.current?.focus(); }} onCloseAutoFocus={event => { event.preventDefault(); returnFocus.current?.focus(); }}><Dialog.Title>{title}</Dialog.Title><Dialog.Description>{description??'请确认后继续，随时可以取消。'}</Dialog.Description><Dialog.Close ref={closeButton} className="icon-button modal-close" aria-label="关闭窗口"><X size={22}/></Dialog.Close>{children}{error&&<p className="inline-error" role="alert">{error}</p>}</Dialog.Content></Dialog.Portal></Dialog.Root>;
}
export function PageTitle({eyebrow,title,subtitle,children}:{eyebrow:string;title:string;subtitle:string;children?:ReactNode}) { return <header className="page-title"><div><span className="eyebrow">{eyebrow}</span><h1>{title}</h1><p>{subtitle}</p></div>{children}</header>; }
export function Empty({title,description,children}:{title:string;description:string;children?:ReactNode}) {return <div className="empty"><span className="empty-flower" aria-hidden="true">✳</span><h2>{title}</h2><p>{description}</p>{children}</div>;}
export function Badge({children,tone='soft'}:{children:ReactNode;tone?:string}) {return <span className={'badge '+tone}>{children}</span>;}
export function ArrowLink(){return <ArrowRight size={21} aria-hidden="true"/>;}
export function Checkmark(){return <Check size={19} aria-hidden="true"/>;}
export function speechAvailable(target: Pick<Window, 'speechSynthesis'> | undefined = typeof window === 'undefined' ? undefined : window): boolean { return !!target?.speechSynthesis; }
export function useSpeech(){
  const preferences=useApp(state=>state.snapshot!.preferences);
  const [playing,setPlaying]=useState(false);
  const [status,setStatus]=useState<'ready'|'muted'|'unavailable'|'error'>('ready');
  const generation=useRef(0);
  useEffect(()=>()=>{generation.current++;window.speechSynthesis?.cancel();},[]);
  useEffect(()=>{if(preferences.muted){generation.current++;window.speechSynthesis?.cancel();setPlaying(false);setStatus('muted');}else if(status==='muted')setStatus('ready');},[preferences.muted]);
  const stop=()=>{generation.current++;window.speechSynthesis?.cancel();setPlaying(false);};
  const speak=(text:string)=>{stop();if(preferences.muted){setStatus('muted');return;}if(!speechAvailable()){setStatus('unavailable');announce('系统没有可用的语音播放，已保留大字字幕。');return;}const current=generation.current;const utterance=new SpeechSynthesisUtterance(text);utterance.lang='zh-CN';utterance.rate=preferences.speechRate;utterance.onend=()=>{if(generation.current===current)setPlaying(false);};utterance.onerror=()=>{if(generation.current===current){setPlaying(false);setStatus('error');announce('语音播放失败，已保留大字字幕，可以继续阅读。');}};setStatus('ready');setPlaying(true);window.speechSynthesis.speak(utterance);};
  return {speak,stop,playing,status};
}
export function MuteButton(){const preferences=useApp(state=>state.snapshot!.preferences);return <button className="icon-button" aria-label={preferences.muted?'打开讲解声音':'静音讲解'} aria-pressed={preferences.muted} onClick={()=>safely(useApp.getState().preferences({muted:!preferences.muted}))}>{preferences.muted?<VolumeX size={21}/>:<Volume2 size={21}/>}</button>;}
export function formatDate(value:string){return new Intl.DateTimeFormat('zh-CN',{month:'long',day:'numeric',hour:'2-digit',minute:'2-digit'}).format(new Date(value));}
