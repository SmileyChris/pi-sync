/**
 * pi-sync types (re-exported for external consumers)
 *
 * The main extension in index.ts inlines these types to avoid
 * import issues with jiti. This file exists for documentation
 * and potential external use.
 */

export interface SyncedFile {
  content: string | { val: string };
  installedAt: number;
  source?: string;
  deletedAt?: number;
  deletedBy?: string;
}

export interface PiConfigDocument {
  settings: Record<string, unknown>;
  models: Record<string, unknown>;
  extensions: Record<string, SyncedFile>;
  skills: Record<string, SyncedFile>;
  prompts: Record<string, SyncedFile>;
  sessions: Record<string, SyncedFile>;
  localOnly: Record<string, string[]>;
  lastSync: Record<string, number>;
}

export interface SyncConfig {
  port: number;
  peers: string[];
  syncSettings: boolean;
  syncExtensions: boolean;
  syncSkills: boolean;
  syncModels: boolean;
  syncPrompts: boolean;
  syncSessions: boolean;
}
