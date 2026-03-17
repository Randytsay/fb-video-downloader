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
    const { url, cookies } = await req.json();

    if (!url) {
      return NextResponse.json(
        { error: "No URL provided." },
        { status: 400 }
      );
    }

    if (!cookies) {
      return NextResponse.json(
        { error: "Cookies content is required for private videos." },
        { status: 400 }
      );
    }

    const { stream, sendEvent, closeStream } = createSSEStream();

    // Check if URL is a direct video link (CDN link) - skip yt-dlp extraction
    const isDirectLink = url.includes("fbcdn.net") || url.includes("video_redirect") || (url.includes(".mp4") && !url.includes("facebook.com/"));
    
    // Check if URL is a Facebook page URL
    const isFacebookPage = url.includes("facebook.com") && !isDirectLink;

    // Write cookies to a temporary file for yt-dlp
    const tempDir = os.tmpdir();
    tempCookiePath = path.join(tempDir, `fb-cookies-${Date.now()}.txt`);
    
    let finalCookies = cookies.trim();
    if (!finalCookies.startsWith("# Netscape")) {
      const lines = ["# Netscape HTTP Cookie File", "# http://curl.haxx.se/rfc/cookie_spec.html", "# This is a generated file!  Do not edit.", ""];
      const pairs = finalCookies.split(";");
      const now = Math.floor(Date.now() / 1000) + 3600*24*365;
      
      for (let p of pairs) {
        const [name, ...valArr] = p.trim().split("=");
        const value = valArr.join("=");
        if (name && value) {
          lines.push(`.facebook.com\tTRUE\t/\tTRUE\t${now}\t${name}\t${value}`);
        }
      }
      finalCookies = lines.join("\n");
    }
    fs.writeFileSync(tempCookiePath, finalCookies);

    const ytDlpPath = path.join(process.cwd(), "scripts", "yt-dlp.exe");
    const ffmpegPath = path.join(process.cwd(), "scripts");
    // Change downloads dir to the user's system Downloads folder
    const downloadsDir = path.join(os.homedir(), "Downloads");

    // Ensure downloads dir exists
    if (!fs.existsSync(downloadsDir)) {
      fs.mkdirSync(downloadsDir, { recursive: true });
    }

    // Strategy: Try Puppeteer first for Facebook pages, then fall back to yt-dlp
    if (isFacebookPage) {
      // Use Puppeteer to find the real video URL
      sendEvent("log", { message: "Using Puppeteer to extract video URL..." });
      
      (async () => {
        let browser: any = null;
        try {
          const puppeteer = await import("puppeteer-core");
          
          const chromePath = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
          
          sendEvent("log", { message: "Launching Chrome..." });
          browser = await puppeteer.default.launch({
            executablePath: chromePath,
            headless: true,
            args: [
              "--no-sandbox",
              "--disable-setuid-sandbox",
              "--disable-dev-shm-usage",
              "--disable-blink-features=AutomationControlled",
            ],
          });

          const page = await browser.newPage();
          
          // Set user agent
          await page.setUserAgent(
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
          );

          // Set cookies via CDP
          sendEvent("log", { message: "Injecting session cookies..." });
          const cdpCookies = parseCookiesToCDP(cookies.trim());
          const client = await page.createCDPSession();
          for (const cookie of cdpCookies) {
            try {
              await client.send("Network.setCookie", cookie);
            } catch (e) {
              // Some cookies may fail, that's ok
            }
          }

          // Enable response interception via CDP to catch GraphQL API calls
          await client.send("Network.enable");

          const videoUrls: string[] = [];
          
          client.on("Network.responseReceived", async (params: any) => {
            const { response, requestId } = params;
            const resUrl = response.url;
            
            // Catch GraphQL responses which contain the video metadata
            if (resUrl.includes("graphql") || resUrl.includes("api/graphql")) {
              try {
                const result = await client.send("Network.getResponseBody", { requestId }) as any;
                const body = result.body;
                
                const patterns = [
                  /browser_native_hd_url["\s:]+["']([^"']+)["']/g,
                  /browser_native_sd_url["\s:]+["']([^"']+)["']/g,
                  /playable_url_quality_hd["\s:]+["']([^"']+)["']/g,
                  /playable_url["\s:]+["']([^"']+)["']/g,
                  /"progressive":\[.*?"progressive_url":"([^"]+)"/g,
                ];
                
                for (const p of patterns) {
                  let match;
                  while ((match = p.exec(body)) !== null) {
                    try {
                      let decoded = match[1].replace(/\\\//g, "/").replace(/\\u0025/g, "%");
                      // Try JSON decode if it's still escaped
                      try { decoded = JSON.parse(`"${decoded}"`); } catch(e) {}
                      if (decoded.startsWith("http")) {
                        videoUrls.push(decoded);
                      }
                    } catch(e) {}
                  }
                }
              } catch (e) {
                // Some bodies can't be fetched, ignore
              }
            }
            
            // Also catch direct CDN MP4 requests as a fallback
            if (resUrl.includes("fbcdn.net") && resUrl.includes("video") && !resUrl.includes(".jpg")) {
              videoUrls.push(resUrl);
            }
          });

          // Navigate to the video page
          sendEvent("log", { message: "Navigating to Facebook video page..." });
          sendEvent("progress", { percent: 10 });
          
          await page.goto(url, { waitUntil: "networkidle2", timeout: 30000 });
          sendEvent("progress", { percent: 20 });

          sendEvent("log", { message: "Waiting for video data to load..." });
          await new Promise(r => setTimeout(r, 5000));
          
          // Try clicking play to force video load if needed
          try {
            await page.evaluate(() => {
              const btns = document.querySelectorAll('[role="button"], [aria-label*="Play"], [aria-label*="play"]');
              btns.forEach((b: any) => { try { b.click(); } catch(e) {} });
            });
            await new Promise(r => setTimeout(r, 3000));
          } catch(e) {}

          // Fallback: final HTML scan
          const htmlUrls = await page.evaluate(() => {
            const html = document.documentElement.innerHTML;
            const results: string[] = [];
            const patterns = [
              /"browser_native_hd_url":"(.*?)"/,
              /"browser_native_sd_url":"(.*?)"/,
              /"playable_url_quality_hd":"(.*?)"/,
              /"playable_url":"(.*?)"/,
              /"progressive_url":"(.*?)"/,
            ];
            for (const p of patterns) {
              const match = html.match(p);
              if (match) {
                try {
                  const decoded = JSON.parse(`"${match[1]}"`);
                  if (decoded.startsWith("http")) results.push(decoded);
                } catch(e) {}
              }
            }
            return results;
          });

          const bestUrl = htmlUrls[0] || videoUrls[0] || null;
          let foundVideoUrl = "";

          if (bestUrl) {
            foundVideoUrl = bestUrl;
            sendEvent("log", { message: `Successfully extracted direct video URL!` });
          }

          sendEvent("progress", { percent: 30 });

          // If we still haven't found a video, try clicking play and waiting
          if (!foundVideoUrl) {
            sendEvent("log", { message: "Trying to trigger video playback..." });
            try {
              // Try clicking any video or play button
              await page.evaluate(() => {
                const video = document.querySelector("video") as HTMLVideoElement;
                if (video) video.play();
                // Click play icon or area
                const playBtn = document.querySelector('[aria-label="Play"]') || document.querySelector('[data-testid="play_button"]');
                if (playBtn) (playBtn as HTMLElement).click();
              });
              // Wait for network requests
              await new Promise(resolve => setTimeout(resolve, 5000));
            } catch (e) {}
          }

          sendEvent("progress", { percent: 40 });

          await browser.close();
          browser = null;

          if (foundVideoUrl) {
            // Now download using yt-dlp with the direct URL
            sendEvent("log", { message: `Downloading: ${foundVideoUrl.substring(0, 100)}...` });
            
            const ytDlpProcess = spawn(ytDlpPath, [
              foundVideoUrl,
              "--ffmpeg-location",
              ffmpegPath,
              "-o",
              path.join(downloadsDir, "fb_video_%(epoch)s.%(ext)s"),
              "--newline",
            ]);

            let lastError = "";

            if (ytDlpProcess.stdout) {
              ytDlpProcess.stdout.on("data", (data) => {
                const output = data.toString();
                const progressMatch = output.match(/\[download\]\s+([\d.]+)%/);
                if (progressMatch) {
                  const p = parseFloat(progressMatch[1]);
                  sendEvent("progress", { percent: 40 + p * 0.6 });
                } else {
                  sendEvent("log", { message: output.trim() });
                }
              });
            }

            if (ytDlpProcess.stderr) {
              ytDlpProcess.stderr.on("data", (data) => {
                lastError = data.toString().trim();
                sendEvent("log", { message: lastError });
              });
            }

            ytDlpProcess.on("close", (code) => {
              if (tempCookiePath && fs.existsSync(tempCookiePath)) {
                try { fs.unlinkSync(tempCookiePath); } catch (e) {}
              }
              if (code === 0) {
                sendEvent("complete", { message: "Download finished successfully." });
              } else {
                sendEvent("error", { message: lastError || `Download process exited with code ${code}` });
              }
              closeStream();
            });
          } else {
            // Fallback: try yt-dlp directly (it might work for some videos)
            sendEvent("log", { message: "Puppeteer could not find video. Falling back to yt-dlp..." });
            
            const ytDlpProcess = spawn(ytDlpPath, [
              url,
              "--cookies", tempCookiePath,
              "--ffmpeg-location", ffmpegPath,
              "-f", "bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best",
              "--merge-output-format", "mp4",
              "-o", path.join(downloadsDir, "%(title)s.%(ext)s"),
              "--newline",
            ]);

            if (ytDlpProcess.stdout) {
              ytDlpProcess.stdout.on("data", (data) => {
                const output = data.toString();
                const progressMatch = output.match(/\[download\]\s+([\d.]+)%/);
                if (progressMatch) {
                  sendEvent("progress", { percent: parseFloat(progressMatch[1]) });
                } else {
                  sendEvent("log", { message: output.trim() });
                }
              });
            }

            if (ytDlpProcess.stderr) {
              ytDlpProcess.stderr.on("data", (data) => {
                sendEvent("log", { message: data.toString().trim() });
              });
            }

            ytDlpProcess.on("close", (code) => {
              if (tempCookiePath && fs.existsSync(tempCookiePath)) {
                try { fs.unlinkSync(tempCookiePath); } catch (e) {}
              }
              if (code === 0) {
                sendEvent("complete", { message: "Download finished successfully." });
              } else {
                sendEvent("error", { message: `Process exited with code ${code}` });
              }
              closeStream();
            });
          }
        } catch (err: any) {
          if (browser) {
            try { await browser.close(); } catch (e) {}
          }
          sendEvent("error", { message: `Puppeteer error: ${err.message}` });
          closeStream();
        }
      })();
    } else {
      // Direct link or non-Facebook URL - download directly with yt-dlp
      sendEvent("log", { message: "Downloading direct video link..." });

      const args = isDirectLink
        ? [url, "--ffmpeg-location", ffmpegPath, "-o", path.join(downloadsDir, "fb_video_%(epoch)s.%(ext)s"), "--newline"]
        : [url, "--cookies", tempCookiePath, "--ffmpeg-location", ffmpegPath, "-f", "bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best", "--merge-output-format", "mp4", "-o", path.join(downloadsDir, "%(title)s.%(ext)s"), "--newline"];

      const ytDlpProcess = spawn(ytDlpPath, args);
      
      sendEvent("status", { message: "Starting download process..." });

      if (ytDlpProcess.stdout) {
        ytDlpProcess.stdout.on("data", (data) => {
          const output = data.toString();
          const progressMatch = output.match(/\[download\]\s+([\d.]+)%/);
          if (progressMatch) {
            sendEvent("progress", { percent: parseFloat(progressMatch[1]) });
          } else {
            sendEvent("log", { message: output.trim() });
          }
        });
      }

      if (ytDlpProcess.stderr) {
        ytDlpProcess.stderr.on("data", (data) => {
          sendEvent("log", { message: data.toString().trim() });
        });
      }

      ytDlpProcess.on("close", (code) => {
        if (tempCookiePath && fs.existsSync(tempCookiePath)) {
          try { fs.unlinkSync(tempCookiePath); } catch (e) {}
        }
        if (code === 0) {
          sendEvent("complete", { message: "Download finished successfully." });
        } else {
          sendEvent("error", { message: `Process exited with code ${code}` });
        }
        closeStream();
      });
    }

    return new NextResponse(stream, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      },
    });
  } catch (error) {
    console.error("API Error:", error);
    return NextResponse.json(
      { error: "Internal Server Error" },
      { status: 500 }
    );
  }
}
