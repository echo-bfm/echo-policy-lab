const f = Math.fround;
export function frameMetrics(actual, reference) {
  let world = 0, local = 0;
  for (let i = 0; i < 14; i++) {
    let w = 0, l = 0;
    for (let j = 0; j < 3; j++) {
      const a = f(actual[i * 3 + j]), b = reference[i * 3 + j];
      const dw = f(a - b), dl = f(f(a - f(actual[j])) - f(b - reference[j]));
      w = f(w + f(dw * dw)); l = f(l + f(dl * dl));
    }
    world += f(f(Math.sqrt(w)) * 1000); local += f(f(Math.sqrt(l)) * 1000);
  }
  const heights = [0, 3, 6, 10, 13].map(i => Math.abs(f(f(actual[i * 3 + 2]) - reference[i * 3 + 2])));
  return {world: world / 14, local: local / 14,
    custom: heights.every((v, i) => v <= [0.25, 0.5, 0.5, 0.25, 0.25][i]),
    strict: heights.every(v => v <= 0.25), low: f(actual[2]) < 0.3 && reference[2] > 0.6};
}
export function summarize(trace, complete = false) {
  let streak = 0, supportLoss = false;
  for (const t of trace) { streak = t.low ? streak + 1 : 0; supportLoss ||= streak >= 10; }
  return {world: trace.length ? trace.reduce((s, t) => s + t.world, 0) / trace.length : null,
    local: trace.length ? trace.reduce((s, t) => s + t.local, 0) / trace.length : null,
    success: complete && trace.every(t => t.custom), strict: complete && trace.every(t => t.strict),
    failureFrame: trace.find(t => !t.custom)?.frame ?? null, strictFailureFrame: trace.find(t => !t.strict)?.frame ?? null,
    supportLoss, samples: trace.length, complete};
}
