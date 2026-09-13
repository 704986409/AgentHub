import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';

import { createReviewEvidence, GitWorktreeManager, type BuildTestEvidencePlan } from '../src/index.js';
import { setMergeHooks } from '../src/workspace/internal/GitWorktreeManagerTestHarness.js';

const execFileAsync=promisify(execFile);const roots:string[]=[];
afterEach(async()=>{for(const root of roots.splice(0))await removeRoot(root);});

describe('Git merge coordination', { timeout: 300_000 }, () => {
  it('serializes actual merges per repository and blocks every same-task operation', async () => {
    const repo=await createRepo('agenthub merge coordination ');const barrier=mergeBarrier();
    const manager=await GitWorktreeManager.open({repositoryRoot:repo});setMergeHooks(manager,{afterPreflight:barrier.hook});const peer=await GitWorktreeManager.open({repositoryRoot:repo});
    const a=await ready(manager,'TASK-A','a.txt');const b=await ready(manager,'TASK-B','b.txt');
    const merging=manager.mergeTaskWorkspace(a.request);await barrier.entered;
    for(const operation of [peer.createWorkspace({taskId:'TASK-A',baseRef:'HEAD'}),peer.removeWorkspace('TASK-A'),peer.captureWorkspaceChanges('TASK-A'),peer.collectBuildTestEvidence('TASK-A',plan()),peer.evaluateMergeGate('TASK-A',a.evidence,a.review),peer.mergeTaskWorkspace(a.request)]){
      await expect(operation).rejects.toMatchObject({code:'GIT_WORKTREE_OPERATION_BUSY'});
    }
    await expect(peer.mergeTaskWorkspace(b.request)).rejects.toMatchObject({code:'GIT_MERGE_REPOSITORY_BUSY'});
    barrier.release();await expect(merging).resolves.toMatchObject({outcome:'merged'});
  });

  it('allows actual merges in different repositories concurrently', async () => {
    const repoA=await createRepo('agenthub merge parallel a ');const repoB=await createRepo('agenthub merge parallel b ');
    const barrier=mergeBarrier();const managerA=await GitWorktreeManager.open({repositoryRoot:repoA});setMergeHooks(managerA,{afterPreflight:barrier.hook});const managerB=await GitWorktreeManager.open({repositoryRoot:repoB});
    const a=await ready(managerA,'TASK-A','a.txt');const b=await ready(managerB,'TASK-B','b.txt');
    const first=managerA.mergeTaskWorkspace(a.request);await barrier.entered;
    await expect(managerB.mergeTaskWorkspace(b.request)).resolves.toMatchObject({outcome:'merged'});
    barrier.release();await expect(first).resolves.toMatchObject({outcome:'merged'});
  });
});
function deferred(){let resolve!:()=>void;const promise=new Promise<void>(r=>{resolve=r;});return{promise,resolve};}
function mergeBarrier(){const entered=deferred();const released=deferred();return{entered:entered.promise,release:()=>released.resolve(),hook:async()=>{entered.resolve();await released.promise;}};}
async function ready(manager:GitWorktreeManager,taskId:string,name:string){const ws=await manager.createWorkspace({taskId,baseRef:'HEAD'});await writeFile(path.join(ws.worktreePath,name),`${name}\n`);await git(ws.worktreePath,['add',name]);await git(ws.worktreePath,['commit','-m',name]);const evidence=await manager.collectBuildTestEvidence(taskId,plan());const review=createReviewEvidence(evidence,{reviewId:`review-${taskId}`,reviewerId:'reviewer',verdict:'ACCEPT',summary:'accepted'});const gateDecision=await manager.evaluateMergeGate(taskId,evidence,review);return{evidence,review,request:{taskId,targetBranch:'main',buildEvidence:evidence,reviewEvidence:review,gateDecision}};}
function plan():BuildTestEvidencePlan{return{commands:[{id:'verify',phase:'test',executable:process.execPath,args:['-e',''],timeoutMs:5000}]};}
async function createRepo(prefix:string){const repo=await mkdtemp(path.join(os.tmpdir(),prefix));roots.push(repo);await git(repo,['init','-b','main']);await git(repo,['config','user.name','AgentHub Test']);await git(repo,['config','user.email','agenthub@example.invalid']);await writeFile(path.join(repo,'initial.txt'),'initial\n');await git(repo,['add','.']);await git(repo,['commit','-m','initial']);return repo;}
async function git(cwd:string,args:readonly string[]){return(await execFileAsync('git',args,{cwd,encoding:'utf8',windowsHide:true})).stdout;}
async function removeRoot(root:string){const resolved=path.resolve(root);const rel=path.relative(path.resolve(os.tmpdir()),resolved);if(!rel||rel==='..'||rel.startsWith(`..${path.sep}`)||path.isAbsolute(rel))throw new Error('unsafe cleanup');await rm(resolved,{recursive:true,force:true,maxRetries:3});}
