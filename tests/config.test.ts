import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { loadConfig } from '../src/core/config.js';

describe('configuration', () => {
  it('loads generic workspace configuration', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'workflow-config-'));
    const file = path.join(directory, 'config.yaml');
    await writeFile(
      file,
      `version: 1
server: { host: 127.0.0.1, port: 4310, dataDir: ~/.workflow-manager-test }
runtime: { portRange: { start: 3100, end: 3110 }, stopTimeoutMs: 1000, startupTimeoutMs: 5000 }
workspaces:
  - id: demo
    label: Demo
    matching: { stripBranchPrefixes: [codex/], includeBranchPatterns: ['^codex/'] }
    repositories:
      - id: app
        label: App
        role: application
        path: ${directory}
        remote: origin
        checks: []
sources: []
`,
      'utf8'
    );
    const config = await loadConfig(file);
    expect(config.workspaces[0]?.repositories[0]?.id).toBe('app');
    expect(config.runtime.portRange).toEqual({ start: 3100, end: 3110 });
    expect(config.configPath).toBe(file);
  });
});
