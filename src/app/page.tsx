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
  const [status, setStatus] = useState<"idle" | "downloading" | "success" | "error">("idle");
  const [progress, setProgress] = useState(0);
  const [logs, setLogs] = useState<string[]>([]);
  const [errorMsg, setErrorMsg] = useState("");
  const [showManual, setShowManual] = useState(false);
  const [mounted, setMounted] = useState(false);

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

  const magicUrlFinderScript = `(function() {
  const findVideo = () => {
    // 1. More aggressive Regex for FB CDN URLs
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

    // 2. Try to find the first high-quality mp4 in performance logs
    if (!targetUrl) {
      const entries = performance.getEntriesByType("resource");
      const videoEntry = entries.find(e => 
        (e.name.includes(".mp4") || e.name.includes("video")) && 
        e.name.includes("fbcdn.net")
      );
      if (videoEntry) targetUrl = videoEntry.name;
    }

    // 3. Look for raw <video> tags (useful for mbasic)
    const videoTag = document.querySelector('video');
    if (videoTag && videoTag.src && videoTag.src.startsWith('http')) targetUrl = videoTag.src;

    // 4. Look for raw <a> download links (mbasic redirect)
    if (!targetUrl) {
      const links = Array.from(document.querySelectorAll('a'));
      const videoLink = links.find(a => a.href.includes("video_redirect") || a.href.includes(".mp4"));
      if (videoLink) targetUrl = videoLink.href;
    }

    if (targetUrl) {
      console.log("Found:", targetUrl);
      const el = document.createElement('textarea');
      el.value = targetUrl;
      document.body.appendChild(el);
      el.select();
      document.execCommand('copy');
      document.body.removeChild(el);
      alert("成功！已找到並複製影片連結。\\n請貼回下載器的網址欄。");
      return true;
    }
    
    alert("仍找不到隱藏連結。\\n提示：在 mbasic 頁面請先『點擊播放影片』，等它跳轉到只有影片的黑畫面後，再執行此腳本。");
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
    netscape.push(\`.facebook.com\\tTRUE\\t/\\tTRUE\\t\${now}\\t\${name}\\t\${value}\`);
  }
  const result = netscape.join('\\n');
  console.log(result);
  if (confirm('Cookies 已產生，是否複製到剪貼簿？')) {
    const el = document.createElement('textarea');
    el.value = result;
    document.body.appendChild(el);
    el.select();
    document.execCommand('copy');
    document.body.removeChild(el);
    alert('已複製到剪貼簿！');
  }
})();`;

  const handleDownload = async () => {
    // Reset state first so the UI updates immediately
    setStatus("idle");
    setErrorMsg("");

    const trimmedUrl = url.trim();
    if (!trimmedUrl) {
      setStatus("error");
      setErrorMsg("請輸入 Facebook 影片網址。");
      return;
    }
    if (!trimmedUrl.includes("facebook.com") && !trimmedUrl.includes("fbcdn.net") && !trimmedUrl.includes(".mp4")) {
      setStatus("error");
      setErrorMsg("請輸入有效的 Facebook 影片網址或直接影片連結。");
      return;
    }

    if (!cookies.trim()) {
      setStatus("error");
      setErrorMsg("請提供您的 Cookies 內容。");
      return;
    }

    try {
      setStatus("downloading");
      setProgress(0);
      setLogs([]);
      setErrorMsg("");

      const res = await fetch("/api/download", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url, cookies: cookies.trim() }),
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
                     setErrorMsg(data.message);
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
              <input
                id="url"
                type="url"
                placeholder="https://www.facebook.com/groups/..."
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                disabled={status === "downloading"}
                className="w-full bg-neutral-950 border border-neutral-800 rounded-xl px-4 py-3 text-neutral-100 placeholder:text-neutral-600 focus:outline-none focus:ring-2 focus:ring-blue-500/50 transition-all disabled:opacity-50"
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
                  className="text-xs text-blue-400 hover:underline flex items-center gap-1"
                >
                  安裝 Cookie-Editor 擴充功能
                </a>
              </label>
              
              <div className="relative group">
                <textarea
                  id="cookies"
                  placeholder="# Netscape HTTP Cookie File&#10;.facebook.com	TRUE	/	TRUE	..."
                  value={cookies}
                  onChange={handleCookieChange}
                  disabled={status === "downloading"}
                  rows={5}
                  className="w-full bg-neutral-950 border border-neutral-800 rounded-xl px-4 py-3 text-neutral-100 placeholder:text-neutral-700 focus:outline-none focus:ring-2 focus:ring-blue-500/50 transition-all disabled:opacity-50 font-mono text-[11px] leading-relaxed resize-none"
                />
              </div>

              <div className="flex flex-col gap-2">
                <div className="bg-blue-500/5 border border-blue-500/10 rounded-xl p-3 space-y-2">
                  <div className="flex justify-between items-center">
                    <p className="text-[11px] font-medium text-blue-400 whitespace-nowrap">如何取得 Cookies：</p>
                    <button 
                      onClick={() => setShowManual(!showManual)}
                      className="text-[10px] text-neutral-500 hover:text-neutral-300 underline underline-offset-2"
                    >
                      {showManual ? "關閉手動指南" : "無法使用擴充功能？(手動指南)"}
                    </button>
                  </div>
                  
                  {!showManual ? (
                    <ol className="text-[10px] text-neutral-400 list-decimal list-inside space-y-1">
                      <li>在瀏覽器打開 Facebook 影片頁面</li>
                      <li>點擊 **Cookie-Editor** 圖示</li>
                      <li>點擊 **Export** &rarr; 選擇 **Netscape**</li>
                      <li>將複製的內容貼到上方輸入框（本系統會自動儲存）</li>
                    </ol>
                  ) : (
                    <div className="space-y-4 pt-1 border-t border-white/5 mt-2">
                      <div className="space-y-1.5">
                        <p className="text-[11px] font-medium text-neutral-300">方法 A：控制台腳本 (較快)</p>
                        <p className="text-[10px] text-neutral-400 leading-normal">
                          按 F12 &rarr; Console &rarr; 貼上並執行下方腳本。
                        </p>
                        <button
                          onClick={() => {
                            navigator.clipboard.writeText(consoleScript);
                            alert("腳本已複製！請貼到瀏覽器控制台 (F12 Console) 並按 Enter。");
                          }}
                          className="w-full bg-blue-500/20 hover:bg-blue-500/30 text-blue-300 text-[10px] py-1.5 rounded-lg border border-blue-500/20 transition-all font-medium"
                        >
                          複製控制台腳本
                        </button>
                      </div>

                      <div className="space-y-1.5">
                        <p className="text-[11px] font-medium text-neutral-300">方法 B：Network 分頁 (最穩)</p>
                        <ol className="text-[10px] text-neutral-400 list-decimal list-inside space-y-1">
                          <li>按 **F12** &rarr; **Network** 分頁 &rarr; **重新整理** 網頁</li>
                          <li>找到一個名為 `graphql` 的請求 &rarr; 查看 **Request Headers**</li>
                          <li>找到 **cookie:** 欄位 &rarr; **複製所有內容**</li>
                          <li>貼到上方的 **Cookies** 輸入框即可</li>
                        </ol>
                      </div>

                      <div className="space-y-1.5 pt-2 border-t border-white/5">
                        <p className="text-[11px] font-medium text-green-400">方法 C：神奇網址搜尋腳本 (備用)</p>
                        <p className="text-[10px] text-neutral-400 leading-normal">
                          如果使用 Cookies 仍下載失敗，可以嘗試直接抓取影片連結：
                        </p>
                        <button
                          onClick={() => {
                            navigator.clipboard.writeText(magicUrlFinderScript);
                            alert("神奇腳本已複製！在影片播放時，貼到瀏覽器控制台 (F12 Console) 執行。");
                          }}
                          className="w-full bg-green-500/10 hover:bg-green-500/20 text-green-300 text-[10px] py-1.5 rounded-lg border border-green-500/20 transition-all font-medium"
                        >
                          複製神奇搜尋腳本
                        </button>
                        <p className="text-[9px] text-neutral-500 italic">
                          該腳本會掃描瀏覽器記憶體中真實的高畫質/低畫質 .mp4 連結。
                        </p>
                      </div>

                      <div className="space-y-1.5 pt-2 border-t border-white/5">
                        <p className="text-[11px] font-medium text-red-400">方法 D：Network 媒體分頁</p>
                        <ol className="text-[10px] text-neutral-400 list-decimal list-inside space-y-1 leading-normal">
                          <li>F12 &rarr; Network &rarr; **All** (不要用 Media)</li>
                          <li>搜尋/篩選關鍵字：**&quot;_nc_&quot;** 或 **&quot;mp4&quot;**</li>
                          <li>對請求按右鍵 &rarr; Copy &rarr; Copy link address</li>
                        </ol>
                      </div>

                      <div className="space-y-1.5 pt-2 border-t border-red-500/20">
                        <p className="text-[11px] font-medium text-blue-400 font-bold">方法 E：mbasic 密技 (最推薦/最快)</p>
                        <ol className="text-[10px] text-neutral-400 list-decimal list-inside space-y-1 leading-normal">
                          <li>將臉書網址中的 **www** 改成 **mbasic**。</li>
                          <li>打開連結 &rarr; **點擊** 影片播放按鈕。</li>
                          <li>它會跳轉到一個**只有影片內容**的黑畫面。</li>
                          <li>對影片按右鍵即可存檔，或在此執行 **神奇搜尋腳本**！</li>
                        </ol>
                      </div>
                    </div>
                  )}
                </div>
              </div>
            </div>
          </div>

          <button
            onClick={handleDownload}
            disabled={status === "downloading"}
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

          {/* Progress & Status UI */}
          <AnimatePresence mode="popLayout">
            {status !== "idle" && (
              <motion.div
                initial={{ opacity: 0, height: 0 }}
                animate={{ opacity: 1, height: "auto" }}
                exit={{ opacity: 0, height: 0 }}
                className="space-y-4 pt-4 border-t border-neutral-800"
              >
                
                {status === "downloading" && (
                  <div className="space-y-2">
                    <div className="flex justify-between text-sm font-medium mb-1">
                      <span className="text-neutral-400">下載進度</span>
                      <span className="text-blue-400">{progress.toFixed(1)}%</span>
                    </div>
                    <div className="h-2 w-full bg-neutral-950 rounded-full overflow-hidden">
                      <motion.div 
                        className="h-full bg-blue-500 rounded-full"
                        initial={{ width: 0 }}
                        animate={{ width: `${progress}%` }}
                        transition={{ duration: 0.2 }}
                      />
                    </div>
                    
                    {/* Tiny Terminal Logs */}
                    <div className="mt-4 bg-neutral-950 rounded-lg p-3 text-xs font-mono text-neutral-500 h-24 overflow-y-auto flex flex-col justify-end space-y-1">
                       {logs.length > 0 ? logs.map((log, idx) => (
                           <div key={idx} className="truncate select-none opacity-80">{log}</div>
                       )) : <div className="animate-pulse">正在透過 Puppeteer 擷取中...</div>}
                    </div>
                  </div>
                )}

                {status === "success" && (
                  <motion.div 
                     initial={{ scale: 0.95 }}
                     animate={{ scale: 1 }}
                     className="bg-green-500/10 border border-green-500/20 text-green-400 p-4 rounded-xl flex items-start gap-3"
                  >
                    <CheckCircle2 className="w-5 h-5 flex-shrink-0 mt-0.5" />
                    <div>
                      <h4 className="font-medium">下載完成！</h4>
                      <p className="text-sm opacity-80 mt-1">影片已存入您電腦的「下載 (Downloads)」資料夾。</p>
                    </div>
                  </motion.div>
                )}

                 {status === "error" && (
                  <motion.div 
                     initial={{ scale: 0.95 }}
                     animate={{ scale: 1 }}
                     className="bg-red-500/10 border border-red-500/20 text-red-400 p-4 rounded-xl flex items-start gap-3"
                  >
                    <AlertCircle className="w-5 h-5 flex-shrink-0 mt-0.5" />
                    <div className="overflow-hidden">
                      <h4 className="font-medium">下載失敗</h4>
                      <p className="text-sm opacity-80 mt-1 truncate" title={errorMsg}>{errorMsg}</p>
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
