const { readFile, writeFile, mkdir } = require("fs/promises");
const path = require("path");

const DB_FILE = process.env.DB_FILE
  ? path.resolve(process.env.DB_FILE)
  : path.join(__dirname, "..", "data", "db.json");

const now = new Date().toISOString();

const initialData = {
  rubbings: [
    {
      id: "rubbing_demo",
      code: "TP-清-014",
      source: "地方碑刻残页",
      paperSize: "42x68cm",
      note: "边缘有旧折痕",
      createdAt: now
    }
  ],
  damages: [
    {
      id: "damage_demo_1",
      rubbingId: "rubbing_demo",
      position: "左上角第3列题字旁",
      type: "虫蛀孔",
      beforePhotoUrl: "https://example.local/before-014-1.jpg",
      afterPhotoUrl: "",
      status: "pending",
      repairNote: "",
      batchId: null,
      createdAt: now,
      repairedAt: null
    },
    {
      id: "damage_demo_2",
      rubbingId: "rubbing_demo",
      position: "下边缘中央",
      type: "撕裂",
      beforePhotoUrl: "https://example.local/before-014-2.jpg",
      afterPhotoUrl: "",
      status: "pending",
      repairNote: "",
      batchId: null,
      createdAt: now,
      repairedAt: null
    }
  ],
  submissions: [],
  batches: []
};

function makeId(prefix) {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

async function ensureDb() {
  await mkdir(path.dirname(DB_FILE), { recursive: true });
  try {
    JSON.parse(await readFile(DB_FILE, "utf8"));
  } catch {
    await writeFile(DB_FILE, JSON.stringify(initialData, null, 2));
  }
}

// 兼容旧版 db.json：缺 submissions 等集合时补齐，避免服务重启后读到半成品数据
function normalize(data) {
  return {
    rubbings: Array.isArray(data.rubbings) ? data.rubbings : [],
    damages: Array.isArray(data.damages) ? data.damages : [],
    submissions: Array.isArray(data.submissions) ? data.submissions : [],
    batches: Array.isArray(data.batches) ? data.batches : []
  };
}

async function readDb() {
  await ensureDb();
  return normalize(JSON.parse(await readFile(DB_FILE, "utf8")));
}

async function writeDb(data) {
  await writeFile(DB_FILE, JSON.stringify(normalize(data), null, 2));
}

module.exports = { DB_FILE, initialData, readDb, writeDb, makeId };
