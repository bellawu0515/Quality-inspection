import 'dotenv/config';
import express from 'express';
import { createServer as createViteServer } from 'vite';
import { FeishuClient } from './src/lib/feishu';
import multer from 'multer';
import crypto from 'crypto';
import path from 'path';
import { fileURLToPath } from 'url';

const upload = multer({ storage: multer.memoryStorage() });

// -------------------- Field Name Mapping (Chinese) --------------------
const F_SHIP = {
  SKU: process.env.FIELD_SHIP_SKU || 'SKU',
  PRODUCT: process.env.FIELD_SHIP_PRODUCT || '产品名称',
  PO: process.env.FIELD_SHIP_PO || 'PO号',
  QTY: process.env.FIELD_SHIP_QTY || '数量', // 你 Railway 已覆盖为“出货数量”
  SAMPLE: process.env.FIELD_SHIP_SAMPLE || '抽检数量',
  LINK: process.env.FIELD_SHIP_LINK || '验货链接',
  CONCLUSION: process.env.FIELD_SHIP_CONCLUSION || '验货结论',
  STATUS: process.env.FIELD_SHIP_STATUS || '验货状态',
  C_FAIL: process.env.FIELD_SHIP_C_FAIL || 'C_致命Fail项数',
  M_FAIL: process.env.FIELD_SHIP_M_FAIL || 'M_重大Fail项数',
  SUBMIT_AT: process.env.FIELD_SHIP_SUBMIT_AT || '验货提交时间',
  VERSION: process.env.FIELD_SHIP_VERSION || '版本', // optional
  PHOTOS: process.env.FIELD_SHIP_PHOTOS || '验货照片', // ✅ 你新增的出货台账附件列
};

const F_STD = {
  SKU: process.env.FIELD_STD_SKU || 'SKU',
  VERSION: process.env.FIELD_STD_VERSION || '版本', // optional
  ITEM: process.env.FIELD_STD_ITEM || '检查项名称',
  METHOD: process.env.FIELD_STD_METHOD || '判断方式',
  STANDARD: process.env.FIELD_STD_STANDARD || '判断标准',
  SEVERITY: process.env.FIELD_STD_SEVERITY || '严重度',
};

const F_CHK = {
  LINK: process.env.FIELD_CHK_LINK || '出货合同', // link to shipment table
  SKU: process.env.FIELD_CHK_SKU || 'SKU',
  PRODUCT: process.env.FIELD_CHK_PRODUCT || '产品名称',
  VERSION: process.env.FIELD_CHK_VERSION || '版本', // optional
  ITEM: process.env.FIELD_CHK_ITEM || '检查项名称',
  METHOD: process.env.FIELD_CHK_METHOD || '判断方式',
  STANDARD: process.env.FIELD_CHK_STANDARD || '判断标准',
  SEVERITY: process.env.FIELD_CHK_SEVERITY || '严重度',
  RESULT: process.env.FIELD_CHK_RESULT || '结果',
  DEFECT: process.env.FIELD_CHK_DEFECT || '缺陷台数',
  REMARK: process.env.FIELD_CHK_REMARK || '备注',
  TIME: process.env.FIELD_CHK_TIME || '填写时间',
};

// -------------------- Helpers --------------------
function cellToText(v: any): string {
  if (v == null) return '';
  if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') return String(v);

  if (Array.isArray(v)) {
    for (const item of v) {
      const t = cellToText(item);
      if (t) return t;
    }
    return '';
  }

  if (typeof v === 'object') {
    // 常见结构
    if (typeof (v as any).text === 'string') return (v as any).text;
    if (typeof (v as any).name === 'string') return (v as any).name;

    // 数值字段可能是 { number: 123 }
    if (typeof (v as any).number === 'number') return String((v as any).number);

    // 公式/引用可能是 { value: ... }
    if ((v as any).value != null) return cellToText((v as any).value);
  }

  return '';
}

function asNumber(v: any): number {
  if (typeof v === 'number') return v;
  const s = cellToText(v).trim();
  const n = Number(s);
  return Number.isFinite(n) ? n : 0;
}

function normalizeSeverity(sev: string): 'C' | 'M' | 'm' | '' {
  const s = (sev || '').trim();
  if (s.includes('致命') || s.includes('🚫') || s.includes('(C)')) return 'C';
  if (s.includes('重大') || s.includes('⚠️') || s.includes('(M)')) return 'M';
  if (s.includes('一般') || s.includes('ℹ️') || s.includes('(m)')) return 'm';
  return '';
}

function makeToken(recordId: string) {
  const secret = process.env.INSPECT_TOKEN_SECRET;
  const exp = Date.now() + 24 * 60 * 60 * 1000;
  if (!secret) return recordId; // fallback
  const payload = JSON.stringify({ rid: recordId, exp });
  const payloadB64 = Buffer.from(payload, 'utf8').toString('base64url');
  const sig = crypto.createHmac('sha256', secret).update(payloadB64).digest('base64url');
  return `${payloadB64}.${sig}`;
}

