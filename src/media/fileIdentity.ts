/**
 * Identifies a user's file across page reloads. `File` objects from the picker cannot be
 * persisted, so after a reload the user re-selects the file and we match it by these fields.
 */
export interface FileIdentity {
  name: string;
  size: number;
  lastModified: number;
}

export const identityOf = (f: File): FileIdentity => ({
  name: f.name,
  size: f.size,
  lastModified: f.lastModified,
});

export const sameFile = (a: FileIdentity, b: FileIdentity) =>
  a.name === b.name && a.size === b.size && a.lastModified === b.lastModified;
