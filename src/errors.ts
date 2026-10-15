/**
 * True only for the API's 404 "Container not found" (a brand-new container
 * nothing has been written to). Other 404s are rethrown.
 */
export function isContainerNotFound(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  if ((err as { status?: unknown }).status !== 404) return false;
  const body = (err as { body?: unknown }).body;
  const code =
    body && typeof body === "object" && "code" in body
      ? String((body as { code?: unknown }).code)
      : "";
  return /container/i.test(err.message) || /container/i.test(code);
}
