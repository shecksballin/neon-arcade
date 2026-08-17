import * as THREE from 'three';

// Tileable value noise: the lattice wraps at `period`, so every octave (and the
// resulting texture) repeats seamlessly under RepeatWrapping.
function makeNoise(seed) {
  const hash = (x, y, period) => {
    const xi = ((x % period) + period) % period;
    const yi = ((y % period) + period) % period;
    let n = xi * 374761393 + yi * 668265263 + seed * 1442695040;
    n = (n ^ (n >>> 13)) * 1274126177;
    return ((n ^ (n >>> 16)) >>> 0) / 4294967295;
  };

  const smooth = (t) => t * t * (3 - 2 * t);

  // u,v in 0..1; `period` lattice cells across the full texture
  return (u, v, period) => {
    const x = u * period, y = v * period;
    const x0 = Math.floor(x), y0 = Math.floor(y);
    const fx = smooth(x - x0), fy = smooth(y - y0);

    const a = hash(x0, y0, period);
    const b = hash(x0 + 1, y0, period);
    const c = hash(x0, y0 + 1, period);
    const d = hash(x0 + 1, y0 + 1, period);

    return (a * (1 - fx) + b * fx) * (1 - fy) + (c * (1 - fx) + d * fx) * fy;
  };
}

function fbm(noise, u, v, basePeriod, octaves) {
  let sum = 0, amp = 0.5, norm = 0, period = basePeriod;
  for (let i = 0; i < octaves; i++) {
    sum += amp * noise(u, v, period);
    norm += amp;
    amp *= 0.5;
    period *= 2;
  }
  return sum / norm;
}

function canvasTexture(size, fill) {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d');
  const image = ctx.createImageData(size, size);
  fill(image.data, size);
  ctx.putImageData(image, 0, 0);

  const texture = new THREE.CanvasTexture(canvas);
  texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
  texture.colorSpace = THREE.NoColorSpace; // data map, not color
  return texture;
}

// Soft, puffy cumulus mass in the red channel.
export function makeCloudTexture(size = 512, seed = 7) {
  const noise = makeNoise(seed);
  return canvasTexture(size, (data, n) => {
    for (let y = 0; y < n; y++) {
      for (let x = 0; x < n; x++) {
        const u = x / n, v = y / n;
        // billowy detail over a broad cover mask -> clumps instead of even fuzz
        const detail = fbm(noise, u, v, 8, 5);
        const mass = fbm(noise, u + 0.37, v + 0.11, 3, 2);
        let c = detail * 0.65 + mass * 0.55;
        c = Math.max(0, Math.min(1, (c - 0.28) * 1.9));
        const i = (y * n + x) * 4;
        const b = Math.round(c * 255);
        data[i] = b; data[i + 1] = b; data[i + 2] = b; data[i + 3] = 255;
      }
    }
  });
}

// Low-frequency 2-channel distortion field (R = x offset, G = y offset).
export function makeFlowTexture(size = 256, seed = 23) {
  const nx = makeNoise(seed);
  const ny = makeNoise(seed + 101);
  return canvasTexture(size, (data, n) => {
    for (let y = 0; y < n; y++) {
      for (let x = 0; x < n; x++) {
        const u = x / n, v = y / n;
        const i = (y * n + x) * 4;
        data[i] = Math.round(fbm(nx, u, v, 3, 3) * 255);
        data[i + 1] = Math.round(fbm(ny, u, v, 3, 3) * 255);
        data[i + 2] = 128;
        data[i + 3] = 255;
      }
    }
  });
}
