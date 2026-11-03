// Stages moved to another model by a person's answer (the Fable reserve Ask's "Use <fallback>"),
// per Project. The Session manager starts that Stage's Sessions on the stored model instead of the
// Workflow's until the entry is cleared.
import type { DatabaseSync } from 'node:sqlite';

export interface StageModels {
  get(projectId: string, kind: string, stage: string): string | undefined;
  set(projectId: string, kind: string, stage: string, model: string): void;
}

export function createStageModels(db: DatabaseSync): StageModels {
  const select = db.prepare('SELECT model FROM stage_models WHERE project_id = ? AND item_kind = ? AND stage = ?');
  const upsert = db.prepare(
    `INSERT INTO stage_models (project_id, item_kind, stage, model) VALUES (?, ?, ?, ?)
     ON CONFLICT (project_id, item_kind, stage) DO UPDATE SET model = excluded.model`,
  );
  return {
    get: (projectId, kind, stage) => (select.get(projectId, kind, stage) as { model: string } | undefined)?.model,
    set: (projectId, kind, stage, model) => void upsert.run(projectId, kind, stage, model),
  };
}
