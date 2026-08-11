export function createSemaphore(maxConcurrent) {
  const max = Math.max(1, Number(maxConcurrent) || 1);
  let active = 0;
  const queue = [];

  function acquire() {
    return new Promise((resolve) => {
      const task = () => {
        active += 1;
        resolve(release);
      };
      if (active < max) task();
      else queue.push(task);
    });
  }

  function release() {
    active = Math.max(0, active - 1);
    const next = queue.shift();
    if (next) next();
  }

  return { acquire };
}
