
import { useState, useEffect } from 'react';
import { useSearchParams } from 'react-router-dom';
import { motion } from 'motion/react';
import { Camera, CheckCircle, AlertTriangle } from 'lucide-react';

interface ChecklistItem {
  recordId: string;
  fields: {
    check_item: string;
    method: string;
    standard: string;
    severity: '🚫致命C' | '⚠️重大M' | 'ℹ️一般m';
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

export default function Inspect() {
  const [searchParams] = useSearchParams();
  const token = searchParams.get('token');

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [shipment, setShipment] = useState<ShipmentInfo | null>(null);
  const [items, setItems] = useState<ChecklistItem[]>([]);
  const [formData, setFormData] = useState<Record<string, {
    result: 'Pass' | 'Fail' | 'N.A';
    defectCount: number;
    remark: string;
    photos: File[];
    photoTokens: string[];
  }>>({});
  const [submitting, setSubmitting] = useState(false);
  const [success, setSuccess] = useState(false);
  const [conclusion, setConclusion] = useState('');

  useEffect(() => {
    if (!token) {
      setError('无效的链接 (Missing Token)');
      setLoading(false);
      return;
    }

    fetch(`/api/checklist?token=${token}`)
      .then(res => {
        if (!res.ok) throw new Error('链接失效或网络错误');
        return res.json();
      })
      .then(data => {
        if (data.error) throw new Error(data.error);
        setShipment(data.shipment);
        setItems(data.items);
        
        const initialData: any = {};
        data.items.forEach((item: ChecklistItem) => {
          initialData[item.recordId] = {
            result: 'Pass',
            defectCount: 0,
            remark: '',
            photos: [],
            photoTokens: []
          };
        });
        setFormData(initialData);
        setLoading(false);
      })
      .catch(err => {
        setError(err.message);
        setLoading(false);
      });
  }, [token]);

  const handleResultChange = (recordId: string, result: 'Pass' | 'Fail' | 'N.A') => {
    setFormData(prev => ({
      ...prev,
      [recordId]: { ...prev[recordId], result }
    }));
  };

  const handleDefectCountChange = (recordId: string, count: number) => {
    setFormData(prev => ({
      ...prev,
      [recordId]: { ...prev[recordId], defectCount: count }
    }));
  };

  const handleRemarkChange = (recordId: string, text: string) => {
    setFormData(prev => ({
      ...prev,
      [recordId]: { ...prev[recordId], remark: text }
    }));
  };

  const handlePhotoUpload = async (recordId: string, e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files.length > 0) {
      const file = e.target.files[0];
      setFormData(prev => ({
        ...prev,
        [recordId]: { ...prev[recordId], photos: [...prev[recordId].photos, file] }
      }));
    }
  };

  const uploadFile = async (file: File): Promise<string> => {
    const formData = new FormData();
    formData.append('file', file);
    const res = await fetch('/api/upload', { method: 'POST', body: formData });
    if (!res.ok) throw new Error('Upload failed');
    const data = await res.json();
    return data.file_token;
  };

  const handleSubmit = async () => {
    if (!token) return;
    
    for (const item of items) {
      const data = formData[item.recordId];
      if (data.result === 'Fail') {
        if (data.photos.length === 0) {
          alert(`检查项 "${item.fields.check_item}" 为 Fail，必须上传照片！`);
          return;
        }
        if (data.defectCount <= 0) {
           alert(`检查项 "${item.fields.check_item}" 为 Fail，缺陷数量必须大于0！`);
           return;
        }
      }
    }

    if (!confirm('确认提交验货结果？提交后不可修改。')) return;

    setSubmitting(true);

    try {
      const payloadItems = [];
      
      for (const item of items) {
        const data = formData[item.recordId];
        const photoTokens = [...data.photoTokens];
        
        for (const file of data.photos) {
          const token = await uploadFile(file);
          photoTokens.push(token);
        }

        payloadItems.push({
          recordId: item.recordId,
          result: data.result,
          defectCount: data.defectCount,
          remark: data.remark,
          photoTokens: photoTokens
        });
      }

      const res = await fetch('/api/submit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, items: payloadItems })
      });

      const resData = await res.json();
      if (!res.ok) throw new Error(resData.error);

      setConclusion(resData.conclusion);
      setSuccess(true);

    } catch (err: any) {
      alert('提交失败: ' + err.message);
    } finally {
      setSubmitting(false);
    }
  };

  if (loading) return <div className="p-8 text-center text-lg text-gray-600">加载中...</div>;
  if (error) return <div className="p-8 text-center text-red-500 text-lg">{error}</div>;
  if (success) return (
    <div className="min-h-screen bg-green-50 flex flex-col items-center justify-center p-4">
      <CheckCircle className="w-24 h-24 text-green-500 mb-4" />
      <h1 className="text-3xl font-bold text-green-800 mb-2">验货完成</h1>
      <p className="text-xl text-green-700">结论: {conclusion}</p>
      <p className="mt-4 text-gray-500">您可以关闭此页面了</p>
    </div>
  );

