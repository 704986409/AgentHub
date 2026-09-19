import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { Database } from '../src/database/index.js';
import { EventBus } from '../src/events/index.js';
import { TaskComplexity, TaskRisk } from '../src/core/types.js';
import { PlanLifecycleService } from '../src/lifecycle/plan-lifecycle.js';

const dirs:string[]=[];
afterEach(()=>{for(const d of dirs.splice(0))rmSync(d,{recursive:true,force:true});});
const projects={findById:(id:string)=>id==='p'?{id}:null}; const agents={getAgent:(id:string)=>id==='lead'?{id,projectId:'p'}:null}; const tasks={getTask:()=>null};
const step={clientId:'a',parentClientId:null,title:'A',description:null,acceptanceCriteria:[],requiredCapabilities:[],requiredSpecialties:[],complexity:TaskComplexity.SIMPLE,risk:TaskRisk.LOW};

describe('0.7.3A lifecycle persistence validation',()=>{
  it('restores a valid schemaVersion 1 snapshot',()=>{
    const dir=mkdtempSync(join(tmpdir(),'agenthub-plan-'));dirs.push(dir);const path=join(dir,'db.sqlite');let db=new Database(path);db.initialize();
    const first=new PlanLifecycleService(projects as never,agents as never,new EventBus(),db,tasks as never);const intake=first.createIntake({projectId:'p',createdBy:'human',goal:'goal',leadAgentId:'lead'});const plan=first.createPlan({intakeId:intake.intakeId,leadAgentId:'lead',summary:'summary',tasks:[step],dependencies:[]});db.close();
    db=new Database(path);db.initialize();const restored=new PlanLifecycleService(projects as never,agents as never,new EventBus(),db,tasks as never);expect(restored.getPlan(plan.planId)).toMatchObject({currentVersion:1,state:'WAITING_APPROVAL'});db.close();
  });
  it('rejects syntactically valid forged terminal state fail-closed',()=>{
    const dir=mkdtempSync(join(tmpdir(),'agenthub-plan-'));dirs.push(dir);const path=join(dir,'db.sqlite');const db=new Database(path);db.initialize();const first=new PlanLifecycleService(projects as never,agents as never,new EventBus(),db,tasks as never);const intake=first.createIntake({projectId:'p',createdBy:'human',goal:'goal',leadAgentId:'lead'});first.createPlan({intakeId:intake.intakeId,leadAgentId:'lead',summary:'summary',tasks:[step],dependencies:[]});const row=db.connection.prepare('SELECT value FROM settings WHERE key=?').get('public_lifecycle_snapshot') as {value:string};const forged=JSON.parse(row.value) as {plans:Array<{state:string}>};const plan=forged.plans[0];if(!plan)throw new Error('fixture');plan.state='COMPLETED';db.connection.prepare('UPDATE settings SET value=? WHERE key=?').run(JSON.stringify(forged),'public_lifecycle_snapshot');const restored=new PlanLifecycleService(projects as never,agents as never,new EventBus(),db,tasks as never);expect(restored.listPlans()).toEqual([]);db.close();
  });
});
