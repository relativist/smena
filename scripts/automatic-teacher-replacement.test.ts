import test from "node:test";
import assert from "node:assert/strict";
import type { Catalog } from "../shared/catalog.ts";
import { previewAutomaticTeacherReplacement } from "../shared/automaticTeacherReplacement.ts";
import type { EditorDay, EditorLesson, Schedule } from "../src/editor.ts";

const catalog: Catalog = {
  subjects: ["math", "english"].map(id=>({id,name:id,shortName:id,archived:false,color:"blue" as const,roomKind:null,labRoomKind:null})),
  teachers: [
    {id:"ill",name:"Больной",archived:false,subjectIds:["math","english"],defaultRoomId:null,unavailability:[{id:"sick",startDate:"2026-10-12",endDate:"2026-10-13",start:500,end:700,reason:"Больничный"}]},
    {id:"preferred",name:"Альфа",archived:false,subjectIds:["math"],defaultRoomId:null,preferredGroupIds:["g1"]},
    {id:"other",name:"Бета",archived:false,subjectIds:["math","english"],defaultRoomId:null},
    {id:"busy",name:"Гамма",archived:false,subjectIds:["math"],defaultRoomId:null},
  ],
  rooms:["r1","r2","r3","r4"].map(id=>({id,name:id,archived:false,kind:"general" as const,capacity:null})),
  groups:["g1","g2","g3"].map(id=>({id,name:id,archived:false,students:20,leaderId:null,roomId:null,autoRoomIds:[]})),
  subgroups:[],
};
function lesson(id:string,roomId:string,extra:Partial<EditorLesson>={}):EditorLesson{return{id,subjectId:"math",teacherId:"ill",teacher:"Больной",roomId,room:roomId,note:`note-${id}`,...extra};}
function day(date:string,items:EditorLesson[],start=540):EditorDay{return{date,start:"09:00",duration:45,breaks:[],slots:[items],times:[{start,duration:45}]};}
const sched=(o:Record<string,EditorDay[]>):Schedule=>o;
const req={teacherId:"ill",startDate:"2026-10-12",endDate:"2026-10-13"};

test("chooses a preferred qualified teacher, preserves lesson details and does not mutate input",()=>{
  const original=sched({"g1:0":[day("2026-10-12",[lesson("a","r1")])]}); const before=structuredClone(original);
  const result=previewAutomaticTeacherReplacement(original,catalog,req);
  assert.deepEqual(result.changedLessonIds,["a"]); assert.equal(result.schedule["g1:0"]![0]!.slots[0]![0]!.teacherId,"preferred");
  assert.equal(result.schedule["g1:0"]![0]!.slots[0]![0]!.roomId,"r1"); assert.equal(result.schedule["g1:0"]![0]!.slots[0]![0]!.note,"note-a");
  assert.deepEqual(original,before); assert.equal(result.allocations[0]?.teacherId,"preferred");
});

test("uses actual slot times, filters selected rule/date/group/subject, and skips events",()=>{
  const precise:EditorDay={date:"2026-10-12",start:"09:00",duration:45,breaks:[],slots:[[lesson("a","r1")],[lesson("outside","r2")]],times:[{start:650,duration:45},{start:710,duration:45}]};
  const original=sched({"g1:0":[precise,day("2026-10-13",[lesson("event","r4",{event:"Собрание",subjectId:"event"})])],"g2:0":[day("2026-10-12",[lesson("group","r3")])]});
  const result=previewAutomaticTeacherReplacement(original,catalog,{...req,groupId:"g1",ruleId:"sick"});
  assert.deepEqual(result.changedLessonIds,["a"]); assert.equal(result.units[0]?.start,650); assert.match(result.skipped.find(x=>x.lessonId==="event")?.reason??"",/мероприятие/i);
});

test("replaces joint mirrors atomically and rejects a candidate busy at actual time",()=>{
  const jointA=lesson("ja","r1",{jointId:"j"}),jointB=lesson("jb","r2",{jointId:"j"});
  const busy=lesson("occupied","r3",{teacherId:"preferred",subjectId:"math"});
  const original=sched({"g1:0":[day("2026-10-12",[jointA])],"g2:0":[day("2026-10-12",[jointB])],"g3:0":[day("2026-10-12",[busy])]});
  const result=previewAutomaticTeacherReplacement(original,catalog,req);
  assert.deepEqual(new Set(result.changedLessonIds),new Set(["ja","jb"]));
  assert.equal(result.schedule["g1:0"]![0]!.slots[0]![0]!.teacherId,"other");
  assert.equal(result.schedule["g2:0"]![0]!.slots[0]![0]!.teacherId,"other");
});

