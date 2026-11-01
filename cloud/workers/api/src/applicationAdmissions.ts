import {
  ApplicationDataUnavailable,
  readApplicationDataControl,
  type ApplicationDataControl,
  type ApplicationWriteContext,
} from "./applicationDataControl.ts";

export type ApplicationAdmissionKind =
  "http" | "rpc" | "queue" | "workflow" | "scheduled" | "alarm" | "socket";

export type ApplicationAdmission = ApplicationWriteContext & {
  kind: "business";
};

export async function beginApplicationAdmission(
  database: D1Database,
  kind: ApplicationAdmissionKind,
  dataEpoch: ApplicationDataControl["dataEpoch"],
  nowMs: number,
  parent?: ApplicationAdmission,
): Promise<ApplicationAdmission> {
  if (!Number.isSafeInteger(nowMs) || nowMs < 0)
    throw new ApplicationDataUnavailable();
  const control = await readApplicationDataControl(database);
  if (
    control.dataEpoch !== dataEpoch ||
    (control.phase !== "active" &&
      !(control.phase === "closing" && kind === "rpc" && parent)) ||
    (parent &&
      (kind !== "rpc" ||
        parent.dataEpoch !== dataEpoch ||
        parent.generation !== control.generation))
  )
    throw new ApplicationDataUnavailable();
  const operationId = crypto.randomUUID();
  const result = await database
    .prepare(
      "INSERT INTO application_data_admissions (operation_id, generation, data_epoch, kind, started_at_ms, status, failure_code, parent_operation_id) VALUES (?, ?, ?, ?, ?, 'running', NULL, ?)",
    )
    .bind(
      operationId,
      control.generation,
      dataEpoch,
      kind,
      nowMs,
      parent?.operationId ?? null,
    )
    .run();
  if (result.meta.changes !== 1) throw new ApplicationDataUnavailable();
  return {
    kind: "business",
    operationId,
    generation: control.generation,
    dataEpoch,
  };
}

export async function completeApplicationAdmission(
  database: D1Database,
  admission: ApplicationAdmission,
): Promise<void> {
  const result = await database
    .prepare(
      "DELETE FROM application_data_admissions WHERE operation_id = ? AND generation = ? AND data_epoch = ? AND status = 'running'",
    )
    .bind(admission.operationId, admission.generation, admission.dataEpoch)
    .run();
  if (result.meta.changes !== 1) throw new ApplicationDataUnavailable();
}

export async function blockApplicationAdmission(
  database: D1Database,
  admission: ApplicationAdmission,
  failureCode: string,
): Promise<void> {
  if (!/^[a-z][a-z0-9-]{0,119}$/.test(failureCode))
    throw new ApplicationDataUnavailable();
  const result = await database
    .prepare(
      "UPDATE application_data_admissions SET status = 'blocked', failure_code = ? WHERE operation_id = ? AND generation = ? AND data_epoch = ? AND status = 'running'",
    )
    .bind(
      failureCode,
      admission.operationId,
      admission.generation,
      admission.dataEpoch,
    )
    .run();
  if (result.meta.changes !== 1) throw new ApplicationDataUnavailable();
}

export class ApplicationAdmissionTasks {
  private pending = 1;
  private failed = false;
  private finished = false;
  private completion: Promise<void> | null = null;
  private readonly complete: () => Promise<void>;
  private readonly block: () => Promise<void>;

  constructor(complete: () => Promise<void>, block: () => Promise<void>) {
    this.complete = complete;
    this.block = block;
  }

  track<T>(task: Promise<T>): Promise<T> {
    if (this.completion) throw new ApplicationDataUnavailable();
    this.pending++;
    return task.then(
      async (value) => {
        await this.settle(false);
        return value;
      },
      async (error: unknown) => {
        await this.settle(true);
        throw error;
      },
    );
  }

  finish(failed: boolean): Promise<void> {
    if (this.finished) throw new ApplicationDataUnavailable();
    this.finished = true;
    return this.settle(failed);
  }

  private async settle(failed: boolean): Promise<void> {
    if (this.pending <= 0) throw new ApplicationDataUnavailable();
    this.failed ||= failed;
    this.pending--;
    if (this.pending === 0) {
      this.completion = this.failed ? this.block() : this.complete();
      await this.completion;
    }
  }
}
