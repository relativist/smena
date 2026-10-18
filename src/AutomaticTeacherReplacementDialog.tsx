import { createId } from "../shared/createId.ts";
import { useEffect, useMemo, useRef, useState } from "react";
import ActionLabel from "./ActionLabel";
import InfoTooltip from "./InfoTooltip";
import { ApiError, api, type AuthSession } from "./api.ts";
import type { StateResponse, TeacherReplacementApplyReceipt, TeacherReplacementUndoReceipt } from "../server/contracts.ts";
import type { ReplacementRequest } from "../shared/automaticTeacherReplacement.ts";
import type { AutomaticTeacherReplacementPreview } from "../shared/automaticTeacherReplacement.ts";
import RussianDateInput from "./RussianDateInput.tsx";
import "./automatic-teacher-replacement.css";

type CompactPreview = Omit<AutomaticTeacherReplacementPreview, "schedule">;
type TeacherAvailability = { availableGroupIds: string[]; availableSubjectIds: string[] };
type Props = { state: StateResponse; auth: AuthSession; initialRequest: ReplacementRequest; onStateChange: (state: StateResponse) => void; onRefresh: () => Promise<StateResponse>; onUnauthorized: () => void; onClose: () => void };
type PendingWrite = { kind: "apply" | "undo"; body: Record<string, unknown>; path: string };
const dateLabel = (value: string) => { const [y,m,d] = value.split("-"); return `${d}.${m}.${y}`; };
const clock = (minutes: number) => `${String(Math.floor(minutes/60)).padStart(2,"0")}:${String(minutes%60).padStart(2,"0")}`;
const newId = () => createId();

