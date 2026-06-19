const express = require("express");

function startKeepAlive() {
  const app = express();
  app.get("/", (req, res) => res.send("Knight is alive ⚔️"));
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => console.log(`🌐 Keep-alive server running on port ${PORT}`));
}

module.exports = { startKeepAlive };
