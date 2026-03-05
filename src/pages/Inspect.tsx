import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { motion } from 'motion/react';
import { Camera, CheckCircle, AlertTriangle, Trash2 } from 'lucide-react';

interface ChecklistItem {
  recordId: string;
  fields: {
    check_item: string;
    method: string;
    standard: string;
    severity: string; // e.g. "🚫致命C" / "⚠️重大M" / "ℹ️一般m"
    result?: 'Pass' | 'Fail' | 'N.A';
    defect_count?: number;
    remark?: string;
  };
}

interface ShipmentInfo {
  po: string;
  sku: string;
  quantity: number;
  sample_size: number;
}

type RowState = {
  result: 'Pass' | 'Fail' | 'N.A';
  defectCount: number;
  remark: string;
};

const draftKey = (token: string) => `qc_draft_${token}`;

export default function Inspect() {
  const [searchParams] = useSearchParams();
  const token = searchParams.get('token');

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [shipment, setShipment] = useState<ShipmentInfo | null>(null);
  const [items, setItems] = useState<ChecklistItem[]>([]);

  // 每条检查项的结果/缺陷/备注
  const [rows, setRows] = useState<Record<string, RowState>>({});

  // ✅ 整单附件：一个上传区，多张图片/视频
  const [shipFiles, setShipFiles] = useState<File[]>([]);
  const [shipPhotoTokens, setShipPhotoTokens] = useState<string[]>([]);

  const [submitting, setSubmitting] = useState(false);
  const [success, setSuccess] = useState(false);
  const [conclusion, setConclusion] = useState('');

  // ---------- load ----------
  useEffect(() => {
    if (!token) {
      setError('无效的链接 (Missing Token)');
      setLoading(false);
      return;
    }

    fetch(`/api/checklist?token=${encodeURIComponent(token)}`)
      .then(async (res) => {
        const data = await res.json();
        if (!res.ok) throw new Error(data?.error || '链接失效或网络错误');
        return data;
      })
      .then((data) => {
        setShipment(data.shipment);
        setItems(data.items);

        // init rows default = N.A（避免默认全PASS）
        const init: Record<string, RowState> = {};
        data.items.forEach((it: ChecklistItem) => {
          init[it.recordId] = {
            result: 'N.A',
            defectCount: 0,
            remark: '',
          };
        });

        // 尝试恢复草稿
        const raw = localStorage.getItem(draftKey(token));
        if (raw) {
          try {
            const saved = JSON.parse(raw);
            if (saved && typeof saved === 'object') {
              Object.keys(init).forEach((rid) => {
                if (saved[rid]) init[rid] = { ...init[rid], ...saved[rid] };
              });
            }
          } catch {}
        }

        setRows(init);
        setLoading(false);
      })
      .catch((err) => {
        setError(err.message || '加载失败');
        setLoading(false);
      });
  }, [token]);

  // ---------- draft autosave (no files) ----------
  useEffect(() => {
    if (!token) return;
    if (!Object.keys(rows).length) return;
    const t = setTimeout(() => {
      localStorage.setItem(draftKey(token), JSON.stringify(rows));
    }, 300);
    return () => clearTimeout(t);
  }, [rows, token]);

  const clearDraft = () => {
    if (!token) return;
    localStorage.removeItem(draftKey(token));
    alert('草稿已清空（照片不会保存，需重新上传）');
  };

  // ---------- UI helpers ----------
  const failItems = useMemo(() => {
    return items.filter((it) => rows[it.recordId]?.result === 'Fail');
  }, [items, rows]);

  const missingDefect = useMemo(() => {
    return items.filter((it) => {
      const r = rows[it.recordId];
      return r?.result === 'Fail' && (!r.defectCount || r.defectCount <= 0);
    });
  }, [items, rows]);

  const needShipPhotos = useMemo(() => {
    return failItems.length > 0;
  }, [failItems.length]);

  const scrollToItem = (rid: string) => {
    const el = document.getElementById(`item-${rid}`);
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  const handleResult = (rid: string, result: RowState['result']) => {
    setRows((prev) => ({ ...prev, [rid]: { ...prev[rid], result } }));
  };

  const handleDefect = (rid: string, v: number) => {
    setRows((prev) => ({ ...prev, [rid]: { ...prev[rid], defectCount: v } }));
  };

  const handleRemark = (rid: string, v: string) => {
    setRows((prev) => ({ ...prev, [rid]: { ...prev[rid], remark: v } }));
  };

  const handleShipFiles = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || []);
    if (!files.length) return;
    setShipFiles((prev) => [...prev, ...files]);
  };

  const removeShipFile = (idx: number) => {
    setShipFiles((prev) => prev.filter((_, i) => i !== idx));
  };

  const uploadFile = async (file: File): Promise<string> => {
    const fd = new FormData();
    fd.append('file', file);
    const res = await fetch('/api/upload', { method: 'POST', body: fd });
    const data = await res.json();
    if (!res.ok) throw new Error(data?.error || '上传失败');
    return data.file_token;
  };

  const handleSubmit = async () => {
    if (!token) return;

    // 1) Fail 必须缺陷数
    if (missingDefect.length > 0) {
      alert(`存在 Fail 项未填写缺陷台数（>0）：${missingDefect[0].fields.check_item}`);
      scrollToItem(missingDefect[0].recordId);
      return;
    }

    // 2) 如果有 Fail，整单必须至少 1 张照片
    if (needShipPhotos && shipFiles.length === 0) {
      alert('存在 Fail 项时：请在页面顶部上传至少 1 张验货照片/视频（整单附件）');
      return;
    }

    // 3) 提交前异常汇总确认
    const summary = [
      `Fail项：${failItems.length} 项`,
      `整单附件：${shipFiles.length} 个`,
      '提交后将写回出货台账（验货结论/状态/照片），且不可修改。',
      '确认提交？',
    ].join('\n');
    if (!confirm(summary)) return;

    setSubmitting(true);
    try {
      // 上传整单附件
      const uploadedTokens: string[] = [];
      for (const f of shipFiles) {
        const t = await uploadFile(f);
        uploadedTokens.push(t);
      }
      setShipPhotoTokens(uploadedTokens);

      // 组装 items
      const payloadItems = items.map((it) => {
        const r = rows[it.recordId];
        return {
          recordId: it.recordId,
          result: r.result,
          defectCount: r.defectCount,
          remark: r.remark,
        };
      });

      const res = await fetch('/api/submit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          token,
          items: payloadItems,
          shipmentPhotoTokens: uploadedTokens,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || '提交失败');

      setConclusion(data.conclusion);
      setSuccess(true);

      // 成功后清草稿
      localStorage.removeItem(draftKey(token));
    } catch (e: any) {
      alert('提交失败：' + (e?.message || '未知错误'));
    } finally {
      setSubmitting(false);
    }
  };

  if (loading) return <div className="p-8 text-center text-lg text-gray-600">加载中...</div>;
  if (error) return <div className="p-8 text-center text-red-500 text-lg">{error}</div>;

  if (success) {
    return (
      <div className="min-h-screen bg-green-50 flex flex-col items-center justify-center p-6">
        <div className="bg-white rounded-2xl shadow-xl p-8 max-w-md w-full text-center">
          <CheckCircle className="mx-auto text-green-500" size={48} />
          <h2 className="text-2xl font-bold mt-4">提交成功</h2>
          <p className="text-gray-600 mt-2">系统结论：<span className="font-semibold">{conclusion}</span></p>
          <p className="text-gray-500 mt-3 text-sm">已回写出货台账：验货结论 / 验货状态 / 验货提交时间 / 验货照片</p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-50">
      {/* 顶部固定信息栏 */}
      <div className="sticky top-0 z-50 bg-white border-b shadow-sm">
        <div className="max-w-3xl mx-auto p-4 flex items-start justify-between gap-4">
          <div>
            <div className="text-sm text-gray-500">验货单</div>
            <div className="text-lg font-semibold">{shipment?.po}</div>
            <div className="text-sm text-gray-600 mt-1">
              SKU：<span className="font-medium">{shipment?.sku}</span>
              <span className="mx-2">|</span>
              出货数量：<span className="font-medium">{shipment?.quantity}</span>
              <span className="mx-2">|</span>
              抽检N：<span className="font-medium">{shipment?.sample_size}</span>
            </div>
          </div>

          <button
            onClick={clearDraft}
            className="inline-flex items-center gap-2 text-sm px-3 py-2 rounded-xl border bg-white hover:bg-gray-50"
            title="清空草稿（照片不会保存）"
          >
            <Trash2 size={16} /> 清空草稿
          </button>
        </div>

        {/* 提交前异常汇总 */}
        <div className="max-w-3xl mx-auto px-4 pb-4">
          <div className="rounded-2xl bg-white border p-4">
            <div className="flex items-center gap-2 font-semibold">
              <AlertTriangle className="text-amber-500" size={18} />
              提交前检查
            </div>
            <div className="text-sm text-gray-700 mt-2 space-y-1">
              <div>Fail 项：<span className="font-medium">{failItems.length}</span> 项</div>
              <div>Fail 未填缺陷台数：<span className="font-medium">{missingDefect.length}</span> 项</div>
              <div>整单附件：<span className="font-medium">{shipFiles.length}</span> 个 {needShipPhotos ? <span className="text-amber-600">(有Fail必须上传)</span> : null}</div>
            </div>

            {failItems.length > 0 ? (
              <div className="mt-3 flex flex-wrap gap-2">
                {failItems.slice(0, 6).map((it) => (
                  <button
                    key={it.recordId}
                    onClick={() => scrollToItem(it.recordId)}
                    className="text-xs px-2 py-1 rounded-full bg-rose-50 text-rose-700 hover:bg-rose-100"
                  >
                    {it.fields.check_item}
                  </button>
                ))}
                {failItems.length > 6 ? (
                  <span className="text-xs text-gray-500">…</span>
                ) : null}
              </div>
            ) : null}
          </div>
        </div>
      </div>

      {/* 整单附件上传区 */}
      <div className="max-w-3xl mx-auto px-4 pt-4">
        <div className="bg-white rounded-2xl border shadow-sm p-4">
          <div className="flex items-center justify-between gap-3">
            <div>
              <div className="font-semibold flex items-center gap-2">
                <Camera size={18} /> 本次验货照片/视频（整单附件）
              </div>
              <div className="text-sm text-gray-500 mt-1">
                建议：现场拍照直接上传；若存在 Fail，必须至少上传 1 张。
              </div>
            </div>

            <label className="cursor-pointer inline-flex items-center gap-2 px-4 py-2 rounded-xl bg-gray-900 text-white hover:bg-black">
              <Camera size={16} /> 上传
              <input type="file" multiple accept="image/*,video/*" className="hidden" onChange={handleShipFiles} />
            </label>
          </div>

          {shipFiles.length > 0 ? (
            <div className="mt-3 grid grid-cols-1 gap-2">
              {shipFiles.map((f, idx) => (
                <div key={idx} className="flex items-center justify-between border rounded-xl px-3 py-2">
                  <div className="text-sm text-gray-700 truncate">{f.name}</div>
                  <button
                    onClick={() => removeShipFile(idx)}
                    className="text-xs px-2 py-1 rounded-lg border hover:bg-gray-50"
                  >
                    删除
                  </button>
                </div>
              ))}
            </div>
          ) : null}
        </div>
      </div>

      {/* 检查项列表 */}
      <div className="max-w-3xl mx-auto p-4 space-y-4 pb-28">
        {items.map((item, idx) => {
          const r = rows[item.recordId];
          const isFail = r?.result === 'Fail';
          return (
            <motion.div
              key={item.recordId}
              id={`item-${item.recordId}`}
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: Math.min(idx * 0.01, 0.25) }}
              className="bg-white rounded-2xl border shadow-sm p-4"
            >
              <div className="flex items-start justify-between gap-3">
                <div>
                  <div className="font-semibold">{item.fields.check_item}</div>
                  <div className="text-sm text-gray-600 mt-1">方式：{item.fields.method || '-'}</div>
                  <div className="text-sm text-gray-600 mt-1">标准：{item.fields.standard || '-'}</div>
                </div>
                <div className="text-xs px-2 py-1 rounded-full bg-gray-100 text-gray-700">
                  {item.fields.severity}
                </div>
              </div>

              {/* 结果按钮 */}
              <div className="mt-4 grid grid-cols-3 gap-2">
                <button
                  onClick={() => handleResult(item.recordId, 'Pass')}
                  className={`py-2 rounded-xl font-semibold border ${
                    r?.result === 'Pass' ? 'bg-green-500 text-white border-green-500' : 'bg-white hover:bg-gray-50'
                  }`}
                >
                  PASS
                </button>
                <button
                  onClick={() => handleResult(item.recordId, 'Fail')}
                  className={`py-2 rounded-xl font-semibold border ${
                    r?.result === 'Fail' ? 'bg-rose-500 text-white border-rose-500' : 'bg-white hover:bg-gray-50'
                  }`}
                >
                  FAIL
                </button>
                <button
                  onClick={() => handleResult(item.recordId, 'N.A')}
                  className={`py-2 rounded-xl font-semibold border ${
                    r?.result === 'N.A' ? 'bg-gray-200 text-gray-800 border-gray-300' : 'bg-white hover:bg-gray-50'
                  }`}
                >
                  N.A
                </button>
              </div>

              {/* Fail 时显示缺陷数与备注 */}
              <div className="mt-4 grid grid-cols-1 gap-3">
                <div className="flex items-center gap-3">
                  <div className="text-sm text-gray-700 w-28">缺陷台数</div>
                  <input
                    type="number"
                    min={0}
                    value={r?.defectCount ?? 0}
                    onChange={(e) => handleDefect(item.recordId, Number(e.target.value))}
                    className={`flex-1 border rounded-xl px-3 py-2 ${
                      isFail && (!r?.defectCount || r.defectCount <= 0) ? 'border-rose-400' : ''
                    }`}
                    placeholder="Fail 必填（>0）"
                  />
                </div>

                <div className="flex items-start gap-3">
                  <div className="text-sm text-gray-700 w-28 pt-2">备注</div>
                  <textarea
                    value={r?.remark || ''}
                    onChange={(e) => handleRemark(item.recordId, e.target.value)}
                    className="flex-1 border rounded-xl px-3 py-2 min-h-[72px]"
                    placeholder="可选：补充说明（例如：孔位偏、划伤、异响…）"
                  />
                </div>
              </div>
            </motion.div>
          );
        })}
      </div>

      {/* 底部提交按钮 */}
      <div className="fixed bottom-0 left-0 right-0 bg-white border-t shadow-lg">
        <div className="max-w-3xl mx-auto p-4">
          <button
            disabled={submitting}
            onClick={handleSubmit}
            className={`w-full py-3 rounded-2xl font-bold text-white ${
              submitting ? 'bg-gray-400' : 'bg-blue-600 hover:bg-blue-700'
            }`}
          >
            {submitting ? '提交中…' : '提交验货结果'}
          </button>
          <div className="text-xs text-gray-500 mt-2">
            提示：草稿会自动保存（不含照片）。存在 Fail 时必须上传整单照片。
          </div>
        </div>
      </div>
    </div>
  );
}
