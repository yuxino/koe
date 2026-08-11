import test from "node:test";
import assert from "node:assert/strict";
import { createSemaphore } from "../src/server/semaphore.js";

test("limits concurrent work to the configured maximum", async () => {
  const semaphore = createSemaphore(2);
  let active = 0;
  let maxActive = 0;

  async function work() {
    const release = await semaphore.acquire();
    active += 1;
    maxActive = Math.max(maxActive, active);
    await new Promise((resolve) => setTimeout(resolve, 20));
    active -= 1;
    release();
  }

  await Promise.all([work(), work(), work(), work(), work()]);
  assert.ok(maxActive <= 2, `max active was ${maxActive}`);
  assert.ok(maxActive >= 2, `expected some overlap, got ${maxActive}`);
});

test("queues waiters until a slot frees up", async () => {
  const semaphore = createSemaphore(1);
  const order = [];
  const first = await semaphore.acquire();
  const second = semaphore.acquire().then((release) => {
    order.push("second-started");
    release();
  });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.deepEqual(order, []);
  first();
  await second;
  assert.deepEqual(order, ["second-started"]);
});
