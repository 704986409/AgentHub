/* eslint-disable @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-non-null-assertion, @typescript-eslint/no-unnecessary-condition */
import { createHash, randomUUID } from 'node:crypto';
import type { Database } from '../database/database.js';
import type { EventBus } from '../events/event-bus.js';
import type { AssignmentRepository, ProjectRepository } from '../repositories/interfaces.js';
import type { AgentRegistry } from '../services/agent-registry.js';
import type { TaskManager } from '../services/task-manager.js';
import { TaskComplexity, TaskRisk, TaskStatus, type Task } from '../core/types.js';
import { isRuntimeTaskSchedulable } from '../orchestration/AgentScheduler.js';
import { isUniqueConstraintError, PlanTaskMaterializationStore } from './plan-task-materialization.js';

export type PlanState = 'WAITING_APPROVAL'|'APPROVED'|'CHANGES_REQUESTED'|'REJECTED'|'EXECUTING'|'REVIEWING'|'COMPLETED'|'FAILED';
export type PlanDecision = 'APPROVE'|'REQUEST_CHANGES'|'REJECT';
export type DependencyState = 'BLOCKED'|'ELIGIBLE'|'SATISFIED';
export type PlanTaskRuntimeState = 'PENDING'|'BLOCKED'|'ELIGIBLE'|'RUNNING'|'REVIEWING'|'WAITING_INPUT'|'PAUSED'|'COMPLETED'|'FAILED';
export interface IntakeDto { intakeId:string; projectId:string; createdBy:string; goal:string; leadAgentId:string; createdAt:string }
export interface CreateIntakeInput { projectId:string; createdBy:string; goal:string; leadAgentId:string }
export interface CreatePlanTaskInput { clientId:string; parentClientId:string|null; title:string; description:string|null; acceptanceCriteria:readonly string[]; requiredCapabilities:readonly string[]; requiredSpecialties:readonly string[]; complexity:TaskComplexity; risk:TaskRisk }
export interface CreatePlanInput { intakeId:string; leadAgentId:string; summary:string; tasks:readonly CreatePlanTaskInput[]; dependencies:readonly { prerequisiteClientId:string; dependentClientId:string }[] }
export interface CreatePlanRevisionInput extends Omit<CreatePlanInput,'intakeId'> { basedOnVersion:number }
export interface PlanDecisionInput { planVersion:number; proposalHash:string; actorId:string; summary:string }
export interface PlanStartInput { planVersion:number; proposalHash:string }
export interface PlanTaskDefinition { planTaskId:string; clientId:string; parentPlanTaskId:string|null; title:string; description:string|null; acceptanceCriteria:readonly string[]; requiredCapabilities:readonly string[]; requiredSpecialties:readonly string[]; complexity:TaskComplexity; risk:TaskRisk }
export interface PlanDependencyDto { prerequisitePlanTaskId:string; dependentPlanTaskId:string }
export interface PlanVersionDto { planId:string; version:number; proposalHash:string; leadAgentId:string; summary:string; tasks:readonly PlanTaskDefinition[]; dependencies:readonly PlanDependencyDto[]; createdAt:string }
export interface PlanApprovalDecisionDto { decisionId:string; planId:string; planVersion:number; proposalHash:string; decision:PlanDecision; actorId:string; summary:string; decidedAt:string }
export interface PlanTaskRuntimeDto extends PlanTaskDefinition { planId:string; planVersion:number; runtimeTaskId:string|null; assignmentId:string|null; agentId:string|null; dependencyState:DependencyState; blockedBy:readonly string[]; runtimeState:PlanTaskRuntimeState }
export interface PlanAggregateDto { total:number; pending:number; blocked:number; eligible:number; running:number; reviewing:number; completed:number; failed:number; state:PlanState }
export interface PlanDto { planId:string; intakeId:string; projectId:string; leadAgentId:string; currentVersion:number; state:PlanState; current:PlanVersionDto; tasks:readonly PlanTaskRuntimeDto[]; dependencies:readonly PlanDependencyDto[]; decisions:readonly PlanApprovalDecisionDto[]; aggregate:PlanAggregateDto; startedVersion:number|null; startedAt:string|null; createdAt:string; updatedAt:string; completedAt:string|null }
interface RuntimeLink { planTaskId:string; runtimeTaskId:string; createdAt:string; reviewPending:boolean }
interface InternalPlan { planId:string; intakeId:string; projectId:string; leadAgentId:string; currentVersion:number; state:PlanState; versions:Map<number,PlanVersionDto>; decisions:PlanApprovalDecisionDto[]; runtimeLinks:Map<string,RuntimeLink>; startedVersion:number|null; startedAt:string|null; createdAt:string; updatedAt:string; completedAt:string|null }
interface StoredPlan extends Omit<InternalPlan,'versions'|'runtimeLinks'> { versions:readonly PlanVersionDto[]; runtimeLinks:readonly RuntimeLink[] }
interface StoredSnapshot { schemaVersion:1; intakes:readonly IntakeDto[]; plans:readonly StoredPlan[] }
const maxItems=1000; const enc=new TextEncoder();

