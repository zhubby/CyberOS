export interface ManagedAgentSession<TSession> {
  sessionId: string;
  fingerprint: string;
  session: TSession;
  dispose: () => void | Promise<void>;
}

export interface AgentSessionRunInput<TSession, TResult> {
  sessionId: string;
  fingerprint: string;
  create: () => Promise<ManagedAgentSession<TSession>>;
  execute: (session: TSession) => Promise<TResult>;
}

interface SessionActor<TSession> {
  tail: Promise<void>;
  resource: ManagedAgentSession<TSession> | null;
  idleTimer: NodeJS.Timeout | null;
  pending: number;
}

export class AgentSessionManager<TSession> {
  private readonly actors = new Map<string, SessionActor<TSession>>();

  constructor(private readonly idleTtlMs = 5 * 60_000) {}

  run<TResult>(input: AgentSessionRunInput<TSession, TResult>): Promise<TResult> {
    const actor = this.actors.get(input.sessionId) ?? this.createActor(input.sessionId);
    actor.pending += 1;
    if (actor.idleTimer) {
      clearTimeout(actor.idleTimer);
      actor.idleTimer = null;
    }

    const result = actor.tail.then(async () => {
      if (actor.resource?.fingerprint !== input.fingerprint) {
        await this.disposeResource(actor);
      }
      actor.resource ??= await input.create();
      return input.execute(actor.resource.session);
    });
    actor.tail = result.then(
      () => undefined,
      () => undefined
    ).finally(() => {
      actor.pending -= 1;
      if (actor.pending === 0) this.scheduleIdleDispose(input.sessionId, actor);
    });
    return result;
  }

  async dispose(sessionId: string): Promise<void> {
    const actor = this.actors.get(sessionId);
    if (!actor) return;
    await actor.tail;
    if (actor.idleTimer) clearTimeout(actor.idleTimer);
    await this.disposeResource(actor);
    this.actors.delete(sessionId);
  }

  async disposeAll(): Promise<void> {
    await Promise.all([...this.actors.keys()].map((sessionId) => this.dispose(sessionId)));
  }

  get size(): number {
    return [...this.actors.values()].filter((actor) => actor.resource !== null).length;
  }

  private createActor(sessionId: string): SessionActor<TSession> {
    const actor: SessionActor<TSession> = {
      tail: Promise.resolve(),
      resource: null,
      idleTimer: null,
      pending: 0
    };
    this.actors.set(sessionId, actor);
    return actor;
  }

  private scheduleIdleDispose(sessionId: string, actor: SessionActor<TSession>): void {
    actor.idleTimer = setTimeout(() => {
      actor.idleTimer = null;
      const disposal = actor.tail.then(async () => {
        if (actor.pending !== 0 || this.actors.get(sessionId) !== actor) return;
        await this.disposeResource(actor);
        if (actor.pending === 0 && this.actors.get(sessionId) === actor) {
          this.actors.delete(sessionId);
        }
      });
      actor.tail = disposal.then(
        () => undefined,
        () => undefined
      );
    }, this.idleTtlMs);
    actor.idleTimer.unref();
  }

  private async disposeResource(actor: SessionActor<TSession>): Promise<void> {
    const resource = actor.resource;
    actor.resource = null;
    if (resource) await resource.dispose();
  }
}
