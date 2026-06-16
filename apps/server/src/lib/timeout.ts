import { HttpError } from "./http.js";

export class TimeoutError extends HttpError {
  readonly isTimeout = true;

  constructor(public label: string, public timeoutMs: number) {
    super(504, `${label} timed out after ${timeoutMs}ms`);
  }
}

function timeoutError(label: string, timeoutMs: number) {
  return new TimeoutError(label, timeoutMs);
}

export async function fetchWithTimeout(
  url: string,
  options: RequestInit = {},
  timeoutMs = 5_000
): Promise<Response> {
  return withTimeout((signal) => fetch(url, { ...options, signal }), timeoutMs, url);
}

export async function withTimeout<T>(
  promiseFactory: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
  label: string
): Promise<T> {
  const controller = new AbortController();
  let timeout: NodeJS.Timeout | null = null;
  const operation = Promise.resolve()
    .then(() => promiseFactory(controller.signal))
    .catch((error) => {
      if (controller.signal.aborted && error instanceof DOMException && error.name === "AbortError") {
        throw timeoutError(label, timeoutMs);
      }
      throw error;
    });

  try {
    return await Promise.race([
      operation,
      new Promise<T>((_resolve, reject) => {
        timeout = setTimeout(() => {
          console.warn(`[timeout] ${label} exceeded ${timeoutMs}ms`);
          controller.abort();
          reject(timeoutError(label, timeoutMs));
        }, timeoutMs);
      })
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
    operation.catch(() => undefined);
  }
}
