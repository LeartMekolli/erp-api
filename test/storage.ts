/**
 * Uploads to a presigned PUT URL the way a browser or client would.
 *
 * `fetch` computes `Content-Length` from the body and refuses a body that
 * disagrees with it, so a `content-length` in `headers` is dropped: a client
 * that sends more bytes than were signed sends an honest length, and storage
 * refuses the signature.
 */
export async function putToSignedUrl(
  url: string,
  body: Buffer,
  headers: Record<string, string>,
): Promise<Response> {
  const sent = Object.fromEntries(
    Object.entries(headers).filter(([name]) => name.toLowerCase() !== 'content-length'),
  );
  return fetch(url, { method: 'PUT', body: new Uint8Array(body), headers: sent });
}
