"use client";

import { useState, useEffect } from "react";
import { Download, Monitor, CheckCircle2, AlertCircle } from "lucide-react";
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
      setLogs(["正在分析影片資訊..."]);

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
        setLogs(["分析完成，請選擇解析度後下載。"]);
      } else {
        throw new Error("找不到可用的影片解析度，請確認網址或 Cookies 是否正確。");
      }
    } catch (err: any) {
      setStatus("error");
      setErrorMsg(err.message || "分析過程中發生錯誤。");
    }
  };

  // Stage 2: Download the selected resolution
  const handleDownload = async () => {
    if (!selectedFormat) return;

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
          selectedUrl: selectedFormat 
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

  const magicUrlFinderScript = `(function() {
  const findVideo = () => {
    const patterns = [
      /"browser_native_hd_url":"(.*?)"/,
      /"browser_native_sd_url":"(.*?)"/,
      /"playable_url":"(.*?)"/,
      /"playable_url_quality_hd":"(.*?)"/
    ];
    let targetUrl = null;
    const html = document.documentElement.innerHTML;
    for (const p of patterns) {
      const match = html.match(p);
      if (match) {
        targetUrl = JSON.parse(\`"\${match[1]}"\`);
        if (targetUrl.startsWith('http')) break;
      }
    }
    if (!targetUrl) {
      const entries = performance.getEntriesByType("resource");
      const videoEntry = entries.find(e => (e.name.includes(".mp4") || e.name.includes("video")) && e.name.includes("fbcdn.net"));
      if (videoEntry) targetUrl = videoEntry.name;
    }
    if (targetUrl) {
      const el = document.createElement('textarea');
      el.value = targetUrl;
      document.body.appendChild(el);
      el.select();
      document.execCommand('copy');
      document.body.removeChild(el);
      alert("成功！已找到並複製影片連結。\\n請貼回下載器的網址欄。");
      return true;
    }
    alert("仍找不到隱藏連結。");
    return false;
  };
  findVideo();
})();`;

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
          <div className="inline-flex items-center justify-center p-3 bg-blue-500/10 rounded-2xl mb-4 border border-blue-500/20">
            <Download className="w-8 h-8 text-blue-400" />
          </div>
          <h1 className="text-3xl font-bold tracking-tight">FB 影片下載器</h1>
          <p className="text-neutral-400">立即從私密社團下載高畫質影片。</p>
        </div>

        {/* Main Card */}
        <div className="bg-neutral-900 border border-neutral-800 rounded-3xl p-6 shadow-2xl space-y-6">
          
          {/* Input Section */}
          <div className="space-y-4">
            <div className="space-y-2">
              <label htmlFor="url" className="text-sm font-medium text-neutral-300">Facebook 影片網址</label>
              <div className="flex gap-2">
                <input
                  id="url"
                  type="url"
                  placeholder="https://www.facebook.com/groups/..."
                  value={url}
                  onChange={(e) => setUrl(e.target.value)}
                  disabled={status === "downloading" || status === "analyzing"}
                  className="flex-1 bg-neutral-950 border border-neutral-800 rounded-xl px-4 py-3 text-neutral-100 placeholder:text-neutral-600 focus:outline-none focus:ring-2 focus:ring-blue-500/50 transition-all disabled:opacity-50"
                />
                <button
                  onClick={handleAnalyze}
                  disabled={status === "downloading" || status === "analyzing" || !url.trim()}
                  className="bg-neutral-800 hover:bg-neutral-700 text-neutral-200 px-4 py-2 rounded-xl border border-neutral-700 transition-all disabled:opacity-30 whitespace-nowrap text-sm font-medium"
                >
                  {status === "analyzing" ? "分析中..." : "分析影片"}
                </button>
              </div>
            </div>

            {formats.length > 0 && (
              <motion.div 
                initial={{ opacity: 0, scale: 0.95 }}
                animate={{ opacity: 1, scale: 1 }}
                className="space-y-2"
              >
                <label className="text-sm font-medium text-neutral-300">選擇下載品質</label>
                <select
                  value={selectedFormat || ""}
                  disabled={status === "downloading"}
                  onChange={(e) => setSelectedFormat(e.target.value)}
                  className="w-full bg-neutral-950 border border-neutral-800 rounded-xl px-4 py-3 text-neutral-100 focus:outline-none focus:ring-2 focus:ring-blue-500/50 transition-all disabled:opacity-50"
                >
                  {formats.map((f, idx) => (
                    <option key={idx} value={f.url}>{f.label}</option>
                  ))}
                </select>
              </motion.div>
            )}

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
                  安裝 Cookie-Editor
                </a>
              </label>
              <textarea
                id="cookies"
                placeholder="# Netscape HTTP Cookie File..."
                value={cookies}
                onChange={handleCookieChange}
                disabled={status === "downloading" || status === "analyzing"}
                rows={4}
                className="w-full bg-neutral-950 border border-neutral-800 rounded-xl px-4 py-3 text-neutral-100 placeholder:text-neutral-700 focus:outline-none focus:ring-2 focus:ring-blue-500/50 transition-all disabled:opacity-50 font-mono text-[11px] resize-none"
              />
            </div>
          </div>

          <button
            onClick={handleDownload}
            disabled={status !== "idle" || !selectedFormat}
            className="w-full bg-blue-600 hover:bg-blue-500 text-white font-medium py-3.5 rounded-xl transition-all disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2 shadow-lg shadow-blue-500/20"
          >
            {status === "downloading" ? (
              <>
                <div className="w-5 h-5 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                正在下載中...
              </>
            ) : (
              <>
                <Download className="w-5 h-5" />
                開始下載影片
              </>
            )}
          </button>

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
                      <span className="text-neutral-400">下載進度</span>
                      <span className="text-blue-400">{progress.toFixed(1)}%</span>
                    </div>
                    <div className="h-2 w-full bg-neutral-950 rounded-full overflow-hidden">
                      <motion.div className="h-full bg-blue-500" animate={{ width: `${progress}%` }} />
                    </div>
                  </div>
                )}
                <div className="bg-neutral-950 rounded-lg p-3 text-[10px] font-mono text-neutral-500 h-24 overflow-y-auto space-y-1">
                   {logs.map((log, idx) => <div key={idx} className="truncate select-none">{log}</div>)}
                </div>

                {status === "success" && (
                  <div className="bg-green-500/10 border border-green-500/20 text-green-400 p-4 rounded-xl flex items-start gap-3">
                    <CheckCircle2 className="w-5 h-5 flex-shrink-0" />
                    <p className="text-sm">下載完成！檔案已存入「下載」資料夾。</p>
                  </div>
                )}

                 {status === "error" && (
                  <div className="bg-red-500/10 border border-red-500/20 text-red-400 p-4 rounded-xl flex items-start gap-3">
                    <AlertCircle className="w-5 h-5 flex-shrink-0" />
                    <p className="text-sm truncate">{errorMsg}</p>
                  </div>
                )}
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </div>
    </div>
  );
}
