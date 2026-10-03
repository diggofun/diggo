/** Wrangler bundles these as modules: *.bin as an ArrayBuffer, *.wasm as a compiled module. */
declare module "*.bin" {
  const data: ArrayBuffer;
  export default data;
}

declare module "*.wasm" {
  const module: WebAssembly.Module;
  export default module;
}
