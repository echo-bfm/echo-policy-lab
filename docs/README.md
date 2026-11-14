# ECHO Policy Lab

Live demo: https://echo-bfm.github.io/echo-policy-lab/

Browser MuJoCo and ONNX inference comparing ECHO-PRE and ECHO-N. The demo includes seventeen motions, actual friction 0.3 or 2.0, and independently selected context from either friction. Robots stand before a run and return to standing with manual Reset.

## Context protocol

The original checkpoint_13600 frozen tracker holds each motion's first frame for 350 native interaction steps. After a canonical pose/velocity reset, long history retains the last 300 interactions, while short history and four previous latents start empty. The donor executes the same motion. Five recorded context tensors are replayed at aligned command indices; the browser recomputes the encoder, target tracker, residual and target physics online. Donor histories and reference features are precomputed. There is no token averaging or added observation/action noise or external force.

## Scope and validation

A307 has been removed from the active catalog. The retained v8 evidence covers 28 combinations: four SharpShooter combinations and three conditions for each of eight retained additions. Six ECHO-N comparisons exceed numerical/outcome tolerance; one changes the main tracking outcome. These are historical measurements, not reruns for the catalog removal. See `verification/v9-selection.json` for scope and `verification/v8-browser.json` for original measured results. Two discrete settings do not establish success over a continuous friction interval.

## Hosting

This repository contains the prebuilt static site. GitHub Pages publishes `main` at `/docs`; `.nojekyll` preserves the bundled assets. All URLs are relative, and ONNX runs with one WASM thread so custom cross-origin isolation headers are not required. Use a recent Chrome or Edge browser with WebAssembly. Initial loading downloads the bundled simulation and model assets; computation runs on the visitor's device.

For local preview: `python3 -m http.server 8000 --bind 127.0.0.1`, then open http://127.0.0.1:8000/.

Bundled third-party components retain their licenses in `licenses/`. No repository-wide license is granted for the model or motion assets here.

Large hashed data blobs are fetched from the same repository at immutable commit `b2980c6f28a4b0f7a7c3a889ab299867107a713b`. SHA-256 checks remain enabled.
