import type { AgentScheduler } from '../orchestration/AgentScheduler.js';
import type { AssignmentDispatcher } from '../orchestration/AssignmentDispatcher.js';
import type { TaskLifecycleOrchestrator, TaskReviewBundle } from '../orchestration/TaskLifecycleOrchestrator.js';
import type { TaskManager } from '../services/task-manager.js';
import type { BuildTestEvidencePlan } from '../workspace/BuildTestEvidenceCollector.js';
import type { EventBus } from '../events/event-bus.js';
import type { PlanDto, PlanStartInput, PlanState, PlanTaskRuntimeDto, PlanLifecycleService } from './plan-lifecycle.js';
import {
  PLAN_ASSIGNMENT_RESUMED,
  type PlanExecutionRecoveryService,
} from './plan-execution-recovery.js';

export interface PlanExecutionStartResult { readonly plan:PlanDto; readonly reviewBundles:readonly TaskReviewBundle[] }
export interface PlanResumeResult {
  readonly planId:string;
  readonly dispatched:number;
  readonly reviewReady:number;
  readonly deferredEligible:number;
}
export interface PlanExecutionCoordinatorOptions {
  planLifecycle:PlanLifecycleService;
  tasks:TaskManager;
  scheduler:AgentScheduler;
  dispatcher:AssignmentDispatcher;
  taskLifecycle:TaskLifecycleOrchestrator;
  targetBranch:string;
  buildTestPlan:BuildTestEvidencePlan;
  eventBus:EventBus;
  reviewTransitions?: { markPlanReviewPending(runtimeTaskId:string):void };
  assignmentRecovery?: PlanExecutionRecoveryService;
}

export function isResumablePlanState(state:PlanState):boolean {
  return state==='EXECUTING' || state==='REVIEWING';
}

