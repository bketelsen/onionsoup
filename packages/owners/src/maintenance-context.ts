/** A stopped maintenance pass may save receipts, but may not start another external effect. */
export interface MaintenanceContext {
  readonly signal: AbortSignal;
  check(): void;
  phase<T>(name: string, operation: () => Promise<T>): Promise<T>;
}

/** The transport was invoked, so a failed response cannot prove that its effect did not happen. */
export class MaintenanceUncertainError extends Error {
  constructor() { super('plugin_maintenance_effect_uncertain'); }
}

/** Positive local proof: the effect transport was never invoked by this call. */
export class MaintenanceEffectNotStarted extends Error {
  constructor() { super('plugin_maintenance_effect_not_started'); }
}
