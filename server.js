const http = require("http");
const { send } = require("./lib/http");
const { handle } = require("./lib/routes");

const PORT = Number(process.env.PORT || 3020);

const server = http.createServer((req, res) => {
  handle(req, res).catch((error) =>
    send(res, error.status || 500, {
      error: error.message || "服务器错误",
      ...(error.blockers ? { blockers: error.blockers } : {})
    })
  );
});

server.listen(PORT, () => {
  console.log(`Rubbing repair API running at http://127.0.0.1:${PORT}`);
});
