/** Messages between VaultClient (main thread) and vault.worker.ts. */

/** OPFS directory holding the copies, one file per media id. */
export const VAULT_DIR = 'media';

export type ToVault = { type: 'store'; id: string; file: File } | { type: 'cancel'; id: string };

export type FromVault =
  | { type: 'progress'; id: string; fraction: number }
  | { type: 'done'; id: string; file: File }
  | { type: 'cancelled'; id: string }
  | { type: 'error'; id: string; message: string };