export class PlanLifecycleService {
  readonly #intakes=new Map<string,IntakeDto>(); readonly #plans=new Map<string,InternalPlan>(); readonly #fences=new Set<string>();
  readonly #materializations:PlanTaskMaterializationStore|undefined;
  public constructor(private readonly projects:ProjectRepository, private readonly agents:AgentRegistry, private readonly events:EventBus, private readonly database?:Database, private readonly tasks?:TaskManager, private readonly assignments?:AssignmentRepository){
    this.#materializations=database?new PlanTaskMaterializationStore(database):undefined;
    this.#load();
  }
  public listIntakes():readonly IntakeDto[]{ return [...this.#intakes.values()].map((x)=>Object.freeze({...x})); }
  public listPlans():readonly PlanDto[]{ return [...this.#plans.values()].map((p)=>this.#project(p)); }
  public getPlan(id:string):PlanDto|null{ const p=this.#plans.get(id); return p?this.#project(p):null; }
  public createIntake(input:CreateIntakeInput):IntakeDto { this.#requireProjectLead(input.projectId,input.leadAgentId); text(input.createdBy,256); text(input.goal,128*1024); const v=Object.freeze({intakeId:randomUUID(),...input,createdAt:now()}); this.#intakes.set(v.intakeId,v); this.#commit(); this.#emit('IntakeCreated',{intakeId:v.intakeId,projectId:v.projectId,leadAgentId:v.leadAgentId}); return v; }
  public createPlan(input:CreatePlanInput):PlanDto { const intake=this.#intakes.get(input.intakeId); if(!intake) fail('PLAN_NOT_FOUND'); this.#requireProjectLead(intake.projectId,input.leadAgentId); const planId=randomUUID(); const version=this.#buildVersion(planId,1,input.leadAgentId,input.summary,input.tasks,input.dependencies); const t=now(); const p:InternalPlan={planId,intakeId:intake.intakeId,projectId:intake.projectId,leadAgentId:input.leadAgentId,currentVersion:1,state:'WAITING_APPROVAL',versions:new Map([[1,version]]),decisions:[],runtimeLinks:new Map(),startedVersion:null,startedAt:null,createdAt:t,updatedAt:t,completedAt:null}; this.#plans.set(planId,p); this.#commit(); this.#emit('PlanProposed',{planId,planVersion:1,proposalHash:version.proposalHash}); return this.#project(p); }
  public createRevision(planId:string,input:CreatePlanRevisionInput):PlanDto { return this.#locked(planId,()=>{ const p=this.#requirePlan(planId); if(p.state!=='CHANGES_REQUESTED'||input.basedOnVersion!==p.currentVersion) fail('PLAN_STALE'); if(input.leadAgentId!==p.leadAgentId) fail('PLAN_CONFLICT'); const n=p.currentVersion+1; const v=this.#buildVersion(planId,n,input.leadAgentId,input.summary,input.tasks,input.dependencies); p.versions.set(n,v); p.currentVersion=n; p.state='WAITING_APPROVAL'; p.updatedAt=now(); p.runtimeLinks.clear(); this.#commit(); this.#emit('PlanRevised',{planId,planVersion:n,basedOnVersion:input.basedOnVersion,proposalHash:v.proposalHash}); return this.#project(p); }); }
  public decide(planId:string,decision:PlanDecision,input:PlanDecisionInput):PlanDto { return this.#locked(planId,()=>{ const p=this.#requirePlan(planId),v=this.#current(p); if(input.planVersion!==p.currentVersion||input.proposalHash!==v.proposalHash) fail('PLAN_STALE'); if(p.state!=='WAITING_APPROVAL') fail('PLAN_INVALID_STATE'); const d=Object.freeze({decisionId:randomUUID(),planId,planVersion:v.version,proposalHash:v.proposalHash,decision,actorId:text(input.actorId,256),summary:textAllowEmpty(input.summary,16*1024),decidedAt:now()}); p.decisions.push(d); p.state=decision==='APPROVE'?'APPROVED':decision==='REJECT'?'REJECTED':'CHANGES_REQUESTED'; p.updatedAt=now(); this.#commit(); this.#emit('PlanApprovalDecision',d); return this.#project(p); }); }
  public approvedVersion(planId:string,input:PlanStartInput):PlanVersionDto { const p=this.#requirePlan(planId),v=this.#current(p); if(p.state!=='APPROVED'&&p.startedVersion!==v.version) fail('PLAN_NOT_APPROVED'); if(input.planVersion!==p.currentVersion||input.proposalHash!==v.proposalHash) fail('PLAN_STALE'); if(!p.decisions.some((d)=>d.planVersion===v.version&&d.proposalHash===v.proposalHash&&d.decision==='APPROVE')) fail('PLAN_NOT_APPROVED'); return v; }
  public linkRuntimeTask(planId:string,version:number,planTaskId:string,runtimeTaskId:string):void { const p=this.#requirePlan(planId); if(version!==p.currentVersion||!this.#current(p).tasks.some((t)=>t.planTaskId===planTaskId)) fail('PLAN_STALE'); const prior=p.runtimeLinks.get(planTaskId); if(prior&&prior.runtimeTaskId!==runtimeTaskId) fail('PLAN_RUNTIME_LINK_CONFLICT'); if(prior)return; const link={planTaskId,runtimeTaskId,createdAt:now(),reviewPending:false}; p.runtimeLinks.set(planTaskId,link); try{ this.#commit(); }catch(error){ p.runtimeLinks.delete(planTaskId); throw error; } this.#emit('PlanTaskMaterialized',{planId,planVersion:version,planTaskId,runtimeTaskId}); }
  public materializeRuntimeTask(planId:string,version:number,definition:PlanTaskDefinition):string {
    const p=this.#requirePlan(planId); if(version!==p.currentVersion) fail('PLAN_STALE');
    if(!this.#current(p).tasks.some((t)=>t.planTaskId===definition.planTaskId)) fail('PLAN_STALE');
    if(!this.tasks) fail('PLAN_RUNTIME_LINK_CONFLICT');
    const linked=p.runtimeLinks.get(definition.planTaskId);
    if(linked){
      const mapped=this.tasks.getTask(linked.runtimeTaskId);
      if(!mapped) fail('PLAN_RUNTIME_MATERIALIZATION_RECONCILIATION_REQUIRED');
      this.#assertOrigin(mapped,planId,version,definition.planTaskId);
      this.#persistIdentity(planId,version,definition.planTaskId,mapped);
      return linked.runtimeTaskId;
    }
    const fromTable=this.#materializations?.get(planId,version,definition.planTaskId)??null;
    if(fromTable){
      const mapped=this.tasks.getTask(fromTable.runtimeTaskId);
      if(!mapped) fail('PLAN_RUNTIME_MATERIALIZATION_RECONCILIATION_REQUIRED');
      this.#assertOrigin(mapped,planId,version,definition.planTaskId);
      this.#persistIdentity(planId,version,definition.planTaskId,mapped);
      this.linkRuntimeTask(planId,version,definition.planTaskId,mapped.id);
      return mapped.id;
    }
    const fromOrigin=this.#taskByOrigin(planId,version,definition.planTaskId);
    if(fromOrigin){
      this.#assertOrigin(fromOrigin,planId,version,definition.planTaskId);
      this.#persistIdentity(planId,version,definition.planTaskId,fromOrigin);
      this.linkRuntimeTask(planId,version,definition.planTaskId,fromOrigin.id);
      return fromOrigin.id;
    }
    let created:Task;
    try{
      created=this.tasks.createTask({
        projectId:p.projectId,title:definition.title,description:definition.description,
        requiredCapabilities:[...definition.requiredCapabilities],requiredSpecialties:[...definition.requiredSpecialties],
        acceptanceCriteria:[...definition.acceptanceCriteria],complexity:definition.complexity,risk:definition.risk,
        originPlanId:planId,originPlanVersion:version,originPlanTaskId:definition.planTaskId,
      });
    }catch(error){
      if(!isUniqueConstraintError(error)) throw error;
      const recovered=this.#taskByOrigin(planId,version,definition.planTaskId);
      if(!recovered) fail('PLAN_RUNTIME_MATERIALIZATION_RECONCILIATION_REQUIRED');
      created=recovered;
    }
    this.#persistIdentity(planId,version,definition.planTaskId,created);
    this.linkRuntimeTask(planId,version,definition.planTaskId,created.id);
    return created.id;
  }
  public markStarted(planId:string,version:number):PlanDto { const p=this.#requirePlan(planId),v=this.#current(p); if(p.currentVersion!==version) fail('PLAN_STALE'); if(!p.decisions.some((d)=>d.planVersion===version&&d.proposalHash===v.proposalHash&&d.decision==='APPROVE'))fail('PLAN_NOT_APPROVED'); if(p.runtimeLinks.size!==v.tasks.length) fail('PLAN_RUNTIME_LINK_CONFLICT'); p.startedVersion=version; p.startedAt??=now(); p.state='EXECUTING'; p.updatedAt=now(); this.#recompute(p); this.#commit(); this.#emit('PlanStarted',{planId,planVersion:version}); return this.#project(p); }
  public markReviewPendingByTask(runtimeTaskId:string,pending:boolean):void { const found=this.#findLink(runtimeTaskId); if(!found)return; found.link.reviewPending=pending; this.#recompute(found.plan); this.#commit(); this.#emit(pending?'PlanTaskReviewReady':'PlanTaskReviewResolved',{planId:found.plan.planId,planVersion:found.plan.currentVersion,planTaskId:found.link.planTaskId,runtimeTaskId}); }
  public refresh(planId:string):PlanDto { const p=this.#requirePlan(planId); this.#recompute(p); this.#commit(); return this.#project(p); }
  public eligibleTasks(planId:string):readonly PlanTaskRuntimeDto[]{
    const p=this.#requirePlan(planId); this.#recompute(p);
    return this.#projectTasks(p).filter((t)=>{
      if(t.dependencyState!=='ELIGIBLE'||t.runtimeTaskId===null) return false;
      const task=this.tasks?.getTask(t.runtimeTaskId);
      return !!task && isRuntimeTaskSchedulable(task);
    });
  }
  #project(p:InternalPlan):PlanDto { this.#recompute(p); const current=this.#current(p),tasks=this.#projectTasks(p),aggregate=aggregateFor(p.state,tasks); return Object.freeze({planId:p.planId,intakeId:p.intakeId,projectId:p.projectId,leadAgentId:p.leadAgentId,currentVersion:p.currentVersion,state:aggregate.state,current,tasks:Object.freeze(tasks),dependencies:current.dependencies,decisions:Object.freeze(p.decisions.map((d)=>({...d}))),aggregate,startedVersion:p.startedVersion,startedAt:p.startedAt,createdAt:p.createdAt,updatedAt:p.updatedAt,completedAt:p.completedAt}); }
  #projectTasks(p:InternalPlan):PlanTaskRuntimeDto[]{
    const v=this.#current(p);
    return v.tasks.map((d)=>{
      const link=p.runtimeLinks.get(d.planTaskId),task=link?this.tasks?.getTask(link.runtimeTaskId)??null:null;
      const assignment=task?.assignmentId?this.assignments?.findById(task.assignmentId):null;
      const blockedBy=v.dependencies.filter((e)=>e.dependentPlanTaskId===d.planTaskId).map((e)=>e.prerequisitePlanTaskId).filter((id)=>!this.#completed(p,id)).sort();
      const dep:DependencyState=this.#completed(p,d.planTaskId)?'SATISFIED':blockedBy.length?'BLOCKED':'ELIGIBLE';
      const state=projectRuntimeState(task,dep,!!link?.reviewPending);
      return Object.freeze({...d,planId:p.planId,planVersion:v.version,runtimeTaskId:link?.runtimeTaskId??null,assignmentId:task?.assignmentId??null,agentId:assignment?.agentId??task?.assignedAgentId??null,dependencyState:dep,blockedBy:Object.freeze(blockedBy),runtimeState:state});
    });
  }
  #completed(p:InternalPlan,planTaskId:string):boolean{ const link=p.runtimeLinks.get(planTaskId); return !!link&&this.tasks?.getTask(link.runtimeTaskId)?.status===TaskStatus.COMPLETED&&!link.reviewPending; }
  #recompute(p:InternalPlan):void { if(p.startedVersion===null)return; const a=aggregateFor(p.state,this.#projectTasks(p)); const prior=p.state; if(a.failed>0)p.state='FAILED'; else if(a.completed===a.total&&a.total>0){p.state='COMPLETED';p.completedAt??=now();} else if(a.running===0&&a.eligible===0&&a.reviewing>0)p.state='REVIEWING'; else p.state='EXECUTING'; if(prior!==p.state){p.updatedAt=now();this.#emit('PlanAggregateChanged',{planId:p.planId,planVersion:p.currentVersion,state:p.state});if(p.state==='COMPLETED')this.#emit('PlanCompleted',{planId:p.planId,planVersion:p.currentVersion,completedAt:p.completedAt});if(p.state==='FAILED')this.#emit('PlanFailed',{planId:p.planId,planVersion:p.currentVersion});} }
  #buildVersion(planId:string,version:number,leadAgentId:string,summary:string,inputTasks:readonly CreatePlanTaskInput[],inputDeps:readonly {prerequisiteClientId:string;dependentClientId:string}[]):PlanVersionDto { text(summary,16*1024); if(!Array.isArray(inputTasks)||inputTasks.length<1||inputTasks.length>maxItems||!Array.isArray(inputDeps)||inputDeps.length>maxItems*4)fail('PLAN_INVALID'); const clientIds=new Set<string>(); for(const t of inputTasks){text(t.clientId,256);if(clientIds.has(t.clientId))fail('PLAN_DUPLICATE_CLIENT');clientIds.add(t.clientId);validateTask(t);} const ids=new Map(inputTasks.map((t)=>[t.clientId,randomUUID()])); const defs=inputTasks.map((t)=>Object.freeze({planTaskId:ids.get(t.clientId)!,clientId:t.clientId,parentPlanTaskId:t.parentClientId===null?null:(ids.get(t.parentClientId)??fail('PLAN_UNKNOWN_PARENT')),title:t.title,description:t.description,acceptanceCriteria:Object.freeze([...t.acceptanceCriteria]),requiredCapabilities:Object.freeze([...t.requiredCapabilities]),requiredSpecialties:Object.freeze([...t.requiredSpecialties]),complexity:t.complexity,risk:t.risk})); for(const d of defs)if(d.parentPlanTaskId===d.planTaskId)fail('PLAN_PARENT_CYCLE'); validateParentDag(defs); const seen=new Set<string>(); const deps=inputDeps.map((d)=>{const a=ids.get(d.prerequisiteClientId),b=ids.get(d.dependentClientId);if(!a||!b)fail('PLAN_UNKNOWN_DEPENDENCY');if(a===b)fail('PLAN_CYCLE');const k=`${a}\0${b}`;if(seen.has(k))fail('PLAN_DUPLICATE_EDGE');seen.add(k);return Object.freeze({prerequisitePlanTaskId:a,dependentPlanTaskId:b});}); validateDependencyDag(defs,deps); const createdAt=now(); const canonical={planId,version,leadAgentId,summary,tasks:defs.map((t)=>({...t})),dependencies:deps.map((d)=>({...d}))}; return Object.freeze({...canonical,proposalHash:hash(canonical),tasks:Object.freeze(defs),dependencies:Object.freeze(deps),createdAt}); }
  #current(p:InternalPlan):PlanVersionDto{ const v=p.versions.get(p.currentVersion); if(!v)fail('PLAN_CORRUPT_SNAPSHOT');return v; }
  #requirePlan(id:string):InternalPlan{ const p=this.#plans.get(id);if(!p)fail('PLAN_NOT_FOUND');return p; }
  #requireProjectLead(projectId:string,leadId:string):void{ text(projectId,256);text(leadId,256);const agent=this.agents.getAgent(leadId);if(!this.projects.findById(projectId)||!agent||agent.projectId!==projectId)fail('PLAN_NOT_FOUND'); }
  #findLink(taskId:string):{plan:InternalPlan;link:RuntimeLink}|null{for(const p of this.#plans.values())for(const link of p.runtimeLinks.values())if(link.runtimeTaskId===taskId)return{plan:p,link};return null;}
  #locked<T>(id:string,fn:()=>T):T{if(this.#fences.has(id))fail('PLAN_CONFLICT');this.#fences.add(id);try{return fn();}finally{this.#fences.delete(id);}}
  #emit(type:string,payload:Record<string,unknown>):void{this.events.publish({eventType:type,payload,actor:'system'});}
  #commit():void{this.#save();}
  #save():void{if(!this.database)return;const snapshot:StoredSnapshot={schemaVersion:1,intakes:[...this.#intakes.values()],plans:[...this.#plans.values()].map((p)=>({...p,versions:[...p.versions.values()],runtimeLinks:[...p.runtimeLinks.values()]}))};this.database.connection.prepare('INSERT INTO settings(key,value,updated_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at').run('public_lifecycle_snapshot',JSON.stringify(snapshot),now());}
  #load():void{if(!this.database)return;const row=this.database.connection.prepare('SELECT value FROM settings WHERE key=?').get('public_lifecycle_snapshot') as {value:string}|undefined;if(!row)return;try{const raw=JSON.parse(row.value) as unknown;const restored=validateStored(raw,this.projects,this.agents,this.tasks,this.#materializations);for(const i of restored.intakes)this.#intakes.set(i.intakeId,Object.freeze(i));for(const s of restored.plans){const p:InternalPlan={...s,versions:new Map(s.versions.map((v)=>[v.version,Object.freeze(v)])),runtimeLinks:new Map(s.runtimeLinks.map((l)=>[l.planTaskId,l]))};this.#plans.set(p.planId,p);this.#recompute(p);}}catch{this.#intakes.clear();this.#plans.clear();this.events.publishSystemError(new Error('PLAN_CORRUPT_SNAPSHOT'),{component:'plan-lifecycle'});}}
  #taskByOrigin(planId:string,version:number,planTaskId:string):Task|null{
    const manager=this.tasks as (TaskManager & {findByPlanOrigin?:TaskManager['findByPlanOrigin'];listTasks?:TaskManager['listTasks']})|undefined;
    if(typeof manager?.findByPlanOrigin==='function') return manager.findByPlanOrigin(planId,version,planTaskId);
    if(typeof manager?.listTasks==='function'){
      const matches=manager.listTasks().filter((task)=>task.originPlanId===planId&&task.originPlanVersion===version&&task.originPlanTaskId===planTaskId);
      if(matches.length>1) fail('PLAN_RUNTIME_MATERIALIZATION_RECONCILIATION_REQUIRED');
      return matches[0]??null;
    }
    return null;
  }
  #assertOrigin(task:Task,planId:string,version:number,planTaskId:string):void{
    if(!originAgrees(task,planId,version,planTaskId)) fail('PLAN_RUNTIME_MATERIALIZATION_RECONCILIATION_REQUIRED');
  }
  #persistIdentity(planId:string,version:number,planTaskId:string,task:Task):void{
    this.#assertOrigin(task,planId,version,planTaskId);
    this.#materializations?.persist({planId,planVersion:version,planTaskId,runtimeTaskId:task.id,createdAt:now()});
    const manager=this.tasks as (TaskManager & {bindPlanOrigin?:TaskManager['bindPlanOrigin']})|undefined;
    if(typeof manager?.bindPlanOrigin==='function') manager.bindPlanOrigin(task.id,planId,version,planTaskId);
    else stampInMemoryOrigin(task,planId,version,planTaskId);
  }
}
function validateTask(t:CreatePlanTaskInput):void{text(t.title,16*1024);if(t.description!==null)textAllowEmpty(t.description,128*1024);for(const a of [t.acceptanceCriteria,t.requiredCapabilities,t.requiredSpecialties]){if(!Array.isArray(a)||a.length>256)fail('PLAN_INVALID');for(const x of a)text(x,8192);}if(!Object.values(TaskComplexity).includes(t.complexity)||!Object.values(TaskRisk).includes(t.risk))fail('PLAN_INVALID');if(t.parentClientId!==null)text(t.parentClientId,256);}
function validateParentDag(tasks:readonly PlanTaskDefinition[]):void{const byId=new Map(tasks.map((t)=>[t.planTaskId,t]));for(const t of tasks){const seen=new Set<string>();let cur:PlanTaskDefinition|undefined=t;while(cur?.parentPlanTaskId){if(seen.has(cur.planTaskId))fail('PLAN_PARENT_CYCLE');seen.add(cur.planTaskId);cur=byId.get(cur.parentPlanTaskId);if(!cur)fail('PLAN_UNKNOWN_PARENT');}}}
function validateDependencyDag(tasks:readonly PlanTaskDefinition[],deps:readonly PlanDependencyDto[]):void{const edges=new Map(tasks.map((t)=>[t.planTaskId,[] as string[]]));for(const d of deps)edges.get(d.prerequisitePlanTaskId)?.push(d.dependentPlanTaskId);const visiting=new Set<string>(),done=new Set<string>();const visit=(id:string):void=>{if(visiting.has(id))fail('PLAN_CYCLE');if(done.has(id))return;visiting.add(id);for(const n of edges.get(id)??[])visit(n);visiting.delete(id);done.add(id);};for(const id of edges.keys())visit(id);}
function aggregateFor(state:PlanState,tasks:readonly PlanTaskRuntimeDto[]):PlanAggregateDto{
  const n=(s:PlanTaskRuntimeState)=>tasks.filter((t)=>t.runtimeState===s).length;
  const blocked=n('BLOCKED')+n('WAITING_INPUT')+n('PAUSED')+n('PENDING');
  const eligible=n('ELIGIBLE');
  return Object.freeze({total:tasks.length,pending:blocked+eligible,blocked,eligible,running:n('RUNNING'),reviewing:n('REVIEWING'),completed:n('COMPLETED'),failed:n('FAILED'),state});
}
export function projectRuntimeState(task:Task|null,dependencyState:DependencyState,reviewPending:boolean):PlanTaskRuntimeState{
  if(task===null) return dependencyState==='BLOCKED'?'BLOCKED':'ELIGIBLE';
  switch(task.status){
    case TaskStatus.FAILED:
    case TaskStatus.CANCELLED:
      return 'FAILED';
    case TaskStatus.CREATED:
    case TaskStatus.QUEUED:
      if(reviewPending) return 'REVIEWING';
      return dependencyState==='BLOCKED'?'BLOCKED':'ELIGIBLE';
    case TaskStatus.ASSIGNED:
    case TaskStatus.IMPLEMENTING:
    case TaskStatus.IN_PROGRESS:
    case TaskStatus.REVISION_REQUIRED:
      return reviewPending?'REVIEWING':'RUNNING';
    case TaskStatus.REVIEWING:
      return 'REVIEWING';
    case TaskStatus.COMPLETED:
      return reviewPending?'REVIEWING':'COMPLETED';
    case TaskStatus.BLOCKED:
    case TaskStatus.WAITING_DEPENDENCY:
    case TaskStatus.WAITING_APPROVAL:
      return reviewPending?'REVIEWING':'BLOCKED';
    case TaskStatus.WAITING_INPUT:
      return reviewPending?'REVIEWING':'WAITING_INPUT';
    case TaskStatus.PAUSED:
      return reviewPending?'REVIEWING':'PAUSED';
    case TaskStatus.PENDING:
      return reviewPending?'REVIEWING':'PENDING';
    default:{
      const closed:never=task.status;
      return closed;
    }
  }
}
function originAgrees(task:Task,planId:string,version:number,planTaskId:string):boolean{
  const originId=task.originPlanId??null, originVersion=task.originPlanVersion??null, originTask=task.originPlanTaskId??null;
  if(originId===null&&originVersion===null&&originTask===null) return true;
  return originId===planId&&originVersion===version&&originTask===planTaskId;
}
function stampInMemoryOrigin(task:Task,planId:string,version:number,planTaskId:string):void{
  if(!originAgrees(task,planId,version,planTaskId)) fail('PLAN_RUNTIME_MATERIALIZATION_RECONCILIATION_REQUIRED');
  const mutable=task as Task & {originPlanId:string|null;originPlanVersion:number|null;originPlanTaskId:string|null};
  mutable.originPlanId=planId; mutable.originPlanVersion=version; mutable.originPlanTaskId=planTaskId;
}
function validateStored(raw:unknown,projects:ProjectRepository,agents:AgentRegistry,tasks?:TaskManager,materializations?:PlanTaskMaterializationStore):StoredSnapshot{
  if(!record(raw)||Object.keys(raw).some((k)=>!['schemaVersion','intakes','plans'].includes(k))||raw.schemaVersion!==1||!Array.isArray(raw.intakes)||!Array.isArray(raw.plans)||raw.intakes.length>maxItems||raw.plans.length>maxItems)fail('PLAN_CORRUPT_SNAPSHOT');
  const snapshot=raw as unknown as StoredSnapshot;const intakeIds=new Set<string>();const intakes=new Map<string,IntakeDto>();
  for(const i of snapshot.intakes){
    if(!record(i)||typeof i.intakeId!=='string'||intakeIds.has(i.intakeId))fail('PLAN_CORRUPT_SNAPSHOT');
    const project=projects.findById(i.projectId); const lead=agents.getAgent(i.leadAgentId);
    if(!project||!lead||lead.projectId!==i.projectId)fail('PLAN_CORRUPT_SNAPSHOT');
    intakeIds.add(i.intakeId); intakes.set(i.intakeId,i); text(i.goal,128*1024);text(i.createdBy,256);
  }
  const runtimeIds=new Set<string>(),planIds=new Set<string>();const states:readonly PlanState[]=['WAITING_APPROVAL','APPROVED','CHANGES_REQUESTED','REJECTED','EXECUTING','REVIEWING','COMPLETED','FAILED'];
  for(const p of snapshot.plans){
    if(!record(p)||planIds.has(p.planId)||!intakeIds.has(p.intakeId)||!states.includes(p.state)||!Array.isArray(p.versions)||p.versions.length<1||p.versions.length>maxItems||!Array.isArray(p.decisions)||!Array.isArray(p.runtimeLinks))fail('PLAN_CORRUPT_SNAPSHOT');planIds.add(p.planId);
    const intake=intakes.get(p.intakeId); if(!intake||p.projectId!==intake.projectId||p.leadAgentId!==intake.leadAgentId)fail('PLAN_CORRUPT_SNAPSHOT');
    const project=projects.findById(p.projectId); const lead=agents.getAgent(p.leadAgentId);
    if(!project||!lead||lead.projectId!==p.projectId)fail('PLAN_CORRUPT_SNAPSHOT');
    if((p.startedVersion===null&&['EXECUTING','REVIEWING','COMPLETED','FAILED'].includes(p.state))||(p.startedVersion!==null&&p.startedVersion!==p.currentVersion))fail('PLAN_CORRUPT_SNAPSHOT');
    const versions:PlanVersionDto[]=[...p.versions].sort((a,b)=>a.version-b.version);if(versions.some((v,i)=>v.version!==i+1)||p.currentVersion!==versions.length)fail('PLAN_CORRUPT_SNAPSHOT');
    for(const v of versions){if(v.planId!==p.planId||v.leadAgentId!==p.leadAgentId||!Array.isArray(v.tasks)||!Array.isArray(v.dependencies)||v.tasks.length<1)fail('PLAN_CORRUPT_SNAPSHOT');for(const t of v.tasks){if(!Object.values(TaskComplexity).includes(t.complexity)||!Object.values(TaskRisk).includes(t.risk))fail('PLAN_CORRUPT_SNAPSHOT');}validateParentDag(v.tasks);validateDependencyDag(v.tasks,v.dependencies);const canonical={planId:v.planId,version:v.version,leadAgentId:v.leadAgentId,summary:v.summary,tasks:v.tasks.map((t:PlanTaskDefinition)=>({...t})),dependencies:v.dependencies.map((d:PlanDependencyDto)=>({...d}))};if(hash(canonical)!==v.proposalHash)fail('PLAN_CORRUPT_SNAPSHOT');}
    for(const d of p.decisions){const v=versions.find((item)=>item.version===d.planVersion);if(!v||d.planId!==p.planId||d.proposalHash!==v.proposalHash||!['APPROVE','REQUEST_CHANGES','REJECT'].includes(d.decision)||!d.decisionId)fail('PLAN_CORRUPT_SNAPSHOT');}
    const currentIds=new Set(versions.at(-1)?.tasks.map((t)=>t.planTaskId)); const seenPlanTasks=new Set<string>();
    for(const l of p.runtimeLinks){
      if(typeof l.reviewPending!=='boolean'||!currentIds.has(l.planTaskId)||seenPlanTasks.has(l.planTaskId)||runtimeIds.has(l.runtimeTaskId))fail('PLAN_CORRUPT_SNAPSHOT');
      const mapped=tasks?.getTask(l.runtimeTaskId); if(!mapped||!originAgrees(mapped,p.planId,p.currentVersion,l.planTaskId))fail('PLAN_CORRUPT_SNAPSHOT');
      seenPlanTasks.add(l.planTaskId); runtimeIds.add(l.runtimeTaskId);
    }
    reconcilePlanMaterializations(p,currentIds,materializations,tasks);
  }
  return snapshot;
}
function reconcilePlanMaterializations(p:StoredPlan,currentIds:Set<string>,materializations?:PlanTaskMaterializationStore,tasks?:TaskManager):void{
  const tableRows=materializations?.listByPlan(p.planId,p.currentVersion)??[];
  const links=new Map(p.runtimeLinks.map((l)=>[l.planTaskId,l]));
  for(const row of tableRows){
    if(!currentIds.has(row.planTaskId)) fail('PLAN_CORRUPT_SNAPSHOT');
    const mapped=tasks?.getTask(row.runtimeTaskId); if(!mapped) fail('PLAN_CORRUPT_SNAPSHOT');
    if(!originAgrees(mapped,row.planId,row.planVersion,row.planTaskId)) fail('PLAN_CORRUPT_SNAPSHOT');
    const link=links.get(row.planTaskId);
    if(link&&link.runtimeTaskId!==row.runtimeTaskId) fail('PLAN_CORRUPT_SNAPSHOT');
  }
  if(!materializations||!tasks) return;
  for(const link of p.runtimeLinks){
    const existing=materializations.get(p.planId,p.currentVersion,link.planTaskId);
    if(existing){
      if(existing.runtimeTaskId!==link.runtimeTaskId) fail('PLAN_CORRUPT_SNAPSHOT');
      continue;
    }
    const mapped=tasks.getTask(link.runtimeTaskId); if(!mapped) fail('PLAN_CORRUPT_SNAPSHOT');
    materializations.persist({planId:p.planId,planVersion:p.currentVersion,planTaskId:link.planTaskId,runtimeTaskId:link.runtimeTaskId,createdAt:link.createdAt});
    if(typeof tasks.bindPlanOrigin==='function') tasks.bindPlanOrigin(mapped.id,p.planId,p.currentVersion,link.planTaskId);
    else stampInMemoryOrigin(mapped,p.planId,p.currentVersion,link.planTaskId);
  }
}
function record(v:unknown):v is Record<string,unknown>{return typeof v==='object'&&v!==null&&!Array.isArray(v)}
function hash(v:unknown):string{return createHash('sha256').update(JSON.stringify(v)).digest('hex')}
function text(v:string,max:number):string{if(typeof v!=='string'||!v.trim()||v.includes('\0')||enc.encode(v).length>max)fail('PLAN_INVALID');return v}
function textAllowEmpty(v:string,max:number):string{if(typeof v!=='string'||v.includes('\0')||enc.encode(v).length>max)fail('PLAN_INVALID');return v}
function now():string{return new Date().toISOString()}
function fail(code:string):never{const e=new Error(code);(e as Error&{code:string}).code=code;throw e}
