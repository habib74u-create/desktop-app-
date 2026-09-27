// src/core/agent-manager.ts
import { EventEmitter } from 'events';
import { log } from './logger';
import { getJarvisCore, type JarvisCore } from './jarvis-core';

export interface AgentContext {
  core: JarvisCore;
  /** Name this agent was registered under. */
  name: string;
  /** Scoped logger for this agent. */
  log: ReturnType<typeof log.main.scope>;
  /** Read-only config snapshot */
  config: Readonly<ReturnType<JarvisCore['getConfig']>>;
  /** Emit a nudge through the core (also fires IPC). */
  nudge: (kind: string, payload: unknown) => void;
}

export interface Agent {
  /** Stable, unique name. */
  readonly name: string;
  /** Human-readable description. */
  readonly description?: string;
  /** Agents this one depends on — must be registered first. */
  readonly dependsOn?: string[];
  /**
   * Called once when the agent is registered + enabled.
   * Use this to attach listeners, open resources, etc.
   */
  init(ctx: AgentContext): Promise<void> | void;
  /**
   * Called when the agent is disabled or the app is shutting down.
   * Must clean up all listeners / resources.
   */
  dispose(): Promise<void> | void;
  /**
   * Optional: called when the app becomes foreground / background.
   */
  onFocus?(): void;
  onBlur?(): void;
}

interface RegisteredAgent {
  agent: Agent;
  ctx: AgentContext;
  enabled: boolean;
  disposed: boolean;
}

export class AgentManager extends EventEmitter {
  private agents = new Map<string, RegisteredAgent>();
  private starting = false;

  constructor(private core: JarvisCore) {
    super();
    this.setMaxListeners(30);
  }

  /* ---------------------------------------------------------------------- */
  /* Registration                                                           */
  /* ---------------------------------------------------------------------- */

  /**
   * Register an agent. Does NOT start it — call `enable(name)`.
   * Throws if an agent with the same name exists.
   */
  register(agent: Agent): void {
    const name = agent.name;
    if (!name || typeof name !== 'string') {
      throw new Error('Agent must have a non-empty name');
    }
    if (this.agents.has(name)) {
      throw new Error(`Agent already registered: ${name}`);
    }

    const ctx: AgentContext = {
      core: this.core,
      name,
      log: log.main.scope(`agent:${name}`),
      config: this.core.getConfig(),
      nudge: (kind, payload) => {
        log.main.debug(`nudge from ${name}: ${kind}`, payload);
        this.core.emit('nudge', { kind, payload });
      },
    };

    this.agents.set(name, { agent, ctx, enabled: false, disposed: false });
    log.main.info(`registered agent: ${name}${agent.description ? ` — ${agent.description}` : ''}`);
    this.emit('registered', name);
  }

  /** Unregister and dispose an agent. */
  async unregister(name: string): Promise<void> {
    const entry = this.agents.get(name);
    if (!entry) return;
    if (entry.enabled) await this.disable(name);
    if (!entry.disposed) {
      try {
        await entry.agent.dispose?.();
      } catch (err) {
        log.main.error(`dispose failed for agent ${name}`, err);
      }
      entry.disposed = true;
    }
    this.agents.delete(name);
    this.emit('unregistered', name);
    log.main.info(`unregistered agent: ${name}`);
  }

  /* ---------------------------------------------------------------------- */
  /* Lifecycle                                                              */
  /* ---------------------------------------------------------------------- */

  /** Initialize all agents in dependency order, then start each. */
  async startAll(): Promise<void> {
    if (this.starting) {
      log.main.warn('AgentManager.startAll() called while already starting');
      return;
    }
    this.starting = true;
    try {
      const order = this.resolveOrder();
      log.main.info(`starting ${order.length} agents: ${order.join(', ')}`);
      for (const name of order) {
        await this.enable(name);
      }
    } finally {
      this.starting = false;
    }
  }

  async stopAll(): Promise<void> {
    // Disable in reverse order for clean shutdown
    const names = [...this.agents.keys()].reverse();
    for (const name of names) {
      await this.disable(name);
    }
  }

