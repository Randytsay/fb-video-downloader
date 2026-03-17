import { NextRequest, NextResponse } from "next/server";
import { spawn } from "child_process";
import path from "path";
import fs from "fs";
import os from "os";

// A helper function to create a SSE stream
function createSSEStream() {
  let streamController: ReadableStreamDefaultController;
  const stream = new ReadableStream({
    start(controller) {
      streamController = controller;
    },
  });

  const sendEvent = (event: string, data: any) => {
    if (streamController) {
      streamController.enqueue(
        `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
      );
    }
  };

  const closeStream = () => {
    if (streamController) {
      streamController.close();
    }
  };

  return { stream, sendEvent, closeStream };
}

// Parse raw cookie string into CDP cookie objects
function parseCookiesToCDP(cookieStr: string) {
  const cookies: any[] = [];
  if (cookieStr.startsWith("# Netscape")) {
    const lines = cookieStr.split("\n");
    for (const line of lines) {
      if (line.startsWith("#") || !line.trim()) continue;
      const parts = line.split("\t");
      if (parts.length >= 7) {
        cookies.push({
          name: parts[5],
          value: parts[6],
          domain: parts[0],
          path: parts[2],
          secure: parts[3] === "TRUE",
          httpOnly: false,
          expires: parseInt(parts[4]) || -1,
        });
      }
    }
  } else {
    const pairs = cookieStr.split(";");
    for (const p of pairs) {
      const idx = p.indexOf("=");
      if (idx === -1) continue;
      const name = p.substring(0, idx).trim();
      const value = p.substring(idx + 1).trim();
      if (name) {
        cookies.push({
          name,
          value,
          domain: ".facebook.com",
          path: "/",
          secure: true,
          httpOnly: name === "xs" || name === "c_user",
          expires: Math.floor(Date.now() / 1000) + 3600 * 24 * 365,
        });
      }
    }
  }
  return cookies;
}

export async function POST(req: NextRequest) {
  let tempCookiePath = "";
  try {
    const { url, cookies, action, selectedUrl, formatId, customFilename } = await req.json();

    if (!url) return NextResponse.json({ error: "No URL provided." }, { status: 400 });
    if (!cookies) return NextResponse.json({ error: "Cookies content is required." }, { status: 400 });

    // Resolve paths
    // @ts-ignore
    const isElectron = !!process.versions.electron;
    // @ts-ignore
    const resourcesPath = isElectron && process.resourcesPath ? process.resourcesPath : process.cwd();
    const ytDlpPath = path.join(resourcesPath, "scripts", "yt-dlp.exe");
    const ffmpegPath = path.join(resourcesPath, "scripts");
    const downloadsDir = path.join(os.homedir(), "Downloads");

    if (!fs.existsSync(downloadsDir)) fs.mkdirSync(downloadsDir, { recursive: true });

    const { stream, sendEvent, closeStream } = createSSEStream();

    if (action === "analyze") {
      (async () => {
        try {
          sendEvent("log", { message: "啟動分析引擎 (Puppeteer + yt-dlp 雙重掃描)..." });
          const foundFormats = new Map<string, { url: string; formatId?: string }>();
          try {
            const puppeteer = await import("puppeteer-core");
            const chromePath = Buffer.from("QzpcUHJvZ3JhbSBGaWxlc1xHb29nbGVcQ2hyb21lXEFwcGxpY2F0aW9uXGNocm9tZS5leGU=", "base64").toString();
            
            if (fs.existsSync(chromePath)) {
              sendEvent("log", { message: "[Puppeteer] 正在模擬瀏覽器環境..." });
              const browser = await puppeteer.default.launch({
                executablePath: chromePath,
                headless: true,
                args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-blink-features=AutomationControlled"],
              });

              try {
                const page = await browser.newPage();
                await page.setUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36");
                
                const cdpCookies = parseCookiesToCDP(cookies.trim());
                const client = await page.createCDPSession();
                for (const cookie of cdpCookies) {
                  try { await client.send("Network.setCookie", cookie); } catch (e) {}
                }
                await client.send("Network.enable");

                client.on("Network.responseReceived", async (params: any) => {
                  const { response, requestId } = params;
                  if (response.url.includes("graphql") || response.url.includes("api/graphql")) {
                    try {
                      const result = await client.send("Network.getResponseBody", { requestId }) as any;
                      const body = result.body;
                      const patterns = [
                        { label: "HD (高畫質)", regex: /"browser_native_hd_url":"(.*?)"/ },
                        { label: "SD (標準畫質)", regex: /"browser_native_sd_url":"(.*?)"/ },
                        { label: "預覽 (HD)", regex: /"playable_url_quality_hd":"(.*?)"/ },
                        { label: "預覽 (SD)", regex: /"playable_url":"(.*?)"/ },
                        { label: "影片來源 (Progressive)", regex: /"progressive_url":"([^"]+)"/ },
                      ];
                      for (const p of patterns) {
                        const match = body.match(p.regex);
                        if (match && !foundFormats.has(p.label)) {
                          try {
                            let decoded = match[1].replace(/\\\//g, "/").replace(/\\u0025/g, "%");
                            try { decoded = JSON.parse(`"${decoded}"`); } catch(e) {}
                            if (decoded.startsWith("http")) foundFormats.set(p.label, { url: decoded });
                          } catch(e) {}
                        }
                      }
                    } catch (e) {}
                  }
                });

                sendEvent("log", { message: "[Puppeteer] 正在載入影片頁面並攔截資料流..." });
                await page.goto(url, { waitUntil: "networkidle2", timeout: 25000 });
                await new Promise(r => setTimeout(r, 4000));

                const html = await page.evaluate(() => document.documentElement.innerHTML);
                const patterns = [
                  { label: "HD (高畫質)", regex: /"browser_native_hd_url":"(.*?)"/ },
                  { label: "SD (標準畫質)", regex: /"browser_native_sd_url":"(.*?)"/ },
                  { label: "影片來源 (Progressive)", regex: /"progressive_url":"(.*?)"/ },
                  { label: "HD (預覽)", regex: /"playable_url_quality_hd":"(.*?)"/ },
                  { label: "SD (預覽)", regex: /"playable_url":"(.*?)"/ },
                  { label: "HD (分流)", regex: /hd_src["\s:]+["']([^"']+)["']/ },
                  { label: "SD (分流)", regex: /sd_src["\s:]+["']([^"']+)["']/ },
                  { label: "HD (來源)", regex: /hd_src_no_ratelimit["\s:]+["']([^"']+)["']/ },
                  { label: "SD (來源)", regex: /sd_src_no_ratelimit["\s:]+["']([^"']+)["']/ },
                ];

                for (const p of patterns) {
                  const matches = [...html.matchAll(new RegExp(p.regex, 'g'))];
                  for (const match of matches) {
                    if (match && !foundFormats.has(p.label)) {
                      try {
                        let urlStr = match[1];
                        try {
                          urlStr = JSON.parse(`"${urlStr}"`);
                        } catch (e) {
                          urlStr = urlStr.replace(/\\\//g, "/").replace(/\\u0025/g, "%");
                        }
                        if (urlStr.includes("facebook.com") || urlStr.includes("fbcdn.net")) {
                          if (urlStr.startsWith("http")) foundFormats.set(p.label, { url: urlStr });
                        }
                      } catch(e) {}
                    }
                  }
                }

                if (foundFormats.size === 0) {
                  const videoLinks = html.match(/https?:\/\/[^\s"'\\}]*?fbcdn\.net[^\s"'\\}]*?\.mp4[^\s"'\\}]*/g);
                  if (videoLinks) {
                    const uniqueLinks = Array.from(new Set(videoLinks));
                    uniqueLinks.slice(0, 3).forEach((link, idx) => {
                       const label = link.includes("oe=") ? `影片連結 ${idx + 1} (加密)` : `影片連結 ${idx + 1}`;
                       foundFormats.set(label, { url: link.replace(/&amp;/g, "&") });
                    });
                  }
                }
                await browser.close();
                sendEvent("log", { message: `[Puppeteer] 掃描完成。找到 ${foundFormats.size} 個來源。` });
              } catch (e: any) {
                if (browser) await browser.close();
                sendEvent("log", { message: `[Puppeteer] 分析時發生錯誤: ${e.message}` });
              }
            }
          } catch (err: any) {
            sendEvent("log", { message: `[Puppeteer] 無法啟動瀏覽器: ${err.message}` });
          }

          try {
            sendEvent("log", { message: "[yt-dlp] 啟動核心解析工具..." });
            const tempDir = os.tmpdir();
            const cookieFile = path.join(tempDir, `analyze-cookies-${Date.now()}.txt`);
            let cookieContent = cookies.trim();
            if (!cookieContent.startsWith("# Netscape")) {
              const lines = ["# Netscape HTTP Cookie File", ""];
              const pairs = cookieContent.split(";");
              for (const p of pairs) {
                const idx = p.indexOf("=");
                if (idx === -1) continue;
                const n = p.substring(0, idx).trim();
                const v = p.substring(idx + 1).trim();
                if (n && v) lines.push(`.facebook.com\tTRUE\t/\tTRUE\t${Math.floor(Date.now()/1000)+31536000}\t${n}\t${v}`);
              }
              cookieContent = lines.join("\n");
            }
            fs.writeFileSync(cookieFile, cookieContent);

            const ytProcess = spawn(ytDlpPath, ["--cookies", cookieFile, "-j", url]);
            let output = "";
            let errorOutput = "";
            
            ytProcess.stdout?.on("data", (d: any) => output += d.toString());
            ytProcess.stderr?.on("data", (d: any) => errorOutput += d.toString());
            
            await new Promise<void>((resolve) => {
              ytProcess.on("close", (code) => {
                if (code !== 0 && errorOutput) {
                   sendEvent("log", { message: `[yt-dlp 警告] ${errorOutput.trim()}` });
                }
                resolve();
              });
            });

            if (fs.existsSync(cookieFile)) fs.unlinkSync(cookieFile);
            if (output) {
              const data = JSON.parse(output);
              if (data.formats) {
                let ytdlpCount = 0;
                data.formats.filter((f: any) => f.vcodec !== "none" && f.url).forEach((f: any) => {
                  let quality = "";
                  const dims = (f.width && f.height) ? `${f.width}x${f.height}` : "";
                  if (f.format_note) quality = f.format_note + (dims ? ` (${dims})` : "");
                  else if (dims) quality = dims;
                  else if (f.height) quality = `${f.height}p`;
                  else if (f.resolution) quality = f.resolution;
                  else quality = `Video (${f.format_id || 'unknown'})`;
                  const label = `${quality} (${f.ext || 'mp4'})`;
                  if (!foundFormats.has(label)) {
                    foundFormats.set(label, { url: f.url, formatId: f.format_id });
                    ytdlpCount++;
                  }
                });
                sendEvent("log", { message: `[yt-dlp] 解析完成，識別出 ${ytdlpCount} 個額外解析度。` });
              }
            }
          } catch (e: any) {
            sendEvent("log", { message: `[yt-dlp] JSON 解析失敗: ${e.message}` });
          }

          const formats = Array.from(foundFormats.entries()).map(([label, info]) => ({ label, url: info.url, formatId: info.formatId }));
          sendEvent("analyze_complete", { formats });
          closeStream();
        } catch (error: any) {
          sendEvent("error", { message: `解析引擎崩潰: ${error.message}` });
          closeStream();
        }
      })();
      return new NextResponse(stream, { headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" } });
    }

    let lastErrorMsg = "";
    
    (async () => {
      try {
        const useFormatId = !!formatId;
        const targetUrl = useFormatId ? url : (selectedUrl || url);
        const isDirect = !useFormatId && (targetUrl.includes("fbcdn.net") || targetUrl.includes("video_redirect"));

        const tempDir = os.tmpdir();
        tempCookiePath = path.join(tempDir, `fb-cookies-${Date.now()}.txt`);
        let cookieContent = cookies.trim();
        if (!cookieContent.startsWith("# Netscape")) {
          const lines = ["# Netscape HTTP Cookie File", ""];
          const pairs = cookieContent.split(";");
          for (const p of pairs) {
            const idx = p.indexOf("=");
            if (idx === -1) continue;
            const n = p.substring(0, idx).trim();
            const v = p.substring(idx + 1).trim();
            if (n && v) lines.push(`.facebook.com\tTRUE\t/\tTRUE\t${Math.floor(Date.now()/1000)+31536000}\t${n}\t${v}`);
          }
          cookieContent = lines.join("\n");
        }
        fs.writeFileSync(tempCookiePath, cookieContent);

        const nameTemplate = customFilename ? `${customFilename}.%(ext)s` : (isDirect ? "fb_video_%(epoch)s.%(ext)s" : "%(title)s.%(ext)s");
        const outputPath = path.join(downloadsDir, nameTemplate);

        const args = isDirect 
          ? [targetUrl, "--cookies", tempCookiePath, "--ffmpeg-location", ffmpegPath, "-o", outputPath, "--newline"]
          : [targetUrl, "--cookies", tempCookiePath, "--ffmpeg-location", ffmpegPath, "-f", useFormatId ? `${formatId}+bestaudio/best` : "bestvideo+bestaudio/best", "--merge-output-format", "mp4", "--postprocessor-args", "ffmpeg:-async 1", "--add-metadata", "-o", outputPath, "--newline"];

        sendEvent("log", { message: `Running command: yt-dlp ${args.map(a => a.includes(" ") ? `"${a}"` : a).join(" ")}` });
        
        const ytDlpProcess = spawn(ytDlpPath, args);
        ytDlpProcess.stdout?.on("data", (data) => {
          const output = data.toString();
          const pMatch = output.match(/\[download\]\s+([\d.]+)%/);
          if (pMatch) sendEvent("progress", { percent: parseFloat(pMatch[1]) });
          else sendEvent("log", { message: output.trim() });
        });
        ytDlpProcess.stderr?.on("data", (data) => {
          const errMsg = data.toString().trim();
          sendEvent("log", { message: `ERROR: ${errMsg}` });
          if (errMsg.toLowerCase().includes("error")) lastErrorMsg = errMsg;
        });
        ytDlpProcess.on("close", (code) => {
          if (tempCookiePath && fs.existsSync(tempCookiePath)) fs.unlinkSync(tempCookiePath);
          if (code === 0) sendEvent("complete", { message: "Download Complete!" });
          else sendEvent("error", { message: lastErrorMsg || `Process exited with code ${code}` });
          closeStream();
        });
      } catch (err: any) { sendEvent("error", { message: err.message }); closeStream(); }
    })();

    return new NextResponse(stream, { headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" } });
  } catch (error) {
    console.error("API Error:", error);
    return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
  }
}