function parseToken(token: string): { rid: string; exp?: number } | null {
  const secret = process.env.INSPECT_TOKEN_SECRET;
  if (!secret) return { rid: token };

  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const [payloadB64, sig] = parts;
  const expected = crypto.createHmac('sha256', secret).update(payloadB64).digest('base64url');
  if (sig !== expected) return null;
  const payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'));
  if (payload.exp && Date.now() > payload.exp) return null;
  return payload;
}

function isFeishuConfigured(): boolean {
  return Boolean(
    process.env.FEISHU_APP_ID &&
      process.env.FEISHU_APP_SECRET &&
      process.env.FEISHU_BITABLE_APP_TOKEN &&
      process.env.TABLE_ID_STANDARDS &&
      process.env.TABLE_ID_SHIPMENTS &&
      process.env.TABLE_ID_CHECKLIST
  );
}

function getAppUrl(PORT: number): string {
  return process.env.APP_URL || `http://localhost:${PORT}`;
}

function getRecordId(obj: any): string {
  return String(obj?.recordId || obj?.record_id || '').trim();
}

// -------------------- Server --------------------
async function startServer() {
  const app = express();
  const PORT = Number(process.env.PORT || 3000);
  app.use(express.json());

  // 1) Generate Checklist
  app.post('/api/generate-checklist', async (req, res) => {
    try {
      let recordId = req.body?.shipmentRecordId;
      if (req.body?.data?.record_id) recordId = req.body.data.record_id;
      if (!recordId) return res.status(400).json({ error: 'Missing shipmentRecordId' });
      if (!isFeishuConfigured()) return res.status(500).json({ error: 'Server not configured' });

      const shipment = await FeishuClient.getShipment(recordId);
      const f = shipment.fields || {};

      const sku = cellToText(f[F_SHIP.SKU]).trim();
      const productName = cellToText(f[F_SHIP.PRODUCT]).trim();
      const version = cellToText(f[F_SHIP.VERSION]).trim();

      if (!sku) return res.status(400).json({ error: `出货台账缺少字段：${F_SHIP.SKU}` });

      let standards = await FeishuClient.getStandards(sku, version || undefined);
      if (standards.length === 0 && version) standards = await FeishuClient.getStandards(sku, undefined);
      if (standards.length === 0) return res.status(404).json({ error: `标准库未找到 SKU=${sku} 的检查项` });

      const checklistRecords = standards.map((std: any) => {
        const sf = std.fields || {};
        return {
          [F_CHK.LINK]: [recordId],
          [F_CHK.SKU]: sku,
          [F_CHK.PRODUCT]: productName,
          ...(version ? { [F_CHK.VERSION]: version } : {}),
          [F_CHK.ITEM]: cellToText(sf[F_STD.ITEM]),
          [F_CHK.METHOD]: cellToText(sf[F_STD.METHOD]),
          [F_CHK.STANDARD]: cellToText(sf[F_STD.STANDARD]),
          [F_CHK.SEVERITY]: cellToText(sf[F_STD.SEVERITY]),
        };
      });

      await FeishuClient.createChecklistItems(checklistRecords);

      const token = makeToken(recordId);
      const inspectUrl = `${getAppUrl(PORT)}/inspect?token=${encodeURIComponent(token)}`;

      // ✅ 回写出货台账（无需飞书自动化第3步）
      await FeishuClient.updateShipment(recordId, {
        [F_SHIP.LINK]: inspectUrl,
        [F_SHIP.STATUS]: '验货中',
      });

      res.json({ success: true, inspectUrl, count: checklistRecords.length });
    } catch (err: any) {
      console.error('Generate Error:', err);
      res.status(500).json({ error: err.message });
    }
  });

  // 2) Load checklist
  app.get('/api/checklist', async (req, res) => {
    const token = req.query.token as string;
    if (!token) return res.status(400).json({ error: 'Missing token' });
    if (!isFeishuConfigured()) return res.status(500).json({ error: 'Server not configured' });

    const parsed = parseToken(token);
    if (!parsed?.rid) return res.status(401).json({ error: 'Invalid token' });

    try {
      const shipment = await FeishuClient.getShipment(parsed.rid);
      const f = shipment.fields || {};

      const po = cellToText(f[F_SHIP.PO]) || parsed.rid;
      const sku = cellToText(f[F_SHIP.SKU]);

      // ✅ 数量兜底：避免字段名/类型导致 0
      const qty = asNumber(f[F_SHIP.QTY] ?? f['出货数量'] ?? f['数量']);
      const sample = asNumber(f[F_SHIP.SAMPLE] ?? f['抽检数量']);

      const checklist = await FeishuClient.getChecklistByShipment(parsed.rid);

      const items = (checklist || []).map((it: any) => {
        const cf = it.fields || {};
        return {
          recordId: getRecordId(it), // ✅ 关键：必须是真实 record_id
          fields: {
            check_item: cellToText(cf[F_CHK.ITEM]),
            method: cellToText(cf[F_CHK.METHOD]),
            standard: cellToText(cf[F_CHK.STANDARD]),
            severity: cellToText(cf[F_CHK.SEVERITY]),
            result: cellToText(cf[F_CHK.RESULT]) || 'N.A',
            defect_count: asNumber(cf[F_CHK.DEFECT]),
            remark: cellToText(cf[F_CHK.REMARK]),
          },
        };
      });

      res.json({ shipment: { po, sku, quantity: qty, sample_size: sample }, items });
    } catch (err: any) {
      console.error('Fetch Checklist Error:', err);
      res.status(500).json({ error: err.message });
    }
  });

  // 3) Upload file
  app.post('/api/upload', upload.single('file'), async (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'No file provided' });
    if (!isFeishuConfigured()) return res.status(500).json({ error: 'Server not configured' });

    try {
      const fileToken = await FeishuClient.uploadFile(req.file.buffer, req.file.originalname, req.file.size);
      res.json({ file_token: fileToken });
    } catch (err: any) {
      console.error('Upload Error:', err);
      res.status(500).json({ error: err.message });
    }
  });

  // 4) Submit results
  app.post('/api/submit', async (req, res) => {
    const { token, items, shipmentPhotoTokens } = req.body || {};
    if (!token || !Array.isArray(items)) return res.status(400).json({ error: 'Invalid payload' });
    if (!isFeishuConfigured()) return res.status(500).json({ error: 'Server not configured' });

    const parsed = parseToken(String(token));
    if (!parsed?.rid) return res.status(401).json({ error: 'Invalid token' });

    try {
      const hasFail = items.some((it: any) => it?.result === 'Fail');
      const shipTokens: string[] = Array.isArray(shipmentPhotoTokens) ? shipmentPhotoTokens : [];
      if (hasFail && shipTokens.length === 0) {
        throw new Error('存在 Fail 项时：必须上传至少 1 张验货照片');
      }

      // ✅ 构造批量更新（同时给 record_id + recordId，避免 id 为空）
      const updates = items.map((item: any) => {
        const rid = String(item.recordId || item.record_id || '').trim();
        if (!rid) throw new Error('提交失败：检查项缺少 recordId（请刷新页面后重试）');

        if (item.result === 'Fail' && (!item.defectCount || Number(item.defectCount) <= 0)) {
          throw new Error('Fail 项必须填写缺陷台数（>0）');
        }

        return {
          record_id: rid,
          recordId: rid,
          fields: {
            [F_CHK.RESULT]: item.result,
            [F_CHK.DEFECT]: item.defectCount || 0,
            [F_CHK.REMARK]: item.remark || '',
            [F_CHK.TIME]: Date.now(),
          },
        };
      });

      await FeishuClient.updateChecklistItems(updates);

      // 重新拉取计算结论
      const dbItems = await FeishuClient.getChecklistByShipment(parsed.rid);

      let cFail = 0, mFail = 0, minorFail = 0;
      for (const dbItem of dbItems) {
        const cf = dbItem.fields || {};
        const result = cellToText(cf[F_CHK.RESULT]);
        if (result !== 'Fail') continue;

        const sev = normalizeSeverity(cellToText(cf[F_CHK.SEVERITY]));
        if (sev === 'C') cFail++;
        else if (sev === 'M') mFail++;
        else if (sev === 'm') minorFail++;
      }

      let conclusion: 'PASS' | 'HOLD' | 'FAIL' = 'PASS';
      if (cFail >= 1) conclusion = 'FAIL';
      else if (mFail >= 2) conclusion = 'FAIL';
      else if (mFail === 1 || minorFail > 3) conclusion = 'HOLD';

      const status = conclusion === 'PASS' ? '已放行' : conclusion === 'HOLD' ? '待返工' : '已拒收';

      const shipUpdate: any = {
        [F_SHIP.CONCLUSION]: conclusion,
        [F_SHIP.STATUS]: status,
        [F_SHIP.SUBMIT_AT]: Date.now(),
        [F_SHIP.C_FAIL]: cFail,
        [F_SHIP.M_FAIL]: mFail,
      };

      if (shipTokens.length > 0) {
        shipUpdate[F_SHIP.PHOTOS] = shipTokens.map((t: string) => ({ file_token: t }));
      }

      await FeishuClient.updateShipment(parsed.rid, shipUpdate);

      res.json({ success: true, conclusion });
    } catch (err: any) {
      console.error('Submit Error:', err);
      res.status(500).json({ error: err.message });
    }
  });

  // Vite Middleware (dev) / Static dist (prod)
  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({ server: { middlewareMode: true }, appType: 'spa' });
    app.use(vite.middlewares);
  } else {
    const __filename = fileURLToPath(import.meta.url);
    const __dirname = path.dirname(__filename);
    const distPath = path.join(__dirname, 'dist');
    app.use(express.static(distPath));
    app.get('*', (_req, res) => res.sendFile(path.join(distPath, 'index.html')));
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer();
