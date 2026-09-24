const { makeId } = require("./storage");

// 缺损项状态：未进批次 pending → 修复中 in_repair → 待验收 submitted
//   → 验收通过 approved（结批后转 repaired）/ 验收退修 rejected（修复人重新提交回到 submitted）
const DAMAGE_STATUS = {
  PENDING: "pending",
  IN_REPAIR: "in_repair",
  SUBMITTED: "submitted",
  APPROVED: "approved",
  REPAIRED: "repaired",
  REJECTED: "rejected"
};

const BATCH_STATUS = { OPEN: "open", COMPLETED: "completed" };
const VERDICT = { PASS: "pass", REJECT: "reject" };

function fail(status, message, extra = {}) {
  const error = new Error(message);
  error.status = status;
  Object.assign(error, extra);
  return error;
}

function findDamage(db, damageId) {
  const damage = db.damages.find((item) => item.id === damageId);
  if (!damage) throw fail(404, "缺损项不存在");
  return damage;
}

function findBatch(db, batchId) {
  const batch = db.batches.find((item) => item.id === batchId);
  if (!batch) throw fail(404, "修补批次不存在");
  return batch;
}

function submissionsOf(db, damageId) {
  return db.submissions
    .filter((item) => item.damageId === damageId)
    .sort((a, b) => a.seq - b.seq);
}

// 每次提交都追加一条独立记录，重新交只加一条，绝不覆盖旧记录
function submitRepair(db, damageId, { repairNote, afterPhotoUrl }) {
  const damage = findDamage(db, damageId);
  if (!damage.batchId) throw fail(400, "缺损项尚未进入修补批次，不能提交");
  const batch = findBatch(db, damage.batchId);
  if (batch.status === BATCH_STATUS.COMPLETED) throw fail(400, "批次已完成，不能再提交");
  if (![DAMAGE_STATUS.IN_REPAIR, DAMAGE_STATUS.REJECTED].includes(damage.status)) {
    throw fail(400, `当前状态为${damage.status}，不能提交；仅修复中或退修项可提交`);
  }
  if (!repairNote || !String(repairNote).trim()) throw fail(400, "缺少处理说明 repairNote");
  if (!afterPhotoUrl || !String(afterPhotoUrl).trim()) throw fail(400, "缺少修复后照片 afterPhotoUrl");

  const seq = db.submissions.filter((item) => item.damageId === damageId).length + 1;
  const submission = {
    id: makeId("submission"),
    damageId,
    batchId: damage.batchId,
    seq,
    repairNote: String(repairNote).trim(),
    afterPhotoUrl: String(afterPhotoUrl).trim(),
    submittedAt: new Date().toISOString(),
    verdict: null,
    rejectReason: "",
    reviewedBy: "",
    reviewedAt: null
  };
  db.submissions.push(submission);

  // 缺损项上只保留最新一次提交的快照，历史明细始终看 submissions
  damage.repairNote = submission.repairNote;
  damage.afterPhotoUrl = submission.afterPhotoUrl;
  damage.status = DAMAGE_STATUS.SUBMITTED;
  return { damage, submission };
}

// 验收人对某一次提交给出独立结论：通过或退修；退修必须写原因
function reviewSubmission(db, submissionId, { verdict, rejectReason, reviewedBy }) {
  const submission = db.submissions.find((item) => item.id === submissionId);
  if (!submission) throw fail(404, "提交记录不存在");
  if (submission.verdict) throw fail(409, `该提交已验收（${submission.verdict}），结论不可修改`);
  const damage = findDamage(db, submission.damageId);
  const batch = findBatch(db, submission.batchId);
  if (batch.status === BATCH_STATUS.COMPLETED) throw fail(400, "批次已完成，不能再验收");
  if (damage.status !== DAMAGE_STATUS.SUBMITTED) {
    throw fail(409, `缺损项当前状态为${damage.status}，本次提交已不在待验收状态`);
  }
  if (![VERDICT.PASS, VERDICT.REJECT].includes(verdict)) {
    throw fail(400, "verdict 必须是 pass（通过）或 reject（退修）");
  }
  if (verdict === VERDICT.REJECT && (!rejectReason || !String(rejectReason).trim())) {
    throw fail(400, "退修必须填写原因 rejectReason");
  }

  submission.verdict = verdict;
  submission.rejectReason = verdict === VERDICT.REJECT ? String(rejectReason).trim() : "";
  submission.reviewedBy = reviewedBy || "";
  submission.reviewedAt = new Date().toISOString();

  if (verdict === VERDICT.PASS) {
    damage.status = DAMAGE_STATUS.APPROVED;
  } else {
    // 退修项继续留在原批次，状态回到修复中，等待修复人再次提交
    damage.status = DAMAGE_STATUS.REJECTED;
  }
  return { damage, submission, batch };
}

