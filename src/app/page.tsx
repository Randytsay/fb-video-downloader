"use client";

import { useState, useEffect } from "react";
import { Download, Monitor, CheckCircle2, AlertCircle, Search } from "lucide-react";
import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";
import { motion, AnimatePresence } from "framer-motion";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export default function Home() {
  const [url, setUrl] = useState("");
  const [cookies, setCookies] = useState("");
  const [status, setStatus] = useState<"idle" | "analyzing" | "downloading" | "success" | "error">("idle");
  const [progress, setProgress] = useState(0);
  const [logs, setLogs] = useState<string[]>([]);
  const [errorMsg, setErrorMsg] = useState("");
  const [showManual, setShowManual] = useState(false);
  const [mounted, setMounted] = useState(false);
  const [formats, setFormats] = useState<{ label: string; url: string }[]>([]);
  const [selectedFormat, setSelectedFormat] = useState<string | null>(null);

  useEffect(() => {
    setMounted(true);
    const savedCookies = localStorage.getItem("fb_cookies");
    if (savedCookies) {
      setCookies(savedCookies);
    }
  }, []);

  const handleCookieChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const val = e.target.value;
    setCookies(val);
    localStorage.setItem("fb_cookies", val);
  };

  // Stage 1: Analyze the video to find available resolutions
  const handleAnalyze = async () => {
    if (!url.trim()) {
      setStatus("error");
      setErrorMsg("請輸入 Facebook 影片網址。");
      return;
    }
    if (!cookies.trim()) {
      setStatus("error");
      setErrorMsg("請提供您的 Cookies 內容。");
      return;
    }

    try {
      setStatus("analyzing");
      setErrorMsg("");
      setFormats([]);
      setSelectedFormat(null);
      setLogs(["正在分析影片資訊 (使用 Puppeteer + yt-dlp 雙重掃描)..."]);

      const res = await fetch("/api/download", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url, cookies: cookies.trim(), action: "analyze" }),
      });

      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "分析失敗");

      if (data.formats && data.formats.length > 0) {
        setFormats(data.formats);
        setSelectedFormat(data.formats[0].url); // Default to first (usually HD)
        setStatus("idle");
        setLogs(["分析完成！您可以選擇特定的解析度，或直接點擊下方的全自動下載。"]);
      } else {
        // Not a fatal error
        setStatus("idle");
        setLogs(["分析完成，但未偵測到多種解析度。建議直接點擊「全自動下載」。"]);
      }
    } catch (err: any) {
      setStatus("idle");
      setErrorMsg(`分析提示：${err.message || "部分資訊目前無法分析"}。您可以無視此訊息，直接點擊「全自動下載」嘗試。`);
    }
  };

  // Stage 2: Download the selected resolution or fallback to direct URL
  const handleDownload = async () => {
    try {
      setStatus("downloading");
      setProgress(0);
      setLogs([]);
      setErrorMsg("");

      const res = await fetch("/api/download", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ 
          url, 
          cookies: cookies.trim(), 
          action: "download",
          selectedUrl: selectedFormat || url // Use selection if available, else use original URL
        }),
      });

      if (!res.ok) {
        throw new Error(await res.text());
      }

      if (!res.body) {
         throw new Error("無法讀取伺服器回應。");
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder("utf-8");
      
      let done = false;

      while (!done) {
        const { value, done: readerDone } = await reader.read();
        done = readerDone;
        if (value) {
           const chunk = decoder.decode(value, { stream: true });
           const lines = chunk.split('\n');
           
           for(let i = 0; i < lines.length; i++) {
               const line = lines[i];
               if(line.startsWith("event: progress")) {
                 const dataLine = lines[i + 1];
                 if(dataLine && dataLine.startsWith("data: ")) {
                    const data = JSON.parse(dataLine.replace("data: ", ""));
                    setProgress(data.percent);
                 }
               } else if (line.startsWith("event: log")) {
                 const dataLine = lines[i + 1];
                 if(dataLine && dataLine.startsWith("data: ")) {
                    const data = JSON.parse(dataLine.replace("data: ", ""));
                    setLogs((prev) => [...prev.slice(-4), data.message]); // Keep last 5 logs
                 }
               } else if (line.startsWith("event: complete")) {
                 setStatus("success");
               } else if (line.startsWith("event: error")) {
                  setStatus("error");
                  const dataLine = lines[i + 1];
                  if(dataLine && dataLine.startsWith("data: ")) {
                     const data = JSON.parse(dataLine.replace("data: ", ""));
                     setErrorMsg(data.message || "下載過程中發生錯誤。");
                  }
               }
           }
        }
      }

    } catch (err: any) {
      setStatus("error");
      setErrorMsg(err.message || "發生非預期錯誤。");
    }
  };

  const consoleScript = `(function() {
  const cookies = document.cookie.split('; ');
  const netscape = ['# Netscape HTTP Cookie File', ''];
  const now = Math.floor(Date.now() / 1000) + 3600*24*365;
  for (const c of cookies) {
    const [name, value] = c.split('=');
    netscape.push(\`.facebook.com\\tTRUE\\t/\\tTRUE\\t\${now}\\t\${name}\\t\${value}\`);
  }
  const result = netscape.join('\\n');
  const el = document.createElement('textarea');
  el.value = result;
  document.body.appendChild(el);
  el.select();
  document.execCommand('copy');
  document.body.removeChild(el);
  alert('已複製到剪貼簿！');
})();`;

  return (
    <div className="min-h-screen bg-neutral-950 text-neutral-50 flex items-center justify-center p-4 selection:bg-blue-500/30">
      <div className="max-w-xl w-full space-y-8">
        {/* Header */}
        <div className="text-center space-y-2">
          <div className="inline-flex items-center justify-center p-3 bg-blue-500/10 rounded-2xl mb-4 border border-blue-500/20 shadow-[0_0_20px_rgba(59,130,246,0.1)]">
            <Download className="w-8 h-8 text-blue-400" />
          </div>
          <h1 className="text-3xl font-bold tracking-tight bg-gradient-to-r from-blue-400 to-indigo-400 bg-clip-text text-transparent">FB 影片下載器 (Pro)</h1>
          <p className="text-neutral-400">支援私密影片下載、解析度選擇、自動轉檔 MP4。</p>
        </div>

        {/* Main Card */}
        <div className="bg-neutral-900/50 backdrop-blur-xl border border-neutral-800 rounded-3xl p-6 shadow-2xl space-y-6">
          
          {/* Input Section */}
          <div className="space-y-4">
            <div className="space-y-2">
              <label htmlFor="url" className="text-sm font-medium text-neutral-300">Facebook 影片網址</label>
              <div className="flex gap-2">
                <input
                  id="url"
                  type="url"
                  placeholder="https://www.facebook.com/..."
                  value={url}
                  onChange={(e) => {
                    setUrl(e.target.value);
                    setFormats([]);
                    setSelectedFormat(null);
                  }}
                  disabled={status === "downloading" || status === "analyzing"}
                  className="flex-1 bg-neutral-950/50 border border-neutral-800 rounded-xl px-4 py-3 text-neutral-100 placeholder:text-neutral-600 focus:outline-none focus:ring-2 focus:ring-blue-500/50 transition-all disabled:opacity-50"
                />
                <button
                  onClick={handleAnalyze}
                  disabled={status === "downloading" || status === "analyzing" || !url.trim()}
                  className="bg-neutral-800 hover:bg-neutral-700 text-neutral-200 px-4 py-2 rounded-xl border border-neutral-700 transition-all disabled:opacity-30 whitespace-nowrap text-sm font-medium flex items-center gap-2 group"
                >
                  <Search className={cn("w-4 h-4 transition-transform", status === "analyzing" && "animate-spin")} />
                  {status === "analyzing" ? "分析中..." : "分析解析度"}
                </button>
              </div>
            </div>

            <AnimatePresence>
              {formats.length > 0 && (
                <motion.div 
                  initial={{ opacity: 0, height: 0 }}
                  animate={{ opacity: 1, height: "auto" }}
                  exit={{ opacity: 0, height: 0 }}
                  className="space-y-2 overflow-hidden"
                >
                  <div className="flex items-center gap-2 mb-1">
                    <CheckCircle2 className="w-4 h-4 text-green-400" />
                    <label className="text-sm font-medium text-green-400">已成功解析影片品質：</label>
                  </div>
                  <select
                    value={selectedFormat || ""}
                    disabled={status === "downloading"}
                    onChange={(e) => setSelectedFormat(e.target.value)}
                    className="w-full bg-neutral-950 border border-blue-500/30 rounded-xl px-4 py-3 text-neutral-100 focus:outline-none focus:ring-2 focus:ring-blue-500/50 transition-all disabled:opacity-50 cursor-pointer"
                  >
                    {formats.map((f, idx) => (
                      <option key={idx} value={f.url}>{f.label}</option>
                    ))}
                  </select>
                </motion.div>
              )}
            </AnimatePresence>

            <div className="space-y-3">
              <label htmlFor="cookies" className="text-sm font-medium text-neutral-300 flex items-center justify-between">
                <span className="flex items-center gap-2">
                  <Monitor className="w-4 h-4 text-blue-400" />
                  Cookies (Netscape 格式)
                </span>
                <a 
                  href="https://chromewebstore.google.com/detail/cookie-editor/hlkenndednhhcgbbmhlhgfogleamhcbg" 
                  target="_blank" 
                  rel="noopener noreferrer"
                  className="text-xs text-blue-400 hover:underline"
                >
                  安裝擴充功能
                </a>
              </label>
              <textarea
                id="cookies"
                placeholder="# Netscape HTTP Cookie File..."
                value={cookies}
                onChange={handleCookieChange}
                disabled={status === "downloading" || status === "analyzing"}
                rows={4}
                className="w-full bg-neutral-950/50 border border-neutral-800 rounded-xl px-4 py-3 text-neutral-100 placeholder:text-neutral-700 focus:outline-none focus:ring-2 focus:ring-blue-500/50 transition-all disabled:opacity-50 font-mono text-[11px] resize-none"
              />
            </div>
          </div>

          <div className="space-y-4">
            <button
              onClick={handleDownload}
              disabled={status === "downloading" || status === "analyzing" || !url.trim()}
              className="w-full bg-blue-600 hover:bg-blue-500 text-white font-bold py-4 rounded-2xl transition-all disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-3 shadow-lg shadow-blue-500/20 text-lg group"
            >
              {status === "downloading" ? (
                <>
                  <div className="w-6 h-6 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                  正在處理與下載中...
                </>
              ) : (
                <>
                  <Download className="w-6 h-6 group-hover:translate-y-0.5 transition-transform" />
                  {selectedFormat ? "開始下載所選品質" : "全自動直接下載"}
                </>
              )}
            </button>
            {!selectedFormat && !formats.length && status === "idle" && (
              <div className="flex items-start gap-2 px-1">
                <AlertCircle className="w-3.5 h-3.5 text-neutral-500 mt-0.5" />
                <p className="text-[10px] text-neutral-500 leading-normal">
                  點擊以上按鈕將交由下載器自動判定。若想自選畫質，請先點擊上方的「分析解析度」。
                </p>
              </div>
            )}
          </div>

          {/* Progress & Logs UI */}
          <AnimatePresence mode="popLayout">
            {(status !== "idle" || logs.length > 0) && (
              <motion.div
                initial={{ opacity: 0, height: 0 }}
                animate={{ opacity: 1, height: "auto" }}
                exit={{ opacity: 0, height: 0 }}
                className="space-y-4 pt-4 border-t border-neutral-800"
              >
                {status === "downloading" && (
                  <div className="space-y-2">
                    <div className="flex justify-between text-sm font-medium">
                      <span className="text-neutral-400">目前進度</span>
                      <span className="text-blue-400">{progress.toFixed(1)}%</span>
                    </div>
                    <div className="h-2 w-full bg-neutral-950 rounded-full overflow-hidden">
                      <motion.div 
                        className="h-full bg-blue-500" 
                        initial={{ width: 0 }}
                        animate={{ width: `${progress}%` }} 
                      />
                    </div>
                  </div>
                )}
                
                <div className="bg-neutral-950/80 rounded-xl p-3 text-[10px] font-mono text-neutral-500 h-24 overflow-y-auto space-y-1 border border-neutral-800/50">
                   {logs.map((log, idx) => (
                     <div key={idx} className="truncate select-none opacity-80 hover:opacity-100 transition-opacity">
                       {log}
                     </div>
                   ))}
                </div>

                {status === "success" && (
                  <motion.div 
                    initial={{ scale: 0.9 }} animate={{ scale: 1 }}
                    className="bg-green-500/10 border border-green-500/20 text-green-400 p-4 rounded-2xl flex items-start gap-3"
                  >
                    <CheckCircle2 className="w-5 h-5 flex-shrink-0 mt-0.5" />
                    <div>
                      <p className="font-semibold">下載完成！🎉</p>
                      <p className="text-sm opacity-80">檔案已存入您的電腦「下載」資料夾。</p>
                    </div>
                  </motion.div>
                )}

                 {status === "error" && (
                  <motion.div 
                    initial={{ scale: 0.9 }} animate={{ scale: 1 }}
                    className="bg-red-500/10 border border-red-500/20 text-red-400 p-4 rounded-2xl flex items-start gap-3"
                  >
                    <AlertCircle className="w-5 h-5 flex-shrink-0 mt-0.5" />
                    <div className="overflow-hidden">
                      <p className="font-semibold">發生錯誤</p>
                      <p className="text-xs opacity-80 break-words">{errorMsg}</p>
                    </div>
                  </motion.div>
                )}
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </div>
    </div>
  );
}
