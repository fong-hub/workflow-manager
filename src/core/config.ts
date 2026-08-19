import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import YAML from 'yaml';
import { z } from 'zod';

import type { AppConfig } from './types.js';

const checkSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  command: z.string().min(1),
});

const releaseSchema = z.object({
  order: z.number().int(),
  defaultTargetBranch: z.string().min(1),
  allowedTargetBranches: z.array(z.string().min(1)).min(1),
  strategy: z.enum(['fast-forward', 'merge', 'cherry-pick']),
});

const runtimeSchema = z.object({
  primary: z.boolean().default(false),
  workingDirectory: z.string().default('.'),
  prepareCommand: z.string().min(1).optional(),
  startCommand: z.string().min(1),
  healthCheckUrl: z.string().min(1).optional(),
});

const repositorySchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  role: z.enum(['application', 'service', 'contract', 'other']).default('other'),
  path: z.string().min(1),
  remote: z.string().min(1).default('origin'),
  release: releaseSchema.optional(),
  runtime: runtimeSchema.optional(),
  checks: z.array(checkSchema).default([]),
});

const rawConfigSchema = z.object({
  version: z.literal(1),
  server: z.object({
    host: z.string().default('127.0.0.1'),
    port: z.number().int().min(1).max(65535).default(4310),
    dataDir: z.string().default('~/.workflow-manager'),
  }),
  runtime: z.object({
    portRange: z.object({
      start: z.number().int().min(1).max(65535),
      end: z.number().int().min(1).max(65535),
    }),
    stopTimeoutMs: z.number().int().positive().default(8000),
    startupTimeoutMs: z.number().int().positive().default(120000),
  }),
  sources: z
    .array(
      z.object({
        id: z.string().min(1),
        type: z.literal('codex-sessions'),
        enabled: z.boolean().default(true),
        sessionsGlob: z.string().min(1),
      })
    )
    .default([]),
  workspaces: z
    .array(
      z.object({
        id: z.string().min(1),
        label: z.string().min(1),
        matching: z.object({
          stripBranchPrefixes: z.array(z.string()).default([]),
          includeBranchPatterns: z.array(z.string()).default([]),
        }),
        repositories: z.array(repositorySchema).min(1),
      })
    )
    .default([]),
});

/** Expands a leading home marker while leaving other paths untouched. */
export function expandHome(input: string): string {
  if (input === '~') return os.homedir();
  if (input.startsWith('~/')) return path.join(os.homedir(), input.slice(2));
  return input;
}

/** Loads and validates the generic workflow-manager YAML configuration. */
export async function loadConfig(configPathInput?: string): Promise<AppConfig> {
  const configPath = path.resolve(
    expandHome(
      configPathInput ??
        process.env.WORKFLOW_MANAGER_CONFIG ??
        'workflow-manager.local.yaml'
    )
  );
  const rawText = await readFile(configPath, 'utf8');
  const parsed = rawConfigSchema.parse(YAML.parse(rawText));
  if (parsed.runtime.portRange.start > parsed.runtime.portRange.end) {
    throw new Error('runtime.portRange.start must be less than or equal to end');
  }

  return {
    ...parsed,
    configPath,
    server: {
      ...parsed.server,
      dataDir: path.resolve(expandHome(parsed.server.dataDir)),
    },
    sources: parsed.sources.map((source) => ({
      ...source,
      sessionsGlob: expandHome(source.sessionsGlob),
    })),
    workspaces: parsed.workspaces.map((workspace) => ({
      ...workspace,
      repositories: workspace.repositories.map((repository) => ({
        id: repository.id,
        label: repository.label,
        role: repository.role,
        path: path.resolve(expandHome(repository.path)),
        remote: repository.remote,
        checks: repository.checks,
        ...(repository.release ? { release: repository.release } : {}),
        ...(repository.runtime
          ? {
              runtime: {
                primary: repository.runtime.primary,
                workingDirectory: repository.runtime.workingDirectory,
                startCommand: repository.runtime.startCommand,
                ...(repository.runtime.prepareCommand
                  ? { prepareCommand: repository.runtime.prepareCommand }
                  : {}),
                ...(repository.runtime.healthCheckUrl
                  ? { healthCheckUrl: repository.runtime.healthCheckUrl }
                  : {}),
              },
            }
          : {}),
      })),
    })),
  };
}
