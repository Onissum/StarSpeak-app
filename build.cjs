const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash } = require('node:crypto');
const base = 'https://huggingface.co/Cactus-Compute/needle3/resolve/f84005f8992caf37f17b0d64a4b5b31a84ce0d2a/wasm/';
const hashes = {
  'needle.js': 'f3f7366dcad9555b792ee519d2518f3c506038bcb2ffd179e76e850000749359',
  'needle.wasm': 'c19b9ddf9c7de4eb4f37e5f1811c5bbea9f099041d2a27284daf89789ee8523d',
  'libfvad.wasm': '3fadafc9c5c1c3117d0178ae631484c6dabc72e0f8742b95c370cd39f46cf171'
};
(async () => {
  const vendor = path.join(__dirname, 'public/vendor');
  await fs.mkdir(vendor, { recursive: true });
  for (const [name, hash] of Object.entries(hashes)) {
    let bytes;
    try { bytes = await fs.readFile(path.join(vendor, name)); } catch {}
    if (!bytes) {
      const url = name === 'libfvad.wasm' ? 'https://unpkg.com/@ozymandiasthegreat/vad@2.0.7/dist/libfvad.wasm' : base + name;
      const response = await fetch(url, { signal: AbortSignal.timeout(60000) });
      if (!response.ok) throw new Error(`Runtime ${name}: HTTP ${response.status}`);
      bytes = Buffer.from(await response.arrayBuffer());
    }
    if (createHash('sha256').update(bytes).digest('hex') !== hash) throw new Error(`Runtime ${name}: integrity check failed`);
    await fs.writeFile(path.join(vendor, name), bytes);
    console.log(`Verified and bundled ${name}: ${bytes.length} bytes`);
  }
})().catch(error => { console.error(error.message); process.exitCode = 1; });
