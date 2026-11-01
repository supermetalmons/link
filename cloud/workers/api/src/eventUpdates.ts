import { DurableObject } from "cloudflare:workers";
import {
  REACTION_HEARTBEAT_REQUEST,
  REACTION_HEARTBEAT_RESPONSE,
} from "@mons/shared/reactions";
import type {
  ApplicationAdmission,
  ApplicationAdmissionKind,
} from "./applicationAdmissions.ts";
import { ApplicationDataUnavailable } from "./applicationDataControl.ts";
import {
  currentApplicationAdmission,
  runApplicationOperation,
  scopedApplicationEnv,
} from "./applicationExecution.ts";
import {
  assertApplicationObjectAdmission,
  fenceApplicationObjectStorage,
  initializeApplicationObjectControl,
} from "./applicationObjectStorage.ts";
import {
  readApplicationAdmissionHeader,
  readApplicationRpcAdmission,
} from "./applicationRoomRpc.ts";
import { EventUpdatesRoom } from "./eventUpdatesRoom.ts";

export class EventUpdates extends DurableObject<Env> {
  private initialization: Promise<void> | null = null;
  private room!: EventUpdatesRoom;

  private async ensureRuntime(): Promise<void> {
    const admission = () => {
      const current = currentApplicationAdmission();
      if (!current) throw new ApplicationDataUnavailable();
      return current;
    };
    this.initialization ??= this.ctx.storage
      .transaction(async () => {
        await initializeApplicationObjectControl(this.ctx.storage, admission());
        assertApplicationObjectAdmission(this.ctx.storage, admission());
        const env = scopedApplicationEnv(this.env);
        this.room = new EventUpdatesRoom(this.ctx, {
          storage: fenceApplicationObjectStorage(this.ctx.storage, admission),
          epoch: env.EVENT_DB_BOOKMARK_EPOCH,
          readRevision: async (eventId) => {
            const row = await env.EVENT_DB.withSession("first-primary")
              .prepare(
                "SELECT revision FROM event_records_canonical WHERE event_id = ?",
              )
              .bind(eventId)
              .first<{ revision: number }>();
            return row?.revision ?? 0;
          },
        });
        this.ctx.setWebSocketAutoResponse();
      })
      .catch((error: unknown) => {
        this.initialization = null;
        throw error;
      });
    await this.initialization;
    assertApplicationObjectAdmission(this.ctx.storage, admission());
  }

  private withApplicationOperation<T>(
    kind: ApplicationAdmissionKind,
    work: () => Promise<T>,
    parent?: ApplicationAdmission,
  ): Promise<T> {
    return runApplicationOperation(
      this.env,
      kind,
      1,
      async () => {
        await this.ensureRuntime();
        return work();
      },
      this.ctx,
      parent,
    );
  }

  fetch(request: Request): Promise<Response> {
    return this.withApplicationOperation(
      "rpc",
      () => this.room.fetch(request),
      readApplicationAdmissionHeader(request),
    );
  }

  notifyEventChanged(
    eventId: string,
    epoch: string,
    revision: number,
    parent?: ApplicationAdmission,
  ): Promise<void> {
    return this.withApplicationOperation(
      "rpc",
      async () => this.room.notifyEventChanged(eventId, epoch, revision),
      readApplicationRpcAdmission(parent),
    );
  }

  alarm(): Promise<void> {
    return this.withApplicationOperation("alarm", () => this.room.alarm());
  }

  async webSocketMessage(
    socket: WebSocket,
    message: string | ArrayBuffer,
  ): Promise<void> {
    try {
      await this.withApplicationOperation("socket", async () => {
        if (!this.room.sessions.active(socket)) return;
        if (message === REACTION_HEARTBEAT_REQUEST) {
          this.room.sessions.send(socket, REACTION_HEARTBEAT_RESPONSE);
          return;
        }
        socket.close(1008, "Event sockets are receive-only");
      });
    } catch (error) {
      if (error instanceof ApplicationDataUnavailable) {
        socket.close(1012, "Service maintenance");
        return;
      }
      throw error;
    }
  }

  async webSocketClose(socket: WebSocket): Promise<void> {
    try {
      await this.withApplicationOperation("socket", async () => socket.close());
    } catch (error) {
      if (error instanceof ApplicationDataUnavailable) {
        socket.close(1012, "Service maintenance");
        return;
      }
      throw error;
    }
  }

  async webSocketError(socket: WebSocket): Promise<void> {
    try {
      await this.withApplicationOperation("socket", async () =>
        socket.close(1011, "Socket failure"),
      );
    } catch (error) {
      if (error instanceof ApplicationDataUnavailable) {
        socket.close(1012, "Service maintenance");
        return;
      }
      throw error;
    }
  }
}
