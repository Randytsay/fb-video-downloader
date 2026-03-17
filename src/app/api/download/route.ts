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
  
  // If it's Netscape format
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
    // Raw cookie header string: key=value; key2=value2
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
    const { url, cookies, action, selectedUrl } = await req.json();

    if (!url) {
      return NextResponse.json({ error: "No URL provided." }, { status: 400 });
    }

    if (!cookies) {
      return NextResponse.json({ error: "Cookies content is required." }, { status: 400 });
    }

    // Resolve paths for yt-dlp and ffmpeg
    // @ts-ignore
    const isElectron = !!process.versions.electron;
    // @ts-ignore
    const resourcesPath = isElectron && process.resourcesPath ? process.resourcesPath : process.cwd();
    const ytDlpPath = path.join(resourcesPath, "scripts", "yt-dlp.exe");
    const ffmpegPath = path.join(resourcesPath, "scripts");
    const downloadsDir = path.join(os.homedir(), "Downloads");

    if (!fs.existsSync(downloadsDir)) {
      fs.mkdirSync(downloadsDir, { recursive: true });
    }

    // ACTION: ANALYZE - Returns a list of available quality URLs
    if (action === "analyze") {
      const foundUrls = new Map<string, string>();

      try {
        const puppeteer = await import("puppeteer-core");
        const chromePath = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
        
        if (fs.existsSync(chromePath)) {
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
              if (response.url.includes("graphql")) {
                try {
                  const result = await client.send("Network.getResponseBody", { requestId }) as any;
                  const body = result.body;
                  const hdMatch = body.match(/browser_native_hd_url["\s:]+["']([^"']+)["']/);
                  const sdMatch = body.match(/browser_native_sd_url["\s:]+["']([^"']+)["']/);
                  if (hdMatch) foundUrls.set("HD (高畫質)", hdMatch[1].replace(/\\\//g, "/"));
                  if (sdMatch) foundUrls.set("SD (標準畫質)", sdMatch[1].replace(/\\\//g, "/"));
                } catch (e) {}
              }
            });

            await page.goto(url, { waitUntil: "networkidle2", timeout: 20000 });
            await new Promise(r => setTimeout(r, 3000));

            const html = await page.evaluate(() => document.documentElement.innerHTML);
            const patterns = [
              { label: "HD (高畫質)", regex: /"browser_native_hd_url":"(.*?)"/ },
              { label: "SD (標準畫質)", regex: /"browser_native_sd_url":"(.*?)"/ },
              { label: "HD (預覽)", regex: /"playable_url_quality_hd":"(.*?)"/ },
              { label: "SD (預覽)", regex: /"playable_url":"(.*?)"/ },
            ];

            for (const p of patterns) {
              const match = html.match(p.regex);
              if (match && !foundUrls.has(p.label)) {
                try {
                  const decoded = JSON.parse(`"${match[1]}"`);
                  if (decoded.startsWith("http")) foundUrls.set(p.label, decoded);
                } catch(e) {}
              }
            }
            await browser.close();
          } catch (e) {
            if (browser) await browser.close();
          }
        }
      } catch (err) {}

      // FALLBACK: Use yt-dlp to dump formats if Puppeteer found nothing
      if (foundUrls.size === 0) {
        try {
          // Write temporary cookies for yt-dlp
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
          const result = await new Promise<string>((resolve) => {
            let output = "";
            ytProcess.stdout?.on("data", (d: any) => output += d.toString());
            ytProcess.on("close", () => resolve(output));
          });

          if (fs.existsSync(cookieFile)) fs.unlinkSync(cookieFile);

          if (result) {
            const data = JSON.parse(result);
            if (data.url) foundUrls.set("自動最佳選擇 (Direct)", data.url);
            if (data.formats) {
              // Extract some distinct formats if available
              data.formats.filter((f: any) => f.vcodec !== "none" && f.url).forEach((f: any) => {
                const label = `${f.format_note || f.height + 'p' || 'Video'} (${f.ext})`;
                if (!foundUrls.has(label)) foundUrls.set(label, f.url);
              });
            }
          }
        } catch (e) {}
      }

      const formats = Array.from(foundUrls.entries()).map(([label, url]) => ({ label, url }));
      return NextResponse.json({ formats });
    }

    // ACTION: DOWNLOAD - Starts the actual download stream
    const { stream, sendEvent, closeStream } = createSSEStream();
    
    (async () => {
      try {
        const targetUrl = selectedUrl || url;
        const isDirect = targetUrl.includes("fbcdn.net") || targetUrl.includes("video_redirect");

        // Write cookies to temp file
        const tempDir = os.tmpdir();
        tempCookiePath = path.join(tempDir, `fb-cookies-${Date.now()}.txt`);
        let cookieContent = cookies.trim();
        if (!cookieContent.startsWith("# Netscape")) {
          const lines = ["# Netscape HTTP Cookie File", ""];
          cookieContent.split(";").forEach(p => {
            const [n, ...v] = p.trim().split("=");
            if (n && v.length) lines.push(`.facebook.com\tTRUE\t/\tTRUE\t${Math.floor(Date.now()/1000)+31536000}\t${n}\t${v.join("=")}`);
          });
          cookieContent = lines.join("\n");
        }
        fs.writeFileSync(tempCookiePath, cookieContent);

        sendEvent("log", { message: "Starting download..." });
        
        const args = isDirect 
          ? [targetUrl, "--ffmpeg-location", ffmpegPath, "-o", path.join(downloadsDir, "fb_video_%(epoch)s.%(ext)s"), "--newline"]
          : [targetUrl, "--cookies", tempCookiePath, "--ffmpeg-location", ffmpegPath, "-f", "bestvideo+bestaudio/best", "--merge-output-format", "mp4", "-o", path.join(downloadsDir, "%(title)s.%(ext)s"), "--newline"];

        const ytDlpProcess = spawn(ytDlpPath, args);

        ytDlpProcess.stdout?.on("data", (data) => {
          const output = data.toString();
          const pMatch = output.match(/\[download\]\s+([\d.]+)%/);
          if (pMatch) sendEvent("progress", { percent: parseFloat(pMatch[1]) });
          else sendEvent("log", { message: output.trim() });
        });

        ytDlpProcess.on("close", (code) => {
          if (tempCookiePath && fs.existsSync(tempCookiePath)) fs.unlinkSync(tempCookiePath);
          if (code === 0) sendEvent("complete", { message: "Download Complete!" });
          else sendEvent("error", { message: `Process exited with code ${code}` });
          closeStream();
        });

      } catch (err: any) {
        sendEvent("error", { message: err.message });
        closeStream();
      }
    })();

    return new NextResponse(stream, {
      headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" },
    });
  } catch (error) {
    console.error("API Error:", error);
    return NextResponse.json(
      { error: "Internal Server Error" },
      { status: 500 }
    );
  }
}
