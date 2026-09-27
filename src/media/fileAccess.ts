/**
 * Checks whether picked files can still be read. On Android a picked video is a handle to a
 * content:// URI whose read grant can lapse (TL-009); reads then fail with "network error" or
 * NotReadableError. Reads one small range per file from its start and end.
 */
export async function unreadableFiles(files: readonly File[]): Promise<File[]> {
  const unique = [...new Set(files)];
  const results = await Promise.all(
    unique.map(async (f) => {
      try {
        await f.slice(0, 1024).arrayBuffer();
        await f.slice(Math.max(0, f.size - 1024)).arrayBuffer();
        return null;
      } catch {
        return f;
      }
    }),
  );
  return results.filter((f): f is File => f !== null);
}

/** Error messages that mean "the file could not be read", as opposed to decode/encode errors. */
export const isReadError = (message: string) =>
  /network error|NotReadable|could not be read/i.test(message);
