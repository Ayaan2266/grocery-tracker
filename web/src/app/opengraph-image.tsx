import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { ImageResponse } from "next/og";

import { PREVIEW_IMAGE } from "@/lib/site";

/**
 * The card a link to the site shows in Discord, LinkedIn, iMessage, Slack and
 * the rest. Drawn at build time from the site's own mark, art and typeface, so
 * it changes when they do. Applies to every page, product pages included.
 */
export const alt = PREVIEW_IMAGE.alt;
export const size = { width: PREVIEW_IMAGE.width, height: PREVIEW_IMAGE.height };
export const contentType = "image/png";

const BLUE = "#0b49bd";
const YELLOW = "#ffe975";

async function dataUrl(path: string, type: string): Promise<string> {
  const file = await readFile(join(process.cwd(), path));
  return `data:${type};base64,${file.toString("base64")}`;
}

export default async function OpenGraphImage() {
  const [bold, medium, mark, tote] = await Promise.all([
    readFile(join(process.cwd(), "assets/fonts/dm-sans-800.ttf")),
    readFile(join(process.cwd(), "assets/fonts/dm-sans-500.ttf")),
    dataUrl("public/brand/loonie-mark.svg", "image/svg+xml"),
    dataUrl("public/illustrations/grocery-tote.png", "image/png"),
  ]);

  return new ImageResponse(
    (
      <div
        style={{
          display: "flex",
          width: "100%",
          height: "100%",
          position: "relative",
          background: BLUE,
          color: "white",
          fontFamily: "DM Sans",
          padding: "64px 72px",
        }}
      >
        <div style={{ display: "flex", flexDirection: "column", width: 720 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
            <img src={mark} width={72} height={72} alt="" />
            <span style={{ fontSize: 46, fontWeight: 800, letterSpacing: -1.5 }}>Loonie</span>
          </div>
          {/* Word by word: the renderer lays a nested span out as its own box, so
              a full stop inside the sentence would sit beside the whole wrapped
              block instead of after its last word. */}
          <div
            style={{
              display: "flex",
              flexWrap: "wrap",
              columnGap: 18,
              marginTop: 70,
              fontSize: 78,
              fontWeight: 800,
              lineHeight: 1.02,
              letterSpacing: -3.5,
            }}
          >
            {["Grocery", "prices", "have", "a"].map((word) => (
              <span key={word}>{word}</span>
            ))}
            <span style={{ display: "flex" }}>
              story<span style={{ color: YELLOW }}>.</span>
            </span>
          </div>
          <div style={{ display: "flex", marginTop: 26, color: YELLOW, fontSize: 36, fontWeight: 800, letterSpacing: -1 }}>
            Find out if today is a good day to buy.
          </div>
          <div style={{ display: "flex", marginTop: "auto", fontSize: 26, fontWeight: 500, opacity: 0.85 }}>
            Nightly price history · Canadian grocery stores
          </div>
        </div>
        <img src={tote} width={430} height={430} alt="" style={{ position: "absolute", right: 40, bottom: -10 }} />
      </div>
    ),
    {
      ...size,
      fonts: [
        { name: "DM Sans", data: bold, weight: 800, style: "normal" },
        { name: "DM Sans", data: medium, weight: 500, style: "normal" },
      ],
    },
  );
}
