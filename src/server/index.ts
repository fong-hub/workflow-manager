import { access } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import cors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import Fastify from 'fastify';
import { z } from 'zod';

import { loadConfig } from '../core/config.js';
import { RepositoryRegistry } from '../core/registry.js';
import { ReleaseManager } from '../core/release.js';
import { RuntimeManager, RuntimePortUnavailableError } from '../core/runtime.js';
import { WorkflowStore } from '../core/store.js';
import { WorkflowService } from '../core/workflows.js';

const config = await loadConfig();
const app = Fastify({ logger: true });
await app.register(cors, { origin: true });

const store = new WorkflowStore(config.server.dataDir);
await store.initialize(config.workspaces);
const registry = new RepositoryRegistry(store);
const runtimes = new RuntimeManager(config);
await runtimes.initialize();
const workflows = new WorkflowService(config, store, runtimes);
const releases = new ReleaseManager(config, store);

app.get('/api/health', async () => ({
  status: 'ok',
  configPath: config.configPath,
  workspaces: config.workspaces.length,
}));

app.get('/api/config', async () => ({
  server: config.server,
  runtime: config.runtime,
  repositoryCount: store.listRepositories().length,
  groupCount: store.listGroups().length,
}));

app.get('/api/repositories', async (request) => {
  const query = z.object({ q: z.string().optional() }).parse(request.query);
  return { repositories: registry.list(query.q ?? '') };
});

app.post('/api/repositories', async (request, reply) => {
  const body = z
    .object({
      path: z.string().min(1),
      label: z.string().min(1).optional(),
      role: z.enum(['application', 'service', 'contract', 'other']).optional(),
      remote: z.string().min(1).optional(),
    })
    .parse(request.body);
  const repository = await registry.register({
    path: body.path,
    ...(body.label ? { label: body.label } : {}),
    ...(body.role ? { role: body.role } : {}),
    ...(body.remote ? { remote: body.remote } : {}),
  });
  workflows.invalidate();
  return reply.code(201).send({ repository });
});

app.patch('/api/repositories/:repositoryId', async (request) => {
  const params = z.object({ repositoryId: z.string() }).parse(request.params);
  const body = z
    .object({
      release: z
        .object({
          order: z.number().int(),
          defaultTargetBranch: z.string().min(1),
          allowedTargetBranches: z.array(z.string().min(1)).min(1),
          strategy: z.enum(['fast-forward', 'merge', 'cherry-pick']),
        })
        .optional(),
    })
    .parse(request.body);
  const repository = await store.updateRepository(params.repositoryId, {
    ...(body.release ? { release: body.release } : {}),
  });
  workflows.invalidate();
  return { repository };
});

app.delete('/api/repositories/:repositoryId', async (request, reply) => {
  const params = z.object({ repositoryId: z.string() }).parse(request.params);
  await registry.remove(params.repositoryId);
  workflows.invalidate();
  return reply.code(204).send();
});

app.get('/api/groups', async () => ({ groups: store.listGroups() }));

app.post('/api/groups', async (request, reply) => {
  const body = z
    .object({
      label: z.string().min(1),
      repositoryIds: z.array(z.string()).optional(),
    })
    .parse(request.body);
  const group = await store.addGroup({
    label: body.label,
    ...(body.repositoryIds ? { repositoryIds: body.repositoryIds } : {}),
  });
  workflows.invalidate();
  return reply.code(201).send({ group });
});

app.patch('/api/groups/:groupId', async (request) => {
  const params = z.object({ groupId: z.string() }).parse(request.params);
  const body = z
    .object({
      label: z.string().min(1).optional(),
      repositoryIds: z.array(z.string()).optional(),
      matching: z
        .object({
          stripBranchPrefixes: z.array(z.string()),
          includeBranchPatterns: z.array(z.string()),
        })
        .optional(),
    })
    .parse(request.body);
  const group = await store.updateGroup(params.groupId, {
    ...(body.label ? { label: body.label } : {}),
    ...(body.repositoryIds ? { repositoryIds: body.repositoryIds } : {}),
    ...(body.matching ? { matching: body.matching } : {}),
  });
  workflows.invalidate();
  return { group };
});

app.delete('/api/groups/:groupId', async (request, reply) => {
  const params = z.object({ groupId: z.string() }).parse(request.params);
  await store.removeGroup(params.groupId);
  workflows.invalidate();
  return reply.code(204).send();
});

app.get('/api/workflows', async (request) => {
  const query = z.object({ refresh: z.enum(['true', 'false']).optional() }).parse(request.query);
  return { workflows: await workflows.list(query.refresh === 'true') };
});

