const FINAL_PREFIX = 'files/';
const UPLOAD_PREFIX = 'uploads/';

/**
 * Where a version's checked bytes live. Built from ids only (plan 3b, S3). No
 * link the API signs ever writes here: only `FilesService.complete` does, by a
 * server-side copy.
 */
export function finalKeyFor(tenantId: string, fileId: string, versionId: string): string {
  return `${FINAL_PREFIX}${tenantId}/${fileId}/${versionId}`;
}

/**
 * Where the client uploads. Derived from the final key, so it is never stored
 * and the two cannot drift apart. A bucket lifecycle rule expires this prefix.
 */
export function uploadKeyFor(finalKey: string): string {
  if (!finalKey.startsWith(FINAL_PREFIX)) {
    throw new Error(`Not a final storage key: ${finalKey}`);
  }
  return `${UPLOAD_PREFIX}${finalKey.slice(FINAL_PREFIX.length)}`;
}
