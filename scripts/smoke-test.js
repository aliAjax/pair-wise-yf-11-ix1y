// 冒烟测试：逐项验收完整闭环
// 运行：node scripts/smoke-test.js
const { spawn } = require("child_process");
const { rm } = require("fs/promises");
const path = require("path");
const assert = require("assert");

const PORT = 3199;
const BASE = `http://127.0.0.1:${PORT}`;
const DB_FILE = path.join(__dirname, "..", "data", "test-db.json");

let server = null;

async function startServer() {
  server = spawn(process.execPath, [path.join(__dirname, "..", "server.js")], {
    env: { ...process.env, PORT: String(PORT), DB_FILE },
    stdio: "ignore"
  });
  for (let i = 0; i < 50; i++) {
    try {
      const res = await fetch(`${BASE}/health`);
      if (res.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("服务启动失败");
}

function stopServer() {
  return new Promise((resolve) => {
    if (!server) return resolve();
    server.once("exit", resolve);
    server.kill();
  });
}

async function req(method, pathname, body) {
  const res = await fetch(`${BASE}${pathname}`, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  return { status: res.status, body: await res.json() };
}

async function main() {
  await rm(DB_FILE, { force: true });
  await startServer();

  // 初始数据：演示缺损项两项
  let r = await req("GET", "/damages");
  assert.strictEqual(r.status, 200);
  const [d1, d2] = r.body.data;
  assert.ok(d1 && d2, "演示缺损项应存在");

  // 建批次
  r = await req("POST", "/batches", { name: "九月修补批", damageIds: [d1.id, d2.id] });
  assert.strictEqual(r.status, 201);
  const batchId = r.body.data.id;
  assert.deepStrictEqual(r.body.data.counts, { total: 2, unsubmitted: 2, submitted: 0, rejected: 0, repaired: 0 });

  // 未交项存在时不能完成
  r = await req("POST", `/batches/${batchId}/complete`, {});
  assert.strictEqual(r.status, 409, "有未交项时批次不能完成");

  // 未入批的缺损项不能提交
  r = await req("POST", "/rubbings/rubbing_demo/damages", {
    position: "右下角",
    type: "霉斑",
    beforePhotoUrl: "https://example.local/before-014-3.jpg"
  });
  const d3 = r.body.data;
  r = await req("POST", `/damages/${d3.id}/submissions`, {
    repairNote: "除霉",
    afterPhotoUrl: "https://example.local/after-014-3.jpg"
  });
  assert.strictEqual(r.status, 409, "未入批的缺损项不能提交验收");

  // 修复人提交第1项
  r = await req("POST", `/damages/${d1.id}/submissions`, {
    repairNote: "虫蛀孔以同色皮纸补缀，浆糊稀释点补",
    afterPhotoUrl: "https://example.local/after-014-1.jpg"
  });
  assert.strictEqual(r.status, 201);
  const sub1 = r.body.data;
  assert.strictEqual(sub1.review, null);

  // 重复提交被拒
  r = await req("POST", `/damages/${d1.id}/submissions`, {
    repairNote: "重复提交",
    afterPhotoUrl: "https://example.local/after-x.jpg"
  });
  assert.strictEqual(r.status, 409, "待验收时不能重复提交");

  // 验收通过第1项
  r = await req("POST", `/submissions/${sub1.id}/review`, { result: "approved", reviewer: "验收员甲" });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.data.damage.status, "repaired");
  assert.ok(r.body.data.damage.repairedAt, "通过项应记录修复时间");

  // 同一提交不能重复验收
  r = await req("POST", `/submissions/${sub1.id}/review`, { result: "rejected", reason: "再验" });
  assert.strictEqual(r.status, 409, "已有结论的提交不能重复验收");

  // 第2项提交后退修：退修必须写原因
  r = await req("POST", `/damages/${d2.id}/submissions`, {
    repairNote: "撕裂处托裱加固",
    afterPhotoUrl: "https://example.local/after-014-2.jpg"
  });
  const sub2 = r.body.data;
  r = await req("POST", `/submissions/${sub2.id}/review`, { result: "rejected" });
  assert.strictEqual(r.status, 400, "退修必须填写原因");
  r = await req("POST", `/submissions/${sub2.id}/review`, { result: "rejected", reason: "托纸接缝处起翘，需重新压平" });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.data.damage.status, "rejected");

  // 退修项仍在原批次，批次不能完成
  r = await req("GET", `/batches/${batchId}`);
  assert.deepStrictEqual(r.body.data.counts, { total: 2, unsubmitted: 0, submitted: 0, rejected: 1, repaired: 1 });
  r = await req("POST", `/batches/${batchId}/complete`, {});
  assert.strictEqual(r.status, 409, "有退修项时批次不能完成");

  // 退修项重新提交：新增一条记录，不覆盖旧结论
  r = await req("POST", `/damages/${d2.id}/submissions`, {
    repairNote: "重新压平托纸接缝并补全缺口",
    afterPhotoUrl: "https://example.local/after-014-2-v2.jpg"
  });
  assert.strictEqual(r.status, 201);
  const sub2b = r.body.data;
  assert.notStrictEqual(sub2b.id, sub2.id);
  r = await req("GET", `/damages/${d2.id}/submissions`);
  assert.strictEqual(r.body.data.length, 2, "同一项每次提交都留独立记录");
  assert.strictEqual(r.body.data[0].review.result, "rejected", "旧结论保留不被覆盖");
  assert.strictEqual(r.body.data[0].review.reason, "托纸接缝处起翘，需重新压平");
  assert.strictEqual(r.body.data[1].review, null);

  // 通过第2次提交后批次可完成
  r = await req("POST", `/submissions/${sub2b.id}/review`, { result: "approved" });
  assert.strictEqual(r.status, 200);
  r = await req("POST", `/batches/${batchId}/complete`, { note: "全部验收通过" });
  assert.strictEqual(r.status, 200);
  assert.deepStrictEqual(r.body.data.counts, { total: 2, unsubmitted: 0, submitted: 0, rejected: 0, repaired: 2 });
  assert.ok(r.body.data.completedAt);

  // 已完成批次不能重复完成
  r = await req("POST", `/batches/${batchId}/complete`, {});
  assert.strictEqual(r.status, 409);

  // 不能直接PATCH状态绕过验收
  r = await req("PATCH", `/damages/${d3.id}`, { status: "repaired" });
  assert.strictEqual(r.status, 400, "状态不能直接PATCH修改");

  // 退修项留在原批次等待再交：第二个批次验证退修阻断
  r = await req("POST", "/batches", { name: "九月补批", damageIds: [d3.id] });
  const batch2 = r.body.data.id;
  r = await req("POST", `/damages/${d3.id}/submissions`, {
    repairNote: "除霉并补色",
    afterPhotoUrl: "https://example.local/after-014-3.jpg"
  });
  const sub3 = r.body.data;
  r = await req("POST", `/submissions/${sub3.id}/review`, { result: "rejected", reason: "补色偏深" });
  assert.strictEqual(r.status, 200);
  r = await req("POST", `/batches/${batch2}/complete`, {});
  assert.strictEqual(r.status, 409, "退修项留在原批次时不能完成");
  r = await req("GET", "/damages?status=rejected");
  assert.strictEqual(r.body.data.length, 1);
  assert.strictEqual(r.body.data[0].batchId, batch2, "退修项继续留在原批次");

  // 重启服务后记录仍在
  await stopServer();
  await startServer();
  r = await req("GET", `/batches/${batchId}`);
  assert.strictEqual(r.body.data.status, "completed", "重启后批次状态仍在");
  assert.deepStrictEqual(r.body.data.counts, { total: 2, unsubmitted: 0, submitted: 0, rejected: 0, repaired: 2 });
  r = await req("GET", `/damages/${d2.id}/submissions`);
  assert.strictEqual(r.body.data.length, 2, "重启后提交历史仍在");
  assert.strictEqual(r.body.data[0].review.result, "rejected");
  assert.strictEqual(r.body.data[1].review.result, "approved");
  r = await req("GET", `/batches/${batch2}`);
  assert.deepStrictEqual(r.body.data.counts, { total: 1, unsubmitted: 0, submitted: 0, rejected: 1, repaired: 0 });

  await stopServer();
  await rm(DB_FILE, { force: true });
  console.log("冒烟测试全部通过 ✔");
}

main().catch(async (error) => {
  console.error(error);
  await stopServer();
  await rm(DB_FILE, { force: true });
  process.exit(1);
});
