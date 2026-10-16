import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync,rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildApp } from "../server/app.ts";
import type Database from "better-sqlite3";
import type { StateResponse } from "../server/contracts.ts";
import type { PlanCoverageResponse, PlanCoverageDetailsResponse } from "../shared/planCoverage.ts";
import { countPlanLessons } from "../src/catalogAdapter.ts";

async function fixture() {
  const root=mkdtempSync(join(tmpdir(),"smena-scoped-admin-"));
  const app=await buildApp({dbPath:join(root,"qa.sqlite")});
  const origin="http://127.0.0.1";
  const response=await app.inject({method:"POST",url:"/api/auth/setup",headers:{origin,host:"127.0.0.1"},payload:{username:"admin",password:"scoped admin test password"}});
  assert.equal(response.statusCode,200,response.body);
  const headers={cookie:String(response.headers["set-cookie"]).split(";")[0]!,origin,host:"127.0.0.1","x-csrf-token":response.json().csrfToken as string};
  const db=(app as unknown as {smenaDb:Database.Database}).smenaDb;
  const close=async()=>{await app.close();rmSync(root,{recursive:true,force:true});};
  return {app,headers,db,close};
}

test("plan coverage matches editor hours and leaves schedule and revision unchanged",async()=>{
  const {app,headers,db,close}=await fixture();
  try {
    const state=(await app.inject({url:"/api/state",headers})).json() as StateResponse;
    const quarter=state.quarters[0]!;
    const before=db.prepare("SELECT revision,updated_at FROM draft_metadata WHERE id=1").get();
    const lessonIds=db.prepare("SELECT id FROM lessons ORDER BY id").all();
    assert.equal((await app.inject(`/api/plan-coverage?quarterId=${quarter.id}`)).statusCode,401);
    const response=await app.inject({url:`/api/plan-coverage?quarterId=${encodeURIComponent(quarter.id)}`,headers});
    assert.equal(response.statusCode,200,response.body);
    assert.equal(response.headers["cache-control"],"no-store");
    const report=response.json() as PlanCoverageResponse;
    for (const group of report.groups) {
      const assignments=state.studyPlans.filter(plan=>plan.groupId===group.id && plan.quarterId===quarter.id)
        .flatMap(plan=>plan.assignments.map(assignment=>({
          target:assignment.target,
          scheduled:countPlanLessons(state.schedule,group.id,quarter,plan.subjectId,assignment.subgroupId ?? undefined,plan.lessonKind),
        })));
      assert.equal(group.target,assignments.reduce((sum,item)=>sum+item.target,0));
      assert.equal(group.scheduled,assignments.reduce((sum,item)=>sum+item.scheduled,0),group.name);
      assert.equal(group.missing,assignments.reduce((sum,item)=>sum+Math.max(0,item.target-item.scheduled),0),group.name);
      assert.equal(group.covered+group.missing,group.target);
      assert.equal("assignments" in group,false);
      const detailsResponse=await app.inject({url:`/api/plan-coverage/details?${new URLSearchParams({quarterId:quarter.id,groupId:group.id})}`,headers});
      assert.equal(detailsResponse.statusCode,200,detailsResponse.body);
      const details=detailsResponse.json() as PlanCoverageDetailsResponse;
      assert.equal(details.group.id,group.id);
      assert.equal(details.quarter.id,quarter.id);
      assert.equal(details.rows.reduce((sum,row)=>sum+row.scheduled,0),group.scheduled);
      for (const row of details.rows) {
        assert.equal(row.scheduled,countPlanLessons(state.schedule,group.id,quarter,row.subjectId,row.subgroupId ?? undefined,row.lessonKind));
      }
    }
    assert.equal("schedule" in report,false);
    assert.deepEqual(db.prepare("SELECT revision,updated_at FROM draft_metadata WHERE id=1").get(),before);
    assert.deepEqual(db.prepare("SELECT id FROM lessons ORDER BY id").all(),lessonIds);
  } finally {await close();}
});

