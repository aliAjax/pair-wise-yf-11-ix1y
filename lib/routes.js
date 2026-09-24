const { readDb, writeDb, makeId } = require("./storage");
const { send, parseBody, required } = require("./http");
const acceptance = require("./acceptance");

const {
  DAMAGE_STATUS,
  BATCH_STATUS,
  findDamage,
  findBatch,
  submissionsOf,
  submitRepair,
  reviewSubmission,
  completeBatch,
  enrichBatch
} = acceptance;

const routes = [
  "GET /health",
  "GET /rubbings",
  "POST /rubbings",
  "GET /rubbings/:id/damages",
  "POST /rubbings/:id/damages",
  "GET /damages?status=&type=",
  "GET /damages/:id",
  "PATCH /damages/:id （仅可改 position/type/beforePhotoUrl，状态只能走提交与验收）",
  "POST /damages/:id/submissions （修复人交处理说明+修复后照片）",
  "GET /damages/:id/submissions （历次提交与验收结论，每次一条不覆盖）",
  "POST /submissions/:id/review （验收人 pass/reject，reject 必须填 rejectReason）",
  "GET /batches",
  "POST /batches",
  "GET /batches/:id （含各状态数量 statusCounts）",
  "POST /batches/:id/complete （有未交/待验/退修项时拒绝）"
];

function findRubbing(db, rubbingId) {
  const rubbing = db.rubbings.find((item) => item.id === rubbingId);
  if (!rubbing) {
    const error = new Error("拓片不存在");
    error.status = 404;
    throw error;
  }
  return rubbing;
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
        pendingDamages: damages.filter((item) => item.status !== DAMAGE_STATUS.REPAIRED).length
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
    const rubbingId = rubbingDamagesMatch[1];
    findRubbing(db, rubbingId);
    return send(res, 200, { data: db.damages.filter((item) => item.rubbingId === rubbingId) });
  }

  if (rubbingDamagesMatch && req.method === "POST") {
    const rubbingId = rubbingDamagesMatch[1];
    findRubbing(db, rubbingId);
    const body = await parseBody(req);
    required(body, ["position", "type", "beforePhotoUrl"]);
    const damage = {
      id: makeId("damage"),
      rubbingId,
      position: body.position,
      type: body.type,
      beforePhotoUrl: body.beforePhotoUrl,
      afterPhotoUrl: "",
      status: DAMAGE_STATUS.PENDING,
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
    const data = db.damages.filter(
      (item) => (!status || item.status === status) && (!type || item.type === type)
    );
    return send(res, 200, { data });
  }

  const damageSubmissionsMatch = pathname.match(/^\/damages\/([^/]+)\/submissions$/);
  if (damageSubmissionsMatch && req.method === "GET") {
    const damage = findDamage(db, damageSubmissionsMatch[1]);
    return send(res, 200, {
      data: {
        damageId: damage.id,
        currentStatus: damage.status,
        submissions: submissionsOf(db, damage.id)
      }
    });
  }

  // 修复人提交：处理说明 + 修复后照片，每次追加一条独立记录
  if (damageSubmissionsMatch && req.method === "POST") {
    const body = await parseBody(req);
    required(body, ["repairNote", "afterPhotoUrl"]);
    const { damage, submission } = submitRepair(db, damageSubmissionsMatch[1], body);
    await writeDb(db);
    return send(res, 201, { data: { damage, submission } });
  }

  const reviewMatch = pathname.match(/^\/submissions\/([^/]+)\/review$/);
  if (reviewMatch && req.method === "POST") {
    const body = await parseBody(req);
    required(body, ["verdict"]);
    const { damage, submission, batch } = reviewSubmission(db, reviewMatch[1], body);
    await writeDb(db);
    return send(res, 200, {
      data: {
        submission,
        damage: { id: damage.id, status: damage.status },
        batch: { id: batch.id, status: batch.status }
      }
    });
  }

  const damageMatch = pathname.match(/^\/damages\/([^/]+)$/);
  if (damageMatch && req.method === "GET") {
    const damage = findDamage(db, damageMatch[1]);
    return send(res, 200, {
      data: { ...damage, submissions: submissionsOf(db, damage.id) }
    });
  }

  if (damageMatch && req.method === "PATCH") {
    const damage = findDamage(db, damageMatch[1]);
    const body = await parseBody(req);
    // 状态、照片与处理说明不得用通用编辑接口改写，必须走提交/验收闭环
    const guarded = ["status", "afterPhotoUrl", "repairNote", "batchId", "repairedAt"];
    const attempted = guarded.filter((field) => body[field] !== undefined);
    if (attempted.length) {
      return send(
        res,
        400,
        { error: `字段 ${attempted.join(", ")} 不允许直接修改；验收状态请通过提交与验收接口变更` }
      );
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
    return send(res, 200, { data: db.batches.map((batch) => enrichBatch(db, batch)) });
  }

  if (req.method === "POST" && pathname === "/batches") {
    const body = await parseBody(req);
    required(body, ["name", "damageIds"]);
    if (!Array.isArray(body.damageIds) || body.damageIds.length === 0) {
      return send(res, 400, { error: "damageIds必须是非空数组" });
    }
    const damageIds = [...new Set(body.damageIds)];
    const invalid = damageIds.filter((id) => !db.damages.find((damage) => damage.id === id));
    if (invalid.length) return send(res, 400, { error: `缺损项不存在：${invalid.join(", ")}` });

    const busy = [];
    const repaired = [];
    damageIds.forEach((id) => {
      const damage = db.damages.find((item) => item.id === id);
      if (damage.batchId && damage.status !== DAMAGE_STATUS.REPAIRED) {
        busy.push(`${id}（已在批次 ${damage.batchId}）`);
      }
      if (damage.status === DAMAGE_STATUS.REPAIRED) repaired.push(id);
    });
    if (busy.length) return send(res, 409, { error: `缺损项已在其他批次中：${busy.join("、")}` });
    if (repaired.length) return send(res, 400, { error: `缺损项已修复，不能再进批次：${repaired.join(", ")}` });

    const batch = {
      id: makeId("batch"),
      name: body.name,
      status: BATCH_STATUS.OPEN,
      damageIds,
      note: body.note || "",
      createdAt: new Date().toISOString(),
      completedAt: null
    };
    db.batches.push(batch);
    db.damages.forEach((damage) => {
      if (damageIds.includes(damage.id)) {
        damage.batchId = batch.id;
        damage.status = DAMAGE_STATUS.IN_REPAIR;
      }
    });
    await writeDb(db);
    return send(res, 201, { data: enrichBatch(db, batch, { detailed: true }) });
  }

  const batchMatch = pathname.match(/^\/batches\/([^/]+)$/);
  if (batchMatch && req.method === "GET") {
    const batch = findBatch(db, batchMatch[1]);
    return send(res, 200, { data: enrichBatch(db, batch, { detailed: true }) });
  }

  const completeMatch = pathname.match(/^\/batches\/([^/]+)\/complete$/);
  if (completeMatch && req.method === "POST") {
    const body = await parseBody(req);
    const batch = completeBatch(db, completeMatch[1]);
    if (body.note !== undefined) batch.note = body.note;
    await writeDb(db);
    return send(res, 200, { data: enrichBatch(db, batch, { detailed: true }) });
  }

  return send(res, 404, { error: "接口不存在", routes });
}

module.exports = { routes, handle };
