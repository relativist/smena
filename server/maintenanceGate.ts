/** Drain requests already using the database before a school-wide restore. */
export class MaintenanceGate {
  private readonly requests = new Set<object>();
  private readonly listeners = new Set<() => void>();
  private exclusive = false;

  enter(id: object): boolean {
    if (this.exclusive) return false;
    this.requests.add(id);
    return true;
  }

  leave(id: object): void {
    this.requests.delete(id);
    for (const listener of this.listeners) listener();
  }

  async run<T>(requestId: object, work: () => Promise<T>): Promise<T> {
    if (this.exclusive) throw Object.assign(new Error("Уже выполняется восстановление данных"), { statusCode: 409 });
    this.exclusive = true;
    try {
      await new Promise<void>((resolve, reject) => {
        const ready = () => ![...this.requests].some(id => id !== requestId);
        if (ready()) { resolve(); return; }
        const timeout = setTimeout(() => {
          this.listeners.delete(changed);
          reject(Object.assign(new Error("Другие операции ещё выполняются. Повторите восстановление позже"), { statusCode: 409 }));
        }, 60_000);
        const changed = () => {
          if (!ready()) return;
          clearTimeout(timeout);
          this.listeners.delete(changed);
          resolve();
        };
        this.listeners.add(changed);
      });
      return await work();
    } finally { this.exclusive = false; }
  }
}