export class PlanExecutionCoordinator {
  readonly #active=new Set<string>();
  readonly #queues=new Map<string,Promise<unknown>>();
  public constructor(private readonly options:PlanExecutionCoordinatorOptions){}
  public async resume(planId:string):Promise<PlanResumeResult>{
    return this.#enqueue(planId,async()=>{
      const plan=this.options.planLifecycle.getPlan(planId);
      if(!plan)throw coded('PLAN_NOT_FOUND');
      if(!isResumablePlanState(plan.state) || plan.startedVersion===null){
        return Object.freeze({planId,dispatched:0,reviewReady:0,deferredEligible:0});
      }
      const result=await this.#dispatchEligible(plan.planId,this.options.planLifecycle.refresh(plan.planId));
      return Object.freeze({
        planId,
        dispatched:result.dispatched,
        reviewReady:result.bundles.length,
        deferredEligible:result.deferredEligible,
      });
    });
  }
  public async resumeStartedPlans():Promise<void>{
    for(const plan of this.options.planLifecycle.listPlans()){
      try { await this.resume(plan.planId); }
      catch { /* recovery coordinator owns isolation; leftover callers must not abort remaining Plans */ }
    }
  }
  public async start(planId:string,input:PlanStartInput):Promise<PlanExecutionStartResult>{
    if(this.#active.has(planId))throw coded('PLAN_CONFLICT'); this.#active.add(planId);
    try{
      return await this.#enqueue(planId,async()=>{
        const version=this.options.planLifecycle.approvedVersion(planId,input);
        let current=this.options.planLifecycle.getPlan(planId); if(!current)throw coded('PLAN_NOT_FOUND');
        for(const definition of version.tasks){
          this.options.planLifecycle.materializeRuntimeTask(planId,version.version,definition);
        }
        current=this.options.planLifecycle.markStarted(planId,version.version);
        const reviewBundles=await this.#dispatchEligible(planId,current);
        return Object.freeze({plan:this.options.planLifecycle.refresh(planId),reviewBundles:Object.freeze(reviewBundles.bundles)});
      });
    }finally{this.#active.delete(planId);}
  }
  public async afterReview(runtimeTaskId:string):Promise<readonly TaskReviewBundle[]>{
    this.options.planLifecycle.markReviewPendingByTask(runtimeTaskId,false);
    const plan=this.options.planLifecycle.listPlans().find((p)=>p.tasks.some((t)=>t.runtimeTaskId===runtimeTaskId));
    if(!plan)return [];
    return this.#enqueue(plan.planId,async()=>{
      const result=await this.#dispatchEligible(plan.planId,this.options.planLifecycle.refresh(plan.planId));
      return Object.freeze(result.bundles);
    });
  }
  async #enqueue<T>(planId:string,fn:()=>Promise<T>):Promise<T>{
    const prior=this.#queues.get(planId)??Promise.resolve();
    let release!:()=>void; const gate=new Promise<void>((resolve)=>{release=resolve;});
    const running=prior.then(()=>gate,()=>gate); this.#queues.set(planId,running);
    await prior.then(()=>undefined,()=>undefined);
    try{return await fn();}finally{release(); if(this.#queues.get(planId)===running)this.#queues.delete(planId);}
  }
  async #dispatchEligible(planId:string,plan:PlanDto):Promise<{bundles:TaskReviewBundle[];dispatched:number;deferredEligible:number}>{
    const bundles:TaskReviewBundle[]=[];
    let dispatched=0;
    let deferredEligible=0;
    const recovered=await this.#recoverResidues(planId,plan,bundles);
    dispatched+=recovered.dispatched;
    deferredEligible+=recovered.deferredEligible;
    const eligible=this.options.planLifecycle.eligibleTasks(planId);
    for(const step of eligible){
      if(!step.runtimeTaskId)throw coded('PLAN_RUNTIME_LINK_CONFLICT');
      const scheduled=this.options.scheduler.scheduleTask({taskId:step.runtimeTaskId,requirements:{requiredOutputProtocols:['worker-result']}});
      if(scheduled.outcome!=='reserved'){ deferredEligible+=1; continue; }
      this.options.assignmentRecovery?.persistReservation(planId,scheduled);
      const prepared=await this.#dispatchReserved(plan,step,scheduled);
      if(prepared==='deferred'){ deferredEligible+=1; continue; }
      dispatched+=1;
      if(prepared!==null) bundles.push(prepared);
    }
    return {bundles,dispatched,deferredEligible};
  }
  async #recoverResidues(
    planId:string,
    plan:PlanDto,
    bundles:TaskReviewBundle[],
  ):Promise<{dispatched:number;deferredEligible:number}>{
    const recovery=this.options.assignmentRecovery;
    if(!recovery) return {dispatched:0,deferredEligible:0};
    let dispatched=0;
    let deferredEligible=0;
    for(const step of this.options.planLifecycle.recoverableRuntimeTasks(planId)){
      if(!step.runtimeTaskId)throw coded('PLAN_RUNTIME_LINK_CONFLICT');
      const inspected=recovery.inspect(step.runtimeTaskId);
      if(inspected.outcome==='idle' || inspected.outcome==='review-ready') continue;
      if(inspected.outcome==='reconciliation-required') throw coded(inspected.code);
      if(inspected.outcome==='requeue-safe'){
        const requeued=await recovery.requeue(inspected.assignmentId);
        if(requeued.outcome==='reconciliation-required') throw coded(requeued.code);
        deferredEligible+=1;
        continue;
      }
      if(inspected.outcome==='requeued'){ deferredEligible+=1; continue; }
      if(inspected.outcome==='review-resumable'){
        const prepared=await this.#preparePersisted(planId,step.runtimeTaskId,inspected.dispatch);
        if(prepared) bundles.push(prepared);
        continue;
      }
      if(inspected.outcome==='turn-completed'){
        const prepared=await this.#preparePersisted(planId,step.runtimeTaskId,inspected.dispatch);
        if(prepared) bundles.push(prepared);
        continue;
      }
      recovery.ensureReserved(inspected.reservation);
      const prepared=await this.#dispatchReserved(plan,step,inspected.reservation,'resume');
      if(prepared==='deferred'){ deferredEligible+=1; continue; }
      dispatched+=1;
      if(prepared!==null) bundles.push(prepared);
    }
    return {dispatched,deferredEligible};
  }
  async #dispatchReserved(
    plan:PlanDto,
    step:PlanTaskRuntimeDto,
    scheduled:{outcome?:string;taskId:string;assignmentId:string;agentId:string},
    mode:'fresh'|'resume'='fresh',
  ):Promise<TaskReviewBundle|null|'deferred'>{
    if(!step.runtimeTaskId)throw coded('PLAN_RUNTIME_LINK_CONFLICT');
    try{
      const dispatchedResult=await this.options.dispatcher.dispatch({
        reservation:scheduled as never,
        baseRef:this.options.targetBranch,
        turn:{prompt:promptFor(plan,step),protocol:'worker-result'},
      });
      this.options.assignmentRecovery?.persistDispatch(scheduled.assignmentId,dispatchedResult);
      if(mode==='resume'){
        this.options.eventBus.publish({
          eventType:PLAN_ASSIGNMENT_RESUMED,
          payload:{planId:plan.planId,taskId:step.runtimeTaskId,assignmentId:scheduled.assignmentId},
        });
      }
      this.options.eventBus.publish({
        eventType:'PlanTaskDispatched',
        taskId:step.runtimeTaskId,
        assignmentId:scheduled.assignmentId,
        agentId:scheduled.agentId,
        payload:{planId:plan.planId,planVersion:plan.currentVersion,planTaskId:step.planTaskId,runtimeTaskId:step.runtimeTaskId},
      });
      return await this.#preparePersisted(plan.planId,step.runtimeTaskId,dispatchedResult);
    }catch(error){
      this.options.assignmentRecovery?.recordDispatchFailure(scheduled.assignmentId,error);
      return await this.#handleDispatchFailure(scheduled.assignmentId,error);
    }
  }
  async #preparePersisted(
    planId:string,
    runtimeTaskId:string,
    dispatchedResult:Parameters<TaskLifecycleOrchestrator['prepareReview']>[0]['dispatchResult'] | object,
  ):Promise<TaskReviewBundle|null>{
    const dispatch=dispatchedResult as { assignmentId?: string };
    const assignmentId=typeof dispatch.assignmentId==='string' ? dispatch.assignmentId : undefined;
    const stage=assignmentId===undefined
      ? undefined
      : this.options.assignmentRecovery?.durableStage(assignmentId);
    const prepared=stage==='TURN_COMPLETED'
      ? await this.options.taskLifecycle.consumeCompletedTurn({
        dispatchResult:dispatchedResult as never,
        buildTestPlan:this.options.buildTestPlan,
      })
      : await this.options.taskLifecycle.prepareReview({
        dispatchResult:dispatchedResult as never,
        buildTestPlan:this.options.buildTestPlan,
      });
    if(prepared.outcome==='review-ready'){
      if(this.options.reviewTransitions) this.options.reviewTransitions.markPlanReviewPending(runtimeTaskId);
      else this.options.planLifecycle.markReviewPendingByTask(runtimeTaskId,true);
      return prepared.reviewBundle;
    }
    this.options.planLifecycle.refresh(planId);
    return null;
  }
  async #handleDispatchFailure(assignmentId:string,error:unknown):Promise<null|'deferred'>{
    const recovery=this.options.assignmentRecovery;
    recovery?.recordDispatchFailure(assignmentId,error);
    if(!recovery) throw error;
    const inspected=recovery.inspectAssignment(assignmentId);
    if(inspected.outcome==='resumable') return 'deferred';
    if(inspected.outcome==='requeue-safe'){
      const requeued=await recovery.requeue(inspected.assignmentId);
      if(requeued.outcome==='reconciliation-required') throw coded(requeued.code);
      return 'deferred';
    }
    if(inspected.outcome==='review-resumable') return 'deferred';
    if(inspected.outcome==='reconciliation-required') throw coded(inspected.code);
    throw error;
  }
}
function promptFor(plan:PlanDto,step:PlanTaskRuntimeDto):string{return [`Plan ${plan.planId} version ${String(plan.currentVersion)}`,`Task: ${step.title}`,step.description??'',`Acceptance criteria:\n${step.acceptanceCriteria.map((x)=>`- ${x}`).join('\n')}`,'Return the required worker-result protocol.'].join('\n\n');}
function coded(code:string):Error{const e=new Error(code);(e as Error&{code:string}).code=code;return e;}
