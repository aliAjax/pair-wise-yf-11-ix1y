const http = require("http");
const { readDb, writeDb, makeId } = require("./src/storage");
const review = require("./src/review");

const PORT = Number(process.env.PORT || 3020);

const routes = [
  "GET /health",
  "GET /rubbings",
  "POST /rubbings",
  "GET /rubbings/:id/damages",
  "POST /rubbings/:id/damages",
  "GET /damages?status=&type=",
  "PATCH /damages/:id",
  "POST /damages/:id/submissions",
  "GET /damages/:id/submissions",
  "POST /submissions/:id/review",
  "GET /batches",
  "POST /batches",
  "GET /batches/:id",
  "POST /batches/:id/complete"
];

function send(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body, null, 2));
}

async function parseBody(req) {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    const error = new Error("请求体必须是合法JSON");
    error.status = 400;
    throw error;
  }
}

function required(body, fields) {
  const missing = fields.filter((field) => body[field] === undefined || body[field] === "");
  if (missing.length) {
    const error = new Error(`缺少字段：${missing.join(", ")}`);
    error.status = 400;
    throw error;
  }
}

async function handle(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const pathname = url.pathname;
  const db = await readDb();

  if (req.method === "GET" && pathname === "/health") {
    return send(res, 200, { ok: true, service: "rubbing-repair-api", routes });
  }

  if (req.method === "GET" && pathname === "/rubbings") {
    const data = db.rubbings.map((rubbing) => {
      const damages = db.damages.filter((item) => item.rubbingId === rubbing.id);
      return {
        ...rubbing,
        damageCount: damages.length,
        pendingDamages: damages.filter((item) => item.status !== "repaired").length
      };
    });
    return send(res, 200, { data });
  }

  if (req.method === "POST" && pathname === "/rubbings") {
    const body = await parseBody(req);
    required(body, ["code", "source", "paperSize"]);
    const rubbing = {
      id: makeId("rubbing"),
      code: body.code,
      source: body.source,
      paperSize: body.paperSize,
      note: body.note || "",
      createdAt: new Date().toISOString()
    };
    db.rubbings.push(rubbing);
    await writeDb(db);
    return send(res, 201, { data: rubbing });
  }

  const rubbingDamagesMatch = pathname.match(/^\/rubbings\/([^/]+)\/damages$/);
  if (rubbingDamagesMatch && req.method === "GET") {
    review.findRubbing(db, rubbingDamagesMatch[1]);
    return send(res, 200, { data: db.damages.filter((item) => item.rubbingId === rubbingDamagesMatch[1]) });
  }

  if (rubbingDamagesMatch && req.method === "POST") {
    review.findRubbing(db, rubbingDamagesMatch[1]);
    const body = await parseBody(req);
    required(body, ["position", "type", "beforePhotoUrl"]);
    const damage = {
      id: makeId("damage"),
      rubbingId: rubbingDamagesMatch[1],
      position: body.position,
      type: body.type,
      beforePhotoUrl: body.beforePhotoUrl,
      afterPhotoUrl: "",
      status: "pending",
      repairNote: "",
      batchId: null,
      createdAt: new Date().toISOString(),
      repairedAt: null
    };
    db.damages.push(damage);
    await writeDb(db);
    return send(res, 201, { data: damage });
  }

  if (req.method === "GET" && pathname === "/damages") {
    const status = url.searchParams.get("status");
    const type = url.searchParams.get("type");
    const data = db.damages.filter((item) => (!status || item.status === status) && (!type || item.type === type));
    return send(res, 200, { data });
  }

  // 修复人提交：处理说明 + 修复后照片，每次提交新增一条记录
  const damageSubmissionsMatch = pathname.match(/^\/damages\/([^/]+)\/submissions$/);
  if (damageSubmissionsMatch && req.method === "POST") {
    const body = await parseBody(req);
    required(body, ["repairNote", "afterPhotoUrl"]);
    const submission = review.submitRepair(db, damageSubmissionsMatch[1], body);
    await writeDb(db);
    return send(res, 201, { data: submission });
  }

  // 同一缺损项的全部提交与验收结论（历史不覆盖）
  if (damageSubmissionsMatch && req.method === "GET") {
    return send(res, 200, { data: review.listSubmissions(db, damageSubmissionsMatch[1]) });
  }

  // 验收人给出通过/退修结论，退修必须写原因
  const submissionReviewMatch = pathname.match(/^\/submissions\/([^/]+)\/review$/);
  if (submissionReviewMatch && req.method === "POST") {
    const body = await parseBody(req);
    required(body, ["result"]);
    const { submission, damage } = review.reviewSubmission(db, submissionReviewMatch[1], body);
    await writeDb(db);
    return send(res, 200, { data: { submission, damage } });
  }

  const damagePatchMatch = pathname.match(/^\/damages\/([^/]+)$/);
  if (damagePatchMatch && req.method === "PATCH") {
    const damage = review.findDamage(db, damagePatchMatch[1]);
    const body = await parseBody(req);
    const blocked = ["status", "repairNote", "afterPhotoUrl", "repairedAt", "batchId"].filter(
      (field) => body[field] !== undefined
    );
    if (blocked.length) {
      return send(res, 400, {
        error: `字段 ${blocked.join(", ")} 只能通过提交/验收流程更新，不能直接修改`
      });
    }
    Object.assign(damage, {
      position: body.position ?? damage.position,
      type: body.type ?? damage.type,
      beforePhotoUrl: body.beforePhotoUrl ?? damage.beforePhotoUrl
    });
    await writeDb(db);
    return send(res, 200, { data: damage });
  }

  if (req.method === "GET" && pathname === "/batches") {
    return send(res, 200, { data: db.batches.map((batch) => review.enrichBatch(db, batch)) });
  }

  if (req.method === "POST" && pathname === "/batches") {
    const body = await parseBody(req);
    required(body, ["name", "damageIds"]);
    const batch = review.createBatch(db, body);
    await writeDb(db);
    return send(res, 201, { data: review.enrichBatch(db, batch) });
  }

  const batchMatch = pathname.match(/^\/batches\/([^/]+)$/);
  if (batchMatch && req.method === "GET") {
    const batch = review.findBatch(db, batchMatch[1]);
    return send(res, 200, { data: review.enrichBatch(db, batch) });
  }

  const completeMatch = pathname.match(/^\/batches\/([^/]+)\/complete$/);
  if (completeMatch && req.method === "POST") {
    const body = await parseBody(req);
    const batch = review.completeBatch(db, completeMatch[1], body.note);
    await writeDb(db);
    return send(res, 200, { data: review.enrichBatch(db, batch) });
  }

  return send(res, 404, { error: "接口不存在", routes });
}

const server = http.createServer((req, res) => {
  handle(req, res).catch((error) => send(res, error.status || 500, { error: error.message || "服务器错误" }));
});

server.listen(PORT, () => {
  console.log(`Rubbing repair API running at http://127.0.0.1:${PORT}`);
});
