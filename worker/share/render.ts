/**
 * SVG to PNG for the share cards, with resvg compiled to WebAssembly. The fonts are bundled
 * (Roboto 500 and 900, the face Android users see in the app's system stack) because the Worker
 * has no system fonts to fall back on.
 */
import { Resvg, initWasm } from "@resvg/resvg-wasm";
import resvgWasm from "@resvg/resvg-wasm/index_bg.wasm";
import roboto500 from "./roboto-500.bin";
import roboto900 from "./roboto-900.bin";

let ready: Promise<void> | null = null;

function init(): Promise<void> {
  ready ??= initWasm(resvgWasm).catch((error: unknown) => {
    ready = null;
    throw error;
  });
  return ready;
}

export async function svgToPng(svg: string, width: number): Promise<Uint8Array> {
  await init();
  const resvg = new Resvg(svg, {
    fitTo: { mode: "width", value: width },
    font: {
      fontBuffers: [new Uint8Array(roboto500), new Uint8Array(roboto900)],
      defaultFontFamily: "Roboto",
      loadSystemFonts: false,
    },
  });
  const image = resvg.render();
  const png = image.asPng();
  image.free();
  resvg.free();
  return png;
}
