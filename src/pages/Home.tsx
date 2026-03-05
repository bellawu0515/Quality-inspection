
import { useState } from 'react';
import { motion } from 'motion/react';
import { ClipboardList, ArrowRight, CheckCircle } from 'lucide-react';

export default function Home() {
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<{ inspectUrl: string } | null>(null);

  const handleGenerate = async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/generate-checklist', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ shipmentRecordId: 'mock-record-id' })
      });
      const data = await res.json();
      if (data.success) {
        setResult(data);
      } else {
        alert('生成失败: ' + data.error);
      }
    } catch (err) {
      alert('网络错误');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-gray-50 flex flex-col items-center justify-center p-4">
      <motion.div 
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        className="bg-white p-8 rounded-2xl shadow-xl max-w-md w-full text-center"
      >
        <div className="w-16 h-16 bg-blue-100 rounded-full flex items-center justify-center mx-auto mb-6">
          <ClipboardList className="w-8 h-8 text-blue-600" />
        </div>
        
        <h1 className="text-2xl font-bold text-gray-900 mb-2">验货管理系统</h1>
        <p className="text-gray-500 mb-8">点击下方按钮模拟生成验货清单 (Mock Mode)</p>

        {!result ? (
          <button
            onClick={handleGenerate}
            disabled={loading}
            className="w-full py-3 bg-blue-600 hover:bg-blue-700 text-white rounded-xl font-semibold transition-colors flex items-center justify-center gap-2"
          >
            {loading ? '生成中...' : '生成验货清单'}
            {!loading && <ArrowRight className="w-4 h-4" />}
          </button>
        ) : (
          <div className="space-y-4">
            <div className="p-4 bg-green-50 rounded-xl border border-green-100">
              <div className="flex items-center justify-center gap-2 text-green-700 font-semibold mb-2">
                <CheckCircle className="w-5 h-5" />
                生成成功
              </div>
              <p className="text-sm text-green-600 mb-4">验货链接已生成</p>
              <a 
                href={result.inspectUrl}
                className="block w-full py-2 bg-green-600 text-white rounded-lg font-medium hover:bg-green-700 transition-colors"
              >
                进入验货页面
              </a>
            </div>
            <button 
              onClick={() => setResult(null)}
              className="text-gray-400 text-sm hover:text-gray-600"
            >
              重置
            </button>
          </div>
        )}
      </motion.div>
    </div>
  );
}
