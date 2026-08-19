import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/** Executes a command without invoking a shell. */
export async function runFile(
  command: string,
  args: string[],
  options: { cwd?: string; allowFailure?: boolean } = {}
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  try {
    const result = await execFileAsync(command, args, {
      cwd: options.cwd,
      encoding: 'utf8',
      maxBuffer: 20 * 1024 * 1024,
    });
    return { stdout: result.stdout, stderr: result.stderr, exitCode: 0 };
  } catch (error) {
    const commandError = error as NodeJS.ErrnoException & {
      stdout?: string;
      stderr?: string;
      code?: number;
    };
    if (!options.allowFailure) throw error;
    return {
      stdout: commandError.stdout ?? '',
      stderr: commandError.stderr ?? commandError.message,
      exitCode: typeof commandError.code === 'number' ? commandError.code : 1,
    };
  }
}

/** Applies trusted configuration template variables to a command or URL. */
export function renderTemplate(
  input: string,
  variables: Record<string, string | number>
): string {
  return input.replace(/\$\{([a-zA-Z0-9_.-]+)\}/g, (full, key: string) => {
    const value = variables[key];
    return value === undefined ? full : String(value);
  });
}
