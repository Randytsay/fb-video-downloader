import puppeteer from "puppeteer-core";
import { spawn } from "child_process";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const cookieStr = "sb=OMhLaBpMh4ZGQis2F3t29JaM; ps_l=1; ps_n=1; datr=HKgvaeX9GJBLfuMjAwZIaDEQ; c_user=100000870048488; ar_debug=1; locale=zh_TW; pas=100000870048488%3A1eKqUOJ8Lv; wl_cbv=v2%3Bclient_version%3A3112%3Btimestamp%3A1773732095; fbl_st=101639135%3BT%3A29562201; vpd=v1%3B844x390x3.0000001192092896; fr=1fR9UG7HE3ghOTVVa.AWcnseM1YIcCSA9lTXUwkThfZsJO6vruytBwDqTHEZafd3o5nOI.BpuQEs..AAA.0.0.BpuQEs.AWcMFbakvPsJFGJfpeslbG_OmSw; xs=61%3ASZirTGII1PxmFg%3A2%3A1764730972%3A-1%3A-1%3A%3AAczJsG8fRLa9w6P6vT9qgOD23y_RUx91WZgp_WEtCOo; dpr=1.125; presence=C%7B%22t3%22%3A%5B%5D%2C%22utc3%22%3A1773732143760%2C%22v%22%3A1%7D; wd=389x796";
const videoUrl = "https://www.facebook.com/nana.chiu.758/videos/1242880724623828?idorvanity=365841813767265";

function parseCookies(str) {
  const cookies = [];
  const pairs = str.split(";");
  for (const p of pairs) {
    const idx = p.indexOf("=");
    if (idx === -1) continue;
    const name = p.substring(0, idx).trim();
    const value = p.substring(idx + 1).trim();
    if (name) {
      cookies.push({
        name, value,
        domain: ".facebook.com",
        path: "/",
        secure: true,
        httpOnly: name === "xs" || name === "c_user",
        expires: Math.floor(Date.now() / 1000) + 3600 * 24 * 365,
      });
    }
  }
  return cookies;
}

async function main() {
  console.log("Launching Chrome...");
  const browser = await puppeteer.launch({
    executablePath: "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage", "--disable-blink-features=AutomationControlled"],
  });

  const page = await browser.newPage();
  await page.setUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36");

  console.log("Injecting cookies...");
  const cdpCookies = parseCookies(cookieStr);
  const client = await page.createCDPSession();
  for (const cookie of cdpCookies) {
    try { await client.send("Network.setCookie", cookie); } catch (e) {}
  }

  // Enable response interception via CDP
  await client.send("Network.enable");

  let foundVideoUrl = null;
  const videoUrls = [];
  
  // Listen to ALL network responses for video URLs
  client.on("Network.responseReceived", async (params) => {
    const { response, requestId } = params;
    const url = response.url;
    
    // Check if this is a GraphQL or API response
    if (url.includes("graphql") || url.includes("api/graphql")) {
      try {
        const result = await client.send("Network.getResponseBody", { requestId });
        const body = result.body;
        
        // Search for video URLs in the response
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
              // Try JSON decode
              try { decoded = JSON.parse(`"${decoded}"`); } catch(e) {}
              if (decoded.startsWith("http")) {
                console.log(`Found via ${p.source.substring(0, 30)}: ${decoded.substring(0, 120)}...`);
                videoUrls.push(decoded);
              }
            } catch(e) {}
          }
        }
      } catch (e) {
        // Can't get body for some responses, that's ok
      }
    }
    
    // Also catch direct CDN video requests
    if (url.includes("fbcdn.net") && url.includes("video") && !url.includes(".jpg") && !url.includes(".png")) {
      console.log(`CDN video request: ${url.substring(0, 120)}...`);
      videoUrls.push(url);
    }
  });

  console.log("Navigating to video page...");
  await page.goto(videoUrl, { waitUntil: "networkidle2", timeout: 30000 });

  const pageTitle = await page.title();
  console.log("Page title:", pageTitle);
  console.log("Current URL:", page.url());

  // Wait a bit more for async content
  console.log("Waiting 5s for async content...");
  await new Promise(r => setTimeout(r, 5000));

  // Also try clicking play
  console.log("Trying to click play...");
  try {
    await page.evaluate(() => {
      const video = document.querySelector("video");
      if (video) { video.play(); console.log("video.play() called"); }
      // Try click on various play buttons
      const btns = document.querySelectorAll('[role="button"], [aria-label*="Play"], [aria-label*="play"]');
      btns.forEach(b => { try { b.click(); } catch(e) {} });
    });
    await new Promise(r => setTimeout(r, 5000));
  } catch (e) {
    console.log("Play click error:", e.message);
  }

  // Final HTML scan
  console.log("\nFinal HTML scan...");
  const htmlUrls = await page.evaluate(() => {
    const html = document.documentElement.innerHTML;
    const results = [];
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
          if (decoded.startsWith("http")) results.push({ source: p.source.substring(0, 30), url: decoded });
        } catch(e) {}
      }
    }
    return results;
  });

  console.log("HTML extracted URLs:", htmlUrls.length);
  htmlUrls.forEach(u => console.log(`  ${u.source}: ${u.url.substring(0, 120)}...`));

  console.log(`\nTotal video URLs found: ${videoUrls.length}`);
  videoUrls.forEach((u, i) => console.log(`  [${i}] ${u.substring(0, 150)}...`));

  // Pick best URL
  const bestUrl = htmlUrls[0]?.url || videoUrls[0] || null;
  
  if (bestUrl) {
    console.log(`\n=== BEST URL: ${bestUrl.substring(0, 150)}... ===`);
    
    await browser.close();
    
    // Download
    const ytDlpPath = path.join(__dirname, "yt-dlp.exe");
    const downloadsDir = path.join(__dirname, "..", "downloads");
    
    const proc = spawn(ytDlpPath, [bestUrl, "--ffmpeg-location", __dirname, "-o", path.join(downloadsDir, "fb_video_%(epoch)s.%(ext)s"), "--newline", "-v"]);
    proc.stdout.on("data", d => process.stdout.write(d));
    proc.stderr.on("data", d => process.stderr.write(d));
    proc.on("close", code => console.log(`\nyt-dlp exited with code: ${code}`));
  } else {
    console.log("\n=== NO VIDEO URL FOUND ===");
    await browser.close();
  }
}

main().catch(e => { console.error("FATAL:", e); process.exit(1); });
