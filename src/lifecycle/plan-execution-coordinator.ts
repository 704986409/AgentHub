import type { AgentScheduler } from '../orchestration/AgentScheduler.js';
import type { AssignmentDispatcher } from '../orchestration/AssignmentDispatcher.js';
import type { TaskLifecycleOrchestrator, TaskReviewBundle } from '../orchestration/TaskLifecycleOrchestrator.js';
import type { TaskManager } from '../services/task-manager.js';
import type { BuildTestEvidencePlan } from '../workspace/BuildTestEvidenceCollector.js';
import type { EventBus } from '../events/event-bus.js';
import type { PlanDto, PlanStartInput, PlanState, PlanTaskRuntimeDto, PlanLifecycleService } from './plan-lifecycle.js';

export interface PlanExecutionStartResult { readonly plan:PlanDto; readonly reviewBundles:readonly TaskReviewBundle[] }
export interface PlanExecutionCoordinatorOptions { planLifecycle:PlanLifecycleService; tasks:TaskManager; scheduler:AgentScheduler; dispatcher:AssignmentDispatcher; taskLifecycle:TaskLifecycleOrchestrator; targetBranch:string; buildTestPlan:BuildTestEvidencePlan; eventBus:EventBus; reviewTransitions?: { markPlanReviewPending(runtimeTaskId:string):void } }

export function isResumablePlanState(state:PlanState):boolean {
  return state==='EXECUTING' || state==='REVIEWING';
}

export class PlanExecutionCoordinator {
  readonly #active=new Set<string>();
  readonly #queues=new Map<string,Promise<unknown>>();
  public constructor(private readonly options:PlanExecutionCoordinatorOptions){}
  public async resume(planId:string):Promise<readonly TaskReviewBundle[]>{
    return this.#enqueue(planId,async()=>{
      const plan=this.options.planLifecycle.getPlan(planId);
      if(!plan)throw coded('PLAN_NOT_FOUND');
      if(!isResumablePlanState(plan.state) || plan.startedVersion===null){
        return Object.freeze([]);
      }
      const bundles=await this.#dispatchEligible(plan.planId,this.options.planLifecycle.refresh(plan.planId));
      return Object.freeze(bundles);
    });
  }
  public async resumeStartedPlans():Promise<void>{
    for(const plan of this.options.planLifecycle.listPlans()){
      await this.resume(plan.planId);
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
        return Object.freeze({plan:this.options.planLifecycle.refresh(planId),reviewBundles:Object.freeze(reviewBundles)});
      });
    }finally{this.#active.delete(planId);}
  }
  public async afterReview(runtimeTaskId:string):Promise<readonly TaskReviewBundle[]>{
    this.options.planLifecycle.markReviewPendingByTask(runtimeTaskId,false);
    const plan=this.options.planLifecycle.listPlans().find((p)=>p.tasks.some((t)=>t.runtimeTaskId===runtimeTaskId));
    if(!plan)return [];
    return this.#enqueue(plan.planId,async()=>{
      const bundles=await this.#dispatchEligible(plan.planId,this.options.planLifecycle.refresh(plan.planId));
      return Object.freeze(bundles);
    });
  }
  async #enqueue<T>(planId:string,fn:()=>Promise<T>):Promise<T>{
    const prior=this.#queues.get(planId)??Promise.resolve();
    let release!:()=>void; const gate=new Promise<void>((resolve)=>{release=resolve;});
    const running=prior.then(()=>gate,()=>gate); this.#queues.set(planId,running);
    await prior.then(()=>undefined,()=>undefined);
    try{return await fn();}finally{release(); if(this.#queues.get(planId)===running)this.#queues.delete(planId);}
  }
  async #dispatchEligible(planId:string,plan:PlanDto):Promise<TaskReviewBundle[]>{
    const bundles:TaskReviewBundle[]=[];
    const eligible=this.options.planLifecycle.eligibleTasks(planId);
    for(const step of eligible){
      if(!step.runtimeTaskId)throw coded('PLAN_RUNTIME_LINK_CONFLICT');
      const scheduled=this.options.scheduler.scheduleTask({taskId:step.runtimeTaskId,requirements:{requiredOutputProtocols:['worker-result']}});
      if(scheduled.outcome!=='reserved')continue;
      const dispatched=await this.options.dispatcher.dispatch({reservation:scheduled,baseRef:this.options.targetBranch,turn:{prompt:promptFor(plan,step),protocol:'worker-result'}});
      this.options.eventBus.publish({eventType:'PlanTaskDispatched',taskId:step.runtimeTaskId,assignmentId:scheduled.assignmentId,agentId:scheduled.agentId,payload:{planId,planVersion:plan.currentVersion,planTaskId:step.planTaskId,runtimeTaskId:step.runtimeTaskId}});
      const prepared=await this.options.taskLifecycle.prepareReview({dispatchResult:dispatched,buildTestPlan:this.options.buildTestPlan});
      if(prepared.outcome==='review-ready'){
        if(this.options.reviewTransitions) this.options.reviewTransitions.markPlanReviewPending(step.runtimeTaskId);
        else this.options.planLifecycle.markReviewPendingByTask(step.runtimeTaskId,true);
        bundles.push(prepared.reviewBundle);
      }else{
        this.options.planLifecycle.refresh(planId);
      }
    }
    return bundles;
  }
}
function promptFor(plan:PlanDto,step:PlanTaskRuntimeDto):string{return [`Plan ${plan.planId} version ${String(plan.currentVersion)}`,`Task: ${step.title}`,step.description??'',`Acceptance criteria:\n${step.acceptanceCriteria.map((x)=>`- ${x}`).join('\n')}`,'Return the required worker-result protocol.'].join('\n\n');}
function coded(code:string):Error{const e=new Error(code);(e as Error&{code:string}).code=code;return e;}