test("admin domains omit all lesson history and compact catalog updates preserve schedule rows",async()=>{
  const {app,headers,db,close}=await fixture();
  try {
    assert.equal((await app.inject("/api/admin/state?view=catalog")).statusCode,401);
    for (const view of ["catalog","plans","calendar","bells","print","bootstrap"]) {
      const response=await app.inject({url:`/api/admin/state?view=${view}`,headers});
      assert.equal(response.statusCode,200,response.body);
      const state=response.json() as StateResponse;
      assert.deepEqual(state.schedule,{});
      assert.equal(state.catalogDeletionBlockers,undefined);
      assert.equal(state.teacherLessonOrigins,undefined);
      if (view !== "plans") assert.deepEqual(state.studyPlans,[]);
    }
    const state=(await app.inject({url:"/api/admin/state?view=catalog",headers})).json() as StateResponse;
    const original=db.prepare("SELECT d.id dayId,s.id slotId,l.id lessonId FROM schedule_days d LEFT JOIN schedule_slots s ON s.day_id=d.id LEFT JOIN lessons l ON l.slot_id=s.id ORDER BY d.id,s.id,l.id").all();
    const catalog=structuredClone(state.catalog);
    catalog.teachers[0]!.preferredShift=catalog.teachers[0]!.preferredShift === "morning" ? "afternoon" : "morning";
    const saved=await app.inject({method:"PUT",url:"/api/catalog?response=compact",headers,payload:{catalog,revision:state.revision,requestId:crypto.randomUUID()}});
    assert.equal(saved.statusCode,200,saved.body);
    assert.deepEqual(saved.json().schedule,{});
    assert.equal(saved.json().revision,state.revision+1);
    assert.deepEqual(db.prepare("SELECT d.id dayId,s.id slotId,l.id lessonId FROM schedule_days d LEFT JOIN schedule_slots s ON s.day_id=d.id LEFT JOIN lessons l ON l.slot_id=s.id ORDER BY d.id,s.id,l.id").all(),original);
  } finally {await close();}
});

test("calendar and bell previews are bounded and require current revision and CSRF",async()=>{
  const {app,headers,db,close}=await fixture();
  try {
    const state=(await app.inject({url:"/api/admin/state?view=bells",headers})).json() as StateResponse;
    const apply={groupIds:[state.catalog.groups[0]!.id],startDate:"2026-10-11",endDate:"2026-10-11",replaceStart:false,resetBreaks:false};
    const bell=await app.inject({method:"POST",url:"/api/bell-settings/preview",headers,payload:{settings:state.bellSettings,apply,revision:state.revision}});
    assert.equal(bell.statusCode,200,bell.body);
    assert.equal("schedule" in bell.json(),false);
    assert.equal((await app.inject({method:"POST",url:"/api/bell-settings/preview",headers,payload:{settings:state.bellSettings,apply,revision:state.revision+1}})).statusCode,409);
    const calendar=await app.inject({method:"POST",url:"/api/calendar/preview",headers,payload:{calendar:state.calendar,revision:state.revision}});
    assert.equal(calendar.statusCode,200,calendar.body);
    assert.equal("schedule" in calendar.json(),false);
    assert.equal((await app.inject({method:"POST",url:"/api/calendar/preview",headers:{cookie:headers.cookie},payload:{calendar:state.calendar,revision:state.revision}})).statusCode,403);
    assert.equal((db.prepare("SELECT revision FROM draft_metadata WHERE id=1").get() as {revision:number}).revision,state.revision);
  } finally {await close();}
});

