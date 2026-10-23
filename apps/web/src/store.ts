import { create } from 'zustand';
import type { LocalSnapshot, AppServices } from '@nuanban/application';
import type { Note, Todo, Preferences, Family } from '@nuanban/domain';
import { recurrenceNext, redactSecrets } from '@nuanban/domain';
import { createLocalId, markReviewed as reviewNote, setMastery as changeMastery } from '@nuanban/application';
import { applyPet, undoPet } from '@nuanban/pet-engine';
import type { PetConfiguration } from '@nuanban/domain';
import type { ConflictChoice } from '@nuanban/domain';
import { LocalConflictFailure, ServiceFailure } from '@nuanban/application';
interface State { snapshot: LocalSnapshot | null; ready: boolean; error: string | null; toast: string | null; busy: boolean; initialize(services: AppServices, initial:()=>LocalSnapshot): Promise<void>; addNote(question:string,summary:string,source:Note['source']):Promise<void>; mastery(id:string,value:Note['mastery']):Promise<void>; review(id:string):Promise<void>; deleteNote(id:string):Promise<void>; saveTodo(todo:Todo):Promise<void>; completeTodo(id:string):Promise<void>; deleteTodo(id:string):Promise<void>; preferences(patch:Partial<Preferences>):Promise<void>; applyPet(candidate:PetConfiguration, revision:number):Promise<void>; undoPet(revision:number):Promise<void>; resolveConflict(id:string,choice:ConflictChoice):Promise<void>; family(items:Family[]):Promise<void>; reset():Promise<void>; erase():Promise<void>; clearError():void; }
let services: AppServices;
let factory:()=>LocalSnapshot;
let queue = Promise.resolve();
function mutate(change:(snapshot:LocalSnapshot)=>LocalSnapshot, message:string):Promise<void> {
  const operation = queue.then(async()=> {
    const previous = useApp.getState().snapshot;
    if (!previous) return;
    useApp.setState({busy:true,error:null});
    try { const snapshot=change(structuredClone(previous)); if(services.repository.commitIfUnchanged)await services.repository.commitIfUnchanged(services.ownerId,previous,snapshot);else await services.repository.commit(services.ownerId,snapshot); useApp.setState({snapshot,toast:message}); }
    catch(error) {
      let preserved = error instanceof LocalConflictFailure ? error.preserved : null;
      if (!preserved && services.repository.commitIfUnchanged && error instanceof ServiceFailure && error.code === 'VERSION_CONFLICT') {
        try { preserved = await services.repository.load(services.ownerId); } catch {}
      }
      useApp.setState({error:error instanceof Error ? error.message:'保存失败', ...(preserved ? { snapshot: preserved } : {})}); throw error;
    }
    finally { useApp.setState({busy:false}); }
  });
  queue=operation.catch(()=>undefined);
  return operation;
}
function track(snapshot:LocalSnapshot, entity:Note|Todo, kind:'note'|'todo'):void { snapshot.outbox.push({id:createLocalId(),ownerId:entity.ownerId,entityId:entity.id,entityType:kind,version:entity.version,status:'pending',createdAt:new Date().toISOString()}); }
export const useApp = create<State>((set)=>({
  snapshot:null,ready:false,error:null,toast:null,busy:false,
  async initialize(injected,initial) { services=injected;factory=initial; try {
    const loaded=await services.repository.load(services.ownerId); let snapshot=loaded??initial();
    if (!loaded) {
      if (services.repository.commitIfUnchanged) {
        try { await services.repository.commitIfUnchanged(services.ownerId,null,snapshot); }
        catch(error) { if (!(error instanceof ServiceFailure) || error.code !== 'VERSION_CONFLICT') throw error; const latest=await services.repository.load(services.ownerId); if(!latest)throw error; snapshot=latest; }
      } else await services.repository.commit(services.ownerId,snapshot);
    }
    set({snapshot,ready:true});
  } catch(error) { set({ready:true,error:error instanceof Error?error.message:'本地数据初始化失败'}); } },
  addNote(question,summary,source) { return mutate(snapshot=> { const sanitized=redactSecrets(question); if(snapshot.notes.some(note=>note.question===sanitized&&!note.deletedAt)) return snapshot; const now=new Date().toISOString(); const note:Note={id:createLocalId(),ownerId:services.ownerId,question:sanitized,topic:sanitized.length>20?sanitized.slice(0,20)+'…':sanitized,summary:redactSecrets(summary),mastery:'unmastered',masterySource:null,reviewedAt:null,source,createdAt:now,updatedAt:now,version:1,deletedAt:null};snapshot.notes.unshift(note);track(snapshot,note,'note'); return snapshot; },'已记下学习要点，仅保存在本机。'); },
  mastery(id,value) { return mutate(snapshot=> { snapshot.notes=snapshot.notes.map(note=>note.id===id?changeMastery(note,value):note); const note=snapshot.notes.find(item=>item.id===id);if(note)track(snapshot,note,'note');return snapshot; },value==='mastered'?'已记录：你确认掌握了。':'已调整为待练习。'); },
  review(id) { return mutate(snapshot=>{snapshot.notes=snapshot.notes.map(note=>note.id===id?reviewNote(note):note);const note=snapshot.notes.find(item=>item.id===id);if(note)track(snapshot,note,'note');return snapshot;},'已记录本次复习，掌握状态保持不变。'); },
  deleteNote(id) { return mutate(snapshot=>{const note=snapshot.notes.find(item=>item.id===id);if(note){note.deletedAt=new Date().toISOString();note.updatedAt=note.deletedAt;note.version++;track(snapshot,note,'note');}return snapshot;},'笔记已删除，关联提醒会显示内容已移除。'); },
  saveTodo(todo) { return mutate(snapshot=>{const index=snapshot.todos.findIndex(item=>item.id===todo.id);if(index>=0)snapshot.todos[index]=todo;else snapshot.todos.unshift(todo);track(snapshot,todo,'todo');return snapshot;},'提醒已保存在本机。需要保持页面打开才可触达。'); },
  completeTodo(id) { return mutate(snapshot=>{const todo=snapshot.todos.find(item=>item.id===id);if(todo&&!todo.completedAt){todo.completedAt=new Date().toISOString();todo.updatedAt=todo.completedAt;todo.version++;track(snapshot,todo,'todo');const next=recurrenceNext(todo);if(next){const following={...todo,id:createLocalId(),dueAt:next,completedAt:null,createdAt:new Date().toISOString(),updatedAt:new Date().toISOString(),version:1};snapshot.todos.push(following);track(snapshot,following,'todo');}}return snapshot;},'待办已完成，笔记掌握状态不会自动改变。'); },
  deleteTodo(id) { return mutate(snapshot=>{const todo=snapshot.todos.find(item=>item.id===id);if(todo){todo.deletedAt=new Date().toISOString();todo.version++;track(snapshot,todo,'todo');}return snapshot;},'提醒已取消。'); },
  preferences(patch) { return mutate(snapshot=>({...snapshot,preferences:{...snapshot.preferences,...patch}}),'偏好已保存在本机。'); },
  applyPet(candidate, revision) { return mutate(snapshot => ({ ...snapshot, preferences: applyPet(snapshot.preferences, candidate, revision) }), '内置桌宠微调已确认并保存在本机。'); },
  undoPet(revision) { return mutate(snapshot => ({ ...snapshot, preferences: undoPet(snapshot.preferences, revision) }), '已撤回到上一套内置桌宠设置。'); },
  resolveConflict(id, choice) {
    const operation = queue.then(async () => {
      if (!services.repository.resolveConflict) throw new Error('当前服务未提供冲突选择，草稿保留，不会自动覆盖。');
      useApp.setState({ busy: true, error: null });
      try { const snapshot = await services.repository.resolveConflict(services.ownerId, id, choice); useApp.setState({ snapshot, toast: '冲突选择已保存在本机，没有进行云同步。' }); }
      catch (error) { useApp.setState({ error: error instanceof Error ? error.message : '冲突选择未保存' }); throw error; }
      finally { useApp.setState({ busy: false }); }
    });
    queue = operation.catch(() => undefined);
    return operation;
  },
  family(items) { return mutate(snapshot=>({...snapshot,family:items}),'本机关系记录已更新，不产生远程授权。'); },
  reset() { return mutate(()=>factory(),'已恢复空白本机资料。'); },
  erase() { return mutate(snapshot=>({...snapshot,notes:[],todos:[],family:[],outbox:[],conflicts:[] }),'本机学习资料与冲突草稿已清空。'); },
  clearError() { set({error:null}); }
}));
export function safely(promise:Promise<unknown>):void { void promise.catch(()=>undefined); }
export function announce(message:string):void { useApp.setState({toast:message}); }
