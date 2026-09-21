import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

import type { AgentHubApplication } from '../application/index.js';
import type { Database } from '../database/index.js';
import { agentDeleteDto, agentDto, assignmentDto, eventDto, lifecycleDto, projectDto, providerDto, reviewReadyDto,
  snapshotCreateAgent, snapshotCreateTask, snapshotEmptyObject, snapshotExecuteCommand,
  snapshotReviewDecision, snapshotUpdateAgent, taskDto, snapshotCreateIntake, snapshotCreatePlan,
  snapshotCreatePlanRevision, snapshotPlanDecision, snapshotPlanStart } from './ApiDtos.js';
import { apiError, normalizeApiError } from './ApiErrors.js';
import { IdempotencyStore, requestFingerprint } from './IdempotencyStore.js';
import { RealtimeHub } from './RealtimeHub.js';
import { ReviewHandleStore } from './ReviewHandleStore.js';

export interface AgentHubHttpServerOptions {
  readonly application: AgentHubApplication;
  readonly host?: string;
  readonly port?: number;
  readonly maxBodyBytes?: number;
  readonly database?: Database;
}
export interface AgentHubServerAddress { readonly host: string; readonly port: number }

export class AgentHubHttpServer {
  readonly #app: AgentHubApplication;
  readonly #host: string;
  readonly #port: number;
  readonly #maxBodyBytes: number;
  readonly #http: Server;
  readonly #realtime: RealtimeHub;
  readonly #idempotency = new IdempotencyStore();
  readonly #reviews: ReviewHandleStore;
  #address: AgentHubServerAddress | undefined;
  #stopped = false;

  public constructor(options: AgentHubHttpServerOptions) {
    this.#host = options.host ?? '127.0.0.1';
    this.#port = options.port ?? 3210;
    if (this.#host !== '127.0.0.1' || !Number.isSafeInteger(this.#port) || this.#port < 0 || this.#port > 65535) {
      throw apiError('AGENTHUB_API_INVALID_REQUEST', 400);
    }
    this.#app = options.application; this.#maxBodyBytes = options.maxBodyBytes ?? 1024 * 1024;
    this.#reviews = options.application.reviews ?? new ReviewHandleStore(options.database);
    this.#realtime = new RealtimeHub({ eventBus: this.#app.eventBus });
    this.#http = createServer((request, response) => { void this.#handle(request, response); });
    this.#http.on('upgrade', (request, socket, head) => this.#realtime.handleUpgrade(request, socket, head));
  }

