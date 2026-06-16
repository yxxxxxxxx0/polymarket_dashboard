export function createLimiter(maxConcurrent: number) {
  const limit = Math.max(1, Math.floor(maxConcurrent));
  let active = 0;
  const queue: Array<() => void> = [];

  const pump = () => {
    if (active >= limit) return;
    const next = queue.shift();
    if (!next) return;
    active += 1;
    next();
  };

  return async function limitTask<T>(task: () => Promise<T>): Promise<T> {
    await new Promise<void>((resolve) => {
      queue.push(resolve);
      pump();
    });

    try {
      return await task();
    } finally {
      active -= 1;
      pump();
    }
  };
}
