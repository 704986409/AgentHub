import { describe, expect, it } from 'vitest';
import { EventBus } from '../src/events/index.js';
import { TaskComplexity, TaskRisk, TaskStatus } from '../src/core/types.js';
import { PlanLifecycleService, type CreatePlanTaskInput } from '../src/lifecycle/plan-lifecycle.js';
import { PlanExecutionCoordinator } from '../src/lifecycle/plan-execution-coordinator.js';
import { snapshotCreatePlan, snapshotPlanDecision, snapshotPlanStart } from '../src/api/ApiDtos.js';

const step=(clientId:string,parentClientId:string|null=null):CreatePlanTaskInput=>({clientId,parentClientId,title:clientId,description:null,acceptanceCriteria:['done'],requiredCapabilities:[],requiredSpecialties:[],complexity:TaskComplexity.SIMPLE,risk:TaskRisk.LOW});
function harness(){
  const taskMap=new Map<string,Record<string,unknown>>(); let sequence=0;
  const tasks={getTask:(id:string)=>taskMap.get(id)??null,createTask:(input:Record<string,unknown>)=>{const id=`task-${String(++sequence)}`;const value={id,...input,status:TaskStatus.CREATED,assignmentId:null,assignedAgentId:null};taskMap.set(id,value);return value;}};
  const projects={findById:(id:string)=>id==='p'?{id}:null}; const agents={getAgent:(id:string)=>id==='lead'?{id,projectId:'p'}:null};
  const service=new PlanLifecycleService(projects as never,agents as never,new EventBus(),undefined,tasks as never,{findById:()=>null} as never);
  const intake=service.createIntake({projectId:'p',createdBy:'human',goal:'goal',leadAgentId:'lead'});
  return {service,intake,tasks,taskMap};
}

describe('0.7.3A lifecycle closure',()=>{
  it('requires a new immutable version after REQUEST_CHANGES',()=>{
    const {service:s,intake}=harness(); const v1=s.createPlan({intakeId:intake.intakeId,leadAgentId:'lead',summary:'v1',tasks:[step('a')],dependencies:[]});
    s.decide(v1.planId,'REQUEST_CHANGES',{planVersion:1,proposalHash:v1.current.proposalHash,actorId:'human',summary:'revise'});
    expect(()=>s.decide(v1.planId,'APPROVE',{planVersion:1,proposalHash:v1.current.proposalHash,actorId:'human',summary:''})).toThrow('PLAN_INVALID_STATE');
    const v2=s.createRevision(v1.planId,{basedOnVersion:1,leadAgentId:'lead',summary:'v2',tasks:[step('a')],dependencies:[]});
    expect(v2).toMatchObject({currentVersion:2,state:'WAITING_APPROVAL'}); expect(v2.current.proposalHash).not.toBe(v1.current.proposalHash);
    expect(s.decide(v2.planId,'APPROVE',{planVersion:2,proposalHash:v2.current.proposalHash,actorId:'human',summary:''}).decisions.at(-1)?.decisionId).toMatch(/^[0-9a-f-]{36}$/u);
  });

  it('rejects parent and dependency graph corruption before mutation',()=>{
    const {service:s,intake}=harness(); const base={intakeId:intake.intakeId,leadAgentId:'lead',summary:'x'};
    expect(()=>s.createPlan({...base,tasks:[step('a','missing')],dependencies:[]})).toThrow('PLAN_UNKNOWN_PARENT');
    expect(()=>s.createPlan({...base,tasks:[step('a'),step('b')],dependencies:[{prerequisiteClientId:'a',dependentClientId:'b'},{prerequisiteClientId:'a',dependentClientId:'b'}]})).toThrow('PLAN_DUPLICATE_EDGE');
    expect(()=>s.createPlan({...base,tasks:[step('a'),step('b')],dependencies:[{prerequisiteClientId:'a',dependentClientId:'b'},{prerequisiteClientId:'b',dependentClientId:'a'}]})).toThrow('PLAN_CYCLE');
  });

  it('computes blockedBy from authoritative runtime completion',()=>{
    const {service:s,intake,taskMap}=harness(); const p=s.createPlan({intakeId:intake.intakeId,leadAgentId:'lead',summary:'linear',tasks:[step('a'),step('b')],dependencies:[{prerequisiteClientId:'a',dependentClientId:'b'}]});
    s.decide(p.planId,'APPROVE',{planVersion:1,proposalHash:p.current.proposalHash,actorId:'human',summary:''});
    const a=p.tasks[0],b=p.tasks[1];if(!a||!b)throw new Error('fixture');s.linkRuntimeTask(p.planId,1,a.planTaskId,'ta');s.linkRuntimeTask(p.planId,1,b.planTaskId,'tb');taskMap.set('ta',{id:'ta',status:TaskStatus.CREATED,assignmentId:null,assignedAgentId:null});taskMap.set('tb',{id:'tb',status:TaskStatus.CREATED,assignmentId:null,assignedAgentId:null});
    s.markStarted(p.planId,1); expect(s.getPlan(p.planId)?.tasks[1]).toMatchObject({dependencyState:'BLOCKED',blockedBy:[a.planTaskId]});
    taskMap.set('ta',{id:'ta',status:TaskStatus.COMPLETED,assignmentId:'aa',assignedAgentId:'worker'}); expect(s.refresh(p.planId).tasks[1]).toMatchObject({dependencyState:'ELIGIBLE',blockedBy:[]});
  });

  it('uses TaskManager, Scheduler, Dispatcher and review preparation for start',async()=>{
    const {service:s,intake,tasks}=harness(); const p=s.createPlan({intakeId:intake.intakeId,leadAgentId:'lead',summary:'run',tasks:[step('a'),step('b')],dependencies:[{prerequisiteClientId:'a',dependentClientId:'b'}]});
    const approved=s.decide(p.planId,'APPROVE',{planVersion:1,proposalHash:p.current.proposalHash,actorId:'human',summary:''}); const calls:string[]=[];
    const coordinator=new PlanExecutionCoordinator({planLifecycle:s,tasks:tasks as never,scheduler:{scheduleTask:({taskId}:{taskId:string})=>{calls.push(`schedule:${taskId}`);return {outcome:'reserved',taskId,assignmentId:'assignment',agentId:'worker'};}} as never,dispatcher:{dispatch:()=>{calls.push('dispatch');return Promise.resolve({});}} as never,taskLifecycle:{prepareReview:()=>{calls.push('review');return Promise.resolve({outcome:'review-ready',reviewBundle:{taskId:'task-1',reviewBundleSha256:'a'.repeat(64)}});}} as never,targetBranch:'main',buildTestPlan:{commands:[]},eventBus:new EventBus()});
    const result=await coordinator.start(p.planId,{planVersion:1,proposalHash:approved.current.proposalHash}); expect(result.plan.tasks.map((x)=>x.runtimeTaskId)).toEqual(['task-1','task-2']);expect(calls).toEqual(['schedule:task-1','dispatch','review']);expect(result.plan.tasks[1]?.dependencyState).toBe('BLOCKED');
  });

  it('strictly rejects unknown fields and malformed lifecycle DTOs',()=>{
    expect(()=>snapshotCreatePlan({intakeId:'i',leadAgentId:'lead',summary:'s',tasks:[{...step('a'),extra:true}],dependencies:[]})).toThrow();
    expect(()=>snapshotPlanDecision({planVersion:1,proposalHash:'x',actorId:'human',summary:''})).toThrow();
    expect(()=>snapshotPlanStart({planVersion:1,proposalHash:'a'.repeat(64),extra:true})).toThrow();
  });
});
