import { open, stat } from 'node:fs/promises';
import { glob } from 'glob';

import type { SessionHint, SourceConfig } from './types.js';

/** Reads only the session metadata event; conversation content is never loaded. */
async function readSessionMetadata(filePath: string): Promise<SessionHint | undefined> {
  const file = await open(filePath, 'r');
  try {
    const buffer = Buffer.alloc(128 * 1024);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    const firstLine = buffer.subarray(0, bytesRead).toString('utf8').split('\n')[0];
    if (!firstLine) return undefined;
    const event = JSON.parse(firstLine) as {
      payload?: {
        id?: string;
        cwd?: string;
        git?: { branch?: string; repository_url?: string };
      };
    };
    const payload = event.payload;
    if (!payload?.id || !payload.cwd) return undefined;
    const fileStat = await stat(filePath);
    return {
      id: payload.id,
      cwd: payload.cwd,
      ...(payload.git?.branch ? { branch: payload.git.branch } : {}),
      ...(payload.git?.repository_url
        ? { repositoryUrl: payload.git.repository_url }
        : {}),
      updatedAt: fileStat.mtime.toISOString(),
    };
  } catch {
    return undefined;
  } finally {
    await file.close();
  }
}

/** Discovers metadata hints from configured Codex session stores. */
export async function discoverSessions(
  sources: SourceConfig[]
): Promise<SessionHint[]> {
  const enabled = sources.filter(
    (source) => source.enabled && source.type === 'codex-sessions'
  );
  const files = (
    await Promise.all(
      enabled.map((source) =>
        glob(source.sessionsGlob, { nodir: true, absolute: true })
      )
    )
  ).flat();
  const sessions = (
    await Promise.all(files.map((filePath) => readSessionMetadata(filePath)))
  ).filter((session): session is SessionHint => Boolean(session));
  return sessions.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}