  public get address(): AgentHubServerAddress | undefined { return this.#address; }
  public async start(): Promise<AgentHubServerAddress> {
    if (this.#stopped || this.#address !== undefined || this.#http.listening) throw apiError('AGENTHUB_API_CONFLICT', 409);
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => reject(error);
      this.#http.once('error', onError);
      this.#http.listen(this.#port, this.#host, () => { this.#http.off('error', onError); resolve(); });
    });
    const value = this.#http.address();
    if (value === null || typeof value === 'string') throw apiError('AGENTHUB_API_INTERNAL', 500);
    this.#address = Object.freeze({ host: this.#host, port: value.port }); return this.#address;
  }
  public async stop(): Promise<void> {
    this.#stopped = true;
    this.#realtime.stop(); this.#idempotency.clear(); this.#address = undefined;
    if (!this.#http.listening) return;
    await new Promise<void>((resolve, reject) => this.#http.close((error) => error === undefined ? resolve() : reject(error)));
  }

  async #handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const requestId = randomUUID();
    try {
      const method = request.method ?? '';
      const url = new URL(request.url ?? '/', 'http://localhost');
      if (url.pathname.length > 8192) throw apiError('AGENTHUB_API_INVALID_REQUEST', 400);
      let result: { status: number; data: unknown };
      if (method === 'GET') result = await this.#get(url);
      else if (method === 'POST') result = await this.#post(url.pathname, request);
      else if (method === 'PUT') result = await this.#put(url.pathname, request);
      else if (method === 'DELETE') result = await this.#delete(url.pathname, request);
      else throw apiError('AGENTHUB_API_METHOD_NOT_ALLOWED', 405);
      this.#write(response, result.status, { ok: true, data: result.data, requestId });
    } catch (error) {
      const normalized = normalizeApiError(error);
      this.#write(response, normalized.status, { ok: false, error: { code: normalized.code,
        message: normalized.message }, requestId });
    }
  }

  async #get(url: URL): Promise<{ status: number; data: unknown }> {
    noUnknownQuery(url, url.pathname === '/api/v1/events'
      ? ['limit', 'after', 'projectId', 'agentId', 'taskId', 'assignmentId', 'eventType'] : []);
    const path = url.pathname;
    if (path === '/api/v1/health') return ok({ status: 'ok', version: '0.7.3K' });
    if (path === '/api/v1/providers') return ok(await this.#providers());
    if (path === '/api/v1/state') {
      this.#app.reviewTransitions?.assertReady();
      return ok({ projects: this.#app.projects.list().map(projectDto),
      agents: this.#app.agents.listAgents().map(agentDto), tasks: this.#app.tasks.listTasks().map(taskDto),
      assignments: this.#app.assignmentQueries.list().map(assignmentDto),
      intakes: this.#app.planLifecycle?.listIntakes() ?? [], plans: this.#app.planLifecycle?.listPlans() ?? [],
      planTasks: (this.#app.planLifecycle?.listPlans() ?? []).flatMap((p) => p.tasks),
      planDependencies: (this.#app.planLifecycle?.listPlans() ?? []).flatMap((p) => p.dependencies) });
    }
    if (path === '/api/v1/projects') return ok(this.#app.projects.list().map(projectDto));
    if (path === '/api/v1/agents') return ok(this.#app.agents.listAgents().map(agentDto));
    if (path === '/api/v1/tasks') return ok(this.#app.tasks.listTasks().map(taskDto));
    if (path === '/api/v1/assignments') return ok(this.#app.assignmentQueries.list().map(assignmentDto));
    if (path === '/api/v1/events') return ok(this.#events(url));
    if (path === '/api/v1/intakes') return ok(this.#app.planLifecycle?.listIntakes() ?? []);
    if (path === '/api/v1/plans') return ok(this.#app.planLifecycle?.listPlans() ?? []);
    if (path === '/api/v1/reviews') {
      this.#app.reviewTransitions?.assertReady();
      return ok(this.#reviews.listPublic(this.#app.planLifecycle?.listPlans() ?? []));
    }
    const planMatch = /^\/api\/v1\/plans\/([^/]+)$/u.exec(path);
    if (planMatch !== null) { const plan = this.#app.planLifecycle?.getPlan(decodeURIComponent(planMatch[1] ?? '')); if (!plan) throw apiError('AGENTHUB_API_NOT_FOUND', 404); return ok(plan); }
    const match = /^\/api\/v1\/(agents|tasks|assignments)\/([^/]+)$/u.exec(path);
    if (match !== null) {
      const id = decodeURIComponent(match[2] ?? '');
      const value = match[1] === 'agents' ? this.#app.agents.getAgent(id) : match[1] === 'tasks'
        ? this.#app.tasks.getTask(id) : this.#app.assignmentQueries.findById(id);
      if (value === null) throw apiError('AGENTHUB_API_NOT_FOUND', 404);
      return ok(match[1] === 'agents' ? agentDto(value as never) : match[1] === 'tasks'
        ? taskDto(value as never) : assignmentDto(value as never));
    }
    throw apiError('AGENTHUB_API_NOT_FOUND', 404);
  }

  async #providers(): Promise<readonly unknown[]> {
    if (this.#app.providerCatalog !== undefined) {
      const catalog = await this.#app.providerCatalog.getCatalog();
      return catalog.map(providerDto);
    }
    return [];
  }

  async #post(path: string, request: IncomingMessage): Promise<{ status: number; data: unknown }> {
    const body = await readJson(request, this.#maxBodyBytes);
    if (path === '/api/v1/agents') {
      const input = snapshotCreateAgent(body);
      return this.#mutate(request, 'POST', path, input, () =>
        Promise.resolve(agentDto(this.#app.agentManagement.createAgent(input))), 201);
    }
    const enable = /^\/api\/v1\/agents\/([^/]+)\/enable$/u.exec(path);
    const disable = /^\/api\/v1\/agents\/([^/]+)\/disable$/u.exec(path);
    if (enable !== null) {
      snapshotEmptyObject(body);
      const agentId = decodeURIComponent(enable[1] ?? '');
      return this.#mutate(request, 'POST', path, {}, () =>
        Promise.resolve(agentDto(this.#app.agentManagement.enableAgent(agentId))));
    }
    if (disable !== null) {
      snapshotEmptyObject(body);
      const agentId = decodeURIComponent(disable[1] ?? '');
      return this.#mutate(request, 'POST', path, {}, () =>
        Promise.resolve(agentDto(this.#app.agentManagement.disableAgent(agentId))));
    }
    if (path === '/api/v1/tasks') {
      const input = snapshotCreateTask(body);
      return this.#mutate(request, 'POST', path, body, () => {
        if (this.#app.projects.findById(input.projectId) === null) throw apiError('AGENTHUB_API_NOT_FOUND', 404);
        return Promise.resolve(taskDto(this.#app.tasks.createTask(input)));
      }, 201);
    }
    if (path === '/api/v1/intakes') {
      const lifecycle=this.#app.planLifecycle; if (!lifecycle) throw apiError('AGENTHUB_API_NOT_FOUND', 404);
      const input=snapshotCreateIntake(body); return this.#mutate(request, 'POST', path, input, () => Promise.resolve(lifecycle.createIntake(input)), 201);
    }
    if (path === '/api/v1/plans') {
      const lifecycle=this.#app.planLifecycle; if (!lifecycle) throw apiError('AGENTHUB_API_NOT_FOUND', 404);
      const input=snapshotCreatePlan(body); return this.#mutate(request, 'POST', path, input, () => Promise.resolve(lifecycle.createPlan(input)), 201);
    }
    const revision = /^\/api\/v1\/plans\/([^/]+)\/revisions$/u.exec(path);
    if (revision !== null) { const lifecycle=this.#app.planLifecycle;if(!lifecycle)throw apiError('AGENTHUB_API_NOT_FOUND',404);const planId=decodeURIComponent(revision[1]??'');const input=snapshotCreatePlanRevision(body);return this.#mutate(request,'POST',path,input,()=>Promise.resolve(lifecycle.createRevision(planId,input)),201); }
    const decision = /^\/api\/v1\/plans\/([^/]+)\/(approve|request-changes|reject)$/u.exec(path);
    if (decision !== null) {
      const lifecycle=this.#app.planLifecycle; if (!lifecycle) throw apiError('AGENTHUB_API_NOT_FOUND', 404);
      const planId = decodeURIComponent(decision[1] ?? ''); const action = decision[2] === 'approve' ? 'APPROVE' : decision[2] === 'reject' ? 'REJECT' : 'REQUEST_CHANGES';
      const input=snapshotPlanDecision(body); return this.#mutate(request, 'POST', path, input, () => Promise.resolve(lifecycle.decide(planId,action,input)), 200);
    }
    const start = /^\/api\/v1\/plans\/([^/]+)\/start$/u.exec(path);
    if (start !== null) {
      const execution=this.#app.planExecution;if(!execution)throw apiError('AGENTHUB_API_NOT_FOUND',404);this.#app.reviewTransitions?.assertReady();const planId=decodeURIComponent(start[1]??'');const input=snapshotPlanStart(body);return this.#mutate(request,'POST',path,input,async()=>{const result=await execution.start(planId,input);if(this.#app.reviewTransitions===undefined){for(const bundle of result.reviewBundles)this.#reviews.register(bundle);}return result.plan;},200);
    }
    const execute = /^\/api\/v1\/tasks\/([^/]+)\/execute$/u.exec(path);
    const review = /^\/api\/v1\/reviews\/([^/]+)\/decision$/u.exec(path);
    if (execute !== null) {
      const taskId = decodeURIComponent(execute[1] ?? ''); const input = snapshotExecuteCommand(body);
      return this.#mutate(request, 'POST', path, body, async () => {
        if (this.#app.tasks.getTask(taskId) === null) throw apiError('AGENTHUB_API_NOT_FOUND', 404);
        const reservation = this.#app.scheduler.scheduleTask({
          taskId,
          requirements: { requiredOutputProtocols: ['worker-result'] },
        });
        if (reservation.outcome !== 'reserved') throw apiError('AGENTHUB_API_CONFLICT', 409);
        const dispatched = await this.#app.dispatcher.dispatch({ reservation, baseRef: input.baseRef,
          turn: { prompt: input.prompt, protocol: 'worker-result' } });
        const prepared = await this.#app.lifecycle.prepareReview({ dispatchResult: dispatched,
          buildTestPlan: this.#app.buildTestPlan });
        if (prepared.outcome === 'review-ready' && this.#app.reviewTransitions === undefined) {
          this.#reviews.register(prepared.reviewBundle);
        }
        return prepared.outcome === 'review-ready' ? reviewReadyDto(prepared.reviewBundle) : lifecycleDto(prepared);
      });
    }
    if (review !== null) {
      const reviewHandle = decodeURIComponent(review[1] ?? ''); const input = snapshotReviewDecision(body);
      return this.#mutate(request, 'POST', path, body, async () => {
        this.#app.reviewTransitions?.assertReady();
        this.#reviews.claim(reviewHandle);
        try {
          const bundle = this.#reviews.resolve(reviewHandle);
          const result = await this.#app.lifecycle.applyReview({ reviewBundle: bundle, decision: input.decision,
            buildTestPlan: this.#app.buildTestPlan, targetBranch: this.#app.targetBranch,
            ...(this.#app.mergePolicy === undefined ? {} : { mergePolicy: this.#app.mergePolicy }),
            allowNoChangeCompletion: input.allowNoChangeCompletion });
          if (result.outcome === 'review-ready') {
            if (this.#app.reviewTransitions === undefined) {
              this.#reviews.expire(reviewHandle); this.#reviews.register(result.reviewBundle);
            }
          } else if (result.outcome !== 'merge-denied') {
            if (this.#app.reviewTransitions !== undefined) this.#app.reviewTransitions.expireAfterTerminalDecision(reviewHandle);
            else this.#reviews.expire(reviewHandle);
          }
          if (result.outcome !== 'review-ready' && result.outcome !== 'merge-denied') {
            const next = await this.#app.planExecution?.afterReview(bundle.taskId) ?? [];
            if (this.#app.reviewTransitions === undefined) {
              for (const bundleNext of next) this.#reviews.register(bundleNext);
            }
          }
          return lifecycleDto(result);
        } finally { this.#reviews.release(reviewHandle); }
      });
    }
    throw apiError('AGENTHUB_API_NOT_FOUND', 404);
  }

  async #put(path: string, request: IncomingMessage): Promise<{ status: number; data: unknown }> {
    const match = /^\/api\/v1\/agents\/([^/]+)$/u.exec(path);
    if (match === null) throw apiError('AGENTHUB_API_NOT_FOUND', 404);
    const body = await readJson(request, this.#maxBodyBytes);
    const input = snapshotUpdateAgent(body);
    const agentId = decodeURIComponent(match[1] ?? '');
    return this.#mutate(request, 'PUT', path, input, () =>
      Promise.resolve(agentDto(this.#app.agentManagement.updateAgent(agentId, input))));
  }

  async #delete(path: string, request: IncomingMessage): Promise<{ status: number; data: unknown }> {
    const match = /^\/api\/v1\/agents\/([^/]+)$/u.exec(path);
    if (match === null) throw apiError('AGENTHUB_API_NOT_FOUND', 404);
    await assertNoBody(request);
    const agentId = decodeURIComponent(match[1] ?? '');
    return this.#mutate(request, 'DELETE', path, {}, () =>
      Promise.resolve(agentDeleteDto(this.#app.agentManagement.deleteAgent(agentId))));
  }

  async #mutate(request: IncomingMessage, method: string, path: string, body: unknown,
    operation: () => Promise<unknown>, status = 200): Promise<{ status: number; data: unknown }> {
    const key = request.headers['idempotency-key'];
    if (typeof key !== 'string' || key.length === 0 || key.length > 256) throw apiError('AGENTHUB_API_IDEMPOTENCY_KEY_REQUIRED', 400);
    const data = await this.#idempotency.execute(key, requestFingerprint(method, path, body), operation);
    return { status, data };
  }

  #events(url: URL): unknown[] {
    const rawLimit = url.searchParams.get('limit'); const limit = rawLimit === null ? 100 : Number(rawLimit);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) throw apiError('AGENTHUB_API_INVALID_REQUEST', 400);
    const filters = ['projectId', 'agentId', 'taskId', 'assignmentId', 'eventType'] as const;
    let events = this.#app.events.list();
    for (const key of filters) { const value = url.searchParams.get(key); if (value !== null) events = events.filter((event) => event[key] === value); }
    const after = url.searchParams.get('after');
    if (after !== null) { const index = events.findIndex((event) => event.eventId === after); events = index < 0 ? [] : events.slice(index + 1); }
    return events.slice(0, limit).map(eventDto);
  }

  #write(response: ServerResponse, status: number, body: unknown): void {
    const encoded = JSON.stringify(body);
    response.writeHead(status, { 'content-type': 'application/json; charset=utf-8',
      'content-length': Buffer.byteLength(encoded), 'cache-control': 'no-store' }); response.end(encoded);
  }
}

function ok(data: unknown) { return { status: 200, data }; }
async function assertNoBody(request: IncomingMessage): Promise<void> {
  const length = request.headers['content-length'];
  if (length !== undefined && length !== '0') throw apiError('AGENTHUB_API_INVALID_REQUEST', 400);
  for await (const chunk of request) {
    if (Buffer.from(chunk as Uint8Array).length > 0) throw apiError('AGENTHUB_API_INVALID_REQUEST', 400);
  }
}
function noUnknownQuery(url: URL, allowed: readonly string[]): void {
  for (const key of url.searchParams.keys()) if (!allowed.includes(key) || url.searchParams.getAll(key).length !== 1) {
    throw apiError('AGENTHUB_API_INVALID_REQUEST', 400);
  }
}
async function readJson(request: IncomingMessage, maxBytes: number): Promise<unknown> {
  if (!(request.headers['content-type'] ?? '').toLowerCase().startsWith('application/json')) {
    throw apiError('AGENTHUB_API_CONTENT_TYPE_REQUIRED', 415);
  }
  const chunks: Buffer[] = []; let bytes = 0;
  for await (const chunk of request) { const value = Buffer.from(chunk as Uint8Array); bytes += value.length;
    if (bytes > maxBytes) throw apiError('AGENTHUB_API_BODY_TOO_LARGE', 413); chunks.push(value); }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown; }
  catch { throw apiError('AGENTHUB_API_INVALID_REQUEST', 400); }
}
