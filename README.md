# 古籍拓片缺损修补API

纯后端零依赖 Node 服务，使用 `data/db.json` 持久化拓片、缺损项、修补批次与逐项验收记录，服务重启后数据仍在。

## 代码结构（按业务拆分）

- `server.js`：启动引导
- `lib/storage.js`：存储层（db.json 读写、种子数据、ID 生成、旧数据兼容）
- `lib/acceptance.js`：验收规则（提交、逐项验收、退修、结批门槛、状态统计）
- `lib/routes.js`：HTTP 接口（路由与入参校验）
- `lib/http.js`：响应、JSON 解析等 HTTP 工具

## 启动

```bash
PORT=3020 node server.js
```

## 逐项验收流程

1. `POST /batches` 建批次，批次内缺损项进入 `in_repair`（修复中）。
2. 修复人对每一项调 `POST /damages/:id/submissions`，**必须交处理说明 `repairNote` 和修复后照片 `afterPhotoUrl`**，项变为 `submitted`（待验收）。
3. 验收人调 `POST /submissions/:id/review`：
   - `{"verdict":"pass"}` → 通过，项变为 `approved`；
   - `{"verdict":"reject","rejectReason":"...原因"}` → 退修，**退修必须写原因**，项变为 `rejected`，继续留在原批次。
4. 退修项由修复人再次提交：每次提交都**新增一条独立记录**，旧的提交与验收结论不覆盖；可用 `GET /damages/:id/submissions` 查看历次结论。
5. `POST /batches/:id/complete` 结批：**只要还有未交、待验收或退修项就拒绝完成**；完成时只把 `approved` 项记为 `repaired`（已修复），退修项留在原批次等待再交。

## 状态

缺损项：`pending`（未进批次）→ `in_repair`（修复中/未交）→ `submitted`（待验收）→ `approved`（验收通过）/ `rejected`（退修，可重新提交）→ 结批后通过项变 `repaired`。

批次：`open` → `completed`。`GET /batches/:id` 的 `statusCounts` 给出各状态数量（另含 notSubmitted / awaitingReview / rejectedTotal / passed 汇总）。

## 接口

- `GET /health`
- `GET /rubbings`、`POST /rubbings`
- `GET/POST /rubbings/:id/damages`
- `GET /damages?status=&type=`
- `GET /damages/:id`（含历次提交记录）
- `PATCH /damages/:id`（仅可改 position/type/beforePhotoUrl；状态、照片、处理说明禁止直接改，必须走提交/验收）
- `POST /damages/:id/submissions`、`GET /damages/:id/submissions`
- `POST /submissions/:id/review`
- `GET /batches`、`POST /batches`
- `GET /batches/:id`
- `POST /batches/:id/complete`

## 闭环示例

```bash
# 建批次
curl -X POST http://127.0.0.1:3020/batches \
  -H 'Content-Type: application/json' \
  -d '{"name":"六月小批修补","damageIds":["damage_demo_1","damage_demo_2"]}'

# 修复人提交第1项
curl -X POST http://127.0.0.1:3020/damages/damage_demo_1/submissions \
  -H 'Content-Type: application/json' \
  -d '{"repairNote":"虫蛀孔用同色纸托裱补缀","afterPhotoUrl":"https://example.local/after-1.jpg"}'

# 验收人退修（必须带原因）
curl -X POST http://127.0.0.1:3020/submissions/<submissionId>/review \
  -H 'Content-Type: application/json' \
  -d '{"verdict":"reject","rejectReason":"补纸纹理与原纸方向不一致"}'
```
