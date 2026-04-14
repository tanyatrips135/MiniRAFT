const fs = require("fs");
const path = require("path");

function createLogger(serviceName) {
  const logDir = process.env.LOG_DIR || path.join(__dirname, "logs");
  fs.mkdirSync(logDir, { recursive: true });

  const safeName = serviceName.replace(/[^a-zA-Z0-9_-]/g, "_");
  const logPath = path.join(logDir, `${safeName}.jsonl`);

  function write(level, event, details = {}) {
    const entry = {
      ts: new Date().toISOString(),
      level,
      service: serviceName,
      event,
      details
    };

    const line = JSON.stringify(entry);
    fs.appendFile(logPath, `${line}\n`, () => {});
    console.log(line);
  }

  return {
    info(event, details) {
      write("info", event, details);
    },
    warn(event, details) {
      write("warn", event, details);
    },
    error(event, details) {
      write("error", event, details);
    }
  };
}

module.exports = {
  createLogger
};
