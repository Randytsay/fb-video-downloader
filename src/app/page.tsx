"use client";

import { useState, useEffect } from "react";
import { Download, Monitor, CheckCircle2, AlertCircle, Search, FileText } from "lucide-react";
import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";
import { motion, AnimatePresence } from "framer-motion";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

interface Format {
  label: string;
  url: string;
  formatId?: string;
}

export default function Home() {
  const [url, setUrl] = useState("");
  const [cookies, setCookies] = useState("");
  const [filename, setFilename] = useState("");
  const [status, setStatus] = useState<"idle" | "analyzing" | "downloading" | "success" | "error">("idle");
  const [progress, setProgress] = useState(0);
  const [logs, setLogs] = useState<string[]>([]);
  const [errorMsg, setErrorMsg] = useState("");
  const [mounted, setMounted] = useState(false);
  const [formats, setFormats] = useState<Format[]>([]);
  const [selectedFormat, setSelectedFormat] = useState<Format | null>(null);
  const [showManual, setShowManual] = useState(false);

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
    const videoTag = document.querySelector('video');
    if (videoTag && videoTag.src && videoTag.src.startsWith('http')) targetUrl = videoTag.src;
    if (!targetUrl) {
      const links = Array.from(document.querySelectorAll('a'));
      const videoLink = links.find(a => a.href.includes("video_redirect") || a.href.includes(".mp4"));
      if (videoLink) targetUrl = videoLink.href;
    }
    if (targetUrl) {
      const el = document.createElement('textarea');
      el.value = targetUrl;
      document.body.appendChild(el);
      el.select();
      document.execCommand('copy');
      document.body.removeChild(el);
      alert("成功！已找到影片原始連結。\\n請貼回下載器的網址欄。");
      return true;
    }
    alert("找不到影片連結。\\n提示：在 mbasic 頁面請先「播放」一下影片，等網頁跳轉到只有影片的黑背景頁面後，再執行此腳本。");
    return false;
  };
  findVideo();
})();`;

  const consoleScript = `(function() {
  const cookies = document.cookie.split('; ');
  const netscape = ['# Netscape HTTP Cookie File', '# http://curl.haxx.se/rfc/cookie_spec.html', '# This is a generated file!  Do not edit.', ''];
  const now = Math.floor(Date.now() / 1000) + 3600*24*365;
  for (const c of cookies) {
    const [name, value] = c.split('=');
    if (name && value) netscape.push(\`.facebook.com\\tTRUE\\t/\\tTRUE\\t\${now}\\t\${name}\\t\${value}\`);
  }
  const result = netscape.join('\\n');
  if (confirm('Cookies 已生成，是否複製到剪貼簿？')) {
    const el = document.createElement('textarea');
    el.value = result;
    document.body.appendChild(el);
    el.select();
    document.execCommand('copy');
    document.body.removeChild(el);
    alert('已複製到剪貼簿！');
  }
})();`;

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

      if (!res.ok) throw new Error(await res.text() || "分析失敗");
      if (!res.body) throw new Error("無法讀取伺服器分析流。");

      const reader = res.body.getReader();
      const decoder = new TextDecoder("utf-8");
      let done = false;

      while (!done) {
        const { value, done: readerDone } = await reader.read();
        done = readerDone;
        if (value) {
          const chunk = decoder.decode(value, { stream: true });
          const lines = chunk.split('\n');
          for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            if (line.startsWith("event: log")) {
              const dataLine = lines[i + 1];
              if (dataLine && dataLine.startsWith("data: ")) {
                const data = JSON.parse(dataLine.replace("data: ", ""));
                setLogs((prev) => [...prev.slice(-49), data.message]);
              }
            } else if (line.startsWith("event: analyze_complete")) {
              const dataLine = lines[i + 1];
              if (dataLine && dataLine.startsWith("data: ")) {
                const data = JSON.parse(dataLine.replace("data: ", ""));
                if (data.formats && data.formats.length > 0) {
                  setFormats(data.formats);
                  setSelectedFormat(data.formats[0]);
                  setLogs((prev) => [...prev.slice(-49), "分析完成！您可以選擇特定的解析度。"]);
                } else {
                  setLogs((prev) => [...prev.slice(-49), "分析完成，但未偵測到多種解析度。建議全自動下載。"]);
                }
              }
              setStatus("idle");
            } else if (line.startsWith("event: error")) {
              const dataLine = lines[i + 1];
              if (dataLine && dataLine.startsWith("data: ")) {
                const data = JSON.parse(dataLine.replace("data: ", ""));
                throw new Error(data.message);
              }
            }
          }
        }
      }
    } catch (err: any) {
      setStatus("idle");
      setErrorMsg(`分析提示：${err.message || "目前無法取得解析度列表"}。您可以直接輸入檔名後點擊「全自動下載」。`);
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
          selectedUrl: selectedFormat?.url || url,
          formatId: selectedFormat?.formatId,
          customFilename: filename.trim()
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
                    setLogs((prev) => [...prev.slice(-49), data.message]); // Keep last 50 logs
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

  if (!mounted) return <div className="min-h-screen bg-neutral-950" />;

  return (
    <div className="min-h-screen bg-neutral-950 text-neutral-50 flex items-center justify-center p-4 selection:bg-blue-500/30">
      <div className="max-w-xl w-full space-y-8">
        {/* Header */}
        <div className="text-center space-y-2">
          <div className="inline-flex items-center justify-center p-3 bg-blue-500/10 rounded-2xl mb-4 border border-blue-500/20 shadow-[0_0_20px_rgba(59,130,246,0.1)]">
            <Download className="w-8 h-8 text-blue-400" />
          </div>
          <h1 className="text-3xl font-bold tracking-tight bg-gradient-to-r from-blue-400 to-indigo-400 bg-clip-text text-transparent">FB 影片下載器 (Pro)</h1>
          <p className="text-neutral-400">支援私密影片下載、品質自選、影音同步對齊。</p>
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
                  className="space-y-4 overflow-hidden"
                >
                  <div className="space-y-2">
                    <div className="flex items-center gap-2 mb-1">
                      <CheckCircle2 className="w-4 h-4 text-green-400" />
                      <label className="text-sm font-medium text-green-400">請選擇影片畫質 (DASH 已支援音訊合併)：</label>
                    </div>
                    <select
                      value={selectedFormat?.url || ""}
                      disabled={status === "downloading"}
                      onChange={(e) => {
                        const fmt = formats.find(f => f.url === e.target.value);
                        if (fmt) setSelectedFormat(fmt);
                      }}
                      className="w-full bg-neutral-950 border border-blue-500/30 rounded-xl px-4 py-3 text-neutral-100 focus:outline-none focus:ring-2 focus:ring-blue-500/50 transition-all disabled:opacity-50 cursor-pointer"
                    >
                      {formats.map((f, idx) => (
                        <option key={idx} value={f.url}>{f.label}</option>
                      ))}
                    </select>
                  </div>
                </motion.div>
              )}
            </AnimatePresence>

            {/* Filename Input */}
            <div className="space-y-2">
              <label htmlFor="filename" className="text-sm font-medium text-neutral-300 flex items-center gap-2">
                <FileText className="w-4 h-4 text-indigo-400" />
                存檔名稱 (選填)
              </label>
              <input
                id="filename"
                type="text"
                placeholder="我的影片 (不需輸入副檔名)"
                value={filename}
                onChange={(e) => setFilename(e.target.value)}
                disabled={status === "downloading" || status === "analyzing"}
                className="w-full bg-neutral-950/50 border border-neutral-800 rounded-xl px-4 py-3 text-neutral-100 placeholder:text-neutral-700 focus:outline-none focus:ring-2 focus:ring-indigo-500/50 transition-all disabled:opacity-50"
              />
            </div>

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

              <div className="flex flex-col gap-2">
                <div className="bg-blue-500/5 border border-blue-500/10 rounded-xl p-3 space-y-2">
                  <div className="flex justify-between items-center">
                    <p className="text-[11px] font-medium text-blue-400">無法安裝擴充功能？手動教學：</p>
                    <button 
                      onClick={() => setShowManual(!showManual)}
                      className="text-[10px] text-neutral-500 hover:text-neutral-300 underline underline-offset-2"
                    >
                      {showManual ? "隱藏手動導引" : "顯示手動方法"}
                    </button>
                  </div>
                  
                  <AnimatePresence>
                    {showManual && (
                      <motion.div 
                        initial={{ opacity: 0, height: 0 }}
                        animate={{ opacity: 1, height: "auto" }}
                        exit={{ opacity: 0, height: 0 }}
                        className="space-y-4 pt-1 border-t border-white/5 mt-2 overflow-hidden"
                      >
                        <div className="space-y-1.5">
                          <p className="text-[11px] font-medium text-neutral-300">方法 A：瀏覽器控制台 (最快)</p>
                          <p className="text-[10px] text-neutral-400 leading-normal">
                            按 F12 &rarr; Console &rarr; 貼上以下代碼並按 Enter。
                          </p>
                          <button
                            onClick={() => {
                              navigator.clipboard.writeText(consoleScript);
                              alert("代碼已複製！請在 Facebook 分頁按 F12 -> Console 貼上並執行。");
                            }}
                            className="w-full bg-blue-500/20 hover:bg-blue-500/30 text-blue-300 text-[10px] py-1.5 rounded-lg border border-blue-500/20 transition-all font-medium"
                          >
                            點此複製抓取代碼
                          </button>
                        </div>

                        <div className="space-y-1.5">
                          <p className="text-[11px] font-medium text-neutral-300">方法 B：Network 手動複製</p>
                          <ol className="text-[10px] text-neutral-400 list-decimal list-inside space-y-1">
                            <li>F12 &rarr; Network &rarr; 重新整理網頁</li>
                            <li>找 `graphql` 請求 &rarr; 查看 Request Headers</li>
                            <li>複製 `cookie:` 整段內容並貼到上方框內</li>
                          </ol>
                        </div>

                        <div className="space-y-1.5 pt-2 border-t border-white/5">
                          <p className="text-[11px] font-medium text-green-400">方法 C：魔法影片抓取腳本 (免 Cookie)</p>
                          <p className="text-[10px] text-neutral-400 leading-normal">
                            若不想用 Cookies，可點此複製腳本並在影片頁面執行，它會幫你直接抓取 MP4 連結。
                          </p>
                          <button
                            onClick={() => {
                              navigator.clipboard.writeText(magicUrlFinderScript);
                              alert("腳本已複製！請在影片頁面按 F12 -> Console 貼上執行，它會自動複製連結。");
                            }}
                            className="w-full bg-green-500/10 hover:bg-green-500/20 text-green-300 text-[10px] py-1.5 rounded-lg border border-green-500/20 transition-all font-medium"
                          >
                            點此複製魔法腳本
                          </button>
                        </div>

                        <div className="space-y-1.5 pt-2 border-t border-white/5">
                          <p className="text-[11px] font-medium text-blue-400 font-bold">方法 E：mbasic 密技 (最推薦)</p>
                          <ol className="text-[10px] text-neutral-400 list-decimal list-inside space-y-1 leading-normal">
                            <li>將網址的 www 改為 mbasic</li>
                            <li>點擊影片進入獨立播放頁面</li>
                            <li>複製該播放頁網址貼回本程式即可下載</li>
                          </ol>
                        </div>
                      </motion.div>
                    )}
                  </AnimatePresence>
                </div>
              </div>
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
                  正在努力下載與合併中...
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
                  提示：您可以先「分析解析度」來選擇畫質並指定檔名，或直接全自動下載。
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
                      <span className="text-neutral-400">處理進度 (含合併時間)</span>
                      <span className="text-blue-400">{progress.toFixed(1)}%</span>
                    </div>
                    <div className="h-2 w-full bg-neutral-950 rounded-full overflow-hidden">
                      <motion.div 
                        className="h-full bg-blue-500" 
                        initial={{ width: 0 }}
                        animate={{ width: `${progress}%` }} 
                        transition={{ duration: 0.5 }}
                      />
                    </div>
                  </div>
                )}
                
                <div className="bg-neutral-950/80 rounded-xl p-3 text-[10px] font-mono text-neutral-500 h-32 overflow-y-auto space-y-1 border border-neutral-800/50">
                   {logs.map((log, idx) => (
                     <div key={idx} className="break-words select-all opacity-80 hover:opacity-100 transition-opacity">
                       {log}
                     </div>
                   ))}
                </div>

                {status === "success" && (
                  <motion.div 
                    initial={{ scale: 0.9, opacity: 0 }} animate={{ scale: 1, opacity: 1 }}
                    className="bg-green-500/10 border border-green-500/20 text-green-400 p-4 rounded-2xl flex items-start gap-3"
                  >
                    <CheckCircle2 className="w-5 h-5 flex-shrink-0 mt-0.5" />
                    <div>
                      <p className="font-semibold">下載完成！🎉</p>
                      <p className="text-sm opacity-80">您的檔案已成功儲存至「下載」資料夾。</p>
                    </div>
                  </motion.div>
                )}

                 {status === "error" && (
                  <motion.div 
                    initial={{ scale: 0.9, opacity: 0 }} animate={{ scale: 1, opacity: 1 }}
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
