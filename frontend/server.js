const express = require("express");
const path = require("path");

const app = express();
const port = Number(process.env.PORT || 3000);

app.use(express.static(path.join(__dirname, "public")));

app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

app.listen(port, () => {
  console.log(`[frontend] listening on ${port}`);
});
