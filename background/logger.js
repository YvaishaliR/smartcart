// background/logger.js
// Observability: structured logging with traces for hackathon demo

export class Logger {
  constructor(component) {
    this.component = component;
    this.logs = [];
    this.traces = [];
  }

  log(level, message, data = null) {
    const entry = {
      timestamp: new Date().toISOString(),
      level,
      component: this.component,
      message,
      data,
      id: crypto.randomUUID?.() || Math.random().toString(36).slice(2),
    };
    this.logs.push(entry);
    console[level === "error" ? "error" : level === "warn" ? "warn" : "log"](
      `[BlinkLess:${this.component}] ${message}`,
      data || ""
    );

    // Persist to chrome.storage for observability panel
    chrome.storage.local.get("agent_logs", (res) => {
      const existing = res.agent_logs || [];
      const updated = [...existing, entry].slice(-200); // Keep last 200 logs
      chrome.storage.local.set({ agent_logs: updated });
    });

    // Broadcast to popup
    chrome.runtime.sendMessage({ type: "LOG_ENTRY", entry }).catch(() => {});
  }

  info(msg, data) {
    this.log("info", msg, data);
  }
  warn(msg, data) {
    this.log("warn", msg, data);
  }
  error(msg, data) {
    this.log("error", msg, data);
  }

  startTrace(name) {
    const trace = { name, start: Date.now(), spans: [] };
    this.traces.push(trace);
    return {
      addSpan: (spanName, data) => {
        trace.spans.push({ name: spanName, time: Date.now() - trace.start, data });
      },
      end: () => {
        trace.duration = Date.now() - trace.start;
        this.info(`Trace "${name}" completed in ${trace.duration}ms`);
      },
    };
  }

  getLogs() {
    return this.logs;
  }

  clear() {
    this.logs = [];
    this.traces = [];
  }
}
