/**
 * ServiceLoader — discovers and loads installed PandoService packages.
 *
 * If the npm package is installed, the service loads. If not, it's skipped.
 * No config file needed. Standard npm dependency management.
 *
 * See docs/SERVICE-ARCHITECTURE-ROADMAP.md for the full design.
 */
import type { PandoService, ServiceContext } from '@pando/shared';

/** Packages to attempt loading as services (order matters for dependency resolution) */
const SERVICE_PACKAGES: string[] = [
  '@pando-code/core',
  // future: '@pando/exchange', '@pando/storage', etc.
];

export class ServiceLoader {
  private services = new Map<string, PandoService>();
  private context: ServiceContext;

  constructor(context: ServiceContext) {
    this.context = context;
  }

  /**
   * Attempt to load all known service packages.
   * Missing packages are silently skipped — that's the whole point.
   */
  async loadAll(): Promise<void> {
    for (const pkg of SERVICE_PACKAGES) {
      await this.loadService(pkg);
    }
  }

  /**
   * Load a single service by npm package name.
   * Returns true if the service loaded successfully.
   */
  async loadService(packageName: string): Promise<boolean> {
    try {
      const mod = await import(packageName);
      if (typeof mod.createService !== 'function') {
        console.log(`[services] ${packageName} has no createService() export — skipping`);
        return false;
      }

      const svc: PandoService = mod.createService();
      await svc.start(this.context);
      this.services.set(svc.id, svc);
      console.log(`[services] Started ${svc.id} v${svc.version} — capabilities: [${svc.capabilities.join(', ')}]`);
      return true;
    } catch (err: any) {
      if (err?.code === 'ERR_MODULE_NOT_FOUND' || err?.code === 'MODULE_NOT_FOUND') {
        console.log(`[services] ${packageName} not installed — skipping`);
      } else {
        console.error(`[services] Failed to load ${packageName}:`, err?.message || err);
      }
      return false;
    }
  }

  /** Get a loaded service by its ID */
  get(serviceId: string): PandoService | undefined {
    return this.services.get(serviceId);
  }

  /** Check if a service is loaded and healthy */
  isHealthy(serviceId: string): boolean {
    return this.services.get(serviceId)?.healthy() ?? false;
  }

  /** Get all loaded services */
  getAll(): PandoService[] {
    return Array.from(this.services.values());
  }

  /** Get all loaded service IDs */
  getIds(): string[] {
    return Array.from(this.services.keys());
  }

  /** Stop all services gracefully */
  async stopAll(): Promise<void> {
    for (const [id, svc] of this.services) {
      try {
        await svc.stop();
        console.log(`[services] Stopped ${id}`);
      } catch (err: any) {
        console.error(`[services] Error stopping ${id}:`, err?.message || err);
      }
    }
    this.services.clear();
  }

  /** Query a capability across all loaded services */
  getCapability(name: string): any {
    for (const svc of this.services.values()) {
      if (svc.capabilities.includes(name)) {
        return svc;
      }
    }
    return null;
  }
}