  async enable(name: string): Promise<void> {
    const entry = this.agents.get(name);
    if (!entry) {
      log.main.warn(`enable: unknown agent ${name}`);
      return;
    }
    if (entry.enabled) return;

    // Ensure deps are enabled
    for (const dep of entry.agent.dependsOn ?? []) {
      if (!this.agents.has(dep)) {
        throw new Error(`Agent ${name} depends on unknown agent: ${dep}`);
      }
      const depEntry = this.agents.get(dep)!;
      if (!depEntry.enabled) await this.enable(dep);
    }

    try {
      await entry.agent.init(entry.ctx);
      entry.enabled = true;
      this.emit('enabled', name);
      log.main.info(`agent enabled: ${name}`);
    } catch (err) {
      log.main.error(`agent init failed: ${name}`, err);
      this.core.reportError(`agent:${name}`, err);
      throw err;
    }
  }

  async disable(name: string): Promise<void> {
    const entry = this.agents.get(name);
    if (!entry || !entry.enabled) return;

    // Refuse to disable if a still-enabled agent depends on us
    for (const [other, otherEntry] of this.agents) {
      if (other === name || !otherEntry.enabled) continue;
      if (otherEntry.agent.dependsOn?.includes(name)) {
        await this.disable(other);
      }
    }

    try {
      await entry.agent.dispose?.();
    } catch (err) {
      log.main.error(`agent dispose failed: ${name}`, err);
    }
    entry.enabled = false;
    entry.disposed = true; // re-enable will re-init
    this.emit('disabled', name);
    log.main.info(`agent disabled: ${name}`);
  }

  /** Re-run init for an enabled agent (e.g. after config change). */
  async restart(name: string): Promise<void> {
    const entry = this.agents.get(name);
    if (!entry?.enabled) return;
    await this.disable(name);
    entry.disposed = false;
    await this.enable(name);
  }

  /* ---------------------------------------------------------------------- */
  /* Focus                                                                  */
  /* ---------------------------------------------------------------------- */

  notifyFocus(): void {
    for (const { agent, enabled } of this.agents.values()) {
      if (!enabled) continue;
      try {
        agent.onFocus?.();
      } catch (err) {
        log.main.error(`onFocus failed for ${agent.name}`, err);
      }
    }
  }

  notifyBlur(): void {
    for (const { agent, enabled } of this.agents.values()) {
      if (!enabled) continue;
      try {
        agent.onBlur?.();
      } catch (err) {
        log.main.error(`onBlur failed for ${agent.name}`, err);
      }
    }
  }

  /* ---------------------------------------------------------------------- */
  /* Introspection                                                          */
  /* ---------------------------------------------------------------------- */

  list(): Array<{ name: string; description?: string; enabled: boolean; dependsOn: string[] }> {
    return [...this.agents.entries()].map(([name, e]) => ({
      name,
      description: e.agent.description,
      enabled: e.enabled,
      dependsOn: e.agent.dependsOn ?? [],
    }));
  }

  isEnabled(name: string): boolean {
    return this.agents.get(name)?.enabled ?? false;
  }

  get(name: string): Agent | undefined {
    return this.agents.get(name)?.agent;
  }

  /* ---------------------------------------------------------------------- */
  /* Internals                                                              */
  /* ---------------------------------------------------------------------- */

  /** Topological sort respecting dependsOn. */
  private resolveOrder(): string[] {
    const visited = new Set<string>();
    const visiting = new Set<string>();
    const order: string[] = [];

    const visit = (name: string) => {
      if (visited.has(name)) return;
      if (visiting.has(name)) {
        throw new Error(`Circular agent dependency: ${[...visiting, name].join(' → ')}`);
      }
      visiting.add(name);
      const entry = this.agents.get(name);
      if (!entry) throw new Error(`Unknown agent in dependency graph: ${name}`);
      for (const dep of entry.agent.dependsOn ?? []) visit(dep);
      visiting.delete(name);
      visited.add(name);
      order.push(name);
    };

    for (const name of this.agents.keys()) visit(name);
    return order;
  }
}

/** Singleton — created in main.ts */
let instance: AgentManager | null = null;

export function initAgentManager(core: JarvisCore): AgentManager {
  if (instance) return instance;
  instance = new AgentManager(core);
  return instance;
}

export function getAgentManager(): AgentManager {
  if (!instance) throw new Error('AgentManager not initialized');
  return instance;
}

export function destroyAgentManager(): void {
  instance = null;
}