export default function AutomaticTeacherReplacementDialog({ state, auth, initialRequest, onStateChange, onRefresh, onUnauthorized, onClose }: Props) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const filtersRef = useRef<HTMLFormElement>(null);
  const [dateEditing, setDateEditing] = useState(false);
  const previewSeq = useRef(0);
  const previewAbort = useRef<AbortController | null>(null);
  const writeRef = useRef<PendingWrite | null>(null);
  const [startDate,setStartDate] = useState(initialRequest.startDate);
  const [endDate,setEndDate] = useState(initialRequest.endDate);
  const [groupId,setGroupId] = useState(initialRequest.groupId ?? "");
  const [subjectId,setSubjectId] = useState(initialRequest.subjectId ?? "");
  const [preview,setPreview] = useState<CompactPreview|null>(null);
  const [availability,setAvailability] = useState<TeacherAvailability>({ availableGroupIds: [], availableSubjectIds: [] });
  const [previewRevision,setPreviewRevision] = useState<number|null>(null);
  const [previewRequest,setPreviewRequest] = useState<ReplacementRequest|null>(null);
  const [loading,setLoading] = useState(false);
  const [busy,setBusy] = useState(false);
  const [error,setError] = useState("");
  const [stale,setStale] = useState(false);
  const [ack,setAck] = useState(false);
  const [writeError,setWriteError] = useState("");
  const [applied,setApplied] = useState(false);
  const [undoRequestId,setUndoRequestId] = useState("");
  const [operationId,setOperationId] = useState("");
  const [writeUncertain,setWriteUncertain] = useState(false);
  const [success,setSuccess] = useState("");
  const [confirmedRevision,setConfirmedRevision] = useState<number|null>(null);
  const [refreshError,setRefreshError] = useState("");
  const skipRevisionEffect = useRef<number|null>(null);

  useEffect(()=>{ const el=dialogRef.current; if(el&&!el.open) el.showModal(); return ()=>{previewAbort.current?.abort();}; },[]);
  const teacher=state.catalog.teachers.find(t=>t.id===initialRequest.teacherId);
  const sourceName=teacher?.name??initialRequest.teacherId;
  const groupNames=useMemo(()=>Object.fromEntries(state.catalog.groups.map(g=>[g.id,g.name])),[state.catalog.groups]);
  const subjects=useMemo(()=>state.catalog.subjects,[state.catalog.subjects]);
  useEffect(()=>{
    if (!/^\d{4}-\d{2}-\d{2}$/.test(startDate) || !/^\d{4}-\d{2}-\d{2}$/.test(endDate)) return;
    const controller=new AbortController();
    const params=new URLSearchParams({availability:"1",teacherId:initialRequest.teacherId,startDate,endDate});
    if(groupId)params.set("groupIds",groupId);
    void api<TeacherAvailability>(`/api/admin/reassignments?${params}`,{signal:controller.signal}).then(setAvailability).catch(reason=>{
      if(controller.signal.aborted)return;
      if(reason instanceof ApiError&&(reason.status===401||reason.status===403))onUnauthorized();
      else setAvailability({availableGroupIds:[],availableSubjectIds:[]});
    });
    return ()=>controller.abort();
  },[initialRequest.teacherId,startDate,endDate,groupId,onUnauthorized]);
  const availableGroupIds=useMemo(()=>new Set(availability.availableGroupIds),[availability.availableGroupIds]);
  const availableSubjectIds=useMemo(()=>new Set(availability.availableSubjectIds),[availability.availableSubjectIds]);
  const groups=useMemo(()=>state.catalog.groups.filter(g=>availableGroupIds.has(g.id)),[state.catalog.groups,availableGroupIds]);
  const availableSubjects=useMemo(()=>state.catalog.subjects.filter(s=>availableSubjectIds.has(s.id)),[state.catalog.subjects,availableSubjectIds]);
  const request=useMemo<ReplacementRequest>(()=>({teacherId:initialRequest.teacherId,startDate,endDate,...(groupId?{groupId}:{}),...(subjectId?{subjectId}:{}),...(initialRequest.ruleId?{ruleId:initialRequest.ruleId}:{})}),[initialRequest,startDate,endDate,groupId,subjectId]);
  const requestKey=JSON.stringify(request);
  const canClose=!busy&&!writeUncertain;

  async function loadPreview(nextRequest=request, revision=state.revision) {
    if (writeRef.current || dateEditing || !filtersRef.current?.reportValidity()) return;
    const seq=++previewSeq.current; previewAbort.current?.abort(); const controller=new AbortController(); previewAbort.current=controller;
    setLoading(true); setError(""); setPreview(null); setPreviewRequest(null); setPreviewRevision(null); setAck(false); setStale(false);
    try {
      const result=await api<{ revision: number; preview: CompactPreview }>("/api/teacher-replacements/preview?response=compact",{method:"POST",headers:{"x-csrf-token":auth.csrfToken},body:JSON.stringify({revision,request:nextRequest}),signal:controller.signal});
      if(seq!==previewSeq.current)return;
      setPreview(result.preview); setPreviewRevision(result.revision); setPreviewRequest(nextRequest);
    } catch(reason) {
      if(seq!==previewSeq.current || (reason instanceof ApiError && reason.status===0 && controller.signal.aborted))return;
      if(reason instanceof ApiError && (reason.status===401||reason.status===403)){onUnauthorized();return;}
      if(reason instanceof ApiError && reason.status===409){setStale(true);setError("Данные изменились. Обновите их перед подбором.");}
      else setError(reason instanceof Error?reason.message:"Не удалось подобрать замены.");
    } finally { if(seq===previewSeq.current)setLoading(false); }
  }
  useEffect(()=>{ if(skipRevisionEffect.current===state.revision){skipRevisionEffect.current=null;return;} if(!applied && !refreshError && (confirmedRevision===null || state.revision>=confirmedRevision)) void loadPreview(request); return ()=>previewAbort.current?.abort(); // first preview and date/filter changes
  },[requestKey,state.revision,applied,dateEditing,confirmedRevision,refreshError]);

  async function refreshState() {
    setBusy(true); setError(""); setRefreshError("");
    try { const next=await onRefresh(); onStateChange(next); setStale(false); setPreview(null); setPreviewRequest(null); setPreviewRevision(null); if(!applied){skipRevisionEffect.current=next.revision; void loadPreview(request,next.revision);} }
    catch(reason){ if(reason instanceof ApiError&&(reason.status===401||reason.status===403))onUnauthorized(); setRefreshError(reason instanceof Error?reason.message:"Не удалось обновить данные."); }
    finally{setBusy(false);}
  }
  async function apply() {
    if(dateEditing||!filtersRef.current?.reportValidity()||!preview||previewRevision===null||previewRevision!==state.revision||JSON.stringify(previewRequest)!==requestKey||stale||loading||busy||applied)return;
    const expectedAssignments=preview.units.filter(u=>u.teacherId).map(u=>({unitId:u.id,teacherId:u.teacherId!}));
    if(!expectedAssignments.length)return;
    if(preview.skipped.length&&!ack)return;
    const body={revision:previewRevision,requestId:newId(),request:previewRequest,expectedAssignments};
    writeRef.current={kind:"apply",path:"/api/teacher-replacements/apply",body};
    await sendWrite();
  }
  async function undo() {
    if(!operationId||busy||writeRef.current?.kind==="apply")return;
    if(!writeRef.current) writeRef.current={kind:"undo",path:`/api/teacher-replacements/${encodeURIComponent(operationId)}/undo`,body:{revision:Math.max(state.revision,confirmedRevision??state.revision),requestId:undoRequestId||newId()}};
    if(!undoRequestId){const current=writeRef.current.body.requestId as string;setUndoRequestId(current);}
    await sendWrite();
  }
  async function sendWrite() {
    const pending=writeRef.current; if(!pending)return;
    setBusy(true);setWriteError("");setRefreshError("");
    try {
      if(pending.kind==="apply"){
        const result=await api<TeacherReplacementApplyReceipt>(`${pending.path}?response=receipt`,{method:"POST",headers:{"x-csrf-token":auth.csrfToken},body:JSON.stringify(pending.body)});
        writeRef.current=null;setWriteUncertain(false);setApplied(true);setOperationId(result.operationId);setConfirmedRevision(result.revision);setSuccess("Замены сохранены в черновике.");setPreview(null);setPreviewRequest(null);setPreviewRevision(null);
      }else{
        const result=await api<TeacherReplacementUndoReceipt>(`${pending.path}?response=receipt`,{method:"POST",headers:{"x-csrf-token":auth.csrfToken},body:JSON.stringify(pending.body)});
        writeRef.current=null;setWriteUncertain(false);setApplied(false);setOperationId("");setConfirmedRevision(result.revision);setSuccess("Замены отменены.");setUndoRequestId("");
      }
      // A receipt confirms the write. Refresh errors must never make it retryable.
      try { const next=await onRefresh(); onStateChange(next); setStale(false); }
      catch(reason) {
        if(reason instanceof ApiError&&(reason.status===401||reason.status===403))onUnauthorized();
        setRefreshError(`Изменения подтверждены сервером. Не удалось обновить экран: ${reason instanceof Error?reason.message:"ошибка загрузки"}`);
      }
    }catch(reason){
      if(reason instanceof ApiError&&(reason.status===401||reason.status===403)){writeRef.current=null;setWriteUncertain(false);setWriteError(reason.message);onUnauthorized();return;}
      if(reason instanceof ApiError&&reason.status===409){setStale(true);setWriteUncertain(false);writeRef.current=null;setWriteError("Черновик уже изменился. Обновите данные и проверьте замены заново.");}
      else if(reason instanceof ApiError&&reason.status>=400&&reason.status<500){setWriteUncertain(false);writeRef.current=null;setWriteError(reason.message);}
      else {setWriteUncertain(true);setWriteError(`${reason instanceof Error?reason.message:"Не удалось подтвердить результат"} Повторите тот же запрос кнопкой ниже.`);}
    }finally{setBusy(false);}
  }
  function changeFilter(fn:()=>void){ if(writeRef.current||busy)return;fn();setPreview(null);setPreviewRequest(null);setPreviewRevision(null);setSuccess("");setError("");setAck(false); }
  const sourceLessonUnits=preview?.units??[];
  const unitRows=sourceLessonUnits;
  const skippedUnits=unitRows.filter(u=>!u.teacherId).length;
  const proposedUnits=unitRows.length-skippedUnits;
  const subjectName=(id:string)=>subjects.find(s=>s.id===id)?.shortName||subjects.find(s=>s.id===id)?.name||id;
  const teacherName=(id?:string)=>id?state.catalog.teachers.find(t=>t.id===id)?.name??id:"—";

  return <dialog ref={dialogRef} className="auto-replacement-dialog" aria-labelledby="auto-replacement-title" onCancel={e=>{e.preventDefault();if(canClose)onClose();}}>
    <header className="atr-header"><div><h2 id="auto-replacement-title">Замены на время отсутствия · {sourceName}</h2><p>{initialRequest.ruleId?"Период отсутствия":"Временная замена занятий"}</p></div><button type="button" aria-label="Закрыть" disabled={!canClose} onClick={onClose}>×</button></header>
    <div className="atr-content" aria-live="polite">
      <div className="atr-note tr-inline-help"><span>Предложение замен</span><InfoTooltip label="Предложение замен">На выбранные даты предлагаются доступные преподаватели. При повторном автосоставлении учитываются принятые замены. Время и кабинет уроков сохраняются; изменения сохранятся после нажатия «Применить замены».</InfoTooltip></div>
      <form ref={filtersRef} onSubmit={event => event.preventDefault()} onInput={event => {
        if (!(event.target instanceof HTMLInputElement) || event.target.type !== "text") return;
        setDateEditing(true);
        setPreview(null);
        setPreviewRequest(null);
        setPreviewRevision(null);
        previewSeq.current += 1;
        previewAbort.current?.abort();
        setLoading(false);
      }}>
      <fieldset className="atr-filters" disabled={busy||Boolean(writeRef.current)||applied}><legend className="atr-visually-hidden">Фильтры подбора замен</legend>
        <label><span>С даты</span><RussianDateInput label="С даты" value={startDate} onChange={v=>changeFilter(()=>{setStartDate(v);setDateEditing(false);})}/></label>
        <label><span>По дату</span><RussianDateInput label="По дату" value={endDate} onChange={v=>changeFilter(()=>{setEndDate(v);setDateEditing(false);})}/></label>
        <label><span>Группа</span><select className="school-code" value={groupId} onChange={e=>changeFilter(()=>setGroupId(e.target.value))}><option value="">Все группы</option>{groups.map(g=><option key={g.id} value={g.id}>{g.name}</option>)}</select></label>
        <label><span>Предмет</span><select value={subjectId} onChange={e=>changeFilter(()=>setSubjectId(e.target.value))}><option value="">Все предметы</option>{availableSubjects.map(s=><option key={s.id} value={s.id}>{s.name}</option>)}</select></label>
      </fieldset>
      </form>
      {loading&&<p className="atr-status">Подбираем преподавателей и проверяем совпадения расписаний…</p>}
      {error&&<p className="atr-error" role="alert">{error}</p>}
      {(stale||refreshError)&&<button type="button" className="atr-secondary" disabled={busy} onClick={()=>void refreshState()}>Обновить данные</button>}
      {preview&&previewRequest&&previewRevision===state.revision&&JSON.stringify(previewRequest)===requestKey&&<>
        <div className="atr-counts" role="status"><span>Занятий к замене: <b>{unitRows.length}</b></span><span>Подобрано: <b>{proposedUnits}</b></span><span>Без замены: <b>{skippedUnits}</b></span></div>
        {skippedUnits>0&&<label className="atr-ack"><input type="checkbox" checked={ack} disabled={busy} onChange={e=>setAck(e.target.checked)}/>Применить найденные замены, оставив уроки без замены без изменений</label>}
        {unitRows.length===0?<p className="atr-empty">На выбранный период уроков этого преподавателя не найдено.</p>:<div className="atr-table-scroll" role="region" aria-label="Предложения по заменам" tabIndex={0}><table className="atr-table"><thead><tr><th>Дата и время</th><th>Предмет</th><th>Группа</th><th>Преподаватель</th><th>Результат</th></tr></thead><tbody>{unitRows.map(u=><tr key={u.id} className={u.teacherId?"":"is-skipped"}><td>{dateLabel(u.date)}<small>{clock(u.start)}–{clock(u.end)}</small></td><td>{subjectName(u.subjectId)}</td><td className="school-code">{u.groupIds.map(id=>groupNames[id]??id).join(" / ")}</td><td>{sourceName}<span className="atr-arrow" aria-hidden="true"> → </span>{teacherName(u.teacherId)}</td><td>{u.teacherId?<span className="atr-ready">Подобрана</span>:<span className="atr-reason">{u.reason??"Не найден кандидат"}</span>}</td></tr>)}</tbody></table></div>}
      </>}
      {success&&<p className="atr-success" role="status">{success}</p>}
      {writeError&&<p className="atr-error" role="alert">{writeError}</p>}
      {refreshError&&<p className="atr-error" role="alert">{refreshError}</p>}
      {writeUncertain&&<p className="atr-status">Результат запроса пока неизвестен. Повтор будет отправлен с тем же идентификатором.</p>}
    </div>
    <footer className="atr-footer"><span>{applied?"Замены можно отменить, пока черновик не менялся":"Проверьте предложения перед применением"}</span><div>{writeUncertain&&<button type="button" className="atr-secondary" disabled={busy} onClick={()=>void sendWrite()}>Повторить запрос</button>}{!applied&&!writeUncertain&&<button type="button" className="atr-secondary" disabled={busy||loading||stale||Boolean(refreshError)} onClick={()=>void loadPreview(request)}><ActionLabel action="preview">Подобрать замены</ActionLabel></button>}{applied?<button type="button" className="atr-secondary" disabled={busy||writeUncertain} onClick={()=>void undo()}>Отменить замены</button>:<button type="button" disabled={busy||loading||stale||Boolean(refreshError)||!preview||previewRevision!==state.revision||JSON.stringify(previewRequest)!==requestKey||!preview.units.some(u=>u.teacherId)||(skippedUnits>0&&!ack)||Boolean(writeRef.current)} onClick={()=>void apply()}><ActionLabel action="apply">Применить замены</ActionLabel></button>}<button type="button" className="atr-secondary" disabled={!canClose} onClick={onClose}>Закрыть</button></div></footer>
  </dialog>;
}