function batchDamages(db, batch) {
  return db.damages.filter((item) => batch.damageIds.includes(item.id));
}

// 结批门槛：批次里还有未交或退修（或待验收）项时，不允许完成
function completionBlockers(db, batch) {
  const blockers = {
    in_repair: 0, // 修复中，一次都没交
    submitted: 0, // 已交未验
    rejected: 0 // 退修，等待再交
  };
  for (const damage of batchDamages(db, batch)) {
    if (Object.prototype.hasOwnProperty.call(blockers, damage.status)) blockers[damage.status] += 1;
  }
  return blockers;
}

function canComplete(db, batch) {
  const blockers = completionBlockers(db, batch);
  const blocking = blockers.in_repair + blockers.submitted + blockers.rejected;
  return { ok: blocking === 0, blockers };
}

// 结批只把验收通过项记为已修复；退修项按规则会被 canComplete 拦在门外
function completeBatch(db, batchId) {
  const batch = findBatch(db, batchId);
  if (batch.status === BATCH_STATUS.COMPLETED) throw fail(400, "批次已完成");
  const check = canComplete(db, batch);
  if (!check.ok) {
    throw fail(
      409,
      `批次不能完成：还有 ${check.blockers.in_repair} 项未提交、${check.blockers.submitted} 项待验收、${check.blockers.rejected} 项退修待再交`,
      { blockers: check.blockers }
    );
  }
  const timestamp = new Date().toISOString();
  batch.status = BATCH_STATUS.COMPLETED;
  batch.completedAt = timestamp;
  batchDamages(db, batch).forEach((damage) => {
    if (damage.status === DAMAGE_STATUS.APPROVED) {
      damage.status = DAMAGE_STATUS.REPAIRED;
      damage.repairedAt = timestamp;
    }
  });
  return batch;
}

function statusCounts(db, batch) {
  const counts = {
    total: batch.damageIds.length,
    pending: 0,
    in_repair: 0,
    submitted: 0,
    approved: 0,
    rejected: 0,
    repaired: 0
  };
  for (const damage of batchDamages(db, batch)) {
    counts[damage.status] = (counts[damage.status] || 0) + 1;
  }
  // 汇总口径：未交 / 待验收 / 退修 / 通过（含已修复）
  counts.notSubmitted = counts.in_repair;
  counts.awaitingReview = counts.submitted;
  counts.rejectedTotal = counts.rejected;
  counts.passed = counts.approved + counts.repaired;
  return counts;
}

function enrichBatch(db, batch, { detailed = false } = {}) {
  const damages = batchDamages(db, batch);
  const base = {
    ...batch,
    total: damages.length,
    repaired: damages.filter((item) => item.status === DAMAGE_STATUS.REPAIRED).length,
    pending: damages.filter((item) => item.status !== DAMAGE_STATUS.REPAIRED).length,
    statusCounts: statusCounts(db, batch)
  };
  if (!detailed) return base;
  return {
    ...base,
    damages: damages.map((damage) => ({
      ...damage,
      submissionCount: submissionsOf(db, damage.id).length
    }))
  };
}

module.exports = {
  DAMAGE_STATUS,
  BATCH_STATUS,
  VERDICT,
  findDamage,
  findBatch,
  submissionsOf,
  submitRepair,
  reviewSubmission,
  batchDamages,
  completionBlockers,
  canComplete,
  completeBatch,
  statusCounts,
  enrichBatch
};
