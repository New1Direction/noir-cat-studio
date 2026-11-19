import fs from 'node:fs/promises';
import path from 'node:path';
import { createCat } from '../src/cat.js';
import { rigCat } from '../src/rig.js';
import { createAnimator } from '../src/animation.js';
import { exportAnimatedGLB } from '../src/export.js';

// The browser exporter uses FileReader; Blob is native in current Node.js.
globalThis.FileReader ??= class {
  readAsArrayBuffer(blob) { this.read(blob, buffer => buffer); }
  readAsDataURL(blob) { this.read(blob, buffer => `data:${blob.type};base64,${Buffer.from(buffer).toString('base64')}`); }
  read(blob, convert) {
    blob.arrayBuffer().then(buffer => {
      this.result = convert(buffer); this.onload?.({ target: this }); this.onloadend?.({ target: this });
    }, error => { this.error = error; this.onerror?.({ target: this }); });
  }
};

const output = path.resolve(process.argv[2] ?? 'exports');
await fs.mkdir(output, { recursive: true });
const manifest = [];
for (const style of ['original', 'dreamcast', 'ps1', 'ps2']) {
  const cat = rigCat(createCat({ style }));
  const animator = createAnimator(cat);
  const result = await exportAnimatedGLB(cat, animator.clips);
  const filename = `noir-${style}-rigged.glb`;
  await fs.writeFile(path.join(output, filename), result.binary);
  const entry = { filename, bytes: result.binary.byteLength, bones: 26, triangles: cat.userData.triangles, animations: result.animations, errors: result.report.issues.numErrors, warnings: result.report.issues.numWarnings };
  manifest.push(entry);
  console.log(`${filename}: ${entry.bytes} bytes, ${entry.animations.length} clips, ${entry.errors} errors, ${entry.warnings} warnings`);
  animator.dispose();
}
await fs.writeFile(path.join(output, 'noir-model-manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
