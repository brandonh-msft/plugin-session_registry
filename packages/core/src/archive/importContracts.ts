import { ImportError, type ImportErrorCode } from "./importErrors.js";

export type ImportLifecycle = "pending" | "ready" | "closed";

export type ImportHandleId = string & { readonly __brand: "ImportHandleId" };

export interface ImportHandle {
  readonly id: ImportHandleId;
  readonly bundleSha256: string;
  readonly byteLength: number;
  readonly workspacePath: string;
}

export function createImportHandle(
  id: string,
  bundleSha256: string,
  byteLength: number,
  workspacePath: string,
): ImportHandle {
  return { id: id as ImportHandleId, bundleSha256, byteLength, workspacePath };
}

export interface ImportSession {
  readonly handle: ImportHandle;
  readonly lifecycle: ImportLifecycle;
}

export interface SliceSelection {
  readonly path: string;
  readonly start?: number;
  readonly end?: number;
}

export interface SliceInspection {
  readonly selection: SliceSelection;
  readonly bytesInspected: number;
  readonly recordsInspected: number;
  readonly complete: boolean;
}

export interface SliceBoundary {
  readonly stoppingPoint: string;
  readonly reason: string;
}

export interface FoundSlice<T = string> {
  readonly outcome: "found";
  readonly content: T;
  readonly inspection: SliceInspection;
}

export interface NotFoundSlice {
  readonly outcome: "not-found";
  readonly inspection: SliceInspection;
  readonly reason: string;
}

export interface PartialSlice<T = string> {
  readonly outcome: "partial-with-boundary";
  readonly content: T;
  readonly inspection: SliceInspection;
  readonly boundary: SliceBoundary;
}

export interface ReadFailureSlice {
  readonly outcome: "read-failure";
  readonly inspection?: SliceInspection;
  readonly error: {
    readonly code: ImportErrorCode;
    readonly message: string;
  };
}

export type SliceOutcome<T = string> =
  | FoundSlice<T>
  | NotFoundSlice
  | PartialSlice<T>
  | ReadFailureSlice;

type ActiveImport = {
  readonly handle: ImportHandle;
  lifecycle: ImportLifecycle;
  inFlightReads: number;
  closePromise?: Promise<void>;
  resolveClose?: () => void;
};

/**
 * Coordinates the single import workspace without owning filesystem I/O.
 * Reads are admitted only while ready, and close drains admitted reads before
 * invoking the workspace release callback.
 */
export class ImportCoordinator {
  private active: ActiveImport | undefined;
  private readonly closedHandles = new Map<ImportHandleId, ImportHandle>();

  public beginImport(handle: ImportHandle): ImportSession {
    if (this.active !== undefined) throw new ImportError("IMPORT_ALREADY_ACTIVE");
    this.active = { handle, lifecycle: "pending", inFlightReads: 0 };
    return { handle, lifecycle: "pending" };
  }

  public markReady(handle: ImportHandle): ImportSession {
    const active = this.requireActive(handle);
    if (active.lifecycle === "closed") throw new ImportError("IMPORT_CLOSED");
    if (active.lifecycle !== "pending") throw new ImportError("IMPORT_NOT_READY");
    active.lifecycle = "ready";
    return { handle: active.handle, lifecycle: "ready" };
  }

  public async read<T>(
    handle: ImportHandle,
    operation: (handle: ImportHandle) => Promise<T> | T,
  ): Promise<T> {
    const active = this.requireActive(handle);
    if (active.lifecycle === "closed") throw new ImportError("IMPORT_CLOSED");
    if (active.lifecycle !== "ready") throw new ImportError("IMPORT_NOT_READY");
    active.inFlightReads++;
    try {
      return await operation(active.handle);
    } finally {
      active.inFlightReads--;
      if (active.inFlightReads === 0) active.resolveClose?.();
    }
  }

  public async closeImport(
    handle: ImportHandle,
    releaseWorkspace: (handle: ImportHandle) => Promise<void> | void = () => undefined,
  ): Promise<ImportSession> {
    const active = this.requireActive(handle);
    if (active.closePromise !== undefined) {
      await active.closePromise;
      return { handle: active.handle, lifecycle: "closed" };
    }

    active.lifecycle = "closed";
    const drained = new Promise<void>((resolve) => {
      active.resolveClose = resolve;
    });
    active.closePromise = (async () => {
      if (active.inFlightReads === 0) active.resolveClose!();
      await drained;
      await releaseWorkspace(active.handle);
      this.active = undefined;
      this.closedHandles.set(active.handle.id, active.handle);
    })();

    try {
      await active.closePromise;
      return { handle: active.handle, lifecycle: "closed" };
    } catch (error) {
      active.closePromise = undefined;
      throw error;
    }
  }

  public session(handle: ImportHandle): ImportSession {
    const active = this.active;
    if (active !== undefined && active.handle.id === handle.id) {
      return { handle: active.handle, lifecycle: active.lifecycle };
    }
    const closed = this.closedHandles.get(handle.id);
    if (closed !== undefined) {
      if (
        closed.bundleSha256 !== handle.bundleSha256 ||
        closed.byteLength !== handle.byteLength ||
        closed.workspacePath !== handle.workspacePath
      ) {
        throw new ImportError("IMPORT_HANDLE_STALE");
      }
      return { handle: closed, lifecycle: "closed" };
    }
    throw new ImportError("IMPORT_HANDLE_UNKNOWN");
  }

  private requireActive(handle: ImportHandle): ActiveImport {
    const active = this.active;
    if (active === undefined) {
      const closed = this.closedHandles.get(handle.id);
      if (closed !== undefined) {
        if (
          closed.bundleSha256 !== handle.bundleSha256 ||
          closed.byteLength !== handle.byteLength ||
          closed.workspacePath !== handle.workspacePath
        ) {
          throw new ImportError("IMPORT_HANDLE_STALE");
        }
        throw new ImportError("IMPORT_CLOSED");
      }
      throw new ImportError("IMPORT_HANDLE_UNKNOWN");
    }
    if (active.handle.id !== handle.id) {
      if (this.closedHandles.has(handle.id)) throw new ImportError("IMPORT_HANDLE_STALE");
      throw new ImportError("IMPORT_HANDLE_UNKNOWN");
    }
    if (
      active.handle.bundleSha256 !== handle.bundleSha256 ||
      active.handle.byteLength !== handle.byteLength ||
      active.handle.workspacePath !== handle.workspacePath
    ) {
      throw new ImportError("IMPORT_HANDLE_STALE");
    }
    return active;
  }
}

export type ImportEntryIndex<T> = ReadonlyMap<string, T>;