  return (
    <div className="min-h-screen bg-gray-50 pb-24">
      <div className="bg-white p-4 shadow-sm sticky top-0 z-10 border-b border-gray-100">
        <h1 className="text-xl font-bold text-gray-800">验货单</h1>
        {shipment && (
          <div className="text-sm text-gray-500 mt-2 grid grid-cols-2 gap-x-4 gap-y-1">
            <div>PO: <span className="font-mono text-gray-900">{shipment.po}</span></div>
            <div>SKU: <span className="font-mono text-gray-900">{shipment.sku}</span></div>
            <div>数量: {shipment.quantity}</div>
            <div>抽检数: <span className="font-bold text-blue-600">{shipment.sample_size}</span></div>
          </div>
        )}
      </div>

      <div className="p-4 space-y-4 max-w-3xl mx-auto">
        {items.map((item) => {
          const data = formData[item.recordId];
          const isFail = data.result === 'Fail';
          const severity = item.fields.severity || 'ℹ️一般m'; // Fallback
          
          return (
            <motion.div 
              key={item.recordId}
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              className={`bg-white rounded-xl shadow-sm border-l-4 overflow-hidden ${
                data.result === 'Pass' ? 'border-green-500' : 
                data.result === 'Fail' ? 'border-red-500' : 'border-gray-300'
              }`}
            >
              <div className="p-4">
                <div className="flex justify-between items-start mb-2 gap-2">
                  <h3 className="font-bold text-lg text-gray-800 leading-tight">{item.fields.check_item}</h3>
                  <span className={`text-xs px-2 py-1 rounded font-bold whitespace-nowrap ${
                    severity.includes('致命') ? 'bg-red-100 text-red-800' :
                    severity.includes('重大') ? 'bg-orange-100 text-orange-800' :
                    'bg-blue-100 text-blue-800'
                  }`}>
                    {severity}
                  </span>
                </div>
                
                <div className="space-y-1 mb-4">
                  <p className="text-sm text-gray-600"><span className="font-semibold text-gray-400">标准:</span> {item.fields.standard}</p>
                  <p className="text-sm text-gray-500"><span className="font-semibold text-gray-400">方法:</span> {item.fields.method}</p>
                </div>

                <div className="grid grid-cols-3 gap-2 mb-4">
                  {(['Pass', 'Fail', 'N.A'] as const).map((res) => (
                    <button
                      key={res}
                      onClick={() => handleResultChange(item.recordId, res)}
                      className={`py-3 rounded-lg font-bold text-lg transition-all ${
                        data.result === res 
                          ? (res === 'Pass' ? 'bg-green-500 text-white shadow-md scale-105' : 
                             res === 'Fail' ? 'bg-red-500 text-white shadow-md scale-105' : 
                             'bg-gray-500 text-white shadow-md scale-105')
                          : 'bg-gray-100 text-gray-400 hover:bg-gray-200'
                      }`}
                    >
                      {res.toUpperCase()}
                    </button>
                  ))}
                </div>

                {isFail && (
                  <motion.div 
                    initial={{ height: 0, opacity: 0 }}
                    animate={{ height: 'auto', opacity: 1 }}
                    className="bg-red-50 p-4 rounded-lg space-y-4 border border-red-100"
                  >
                    <div>
                      <label className="block text-sm font-bold text-red-800 mb-1 flex items-center gap-1">
                        <AlertTriangle className="w-4 h-4" /> 缺陷数量 (必填)
                      </label>
                      <input 
                        type="number" 
                        min="1"
                        value={data.defectCount || ''}
                        onChange={(e) => handleDefectCountChange(item.recordId, parseInt(e.target.value))}
                        className="w-full p-3 border border-red-200 rounded-lg focus:ring-2 focus:ring-red-500 outline-none bg-white"
                        placeholder="请输入数量"
                      />
                    </div>
                    
                    <div>
                      <label className="block text-sm font-bold text-red-800 mb-2 flex items-center gap-1">
                        <Camera className="w-4 h-4" /> 照片凭证 (必填)
                      </label>
                      <div className="flex flex-wrap gap-3">
                        {data.photos.map((file, idx) => (
                          <div key={idx} className="w-20 h-20 bg-gray-200 rounded-lg overflow-hidden relative shadow-sm">
                             <img src={URL.createObjectURL(file)} className="w-full h-full object-cover" />
                          </div>
                        ))}
                        <label className="w-20 h-20 bg-white border-2 border-dashed border-red-300 rounded-lg flex flex-col items-center justify-center cursor-pointer hover:bg-red-50 active:bg-red-100 transition-colors">
                          <Camera className="w-6 h-6 text-red-400" />
                          <span className="text-xs text-red-400 mt-1">上传</span>
                          <input type="file" accept="image/*" className="hidden" onChange={(e) => handlePhotoUpload(item.recordId, e)} />
                        </label>
                      </div>
                    </div>

                    <div>
                      <label className="block text-sm font-bold text-red-800 mb-1">备注</label>
                      <textarea 
                        value={data.remark}
                        onChange={(e) => handleRemarkChange(item.recordId, e.target.value)}
                        className="w-full p-3 border border-red-200 rounded-lg text-sm bg-white focus:ring-2 focus:ring-red-500 outline-none"
                        rows={2}
                        placeholder="请输入缺陷描述..."
                      />
                    </div>
                  </motion.div>
                )}
              </div>
            </motion.div>
          );
        })}
      </div>

      <div className="fixed bottom-0 left-0 right-0 bg-white/90 backdrop-blur-md border-t border-gray-200 p-4 shadow-lg safe-area-bottom">
        <button
          onClick={handleSubmit}
          disabled={submitting}
          className={`w-full max-w-3xl mx-auto block py-4 rounded-xl text-xl font-bold text-white shadow-lg transition-all ${
            submitting ? 'bg-gray-400 cursor-not-allowed' : 'bg-blue-600 hover:bg-blue-700 active:scale-[0.98]'
          }`}
        >
          {submitting ? '提交中...' : '提交验货结果'}
        </button>
      </div>
    </div>
  );
}
