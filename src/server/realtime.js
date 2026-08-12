import { randomUUID } from "node:crypto";
import WebSocket from "ws";

const DEFAULT_WS_URL = "wss://dashscope.aliyuncs.com/api-ws/v1/inference/";
const DEFAULT_MODEL = "qwen-audio-3.0-asr-flash-streaming";
const DEFAULT_TIMEOUT_MS = 20_000;

export function createRealtimeAsr({
  apiKey,
  model = DEFAULT_MODEL,
  wsUrl = DEFAULT_WS_URL,
  parameters = {},
  timeoutMs = DEFAULT_TIMEOUT_MS
} = {}) {
  if (!apiKey) throw new Error("DASHSCOPE_API_KEY is not configured.");

  let socket = null;
  let taskId = "";
  let startedResolve;
  let startedReject;
  const taskStarted = new Promise((resolve, reject) => {
    startedResolve = resolve;
    startedReject = reject;
  });
  let finishedResolve;
  let finishedReject;
  const taskFinished = new Promise((resolve, reject) => {
    finishedResolve = resolve;
    finishedReject = reject;
  });
  taskStarted.catch(() => undefined);
  taskFinished.catch(() => undefined);
  let open = false;
  let closed = false;
  let socketError = null;

  function sendFrame(chunk) {
    if (!open || closed) throw new Error("realtime_connection_closed");
    return new Promise((resolve, reject) => {
      socket.send(chunk, (error) => {
        if (error) reject(error);
        else resolve();
      });
    });
  }

  function runTask() {
    taskId = randomUUID().replace(/-/g, "").slice(0, 32);
    const message = {
      header: { action: "run-task", task_id: taskId, streaming: "duplex" },
      payload: {
        task_group: "audio",
        task: "asr",
        function: "recognition",
        model,
        parameters: {
          format: "pcm",
          sample_rate: 16_000,
          ...parameters
        },
        input: {}
      }
    };
    socket.send(JSON.stringify(message));
  }

  function finishTask() {
    if (!open) return;
    socket.send(JSON.stringify({
      header: { action: "finish-task", task_id: taskId, streaming: "duplex" },
      payload: { input: {} }
    }));
  }

  async function openConnection() {
    await new Promise((resolve, reject) => {
      socket = new WebSocket(wsUrl, {
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "user-agent": "koe-helper/1"
        }
      });
      socket.on("error", (error) => {
        clearTimeout(timer);
        socketError = error;
        const message = error?.message || "websocket_error";
        startedReject?.(new Error(message));
        finishedReject?.(new Error(message));
        startedReject = null;
        finishedReject = null;
      });
      const timer = setTimeout(() => {
        reject(new Error("realtime_connect_timeout"));
        try { socket.terminate(); } catch { /* ignore */ }
      }, timeoutMs);
      socket.on("open", () => {
        clearTimeout(timer);
        open = true;
        resolve();
      });
      socket.on("close", (code, reason) => {
        clearTimeout(timer);
        closed = true;
        open = false;
        console.log(`[koe] realtime ws closed code=${code} reason=${String(reason || "")}`);
        const detail = socketError?.message || reason || code;
        startedReject?.(new Error(`realtime_closed_before_start:${detail}`));
        finishedReject?.(new Error(`realtime_closed_before_finish:${detail}`));
        startedReject = null;
        finishedReject = null;
      });
    });
    if (socketError) throw socketError;
  }

  function onMessage(callbacks) {
    socket.on("message", (raw) => {
      let message;
      try {
        message = JSON.parse(String(raw));
      } catch {
        return;
      }
      const event = message?.header?.event || "";
      if (event === "task-started") {
        startedResolve?.();
        startedResolve = null;
        startedReject = null;
        return;
      }
      if (event === "result-generated") {
        const sentence = message?.payload?.output?.sentence;
        if (!sentence || sentence.heartbeat) return;
        callbacks.onSentence?.(sentence, Boolean(sentence.sentence_end));
        return;
      }
      if (event === "task-finished") {
        finishedResolve?.({ duration: message?.payload?.usage?.duration || 0 });
        finishedResolve = null;
        finishedReject = null;
        return;
      }
      if (event === "task-failed") {
        const error = new Error(message?.header?.error_message || "realtime_task_failed");
        error.code = message?.header?.error_code || "TASK_FAILED";
        startedReject?.(error);
        finishedReject?.(error);
        startedReject = null;
        finishedReject = null;
      }
    });
  }

  return {
    get taskStarted() { return taskStarted; },
    get taskFinished() { return taskFinished; },
    async connect(callbacks) {
      await openConnection();
      onMessage(callbacks);
      runTask();
      return Promise.race([
        taskStarted,
        delay(timeoutMs).then(() => {
          throw new Error("realtime_task_start_timeout");
        })
      ]);
    },
    sendFrame,
    finish() {
      if (!open || closed) return Promise.reject(new Error("realtime_connection_closed"));
      finishTask();
      return taskFinished;
    },
    close() {
      if (socket) {
        try { socket.close(1000, "bye"); } catch { /* ignore */ }
      }
      open = false;
    },
    terminate() {
      if (socket) {
        try { socket.terminate(); } catch { /* ignore */ }
      }
      open = false;
      closed = true;
    },
    get closed() { return closed; }
  };
}

function delay(ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}
