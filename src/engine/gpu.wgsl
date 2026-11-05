// Shared parameter layout: eight u32 values followed by four f32 values.
struct Params {
  width: u32, height: u32, sw: u32, sh: u32,
  transparent: u32, detail: u32, count: u32, dither: u32,
  contrast: f32, saturation: f32, brightness: f32, strength: f32,
}
@group(0) @binding(0) var<uniform> p: Params;
@group(0) @binding(1) var<storage, read> input: array<u32>;
@group(0) @binding(2) var<storage, read_write> output: array<u32>;
@group(0) @binding(3) var<storage, read> linear: array<f32>;
@group(0) @binding(4) var<storage, read_write> raw: array<vec2<f32>>;
@group(0) @binding(5) var<storage, read_write> features: array<vec4<f32>>;
@group(0) @binding(6) var<storage, read> labs: array<vec4<f32>>;
@group(0) @binding(7) var<storage, read> palette: array<u32>;

fn rgb(v: u32) -> vec3<f32> { return vec3<f32>(f32(v & 255u), f32((v >> 8u) & 255u), f32((v >> 16u) & 255u)); }
fn opaque(v: u32) -> bool { return (v >> 24u) != 0u; }
// Match Uint8ClampedArray's round-to-nearest, ties-to-even conversion.
fn byte(v: f32) -> u32 {
  let c = clamp(v, 0.0, 255.0); let f = floor(c); let t = c - f;
  return u32(f) + select(0u, 1u, t > 0.5 || (t == 0.5 && (u32(f) & 1u) == 1u));
}
fn pack(c: vec3<f32>, a: u32) -> u32 { return byte(c.r) | (byte(c.g) << 8u) | (byte(c.b) << 16u) | (a << 24u); }
fn decode(v: u32) -> vec3<f32> { return vec3<f32>(linear[v & 255u], linear[(v >> 8u) & 255u], linear[(v >> 16u) & 255u]); }
fn encode(v: f32) -> f32 {
  if (v <= 0.0031308) { return 255.0 * 12.92 * v; }
  return 255.0 * (1.055 * pow(v, 1.0 / 2.4) - 0.055);
}
fn inside(q: vec2<i32>) -> bool { return all(q >= vec2<i32>(0)) && q.x < i32(p.width) && q.y < i32(p.height); }
fn index(q: vec2<i32>) -> u32 { return u32(q.y) * p.width + u32(q.x); }
fn luma(v: u32) -> f32 { return dot(rgb(v), vec3<f32>(0.2126, 0.7152, 0.0722)) / 255.0; }

@compute @workgroup_size(8, 8)
fn sample(@builtin(global_invocation_id) id: vec3<u32>) {
  if (id.x >= p.width || id.y >= p.height) { return; }
  let scale = vec2<f32>(f32(p.sw) / f32(p.width), f32(p.sh) / f32(p.height));
  let lo = vec2<f32>(id.xy) * scale; let hi = vec2<f32>(id.xy + vec2<u32>(1u)) * scale;
  var color = vec3<f32>(0.0); var alpha = 0.0;
  for (var y = u32(floor(lo.y)); y < u32(ceil(hi.y)); y++) {
    for (var x = u32(floor(lo.x)); x < u32(ceil(hi.x)); x++) {
      let weight = (min(hi.x, f32(x + 1u)) - max(lo.x, f32(x))) * (min(hi.y, f32(y + 1u)) - max(lo.y, f32(y)));
      let v = input[min(y, p.sh - 1u) * p.sw + min(x, p.sw - 1u)]; let a = f32(v >> 24u) / 255.0;
      if (p.transparent != 0u) { color += decode(v) * a * weight; alpha += a * weight; }
      else { color += (decode(v) * a + vec3<f32>(1.0 - a)) * weight; alpha += weight; }
    }
  }
  var c = vec3<f32>(0.0);
  if (alpha > 0.0) { let v = color / alpha; c = vec3<f32>(encode(v.r), encode(v.g), encode(v.b)); }
  output[id.y * p.width + id.x] = pack(c, select(0u, 255u, alpha / (scale.x * scale.y) >= 0.5));
}

@compute @workgroup_size(8, 8)
fn adjust(@builtin(global_invocation_id) id: vec3<u32>) {
  if (id.x >= p.width || id.y >= p.height) { return; }
  let i = id.y * p.width + id.x; let v = input[i];
  if (!opaque(v)) { output[i] = v; return; }
  var c = rgb(v);
  if (p.detail != 0u) {
    let offsets = array<vec2<i32>, 4>(vec2<i32>(-1, 0), vec2<i32>(1, 0), vec2<i32>(0, -1), vec2<i32>(0, 1));
    var sum = vec3<f32>(0.0); var count = 0.0;
    for (var k = 0u; k < 4u; k++) { let q = vec2<i32>(id.xy) + offsets[k];
      if (inside(q) && opaque(input[index(q)])) { sum += rgb(input[index(q)]); count += 1.0; }
    }
    if (count > 0.0) { c = clamp(c + (c - sum / count) * 0.45, vec3<f32>(0.0), vec3<f32>(255.0)); }
  }
  let l = dot(c, vec3<f32>(0.2126, 0.7152, 0.0722));
  c = ((vec3<f32>(l) + (c - vec3<f32>(l)) * p.saturation) - vec3<f32>(127.5)) * p.contrast + vec3<f32>(127.5 + p.brightness);
  output[i] = pack(c, 255u);
}