test("does not assign one teacher to overlapping replacement units",()=>{
  const original=sched({"g1:0":[day("2026-10-12",[lesson("a","r1")])],"g2:0":[day("2026-10-12",[lesson("b","r2")])]});
  const result=previewAutomaticTeacherReplacement(original,catalog,req);
  assert.equal(result.changedLessonIds.length,2); assert.notEqual(result.schedule["g1:0"]![0]!.slots[0]![0]!.teacherId,result.schedule["g2:0"]![0]!.slots[0]![0]!.teacherId);
});

test("maintains same-subject continuity across dates when one teacher covers the stream",()=>{
  const original=sched({"g1:0":[day("2026-10-12",[lesson("a","r1")]),day("2026-10-13",[lesson("b","r2")])]});
  const result=previewAutomaticTeacherReplacement(original,catalog,req);
  assert.equal(result.schedule["g1:0"]![0]!.slots[0]![0]!.teacherId,"preferred");
  assert.equal(result.schedule["g1:0"]![1]!.slots[0]![0]!.teacherId,"preferred");
});

test("assigns a constrained unit first, then keeps a flexible subject stream continuous",()=>{
  const original=sched({
    "g2:0":[day("2026-10-12",[lesson("constrained","r1",{subjectId:"english"})])],
    "g1:0":[day("2026-10-12",[lesson("flex-a","r2")]),day("2026-10-13",[lesson("flex-b","r3")])],
  });
  const result=previewAutomaticTeacherReplacement(original,catalog,req);
  assert.equal(result.schedule["g2:0"]![0]!.slots[0]![0]!.teacherId,"other");
  assert.equal(result.schedule["g1:0"]![0]!.slots[0]![0]!.teacherId,"preferred");
  assert.equal(result.schedule["g1:0"]![1]!.slots[0]![0]!.teacherId,"preferred");
  assert.equal(result.changedLessonIds.length,3);
});

test("reports qualification, teacher unavailability, room closure, and room capacity blockers",()=>{
  const scienceCatalog:Catalog={...catalog,subjects:[...catalog.subjects,{id:"science",name:"science",shortName:"science",archived:false,color:"blue",roomKind:null,labRoomKind:null}]};
  const science=sched({"g1:0":[day("2026-10-12",[lesson("science","r1",{subjectId:"science"})])]});
  const noQualified=previewAutomaticTeacherReplacement(science,scienceCatalog,{...req,subjectId:"science"});
  assert.match(noQualified.skipped[0]!.reason,/специальност/i);

  const allAway:Catalog={...catalog,teachers:catalog.teachers.map(teacher=>teacher.id==="ill"?teacher:{...teacher,unavailability:[{id:`away-${teacher.id}`,startDate:"2026-10-12",endDate:"2026-10-12",start:500,end:700}]})};
  const one=sched({"g1:0":[day("2026-10-12",[lesson("a","r1")])]});
  assert.match(previewAutomaticTeacherReplacement(one,allAway,req).skipped[0]!.reason,/недоступны/i);

  const closed:Catalog={...catalog,rooms:catalog.rooms.map(room=>room.id==="r1"?{...room,unavailability:[{id:"repair",startDate:"2026-10-12",endDate:"2026-10-12",start:500,end:700,reason:"Ремонт"}]}:room)};
  assert.match(previewAutomaticTeacherReplacement(one,closed,req).skipped[0]!.reason,/недоступен/i);

  const tooSmall:Catalog={...catalog,rooms:catalog.rooms.map(room=>room.id==="r1"?{...room,capacity:10}:room)};
  assert.match(previewAutomaticTeacherReplacement(one,tooSmall,req).skipped[0]!.reason,/рассчитан на 10/i);
});

test("throws on invalid interval or missing absence rule",()=>{
  const empty=sched({});
  assert.throws(()=>previewAutomaticTeacherReplacement(empty,catalog,{...req,startDate:"2026-10-14"}),/период/);
  assert.throws(()=>previewAutomaticTeacherReplacement(empty,catalog,{...req,startDate:"2026-02-30"}),/период/);
  assert.throws(()=>previewAutomaticTeacherReplacement(empty,catalog,{...req,ruleId:"missing"}),/не найдено/);
  assert.throws(()=>previewAutomaticTeacherReplacement(empty,catalog,{...req,groupId:"unknown"}),/группа не найдена/);
  assert.throws(()=>previewAutomaticTeacherReplacement(empty,catalog,{...req,subjectId:"unknown"}),/предмет не найден/);
});

console.log("automatic teacher replacement: 8 checks passed");