test("availability previews return only the selected resource and guard stale drafts",async()=>{
  const {app,headers,close}=await fixture();
  try {
    const state=(await app.inject({url:"/api/admin/state?view=catalog",headers})).json() as StateResponse;
    const resourceId=state.catalog.teachers[0]!.id;
    const rules=[{id:"absence-preview",startDate:"2026-10-05",endDate:"2026-10-30",start:0,end:1440}];
    const payload={kind:"teacher",resourceId,rules,revision:state.revision};
    const response=await app.inject({method:"POST",url:"/api/catalog/availability-preview",headers,payload});
    assert.equal(response.statusCode,200,response.body);
    assert.ok(Array.isArray(response.json().violations));
    assert.ok(response.json().violations.every((row:{resourceId:string;kind:string;groupName:string;subjectName:string})=>row.resourceId === resourceId && row.kind === "teacher" && row.groupName && row.subjectName));
    assert.equal("schedule" in response.json(),false);
    assert.equal((await app.inject({method:"POST",url:"/api/catalog/availability-preview",headers,payload:{...payload,revision:state.revision+1}})).statusCode,409);
  } finally {await close();}
});

test("quarter-scoped curricula saves and metadata-only quarter edits preserve other quarters",async()=>{
  const {app,headers,db,close}=await fixture();
  try {
    let full=(await app.inject({url:"/api/state",headers})).json() as StateResponse;
    const extraQuarter={id:crypto.randomUUID(),name:"Следующая тестовая четверть",startDate:"2027-01-11",endDate:"2027-03-19"};
    const regular=full.studyPlans.find((plan)=>plan.mode === "whole")!;
    const extraPlan={...regular,id:crypto.randomUUID(),quarterId:extraQuarter.id,assignments:[{id:crypto.randomUUID(),subgroupId:null,target:12}]};
    const prepared=await app.inject({method:"PUT",url:"/api/plans",headers,payload:{quarters:[...full.quarters,extraQuarter],studyPlans:[...full.studyPlans,extraPlan],revision:full.revision,requestId:crypto.randomUUID()}});
    assert.equal(prepared.statusCode,200,prepared.body);
    full=prepared.json() as StateResponse;
    const quarterId=regular.quarterId;
    const scoped=(await app.inject({url:`/api/admin/state?view=plans&quarterId=${quarterId}`,headers})).json() as StateResponse;
    assert.equal(scoped.plansScope?.quarterId,quarterId);
    assert.ok(scoped.studyPlans.every((plan)=>plan.quarterId === quarterId));
    assert.ok(scoped.curricula!.every((plan)=>plan.quarterId === quarterId));
    const untouchedPlans=full.studyPlans.filter((plan)=>plan.quarterId !== quarterId);
    const untouchedCurricula=full.curricula!.filter((plan)=>plan.quarterId !== quarterId);
    const curricula=structuredClone(scoped.curricula!);
    curricula[0]!.name+=" · проверка";
    const saved=await app.inject({method:"PUT",url:"/api/curricula?response=compact",headers,payload:{curricula,scopeQuarterId:quarterId,revision:scoped.revision,requestId:crypto.randomUUID()}});
    assert.equal(saved.statusCode,200,saved.body);
    assert.equal(saved.json().plansScope.quarterId,quarterId);
    const after=(await app.inject({url:"/api/state",headers})).json() as StateResponse;
    assert.deepEqual(after.studyPlans.filter((plan)=>plan.quarterId !== quarterId),untouchedPlans);
    assert.deepEqual(after.curricula!.filter((plan)=>plan.quarterId !== quarterId),untouchedCurricula);
    const beforeIds=db.prepare("SELECT id FROM lessons ORDER BY id").all();
    const editedQuarters=after.quarters.map((quarter)=>quarter.id === quarterId ? {...quarter,name:quarter.name+" · новое название"} : quarter);
    const edited=await app.inject({method:"PUT",url:"/api/plans?response=compact",headers,payload:{quarters:editedQuarters,metadataOnly:true,responseQuarterId:quarterId,revision:after.revision,requestId:crypto.randomUUID()}});
    assert.equal(edited.statusCode,200,edited.body);
    const final=(await app.inject({url:"/api/state",headers})).json() as StateResponse;
    assert.deepEqual(final.studyPlans,after.studyPlans);
    assert.deepEqual(final.curricula,after.curricula);
    assert.deepEqual(db.prepare("SELECT id FROM lessons ORDER BY id").all(),beforeIds);
  } finally {await close();}
});