@compute @workgroup_size(8, 8)
fn ridges(@builtin(global_invocation_id) id: vec3<u32>) {
  if (id.x >= p.width || id.y >= p.height) { return; }
  let i = id.y * p.width + id.x; let value = luma(input[i]); var best = 0.0;
  if (opaque(input[i])) {
    let directions = array<vec2<i32>, 4>(vec2<i32>(1, 0), vec2<i32>(0, 1), vec2<i32>(1, 1), vec2<i32>(1, -1));
    for (var k = 0u; k < 4u; k++) { for (var radius = 1; radius <= 2; radius++) {
      let a = vec2<i32>(id.xy) - directions[k] * radius; let b = vec2<i32>(id.xy) + directions[k] * radius;
      if (!inside(a) || !inside(b)) { continue; }
      let av = input[index(a)]; let bv = input[index(b)]; if (!opaque(av) || !opaque(bv)) { continue; }
      let la = luma(av); let lb = luma(bv); let da = la - value; let db = lb - value;
      if (da * db > 0.0) { best = max(best, max(0.0, min(abs(da), abs(db)) - 0.025) / 0.22 * max(0.0, 1.0 - abs(la - lb) / 0.35)); }
    } }
  }
  raw[i] = vec2<f32>(min(1.0, best), value);
}

@compute @workgroup_size(8, 8)
fn support(@builtin(global_invocation_id) id: vec3<u32>) {
  if (id.x >= p.width || id.y >= p.height) { return; }
  let i = id.y * p.width + id.x; var neighborSupport = 0.0; var similar = 0.0; var neighbors = 0.0;
  for (var dy = -1; dy <= 1; dy++) { for (var dx = -1; dx <= 1; dx++) {
    let q = vec2<i32>(id.xy) + vec2<i32>(dx, dy);
    if ((dx == 0 && dy == 0) || !inside(q)) { continue; }
    let j = index(q); if (!opaque(input[j])) { continue; } neighbors += 1.0;
    let d = abs(rgb(input[i]) - rgb(input[j])); if (max(d.r, max(d.g, d.b)) < 20.0) { similar += 1.0; }
    if (abs(raw[i].y - raw[j].y) < 0.12) { neighborSupport = max(neighborSupport, raw[j].x); }
  } }
  let ridge = raw[i].x;
  let importance = max(max(ridge * 0.4, min(ridge, neighborSupport)), select(0.0, ridge, ridge > 0.9));
  var coherence = 1.0; if (neighbors > 0.0) { coherence = similar / neighbors; }
  features[i] = vec4<f32>(importance, raw[i].y, coherence, 0.0);
}

fn oklab(v: u32) -> vec3<f32> {
  let c = decode(v);
  let lms = pow(vec3<f32>(dot(c, vec3<f32>(0.4122214708, 0.5363325363, 0.0514459929)), dot(c, vec3<f32>(0.2119034982, 0.6806995451, 0.1073969566)), dot(c, vec3<f32>(0.0883024619, 0.2817188376, 0.6299787005))), vec3<f32>(1.0 / 3.0));
  return vec3<f32>(dot(lms, vec3<f32>(0.2104542553, 0.7936177850, -0.0040720468)), dot(lms, vec3<f32>(1.9779984951, -2.4285922050, 0.4505937099)), dot(lms, vec3<f32>(0.0259040371, 0.7827717662, -0.8086757660)));
}
@compute @workgroup_size(8, 8)
fn quantize(@builtin(global_invocation_id) id: vec3<u32>) {
  if (id.x >= p.width || id.y >= p.height) { return; }
  let i = id.y * p.width + id.x; var v = input[i];
  if (!opaque(v)) { output[i] = 0u; return; }
  if (p.dither != 0u) {
    let bayer = array<f32, 16>(0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5);
    let offset = (bayer[(id.y % 4u) * 4u + id.x % 4u] / 16.0 - 0.46875) * 90.0 * p.strength;
    // Quantization uses Math.round; unlike intermediate RGBA storage this rounds ties up.
    v = pack(floor(clamp(rgb(v) + vec3<f32>(offset), vec3<f32>(0.0), vec3<f32>(255.0)) + vec3<f32>(0.5)), 255u);
  }
  let color = oklab(v); var best = 0u; var distance = 1e20;
  for (var k = 0u; k < p.count; k++) { let d = color - labs[k].xyz; let error = dot(d, d); if (error < distance) { distance = error; best = k; } }
  output[i] = palette[best];
}
