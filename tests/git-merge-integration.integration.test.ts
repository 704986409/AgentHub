import { execFile } from 'node:child_process';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';

import { createReviewEvidence, GitWorktreeManager, type BuildTestEvidencePlan } from '../src/index.js';

const execFileAsync = promisify(execFile); const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await removeRoot(root); });

describe('Git merge real integration and V0.5 acceptance', { timeout: 120_000 }, () => {
  it('runs the full evidence/review/gate/merge chain and preserves task audit state with hooks disabled', async () => {
    const f = await fixture('agenthub merge acceptance ');
    const sentinel = path.join(f.repo, 'hook-ran.txt');
    const hook = path.join(f.repo, '.git', 'hooks', process.platform === 'win32' ? 'post-merge' : 'post-merge');
    await writeFile(hook, `#!/bin/sh\necho bad > "${sentinel.replaceAll('\\', '/')}"\n`, 'utf8');
    if (process.platform !== 'win32') await execFileAsync('chmod', ['+x', hook]);
    const baseMarkerBefore = (await git(f.repo, ['rev-parse', 'refs/agenthub/bases/TASK-A'])).trim();
    const result = await f.manager.mergeTaskWorkspace(f.request);
    expect(result.outcome).toBe('merged');
    expect(await status(f.repo)).toBe('');
    expect((await git(f.repo, ['rev-list', '--parents', '-n', '1', 'HEAD'])).trim().split(/\s+/u)).toHaveLength(3);
    expect((await git(f.repo, ['rev-parse', f.workspace.branchName])).trim()).toBe(f.taskHead);
    expect((await git(f.workspace.worktreePath, ['rev-parse', 'HEAD'])).trim()).toBe(f.taskHead);
    expect((await git(f.repo, ['rev-parse', 'refs/agenthub/bases/TASK-A'])).trim()).toBe(baseMarkerBefore);
    await expect(access(sentinel)).rejects.toBeDefined();
  });

  it('merges a nonconflicting independently advanced target as a two-parent merge commit', async () => {
    const f = await fixture('agenthub merge advanced ');
    await writeFile(path.join(f.repo, 'target.txt'), 'target\n'); await git(f.repo, ['add', 'target.txt']); await git(f.repo, ['commit', '-m', 'target']);
    const targetBefore = (await git(f.repo, ['rev-parse', 'HEAD'])).trim();
    const result = await f.manager.mergeTaskWorkspace(f.request);
    expect(result).toMatchObject({ outcome: 'merged', targetHeadBefore: targetBefore });
    const parents = (await git(f.repo, ['rev-list', '--parents', '-n', '1', 'HEAD'])).trim().split(/\s+/u);
    expect(parents.slice(1)).toEqual([targetBefore, f.taskHead]);
  });

  it('preflights conflicts without mutating primary merge state or the task', async () => {
    const f = await fixture('agenthub merge conflict ', 'shared.txt', 'task\n');
    await writeFile(path.join(f.repo, 'shared.txt'), 'target\n'); await git(f.repo, ['add', 'shared.txt']); await git(f.repo, ['commit', '-m', 'target conflict']);
    const targetBefore = (await git(f.repo, ['rev-parse', 'HEAD'])).trim();
    await expect(f.manager.mergeTaskWorkspace(f.request)).rejects.toMatchObject({ code: 'GIT_MERGE_CONFLICT' });
    expect((await git(f.repo, ['rev-parse', 'HEAD'])).trim()).toBe(targetBefore);
    expect(await status(f.repo)).toBe('');
    expect(await gitExit(f.repo, ['rev-parse', '-q', '--verify', 'MERGE_HEAD'])).toBe(1);
    expect((await git(f.workspace.worktreePath, ['rev-parse', 'HEAD'])).trim()).toBe(f.taskHead);
  });

  it('blocks an ignored primary path that would become tracked', async () => {
    const f = await fixture('agenthub merge collision ', 'generated.txt', 'tracked task\n');
    await writeFile(path.join(f.repo, '.gitignore'), 'generated.txt\n'); await git(f.repo, ['add', '.gitignore']); await git(f.repo, ['commit', '-m', 'ignore generated']);
    await writeFile(path.join(f.repo, 'generated.txt'), 'local ignored\n');
    await expect(f.manager.mergeTaskWorkspace(f.request)).rejects.toMatchObject({ code: 'GIT_MERGE_PRIMARY_COLLISION' });
    expect(await readFile(path.join(f.repo, 'generated.txt'), 'utf8')).toBe('local ignored\n');
  });
});

async function fixture(prefix: string, taskPath='task.txt', content='task\n') {
  const repo=await createRepo(prefix); const manager=await GitWorktreeManager.open({repositoryRoot:repo});
  const workspace=await manager.createWorkspace({taskId:'TASK-A',baseRef:'HEAD'});
  await writeFile(path.join(workspace.worktreePath,taskPath),content);
  const trackedHook=path.join(workspace.worktreePath,'.agenthub-disabled-hooks','post-merge');
  await mkdir(path.dirname(trackedHook), { recursive: true });
  await writeFile(trackedHook,'#!/bin/sh\nexit 87\n');
  await git(workspace.worktreePath,['add',taskPath,'.agenthub-disabled-hooks/post-merge']);
  await git(workspace.worktreePath,['update-index','--chmod=+x','.agenthub-disabled-hooks/post-merge']);
  await git(workspace.worktreePath,['commit','-m','task']);
  const evidence=await manager.collectBuildTestEvidence('TASK-A',plan()); const review=createReviewEvidence(evidence,{reviewId:'review',reviewerId:'reviewer',verdict:'ACCEPT',summary:'accepted'});
  const gateDecision=await manager.evaluateMergeGate('TASK-A',evidence,review,{requiredPhases:['test'],requiredCommandIds:['verify']});
  return {repo,manager,workspace,evidence,review,gateDecision,taskHead:evidence.headCommit,request:{taskId:'TASK-A',targetBranch:'main',buildEvidence:evidence,reviewEvidence:review,gateDecision,gatePolicy:{requiredPhases:['test'] as const,requiredCommandIds:['verify']}}};
}
function plan():BuildTestEvidencePlan{return{commands:[{id:'verify',phase:'test',executable:process.execPath,args:['-e',''],timeoutMs:5000}]};}
async function createRepo(prefix:string){const repo=await mkdtemp(path.join(os.tmpdir(),prefix));roots.push(repo);await git(repo,['init','-b','main']);await git(repo,['config','user.name','AgentHub Test']);await git(repo,['config','user.email','agenthub@example.invalid']);await writeFile(path.join(repo,'initial.txt'),'initial\n');await writeFile(path.join(repo,'shared.txt'),'base\n');await git(repo,['add','.']);await git(repo,['commit','-m','initial']);return repo;}
async function git(cwd:string,args:readonly string[]){return(await execFileAsync('git',args,{cwd,encoding:'utf8',windowsHide:true})).stdout;}
async function gitExit(cwd:string,args:readonly string[]){try{await git(cwd,args);return 0;}catch(e){return (e as {code?:number}).code??-1;}}
async function status(cwd:string){return git(cwd,['status','--porcelain=v1','--untracked-files=all']);}
async function removeRoot(root:string){const resolved=path.resolve(root);const rel=path.relative(path.resolve(os.tmpdir()),resolved);if(!rel||rel==='..'||rel.startsWith(`..${path.sep}`)||path.isAbsolute(rel))throw new Error('unsafe cleanup');await rm(resolved,{recursive:true,force:true,maxRetries:3});}
