import { apiErrorPatch, readPendingTaskState, updateTaskState } from '../runner/task-state.js';

async function readStdinJson(): Promise<Record<string, unknown>> {
  if (process.stdin.isTTY) {
    return {};
  }

  const chunks: Buffer[] = [];

  for await (const chunk of process.stdin) {
    chunks.push(chunk as Buffer);
  }

  const raw = Buffer.concat(chunks).toString('utf8').trim();

  if (!raw) {
    return {};
  }

  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return {};
  }
}

export async function runStopFailureHook(worktreePath: string): Promise<number> {
  if (!(await readPendingTaskState(worktreePath))) {
    return 0;
  }

  const payload = await readStdinJson();
  const errorType = typeof payload.error === 'string' ? payload.error : 'unknown';
  const transcriptPath = typeof payload.transcript_path === 'string' ? payload.transcript_path : undefined;

  await updateTaskState(worktreePath, apiErrorPatch({ errorType, transcriptPath }));

  return 0;
}
