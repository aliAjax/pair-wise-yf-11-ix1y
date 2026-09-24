# 古籍拓片缺损修补API

纯后端零依赖Node服务，使用 `data/db.json` 持久化拓片、缺损项、修补批次和逐项验收记录，服务重启后记录仍在。

## 目录结构

- `server.js` 接口层：HTTP 路由与请求响应
- `src/storage.js` 存储层：`data/db.json` 读写与结构归一化
- `src/review.js` 验收规则层：提交、验收、批次完成的业务规则

## 启动

```bash
PORT=3020 node server.js
```

## 缺损项状态

`pending` 待入批 → `in_repair` 修复中（未交）→ `submitted` 待验收 → `repaired` 验收通过 / `rejected` 退修（留在原批次等待再交）

## 逐项验收流程

1. 修复人对批次内缺损项提交处理说明和修复后照片：`POST /damages/:id/submissions`，每次提交新增一条记录。
2. 验收人对每条提交给出结论：`POST /submissions/:id/review`，`result` 为 `approved`（通过）或 `rejected`（退修），退修必须填 `reason`。
3. 同一项每次提交都有独立结论，重新提交只新增一条记录，不覆盖旧结论；`GET /damages/:id/submissions` 可查看全部历史。
4. 批次里还有未交、待验收或退修项时，`POST /batches/:id/complete` 返回 409 不能完成。
5. 完成只把验收通过的项记为已修复；退修项继续留在原批次等待再交。
6. 缺损项的状态、修复说明、修复后照片只能通过提交/验收流程更新，`PATCH /damages/:id` 仅允许修改位置、类型、修复前照片。

## 主要接口

- `GET /health`
- `GET /rubbings`
- `POST /rubbings`
- `GET /rubbings/:id/damages`
- `POST /rubbings/:id/damages`
- `GET /damages?status=&type=`
- `PATCH /damages/:id`
- `POST /damages/:id/submissions` 修复人提交 `{ repairNote, afterPhotoUrl }`
- `GET /damages/:id/submissions` 该项全部提交与验收结论
- `POST /submissions/:id/review` 验收 `{ result: "approved"|"rejected", reason?, reviewer? }`
- `GET /batches`
- `POST /batches`
- `GET /batches/:id` 批次详情，含各状态数量 `counts: { total, unsubmitted, submitted, rejected, repaired }`
- `POST /batches/:id/complete`

## 闭环示例

```bash
# 建批次
curl -X POST http://127.0.0.1:3020/batches \
  -H 'Content-Type: application/json' \
  -d '{"name":"九月小批修补","damageIds":["damage_demo_1","damage_demo_2"]}'

# 修复人提交
curl -X POST http://127.0.0.1:3020/damages/damage_demo_1/submissions \
  -H 'Content-Type: application/json' \
  -d '{"repairNote":"虫蛀孔以同色皮纸补缀","afterPhotoUrl":"https://example.local/after-014-1.jpg"}'

# 验收人退修（必须写原因）或通过
curl -X POST http://127.0.0.1:3020/submissions/<submissionId>/review \
  -H 'Content-Type: application/json' \
  -d '{"result":"rejected","reason":"补纸接缝起翘，需重新压平"}'

# 全部通过后完成批次
curl -X POST http://127.0.0.1:3020/batches/<batchId>/complete \
  -H 'Content-Type: application/json' -d '{}'
```

## 冒烟测试

```bash
node scripts/smoke-test.js
```

覆盖：未交/退修阻断完成、退修必填原因、重复提交与重复验收拦截、提交历史不覆盖、重启后记录仍在。
