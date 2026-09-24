const { makeId } = require("./storage");

// 验收规则层：逐项验收的业务规则，不直接关心 HTTP 与文件存储
//
// 缺损项状态机：
//   pending   待入批
//   in_repair 修复中（批次内未交）
//   submitted 已提交，待验收
//   rejected  退修（继续留在原批次等待再交）
//   repaired  验收通过（已修复）
//
// 每次修复提交生成一条 submission 记录，验收结论写在该记录上；
// 重新提交只新增一条，不覆盖旧记录，历史结论完整保留。

function httpError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function findRubbing(db, rubbingId) {
  const rubbing = db.rubbings.find((item) => item.id === rubbingId);
  if (!rubbing) throw httpError(404, "拓片不存在");
  return rubbing;
}

function findDamage(db, damageId) {
  const damage = db.damages.find((item) => item.id === damageId);
  if (!damage) throw httpError(404, "缺损项不存在");
  return damage;
}

function findBatch(db, batchId) {
  const batch = db.batches.find((item) => item.id === batchId);
  if (!batch) throw httpError(404, "修补批次不存在");
  return batch;
}

function findSubmission(db, submissionId) {
  const submission = db.submissions.find((item) => item.id === submissionId);
  if (!submission) throw httpError(404, "提交记录不存在");
  return submission;
}

// 批次内各状态数量
function damageCounts(damages) {
  return {
    total: damages.length,
    unsubmitted: damages.filter((item) => item.status === "pending" || item.status === "in_repair").length,
    submitted: damages.filter((item) => item.status === "submitted").length,
    rejected: damages.filter((item) => item.status === "rejected").length,
    repaired: damages.filter((item) => item.status === "repaired").length
  };
}

function enrichBatch(db, batch) {
  const damages = db.damages.filter((item) => batch.damageIds.includes(item.id));
  return { ...batch, damages, counts: damageCounts(damages) };
}

function createBatch(db, { name, damageIds, note }) {
  if (!Array.isArray(damageIds) || damageIds.length === 0) {
    throw httpError(400, "damageIds必须是非空数组");
  }
  const ids = [...new Set(damageIds)];
  const damages = ids.map((id) => db.damages.find((item) => item.id === id));
  const missing = ids.filter((id, index) => !damages[index]);
  if (missing.length) throw httpError(400, `缺损项不存在：${missing.join(", ")}`);
  const repaired = damages.filter((item) => item.status === "repaired");
  if (repaired.length) {
    throw httpError(409, `缺损项已验收通过，不能重复入批：${repaired.map((item) => item.id).join(", ")}`);
  }
  const busy = damages.filter((item) => {
    if (!item.batchId) return false;
    const batch = db.batches.find((entry) => entry.id === item.batchId);
    return batch && batch.status === "open";
  });
  if (busy.length) {
    throw httpError(409, `缺损项已在未完成的批次中：${busy.map((item) => item.id).join(", ")}`);
  }
  const batch = {
    id: makeId("batch"),
    name,
    status: "open",
    damageIds: ids,
    note: note || "",
    createdAt: new Date().toISOString(),
    completedAt: null
  };
  db.batches.push(batch);
  damages.forEach((damage) => {
    damage.batchId = batch.id;
    damage.status = "in_repair";
  });
  return batch;
}

// 修复人提交：处理说明 + 修复后照片，每次提交新增一条记录
function submitRepair(db, damageId, { repairNote, afterPhotoUrl }) {
  const damage = findDamage(db, damageId);
  if (!damage.batchId) throw httpError(409, "缺损项未加入修补批次，不能提交验收");
  const batch = findBatch(db, damage.batchId);
  if (batch.status !== "open") throw httpError(409, "批次已完成，不能再提交");
  if (damage.status === "submitted") throw httpError(409, "该缺损项已提交，请等待验收结论");
  if (damage.status === "repaired") throw httpError(409, "该缺损项已验收通过，无需再交");
  const submission = {
    id: makeId("submission"),
    damageId: damage.id,
    batchId: batch.id,
    repairNote,
    afterPhotoUrl,
    submittedAt: new Date().toISOString(),
    review: null
  };
  db.submissions.push(submission);
  damage.status = "submitted";
  damage.repairNote = repairNote;
  damage.afterPhotoUrl = afterPhotoUrl;
  return submission;
}

// 同一缺损项的全部提交记录（含各自独立的验收结论），按提交时间排序
function listSubmissions(db, damageId) {
  findDamage(db, damageId);
  return db.submissions
    .filter((item) => item.damageId === damageId)
    .sort((a, b) => a.submittedAt.localeCompare(b.submittedAt));
}

// 验收人给出结论：通过或退修，退修必须写原因；每条提交只验收一次
function reviewSubmission(db, submissionId, { result, reason, reviewer }) {
  const submission = findSubmission(db, submissionId);
  if (submission.review) throw httpError(409, "该提交已有验收结论，不能重复验收");
  if (result !== "approved" && result !== "rejected") {
    throw httpError(400, "result 必须是 approved（通过）或 rejected（退修）");
  }
  if (result === "rejected" && !reason) throw httpError(400, "退修必须填写原因");
  const damage = findDamage(db, submission.damageId);
  submission.review = {
    result,
    reason: reason || "",
    reviewer: reviewer || "",
    reviewedAt: new Date().toISOString()
  };
  if (result === "approved") {
    damage.status = "repaired";
    damage.repairedAt = submission.review.reviewedAt;
  } else {
    // 退修：缺损项继续留在原批次，等待修复人重新提交
    damage.status = "rejected";
  }
  return { submission, damage };
}

// 批次完成：还有未交、待验收或退修项时不能完成；
// 完成只把验收通过的项记为已修复，退修项继续留在原批次等待再交
function completeBatch(db, batchId, note) {
  const batch = findBatch(db, batchId);
  if (batch.status !== "open") throw httpError(409, "批次已完成，不能重复完成");
  const damages = db.damages.filter((item) => batch.damageIds.includes(item.id));
  const counts = damageCounts(damages);
  const blocking = counts.unsubmitted + counts.submitted + counts.rejected;
  if (blocking > 0) {
    throw httpError(
      409,
      `批次还有未通过验收的缺损项（未交${counts.unsubmitted}项、待验收${counts.submitted}项、退修${counts.rejected}项），不能完成`
    );
  }
  batch.status = "completed";
  batch.completedAt = new Date().toISOString();
  if (note !== undefined) batch.note = note;
  damages.forEach((damage) => {
    if (damage.status === "repaired" && !damage.repairedAt) damage.repairedAt = batch.completedAt;
  });
  return batch;
}

module.exports = {
  findRubbing,
  findDamage,
  findBatch,
  damageCounts,
  enrichBatch,
  createBatch,
  submitRepair,
  listSubmissions,
  reviewSubmission,
  completeBatch
};
