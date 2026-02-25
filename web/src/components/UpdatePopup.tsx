import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { X, Sparkles } from 'lucide-react';

export default function UpdatePopup() {
  const [popup, setPopup] = useState<{ show: boolean; version: string; releaseNote: string } | null>(null);

  useEffect(() => {
    api.getUpdatePopup().then(r => {
      if (r.ok && r.show) setPopup({ show: true, version: r.version, releaseNote: r.releaseNote });
    }).catch(() => {});
  }, []);

  if (!popup?.show) return null;

  const dismiss = () => {
    setPopup(null);
    api.markUpdatePopupShown().catch(() => {});
  };

  return (
    <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/50 backdrop-blur-sm animate-in fade-in duration-300">
      <div className="bg-white dark:bg-gray-800 rounded-2xl shadow-2xl border border-gray-200 dark:border-gray-700 w-full max-w-lg mx-4 overflow-hidden animate-in zoom-in-95 duration-300">
        {/* Header */}
        <div className="bg-gradient-to-r from-violet-600 to-purple-600 px-6 py-5 text-white relative">
          <button onClick={dismiss} className="absolute top-4 right-4 p-1 rounded-lg hover:bg-white/20 transition-colors">
            <X size={18} />
          </button>
          <div className="flex items-center gap-3">
            <div className="p-2 bg-white/20 rounded-xl">
              <Sparkles size={24} />
            </div>
            <div>
              <h2 className="text-lg font-bold">ClawPanel 已更新至 {popup.version}</h2>
              <p className="text-violet-200 text-xs mt-0.5">更新已自动完成</p>
            </div>
          </div>
        </div>

        {/* Content */}
        <div className="px-6 py-5 max-h-80 overflow-y-auto">
          <h3 className="text-sm font-bold text-gray-900 dark:text-white mb-3">更新内容</h3>
          <div className="text-xs text-gray-600 dark:text-gray-300 whitespace-pre-wrap leading-relaxed">
            {popup.releaseNote || '暂无更新说明'}
          </div>
        </div>

        {/* Footer */}
        <div className="px-6 py-4 border-t border-gray-100 dark:border-gray-700 flex justify-end">
          <button onClick={dismiss}
            className="px-6 py-2.5 text-sm font-medium rounded-xl bg-violet-600 text-white hover:bg-violet-700 shadow-sm shadow-violet-200 dark:shadow-none transition-all hover:shadow-md">
            我知道了
          </button>
        </div>
      </div>
    </div>
  );
}
