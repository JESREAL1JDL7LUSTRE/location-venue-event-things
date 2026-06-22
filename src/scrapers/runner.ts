import { eq, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { eventsScraperrun } from '../../drizzle/schema.js';

export type RunStatus = 'queued' | 'running' | 'success' | 'failed' | 'cancelled';

export const createScraperRun = async (scraperKey: string): Promise<{ id: number; alreadyActive: boolean }> => {
  const active = await db
    .select({ id: eventsScraperrun.id })
    .from(eventsScraperrun)
    .where(
      sql`${eventsScraperrun.scraperKey} = ${scraperKey} AND ${eventsScraperrun.status} IN ('queued', 'running')`,
    )
    .limit(1);

  if (active.length > 0) return { id: active[0].id, alreadyActive: true };

  const now = new Date().toISOString();
  const inserted = await db
    .insert(eventsScraperrun)
    .values({
      scraperKey,
      status: 'queued',
      createdCount: 0,
      updatedCount: 0,
      extraCounts: {},
      errorMessage: '',
      logOutput: '',
      createdAt: now,
      updatedAt: now,
    })
    .returning({ id: eventsScraperrun.id });

  return { id: inserted[0].id, alreadyActive: false };
};

export const markRunStarted = async (runId: number, pid: number) => {
  const now = new Date().toISOString();
  await db
    .update(eventsScraperrun)
    .set({ status: 'running', startedAt: now, pid, updatedAt: now })
    .where(eq(eventsScraperrun.id, runId));
};

export const markRunSuccess = async (
  runId: number,
  created: number,
  updated: number,
  extraCounts: Record<string, unknown> = {},
) => {
  const now = new Date().toISOString();
  await db
    .update(eventsScraperrun)
    .set({ status: 'success', finishedAt: now, createdCount: created, updatedCount: updated, extraCounts, updatedAt: now })
    .where(eq(eventsScraperrun.id, runId));
};

export const markRunFailed = async (runId: number, error: Error) => {
  const now = new Date().toISOString();
  await db
    .update(eventsScraperrun)
    .set({ status: 'failed', finishedAt: now, errorMessage: error.stack ?? error.message, updatedAt: now })
    .where(eq(eventsScraperrun.id, runId));
};

export const appendLog = async (runId: number, line: string) => {
  await db
    .update(eventsScraperrun)
    .set({
      logOutput: sql`${eventsScraperrun.logOutput} || ${line + '\n'}`,
      updatedAt: new Date().toISOString(),
    })
    .where(eq(eventsScraperrun.id, runId));
};

export const cancelRun = async (runId: number): Promise<{ found: boolean; wasActive: boolean }> => {
  const rows = await db
    .select({ id: eventsScraperrun.id, status: eventsScraperrun.status, pid: eventsScraperrun.pid })
    .from(eventsScraperrun)
    .where(eq(eventsScraperrun.id, runId))
    .limit(1);

  if (!rows.length) return { found: false, wasActive: false };
  const run = rows[0];
  if (!['queued', 'running'].includes(run.status)) return { found: true, wasActive: false };

  if (run.pid) {
    try { process.kill(run.pid, 'SIGTERM'); } catch { /* already dead */ }
  }

  const now = new Date().toISOString();
  await db
    .update(eventsScraperrun)
    .set({ status: 'cancelled', finishedAt: now, updatedAt: now })
    .where(eq(eventsScraperrun.id, runId));

  return { found: true, wasActive: true };
};