app.get('/api/workflows/:workflowId', async (request, reply) => {
  const params = z.object({ workflowId: z.string() }).parse(request.params);
  const workflow = await workflows.get(params.workflowId);
  if (!workflow) return reply.code(404).send({ error: 'Workflow not found' });
  return { workflow };
});

app.patch('/api/workflows/:workflowId', async (request) => {
  const params = z.object({ workflowId: z.string() }).parse(request.params);
  const body = z.object({ title: z.string().min(1) }).parse(request.body);
  return { workflow: await workflows.rename(params.workflowId, body.title) };
});

app.post('/api/workflows/:workflowId/accept', async (request) => {
  const params = z.object({ workflowId: z.string() }).parse(request.params);
  const body = z.object({ note: z.string().optional() }).parse(request.body ?? {});
  return { workflow: await workflows.accept(params.workflowId, body.note) };
});

const repositoryRuntimeParams = z.object({
  workflowId: z.string(),
  repositoryId: z.string(),
});

app.post(
  '/api/workflows/:workflowId/repositories/:repositoryId/runtime/start',
  async (request, reply) => {
    const params = repositoryRuntimeParams.parse(request.params);
    const body = z
      .object({ port: z.number().int().min(1).max(65_535).optional() })
      .parse(request.body ?? {});
    const workflow = await workflows.get(params.workflowId);
    if (!workflow) return reply.code(404).send({ error: 'Workflow not found' });
    return reply.code(202).send({
      runtime: await runtimes.start(
        workflow,
        params.repositoryId,
        body.port === undefined ? {} : { port: body.port }
      ),
    });
  }
);

app.post(
  '/api/workflows/:workflowId/repositories/:repositoryId/runtime/stop',
  async (request) => {
    const params = repositoryRuntimeParams.parse(request.params);
    return {
      runtime: await runtimes.stop(params.workflowId, params.repositoryId),
    };
  }
);

app.get(
  '/api/workflows/:workflowId/repositories/:repositoryId/runtime/log',
  async (request) => {
    const params = repositoryRuntimeParams.parse(request.params);
    return {
      log: await runtimes.readLog(params.workflowId, params.repositoryId),
    };
  }
);

const releaseBodySchema = z.object({
  targets: z
    .array(
      z.object({
        repositoryId: z.string(),
        targetBranch: z.string(),
        strategy: z.enum(['fast-forward', 'merge', 'cherry-pick']).optional(),
      })
    )
    .default([]),
});

app.post('/api/workflows/:workflowId/release/preflight', async (request, reply) => {
  const params = z.object({ workflowId: z.string() }).parse(request.params);
  const body = releaseBodySchema.parse(request.body ?? {});
  const workflow = await workflows.get(params.workflowId);
  if (!workflow) return reply.code(404).send({ error: 'Workflow not found' });
  const targets = body.targets.map((target) => ({
    repositoryId: target.repositoryId,
    targetBranch: target.targetBranch,
    ...(target.strategy ? { strategy: target.strategy } : {}),
  }));
  return { checks: await releases.preflight(workflow, targets) };
});

app.post('/api/workflows/:workflowId/release', async (request, reply) => {
  const params = z.object({ workflowId: z.string() }).parse(request.params);
  const body = releaseBodySchema
    .extend({ confirmed: z.literal(true) })
    .parse(request.body ?? {});
  const workflow = await workflows.get(params.workflowId);
  if (!workflow) return reply.code(404).send({ error: 'Workflow not found' });
  const targets = body.targets.map((target) => ({
    repositoryId: target.repositoryId,
    targetBranch: target.targetBranch,
    ...(target.strategy ? { strategy: target.strategy } : {}),
  }));
  return { result: await releases.release(workflow, targets) };
});

app.setErrorHandler((error, _request, reply) => {
  app.log.error(error);
  const statusCode = error instanceof z.ZodError
    ? 400
    : error instanceof RuntimePortUnavailableError
      ? 409
      : 500;
  void reply.code(statusCode).send({
    error: error instanceof Error ? error.message : 'Unknown error',
  });
});

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const webRoot = path.resolve(currentDir, '../../web');
try {
  await access(webRoot);
  await app.register(fastifyStatic, { root: webRoot });
  app.setNotFoundHandler((_request, reply) => reply.sendFile('index.html'));
} catch {
  app.log.info('Static web build not found; run the Vite development server.');
}

await app.listen({ host: config.server.host, port: config.server.port });

let shuttingDown = false;
const shutdown = async (signal: NodeJS.Signals) => {
  if (shuttingDown) return;
  shuttingDown = true;
  app.log.info(`Received ${signal}; stopping managed worktree runtimes.`);
  await runtimes.shutdown();
  await app.close();
  process.exit(0);
};

process.once('SIGINT', () => void shutdown('SIGINT'));
process.once('SIGTERM', () => void shutdown('SIGTERM'));
