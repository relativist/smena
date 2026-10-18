import { createId } from "../shared/createId.ts";
import { useEffect, useRef, useState } from "react";
import type { StateResponse } from "../server/contracts";
import type { Schedule } from "./editor";
import { scheduleDayChanges } from "./scheduleContext";
import { api, ApiError } from "./api";

type SaveStatus = {
  kind: "saved" | "pending" | "saving" | "error" | "conflict" | "auth";
  message: string;
  updatedAt?: string;
};
type PendingRequest = {
  schedule: Schedule;
  revision: number;
  requestId: string;
};

/** Serial writes keep revisions ordered; an uncertain write retries its original id. */
export function useAutosave(
  initial: StateResponse,
  csrfToken: string,
  onUnauthorized: () => void,
) {
  const [status, setStatus] = useState<SaveStatus>({
    kind: "saved",
    message: "Сохранено",
    updatedAt: initial.updatedAt,
  });
  const [savedRevision, setSavedRevision] = useState(initial.revision);
  const desired = useRef(initial.schedule);
  const acknowledged = useRef(initial.schedule);
  const revision = useRef(initial.revision);
  const pending = useRef<PendingRequest | null>(null);
  const running = useRef<Promise<boolean> | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mounted = useRef(true);
  const conflict = useRef(false);
  const authExpired = useRef(false);
  const token = useRef(csrfToken);
  const requestAuth = useRef(onUnauthorized);
  const scoped = useRef(initial.editorBootstrap === true);
  token.current = csrfToken;
  requestAuth.current = onUnauthorized;

  function report(value: SaveStatus) {
    if (mounted.current) setStatus(value);
  }
  async function drain(): Promise<boolean> {
    if (conflict.current) return false;
    while (pending.current || desired.current !== acknowledged.current) {
      pending.current ??= {
        schedule: desired.current,
        revision: revision.current,
        requestId: createId(),
      };
      const snapshot = pending.current;
      report({ kind: "saving", message: "Сохраняется…" });
      try {
        const isScoped = scoped.current;
        const changes = isScoped
          ? scheduleDayChanges(acknowledged.current, snapshot.schedule)
          : null;
        if (changes && changes.length === 0) {
          acknowledged.current = snapshot.schedule;
          pending.current = null;
          if (desired.current === acknowledged.current)
            report({ kind: "saved", message: "Сохранено" });
          continue;
        }
        const saved = await api<{ revision: number; updatedAt: string }>(
          isScoped ? "/api/editor/days" : "/api/state",
          isScoped
            ? {
                method: "PUT",
                headers: { "x-csrf-token": token.current },
                body: JSON.stringify({
                  revision: snapshot.revision,
                  requestId: snapshot.requestId,
                  changes: changes ?? [],
                }),
              }
            : {
            method: "PUT",
            headers: { "x-csrf-token": token.current },
            body: JSON.stringify(snapshot),
              },
        );
        if (!Number.isInteger(saved.revision))
          throw new ApiError("Сервер не подтвердил сохранение.", 0);
        revision.current = saved.revision;
        if (mounted.current) setSavedRevision(saved.revision);
        acknowledged.current = snapshot.schedule;
        pending.current = null;
        authExpired.current = false;
        if (desired.current === acknowledged.current)
          report({
            kind: "saved",
            message: "Сохранено",
            updatedAt: saved.updatedAt,
          });
      } catch (error) {
        const code = error instanceof ApiError ? error.status : 0;
        if (code === 401 || code === 403) {
          authExpired.current = true;
          report({
            kind: "auth",
            message: "Войдите снова, чтобы сохранить правки.",
          });
          requestAuth.current();
        } else if (code === 409) {
          conflict.current = true;
          report({
            kind: "conflict",
            message:
              "Расписание изменено в другой вкладке. Ваши правки остались здесь; автоматическая перезапись остановлена.",
          });
        } else {
          report({
            kind: "error",
            message:
              error instanceof Error
                ? error.message
                : "Не удалось сохранить изменения.",
          });
        }
        return false;
      }
    }
    return true;
  }

  function flush(): Promise<boolean> {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    if (running.current) return running.current;
    const work = drain();
    running.current = work;
    void work.finally(() => {
      if (running.current === work) running.current = null;
    });
    return work;
  }
  function queue(next: Schedule) {
    desired.current = next;
    if (conflict.current || authExpired.current) return;
    report({ kind: "pending", message: "Есть изменения…" });
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => void flush(), 350);
  }

  useEffect(() => {
    mounted.current = true;
    const onLeave = (event: BeforeUnloadEvent) => {
      if (pending.current || desired.current !== acknowledged.current) {
        event.preventDefault();
        event.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", onLeave);
    return () => {
      mounted.current = false;
      if (timer.current) clearTimeout(timer.current);
      window.removeEventListener("beforeunload", onLeave);
    };
  }, []);
  useEffect(() => {
    if (authExpired.current) {
      authExpired.current = false;
      void flush();
    }
  }, [csrfToken]);

  function reset(schedule: Schedule, nextRevision: number) {
    if (pending.current || running.current || desired.current !== acknowledged.current)
      return false;
    desired.current = schedule;
    acknowledged.current = schedule;
    revision.current = nextRevision;
    if (mounted.current) setSavedRevision(nextRevision);
    pending.current = null;
    conflict.current = false;
    authExpired.current = false;
    report({ kind: "saved", message: "Сохранено" });
    return true;
  }

  function setScopedMode(value: boolean) {
    scoped.current = value;
  }
  function currentRevision() { return revision.current; }

  return { status, queue, flush, reset, setScopedMode, currentRevision, revision: savedRevision };
}
